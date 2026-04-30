/**
 * Init — one-time repo setup.
 *
 * Creates labels, writes config, patches instruction files.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureLabel } from './github-api.mjs';
import { configExists, configPath, getTemplate, loadConfig } from './workflow-config.mjs';

const execFileAsync = promisify(execFile);

/**
 * Resolve owner/repo from git remote if not provided via CLI flags.
 */
async function resolveRepo(repoRoot, owner, repo) {
  if (owner && repo) return { owner, repo };

  try {
    const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'owner,name'], {
      cwd: repoRoot,
      timeout: 10_000,
    });
    const data = JSON.parse(stdout);
    return { owner: data.owner.login, repo: data.name };
  } catch {
    throw new Error(
      'Could not determine repository owner/name. Pass --owner and --repo, or run from a directory with a GitHub remote.'
    );
  }
}

const LABEL_COLORS = {
  'estimate:S': '0e8a16',
  'estimate:M': 'fbca04',
  'estimate:L': 'e99695',
  'estimate:XL': 'd93f0b',
  'squad:chore-auto': 'c5def5',
  'architecture:approved': '0e8a16',
  'security:approved': '0e8a16',
  'codereview:approved': '0e8a16',
  'docs:approved': '0e8a16',
};

const LABEL_DESCRIPTIONS = {
  'estimate:S': 'Small — ~1 story point, ≤2 hours',
  'estimate:M': 'Medium — ~3 story points, ≤8 hours',
  'estimate:L': 'Large — ~8 story points, ≤24 hours (must decompose)',
  'estimate:XL': 'Extra large — ~20 story points, ≤80 hours (must decompose)',
};

const INSTRUCTIONS_MARKER_START = '<!-- squad-workflows: start -->';
const INSTRUCTIONS_MARKER_END = '<!-- squad-workflows: end -->';

export async function runInit(repoRoot, { token, owner, repo, force }) {
  const results = { labels: [], config: null, instructions: [] };

  // Resolve owner/repo from git remote if not explicitly provided
  const resolved = await resolveRepo(repoRoot, owner, repo);
  owner = resolved.owner;
  repo = resolved.repo;

  // 1. Write config
  const cfgPath = configPath(repoRoot);
  if (!configExists(repoRoot) || force) {
    mkdirSync(join(repoRoot, '.squad', 'workflows'), { recursive: true });
    writeFileSync(cfgPath, getTemplate() + '\n');
    results.config = 'created';
  } else {
    results.config = 'exists (use force to overwrite)';
  }

  // 2. Create labels
  const config = loadConfig(repoRoot);
  const allLabels = [
    ...config.labels.estimates,
    ...config.labels.fastLane,
    ...config.labels.designApprovals,
  ];
  const unique = [...new Set(allLabels)];

  for (const label of unique) {
    try {
      await ensureLabel(
        owner, repo, label,
        LABEL_COLORS[label] || 'ededed',
        LABEL_DESCRIPTIONS[label] || '',
        token
      );
      results.labels.push({ label, status: 'ok' });
    } catch (err) {
      results.labels.push({ label, status: 'error', message: err.message });
    }
  }

  // 3. Patch copilot-instructions.md
  const instrPath = join(repoRoot, '.github', 'copilot-instructions.md');
  if (existsSync(instrPath)) {
    const patched = patchInstructionBlock(
      readFileSync(instrPath, 'utf-8'),
      buildInstructionBlock(config)
    );
    writeFileSync(instrPath, patched);
    results.instructions.push('copilot-instructions.md patched');
  }

  // 4. Patch ceremonies.md
  const ceremoniesPath = join(repoRoot, '.squad', 'ceremonies.md');
  if (existsSync(ceremoniesPath)) {
    const patched = patchInstructionBlock(
      readFileSync(ceremoniesPath, 'utf-8'),
      buildCeremoniesBlock(config)
    );
    writeFileSync(ceremoniesPath, patched);
    results.instructions.push('ceremonies.md patched');
  }

  return results;
}

