/**
 * Setup — full guided setup (recommended).
 *
 * Phases:
 *   1. Init — install extension, skill, config template (if missing)
 *   2. Labels — create GitHub labels for estimates/approvals
 *   3. Instructions — patch copilot-instructions.md and ceremonies.md
 *   4. Health — run doctor
 *
 * This is the recommended entry point. `init` is the advanced/silent variant.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureLabel } from './github-api.mjs';
import { configExists, configPath, getTemplate, loadConfig } from './workflow-config.mjs';
import { buildInstructionBlock, buildRalphCharterBlock, buildCeremoniesBlock, buildLifecycleOverrideBlock, patchInstructionBlock, readInstalledWorkflowsVersion } from './init.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..', '..', '..');

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

// Marker constants removed — imported from init.mjs

function log(msg) {
  process.stderr.write(msg + '\n');
}

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
    return { owner: null, repo: null };
  }
}

export async function runSetup(repoRoot, { token, owner, repo, force, json }) {
  const target = repoRoot;
  const results = { phases: [], labels: [], config: null, instructions: [], doctor: null };

  // ━━━ Phase 1: Initialize ━━━
  if (!json) log('\n━━━ Phase 1: Initialize ━━━\n');

  // Install config
  const cfgPath = configPath(target);
  if (!configExists(target) || force) {
    mkdirSync(join(target, '.squad', 'workflows'), { recursive: true });
    writeFileSync(cfgPath, getTemplate() + '\n');
    results.config = 'created';
    if (!json) log(`  ✓ Config → ${cfgPath}`);
  } else {
    results.config = 'exists';
    if (!json) log(`  ⏭ Config already exists — skipping (use --force to overwrite)`);
  }

  // Install extension
  const extSrcDir = join(PACKAGE_ROOT, 'extensions', 'squad-workflows');
  const extDestDir = join(target, '.github', 'extensions', 'squad-workflows');

  if (resolve(extSrcDir) !== resolve(extDestDir)) {
    mkdirSync(join(extDestDir, 'lib'), { recursive: true });

    if (existsSync(extSrcDir)) {
      const extFiles = readdirSync(extSrcDir).filter(f => f.endsWith('.mjs'));
      for (const file of extFiles) {
        copyFileSync(join(extSrcDir, file), join(extDestDir, file));
      }
      const libDir = join(extSrcDir, 'lib');
      if (existsSync(libDir)) {
        const libFiles = readdirSync(libDir).filter(f => f.endsWith('.mjs'));
        for (const file of libFiles) {
          copyFileSync(join(libDir, file), join(extDestDir, 'lib', file));
        }
      }
      if (!json) log(`  ✓ Extension → ${extDestDir}`);
    }
  } else {
    if (!json) log(`  ⏭ Extension source is target — skipping copy`);
  }

  // Install SKILL.md
  const skillSrc = join(PACKAGE_ROOT, 'squad-workflows', 'SKILL.md');
  const skillDestDir = join(target, '.squad', 'skills', 'squad-workflows');
  if (existsSync(skillSrc)) {
    mkdirSync(skillDestDir, { recursive: true });
    copyFileSync(skillSrc, join(skillDestDir, 'SKILL.md'));
    if (!json) log(`  ✓ SKILL.md → ${join(skillDestDir, 'SKILL.md')}`);
  }

  results.phases.push('init');

  // ━━━ Phase 2: Labels ━━━
  if (!json) log('\n━━━ Phase 2: Labels ━━━\n');

  const resolved = await resolveRepo(target, owner, repo);
  owner = resolved.owner;
  repo = resolved.repo;

  if (owner && repo) {
    const config = loadConfig(target);
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
        if (!json) log(`  ✓ ${label}`);
      } catch (err) {
        results.labels.push({ label, status: 'error', message: err.message });
        if (!json) log(`  ⚠ ${label}: ${err.message}`);
      }
    }
  } else {
    if (!json) log('  ⏭ No GitHub remote detected — skipping label creation');
  }

  results.phases.push('labels');

  // ━━━ Phase 3: Instructions ━━━
  if (!json) log('\n━━━ Phase 3: Instructions ━━━\n');

  const config = loadConfig(target);

  // Patch copilot-instructions.md
  const instrPath = join(target, '.github', 'copilot-instructions.md');
  if (existsSync(instrPath)) {
    const before = readFileSync(instrPath, 'utf-8');
    const previousVersion = readInstalledWorkflowsVersion(before);
    const patched = patchInstructionBlock(before, buildInstructionBlock(config));
    writeFileSync(instrPath, patched);
    const newVersion = readInstalledWorkflowsVersion(patched);
    results.instructions.push('copilot-instructions.md');
    results.previousVersion = previousVersion;
    results.newVersion = newVersion;
    if (!json) {
      log(`  ✓ Patched copilot-instructions.md`);
      if (newVersion) {
        if (previousVersion && previousVersion !== newVersion) {
          log(`    Block version: v${previousVersion} → v${newVersion}`);
        } else if (previousVersion && previousVersion === newVersion) {
          log(`    Block version: v${newVersion} (unchanged)`);
        } else {
          log(`    Block version: v${newVersion}`);
        }
      }
    }
  } else {
    if (!json) log(`  ⏭ No copilot-instructions.md found`);
  }

  // Patch Ralph's charter
  const ralphCharterPath = join(target, '.squad', 'agents', 'ralph', 'charter.md');
  if (existsSync(ralphCharterPath)) {
    const patched = patchInstructionBlock(
      readFileSync(ralphCharterPath, 'utf-8'),
      buildRalphCharterBlock()
    );
    writeFileSync(ralphCharterPath, patched);
    results.instructions.push('ralph/charter.md');
    if (!json) log(`  ✓ Patched ralph/charter.md`);
  } else {
    if (!json) log(`  ⏭ No ralph/charter.md found`);
  }

  // Patch ceremonies.md
  const ceremoniesPath = join(target, '.squad', 'ceremonies.md');
  if (existsSync(ceremoniesPath)) {
    const patched = patchInstructionBlock(
      readFileSync(ceremoniesPath, 'utf-8'),
      buildCeremoniesBlock(config)
    );
    writeFileSync(ceremoniesPath, patched);
    results.instructions.push('ceremonies.md');
    if (!json) log(`  ✓ Patched ceremonies.md`);
  } else {
    if (!json) log(`  ⏭ No ceremonies.md found`);
  }

  // Patch issue-lifecycle.md
  const lifecyclePath = join(target, '.squad', 'issue-lifecycle.md');
  if (existsSync(lifecyclePath)) {
    const patched = patchInstructionBlock(
      readFileSync(lifecyclePath, 'utf-8'),
      buildLifecycleOverrideBlock()
    );
    writeFileSync(lifecyclePath, patched);
    results.instructions.push('issue-lifecycle.md');
    if (!json) log(`  ✓ Patched issue-lifecycle.md`);
  } else {
    if (!json) log(`  ⏭ No issue-lifecycle.md found`);
  }

  results.phases.push('instructions');

  // ━━━ Phase 4: Health Check ━━━
  if (!json) log('\n━━━ Phase 4: Health Check ━━━\n');

  try {
    const { runDoctor } = await import('./doctor.mjs');
    const doctorResult = await runDoctor(target, { owner, repo, token });
    results.doctor = doctorResult;
    if (!json && doctorResult?.checks) {
      for (const check of doctorResult.checks) {
        const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
        log(`  ${icon} ${check.check}: ${check.message}`);
      }
    }
  } catch (err) {
    if (!json) log(`  ⚠ Doctor failed: ${err.message}`);
    results.doctor = { error: err.message };
  }

  results.phases.push('health');

  // Done
  if (!json) {
    log(`\n✅ squad-workflows setup complete.`);
    log(`\nNext steps:`);
    log(`  1. Edit .squad/workflows/config.json to match your project's branch model.`);
    log(`  2. Commit the generated files.`);
    log(`  3. Use squad_workflows_estimate on issues to start the workflow.`);
    return undefined; // visual output already printed to stderr
  }

  return results;
}
