/**
 * Doctor — health check for squad-workflows setup.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configExists, loadConfig } from './workflow-config.mjs';
import { ghApi } from './github-api.mjs';

export async function runDoctor(repoRoot, { token, owner, repo } = {}) {
  const checks = [];

  // 1. Config file
  if (configExists(repoRoot)) {
    try {
      loadConfig(repoRoot);
      checks.push({ check: 'config', status: 'pass', message: 'Config loaded successfully' });
    } catch (err) {
      checks.push({ check: 'config', status: 'fail', message: err.message });
    }
  } else {
    checks.push({ check: 'config', status: 'fail', message: 'No config found. Run squad_workflows_init.' });
  }

  // 2. Instruction blocks
  const instrPath = join(repoRoot, '.github', 'copilot-instructions.md');
  if (existsSync(instrPath)) {
    const content = readFileSync(instrPath, 'utf-8');
    const hasBlock = /<!--\s*squad-workflows:\s*start(?:\s+v[^\s>-]+)?\s*-->/.test(content);
    checks.push({
      check: 'copilot-instructions',
      status: hasBlock ? 'pass' : 'warn',
      message: hasBlock ? 'Workflow block present' : 'Missing workflow block. Run squad_workflows_init.',
    });
  } else {
    checks.push({ check: 'copilot-instructions', status: 'warn', message: 'No copilot-instructions.md found' });
  }

  // 3. Ceremonies block
  const ceremoniesPath = join(repoRoot, '.squad', 'ceremonies.md');
  if (existsSync(ceremoniesPath)) {
    const content = readFileSync(ceremoniesPath, 'utf-8');
    const hasBlock = /<!--\s*squad-workflows:\s*start(?:\s+v[^\s>-]+)?\s*-->/.test(content);
    checks.push({
      check: 'ceremonies',
      status: hasBlock ? 'pass' : 'warn',
      message: hasBlock ? 'Workflow block present' : 'Missing workflow block. Run squad_workflows_init.',
    });
  }

  // 3a. Ralph charter block
  const ralphCharterPath = join(repoRoot, '.squad', 'agents', 'ralph', 'charter.md');
  if (existsSync(ralphCharterPath)) {
    const content = readFileSync(ralphCharterPath, 'utf-8');
    const hasBlock = /<!--\s*squad-workflows:\s*start(?:\s+v[^\s>-]+)?\s*-->/.test(content);
    checks.push({
      check: 'ralph-charter',
      status: hasBlock ? 'pass' : 'warn',
      message: hasBlock ? 'PR feedback loop block present' : 'Missing PR feedback loop block. Run squad_workflows_init.',
    });
  }

  // 3b. Issue lifecycle override
  const lifecyclePath = join(repoRoot, '.squad', 'issue-lifecycle.md');
  if (existsSync(lifecyclePath)) {
    const content = readFileSync(lifecyclePath, 'utf-8');
    const hasBlock = /<!--\s*squad-workflows:\s*start(?:\s+v[^\s>-]+)?\s*-->/.test(content);
    checks.push({
      check: 'issue-lifecycle',
      status: hasBlock ? 'pass' : 'warn',
      message: hasBlock
        ? 'Override block present'
        : 'Missing override block — upstream commands may conflict. Run squad-workflows setup to re-patch.',
    });
  }

  // 4. Labels (if token provided)
  if (token && owner && repo) {
    const config = configExists(repoRoot) ? loadConfig(repoRoot) : null;
    if (config) {
      const allLabels = [...new Set([
        ...config.labels.estimates,
        ...config.labels.fastLane,
        ...config.labels.designApprovals,
        ...(config.labels.reviewSignals || []),
      ])];

      try {
        const repoLabels = await ghApi(`/repos/${owner}/${repo}/labels?per_page=100`, { token });
        const repoLabelNames = repoLabels.map((l) => l.name);
        const missing = allLabels.filter((l) => !repoLabelNames.includes(l));

        checks.push({
          check: 'labels',
          status: missing.length === 0 ? 'pass' : 'warn',
          message: missing.length === 0
            ? `All ${allLabels.length} labels present`
            : `Missing labels: ${missing.join(', ')}`,
        });
      } catch (err) {
        checks.push({ check: 'labels', status: 'error', message: err.message });
      }
    }
  }

  // 5. SKILL.md
  const skillCandidates = [
    join(repoRoot, '.squad', 'skills', 'squad-workflows', 'SKILL.md'),
    join(repoRoot, '.squad', 'skills', 'pr-workflow', 'SKILL.md'),
  ];
  const skillPath = skillCandidates.find((p) => existsSync(p));
  if (skillPath) {
    const content = readFileSync(skillPath, 'utf-8');
    const refsExtension = content.includes('squad_workflows_');
    checks.push({
      check: 'skill-md',
      status: refsExtension ? 'pass' : 'info',
      message: refsExtension
        ? 'SKILL.md references squad-workflows tools'
        : 'SKILL.md does not reference squad-workflows tools (consider running init)',
    });
  }

  // 5b. PR feedback loop skill
  const feedbackSkillPath = join(repoRoot, '.copilot', 'skills', 'pr-feedback-loop', 'SKILL.md');
  if (existsSync(feedbackSkillPath)) {
    const content = readFileSync(feedbackSkillPath, 'utf-8');
    const hasInitiation = content.includes('## Initiation');
    const hasTools = content.includes('squad_workflows_address_feedback');
    checks.push({
      check: 'pr-feedback-loop-skill',
      status: (hasInitiation && hasTools) ? 'pass' : 'warn',
      message: (hasInitiation && hasTools)
        ? 'PR feedback loop skill present with initiation section and tool references'
        : 'PR feedback loop skill missing initiation section or tool references — run init to patch.',
    });
  } else {
    checks.push({
      check: 'pr-feedback-loop-skill',
      status: 'info',
      message: 'PR feedback loop skill not found at .copilot/skills/pr-feedback-loop/SKILL.md',
    });
  }

  const passed = checks.filter((c) => c.status === 'pass').length;
  const total = checks.length;
  const healthy = checks.every((c) => c.status !== 'fail');

  return { healthy, summary: `${passed}/${total} checks passed`, checks };
}