function buildInstructionBlock(config) {
  return `${INSTRUCTIONS_MARKER_START}
## Workflow Tools (squad-workflows extension)

Use these tools for the issue-to-merge lifecycle:

**Planning:** \`squad_workflows_estimate\` → \`squad_workflows_decompose\` (if L/XL)
**Design:** \`squad_workflows_post_design_proposal\` → \`squad_workflows_check_design_approval\`
**Review:** \`squad_workflows_check_feedback\` + \`squad_workflows_check_ci\`
**Merge:** \`squad_workflows_merge_check\` → \`squad_workflows_merge\`
**Utility:** \`squad_workflows_fast_lane\`, \`squad_workflows_board_sync\`, \`squad_workflows_wave_status\`, \`squad_workflows_status\`

### Fast Lane
Issues labeled ${config.designProposal.fastLaneLabels.map(l => '`' + l + '`').join(' or ')} skip Design Proposal and Design Review.

### Wave-Based Delivery
Large features must be decomposed into waves (GitHub milestones). Each wave is independently shippable and produces a releasable changeset. Max issue estimate per wave: ${config.waves.maxIssueEstimate}.

### Branch Conventions
- Base branch: \`${config.branchModel.base}\`
- Branch naming: \`squad/{issue-number}-{kebab-case-slug}\`
- Always use worktrees: \`git worktree add .worktrees/{slug} -b squad/{issue}-{slug} origin/${config.branchModel.base}\`
${INSTRUCTIONS_MARKER_END}`;
}

function buildCeremoniesBlock(config) {
  const fastLaneLabels = config.designProposal.fastLaneLabels.map(l => '`' + l + '`').join(' or ');
  const approvals = config.labels.designApprovals.map(l => '`' + l + '`').join(', ');
  return `${INSTRUCTIONS_MARKER_START}
### Planning Ceremony (squad-workflows)

| Step | Tool | Gate |
|------|------|------|
| Estimate issue | \`squad_workflows_estimate\` | Auto-applies \`estimate:S/M/L/XL\` label |
| Decompose (if L/XL) | \`squad_workflows_decompose\` | Creates milestones + child issues |
| Fast-lane check | \`squad_workflows_fast_lane\` | Issues labeled ${fastLaneLabels} skip Design Proposal and Design Review |

### Design Ceremony

| Step | Tool | Gate |
|------|------|------|
| Post Design Proposal | \`squad_workflows_post_design_proposal\` | Posts DP comment on issue, adds \`design-proposal\` label |
| Check Design Approval | \`squad_workflows_check_design_approval\` | Blocks until all approval labels present: ${approvals} |

### Review Ceremony

| Step | Tool | Gate |
|------|------|------|
| Check review feedback | \`squad_workflows_check_feedback\` | Lists unresolved review threads — all must be resolved before merge |
| Check CI status | \`squad_workflows_check_ci\` | CI must be green — returns actionable failure context if not |
| Pre-merge validation | \`squad_workflows_merge_check\` | Holistic gate: approvals + threads + CI + changeset + branch current |

### Merge Ceremony

| Step | Tool | Gate |
|------|------|------|
| Merge PR | \`squad_workflows_merge\` | Squash merge, delete branch, check wave completion |

### Wave Completion Ceremony

When the last issue in a wave merges:

| Step | Tool | Gate |
|------|------|------|
| Check wave progress | \`squad_workflows_wave_status\` | Reports which waves are complete and releasable |
| Release wave | \`squad_workflows_release_wave\` | Runs changeset version, closes milestone, posts summary |
${INSTRUCTIONS_MARKER_END}`;
}

function patchInstructionBlock(content, block) {
  const startIdx = content.indexOf(INSTRUCTIONS_MARKER_START);
  const endIdx = content.indexOf(INSTRUCTIONS_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    return content.slice(0, startIdx) + block + content.slice(endIdx + INSTRUCTIONS_MARKER_END.length);
  }

  return content.trimEnd() + '\n\n' + block + '\n';
}
