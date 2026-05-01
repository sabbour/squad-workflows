/**
 * Init — one-time repo setup.
 *
 * Creates labels, writes config, patches instruction files.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
  'docs:not-applicable': 'bfdadc',
  'docs:rejected': 'd93f0b',
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
    ...(config.labels.reviewSignals || []),
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

  // 4. Patch Ralph's charter
  const ralphCharterPath = join(repoRoot, '.squad', 'agents', 'ralph', 'charter.md');
  if (existsSync(ralphCharterPath)) {
    const patched = patchInstructionBlock(
      readFileSync(ralphCharterPath, 'utf-8'),
      buildRalphCharterBlock()
    );
    writeFileSync(ralphCharterPath, patched);
    results.instructions.push('ralph/charter.md patched');
  }

  // 5. Patch all agent charters (excluding _alumni and scribe)
  const agentsDir = join(repoRoot, '.squad', 'agents');
  const EXCLUDED_AGENTS = new Set(['_alumni', 'scribe', 'ralph']);
  if (existsSync(agentsDir)) {
    const agentDirs = readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !EXCLUDED_AGENTS.has(d.name));
    for (const dir of agentDirs) {
      const charterPath = join(agentsDir, dir.name, 'charter.md');
      if (existsSync(charterPath)) {
        const patched = patchInstructionBlock(
          readFileSync(charterPath, 'utf-8'),
          buildAgentCharterBlock()
        );
        writeFileSync(charterPath, patched);
        results.instructions.push(`agents/${dir.name}/charter.md patched`);
      }
    }
  }

  // 6. Patch ceremonies.md
  const ceremoniesPath = join(repoRoot, '.squad', 'ceremonies.md');
  if (existsSync(ceremoniesPath)) {
    const patched = patchInstructionBlock(
      readFileSync(ceremoniesPath, 'utf-8'),
      buildCeremoniesBlock(config)
    );
    writeFileSync(ceremoniesPath, patched);
    results.instructions.push('ceremonies.md patched');
  }

  // 7. Patch issue-lifecycle.md
  const lifecyclePath = join(repoRoot, '.squad', 'issue-lifecycle.md');
  if (existsSync(lifecyclePath)) {
    const patched = patchInstructionBlock(
      readFileSync(lifecyclePath, 'utf-8'),
      buildLifecycleOverrideBlock()
    );
    writeFileSync(lifecyclePath, patched);
    results.instructions.push('issue-lifecycle.md patched');
  }

  return results;
}

export function buildInstructionBlock(config) {
  return `${INSTRUCTIONS_MARKER_START}
## Workflow Tools (squad-workflows extension)

Use these tools for the issue-to-merge lifecycle:

**Planning:** \`squad_workflows_estimate\` → \`squad_workflows_decompose\` (if L/XL)
**Design:** \`squad_workflows_post_design_proposal\` → \`squad_workflows_check_design_approval\`
**Review:** \`squad_workflows_check_feedback\` + \`squad_workflows_check_ci\`
**Feedback Loop:** \`squad_workflows_address_feedback\` / \`squad_workflows_address_all_feedback\` → batch fixes → one commit/consolidated update → resolve → reviewDecision check → human re-review/dismissal ping if needed → role-gate approval via \`squad_reviews_execute_pr_review\`
**Branch Sync:** \`squad_workflows_update_branch\` (reactive — only when merge blocked by stale branch)
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

### Pre-Push Validation
Before pushing any branch, run \`npm test\` (and \`npm run build\` if a build script exists in package.json). Do NOT push code that fails tests or build.
${INSTRUCTIONS_MARKER_END}`;
}

export function buildRalphCharterBlock() {
  return `${INSTRUCTIONS_MARKER_START}
## PR Feedback Loop (squad-workflows)

**Goal:** Clear the board — get every open squad PR merged and every assigned issue completed. This is Ralph's primary objective when active. The board is clear when there are 0 open PRs from squad bots and 0 open issues with \`squad:*\` labels.

**Skills to read before starting:**
- \`.copilot/skills/pr-feedback-loop/SKILL.md\` — the full cycle definition (initiation, patterns, thread protocol)
- \`.copilot/skills/reviewer-protocol/SKILL.md\` — how reviews work, thread resolution rules
- \`.copilot/skills/gh-auth-isolation/SKILL.md\` — bot identity isolation for writes
- \`.copilot/skills/self-approval-fallback/SKILL.md\` — what to do when review gate is stuck on self-authored PRs
- \`.copilot/skills/git-workflow/SKILL.md\` — branch conventions, push protocol

### Loop steps (execute in order, every work-check cycle)

1. **Scan.** Call \`squad_workflows_address_all_feedback(owner, repo)\`. Returns structured data for every open PR with unresolved review threads — file paths, line numbers, reviewer suggestions, category (codereview/security/docs/architecture).
2. **Prioritize.** Sort PRs: CI failures first → \`CHANGES_REQUESTED\` → approved-but-unresolved-threads. Skip PRs with unresolvable blockers (missing human approval, merge conflicts you cannot fix).
3. **Fix in one batch.** For each actionable PR, spawn the authoring agent (the one whose bot identity matches the PR's branch, e.g. \`squad-backend[bot]\` → Kif) with the full structured thread batch as input. The spawned agent must read \`.copilot/skills/pr-feedback-loop/SKILL.md\` and \`.copilot/skills/git-workflow/SKILL.md\`, address all related feedback in one implementation pass, validate once, and create **one commit for the batch** before pushing with \`squad_workflows_push\`. Do not loop thread-by-thread with separate commits.
4. **Consolidate update, then resolve threads.** After the batch push, prefer one consolidated PR comment/update summarizing the commit SHA and all addressed reviewer concerns. Then reply to each addressed thread **using the same bot identity that authored the PR** (the authoring agent's roleSlug, NOT Ralph's). Use \`squad_reviews_resolve_thread(pr, threadId, commentId, reply, action)\` with reply = \`"Addressed in {sha}: {description}"\` and action = \`"addressed"\`. Replies may reference the consolidated PR update, but MUST remain substantive enough for the thread. See \`.copilot/skills/reviewer-protocol/SKILL.md\` for the thread resolution contract. Never resolve without a reply.
5. **Two-step closure check.** After all threads are resolved, check PR \`reviewDecision\`. If it is still \`CHANGES_REQUESTED\`, ping the human reviewer for re-review/dismissal. Separately submit any required Squad role-gate approval with \`squad_reviews_execute_pr_review\`; thread resolution or human dismissal does not satisfy role gates.
6. **Re-request review.** Call \`squad_reviews_dispatch_review(pr, role)\` for the reviewer role that left the feedback. This adds the \`review:{role}:requested\` label and posts a notification comment.
7. **Merge gate.** Call \`squad_workflows_merge_check(pr)\`. If all-clear (approvals + CI green + 0 unresolved threads + branch current), call \`squad_workflows_merge(pr)\`. If the gate is stuck due to self-approval, read \`.copilot/skills/self-approval-fallback/SKILL.md\` for the escalation path.
8. **Branch behind?** If merge_check fails ONLY because the branch is behind base, call \`squad_workflows_update_branch(pr)\` for that specific PR, then retry merge_check once.
9. **Next PR.** Move to the next PR in the priority list. Repeat steps 3–7.
10. **Wave boundary check.** After all PRs in the cycle are processed, call \`squad_workflows_wave_status(owner, repo)\`. If a wave (milestone) just completed, report to the user and pause for release coordination (see \`.copilot/skills/release-process/SKILL.md\`). Otherwise, loop back to step 1.

### Rules

- **Never call \`squad_workflows_update_all_branches()\` proactively.** Only call \`squad_workflows_update_branch(pr)\` on a specific PR, and only when step 7's condition is met.
- **Thread resolution identity: use the PR author's bot, not Ralph's.** The reply must come from the same identity that wrote the code. Ralph orchestrates; the authoring bot speaks.
- **Thread resolution order is: fix → reply → resolve → reviewDecision check.** Resolving without replying is a governance violation (see \`.copilot/skills/reviewer-protocol/SKILL.md\`).
- **Batch feedback before pushing.** One PR feedback cycle should produce one cohesive fix commit and one consolidated update where possible. Avoid per-thread commits/comments because each synchronize can trigger approval invalidation and rebase churn.
- **Two-step closure is mandatory.** Once all threads are resolved, a remaining \`CHANGES_REQUESTED\` reviewDecision needs a human re-review/dismissal ping, and Squad role gates need a separate \`squad_reviews_execute_pr_review\` approval.
- **Bot identity required for all writes.** Read \`.copilot/skills/gh-auth-isolation/SKILL.md\`. Use the squad_workflows push/create_pr tools or the bot token inline form. Never fall back to ambient \`gh\` auth.
- **Skip, don't stall.** If a PR has unresolvable blockers (merge conflicts requiring human judgment, missing human-only approval, repeated CI failures after 2 fix attempts), skip it, log why, and move to the next.
- **Wave boundaries are a valid stop point.** When a milestone completes, pause and report. Do not continue into the next wave without acknowledgment.
${INSTRUCTIONS_MARKER_END}`;
}

export function buildAgentCharterBlock() {
  return `${INSTRUCTIONS_MARKER_START}
## Workflow Rules (squad-workflows)

### Pre-Push Validation
Before pushing any branch, run \`npm test\` (and \`npm run build\` if a build script exists in package.json). Do NOT push code that fails tests or build.
${INSTRUCTIONS_MARKER_END}`;
}

export function buildCeremoniesBlock(config) {
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

export function buildLifecycleOverrideBlock() {
  return `${INSTRUCTIONS_MARKER_START}
> **⚠️ This project uses squad-workflows.** The step-by-step commands in
> sections 1–7 below are superseded by the squad-workflows extension tools.
> Follow these references instead:
>
> - **Workflow tools**: \`.squad/skills/squad-workflows/SKILL.md\`
> - **Ceremonies & gates**: \`.squad/ceremonies.md\`
> - **Branch model & identity**: \`.github/copilot-instructions.md\`
>
> If this notice is missing, run \`squad-workflows setup\` to re-patch.
${INSTRUCTIONS_MARKER_END}`;
}

export function patchInstructionBlock(content, block) {
  const startIdx = content.indexOf(INSTRUCTIONS_MARKER_START);
  const endIdx = content.indexOf(INSTRUCTIONS_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    return content.slice(0, startIdx) + block + content.slice(endIdx + INSTRUCTIONS_MARKER_END.length);
  }

  return content.trimEnd() + '\n\n' + block + '\n';
}
