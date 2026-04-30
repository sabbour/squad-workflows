/**
 * squad-workflows — Copilot CLI extension entry point.
 *
 * Registers all squad_workflows_* tools for the issue-to-merge lifecycle.
 */

import { approveAll } from '@github/copilot-sdk';
import { joinSession } from '@github/copilot-sdk/extension';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, 'lib');

function resolveRepoRoot() {
  // Walk up from extension dir: .github/extensions/squad-workflows/ → repo root
  const candidate = join(__dirname, '..', '..', '..');
  if (existsSync(join(candidate, '.squad')) || existsSync(join(candidate, 'package.json'))) {
    return candidate;
  }
  return candidate;
}

function jsonHandler(fn) {
  return async (params = {}) => {
    try {
      const result = await fn(params);
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }, null, 2);
    }
  };
}

const REPO_ROOT = resolveRepoRoot();

// Lazy-load lib modules to keep startup fast
const lib = (name) => import(join(LIB_DIR, name));

// ---------------------------------------------------------------------------
// Token auto-resolution via squad-identity lease system
// ---------------------------------------------------------------------------
const IDENTITY_LIB = join(__dirname, '..', 'squad-identity', 'lib');

let _leaseState = null; // { scopeId, role, deadlineUnix, remainingOps }

async function getToken(roleSlug) {
  const role = roleSlug || process.env.ROLE_SLUG || 'lead';

  // Check if current lease is still usable (>60s remaining, >0 ops)
  if (_leaseState && _leaseState.role === role) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (_leaseState.remainingOps > 0 && nowSec < _leaseState.deadlineUnix - 60) {
      try {
        const { exchangeLease } = await import(join(IDENTITY_LIB, 'token-lease-store.mjs'));
        const result = exchangeLease(_leaseState.scopeId, role);
        _leaseState.remainingOps = result.remainingOps;
        return result.token;
      } catch {
        // Lease expired/exhausted — fall through to create new one
        _leaseState = null;
      }
    } else {
      _leaseState = null;
    }
  }

  // Resolve a fresh token and create a new lease
  const { resolveToken } = await import(join(IDENTITY_LIB, 'resolve-token.mjs'));
  const token = await resolveToken(REPO_ROOT, role);
  if (!token) {
    throw new Error(`Could not resolve token for role "${role}". Run squad_identity_doctor for diagnostics.`);
  }

  const { createLease, exchangeLease } = await import(join(IDENTITY_LIB, 'token-lease-store.mjs'));
  const lease = createLease({ role, token, maxOps: 500, maxTimeSec: 3500 });
  _leaseState = { scopeId: lease.scopeId, role, deadlineUnix: lease.deadlineUnix, remainingOps: lease.remainingOps };

  // Exchange immediately to get the token back (first op)
  const result = exchangeLease(lease.scopeId, role);
  _leaseState.remainingOps = result.remainingOps;
  return result.token;
}

const session = await joinSession({
  onPermissionRequest: approveAll,
  tools: [
    // ── Setup ──────────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_init',
      description: 'One-time repo setup: create labels, board columns, write config, patch ceremonies/lifecycle/instructions.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          force: { type: 'boolean', description: 'Overwrite existing config if present' },
        },
        required: ['owner', 'repo'],
      },
      handler: jsonHandler(async ({ owner, repo, force }) => {
        const token = await getToken();
        const { runInit } = await lib('init.mjs');
        return runInit(REPO_ROOT, { token, owner, repo, force });
      }),
    },
    {
      name: 'squad_workflows_doctor',
      description: 'Health check: config valid? Labels exist? Instruction blocks present and current?',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: [],
      },
      handler: jsonHandler(async ({ owner, repo }) => {
        const token = await getToken();
        const { runDoctor } = await lib('doctor.mjs');
        return runDoctor(REPO_ROOT, { token, owner, repo });
      }),
    },

    // ── Planning ───────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_estimate',
      description: 'Analyze an issue and auto-apply an estimate:S/M/L/XL label with story points. Combines issue description, acceptance criteria, files likely touched, and historical data.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['issue', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, owner, repo }) => {
        const token = await getToken();
        const { runEstimate } = await lib('estimate.mjs');
        return runEstimate(REPO_ROOT, { issue, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_decompose',
      description: 'Decompose a large issue into waves. Creates a GitHub milestone per wave and child issues with demo criteria. Enforces max estimate:M per issue.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Parent issue number to decompose' },
          waves: {
            type: 'array',
            description: 'Wave definitions with titles, child issues, and demo criteria',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Wave title (e.g., "Basic Widget Support")' },
                demoCriteria: { type: 'string', description: 'What you can test after this wave ships' },
                issues: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      body: { type: 'string' },
                      estimate: { type: 'string', enum: ['S', 'M'] },
                      labels: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['title', 'estimate'],
                  },
                },
              },
              required: ['title', 'demoCriteria', 'issues'],
            },
          },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['issue', 'waves', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, waves, owner, repo }) => {
        const token = await getToken();
        const { runDecompose } = await lib('decompose.mjs');
        return runDecompose(REPO_ROOT, { issue, waves, token, owner, repo });
      }),
    },

    // ── Design ─────────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_post_design_proposal',
      description: 'Post a Design Proposal comment on an issue. Validates completeness of required sections. Includes subtasks grouped by wave.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue number' },
          proposal: {
            type: 'object',
            description: 'Design proposal content',
            properties: {
              problem: { type: 'string', description: 'Problem statement with evidence' },
              estimate: { type: 'string', description: 'Overall estimate (S/M/L/XL)' },
              approach: { type: 'string', description: 'Technical approach' },
              subtasks: { type: 'string', description: 'Subtasks grouped by wave (markdown)' },
              files: { type: 'string', description: 'Files to modify' },
              security: { type: 'string', description: 'Security considerations' },
              docs: { type: 'string', description: 'Documentation plan' },
              alternatives: { type: 'string', description: 'Alternatives considered' },
            },
            required: ['problem', 'estimate', 'approach', 'subtasks', 'files', 'security', 'docs', 'alternatives'],
          },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['issue', 'proposal', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, proposal, owner, repo }) => {
        const token = await getToken();
        const { runPostDesignProposal } = await lib('design-proposal.mjs');
        return runPostDesignProposal(REPO_ROOT, { issue, proposal, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_check_design_approval',
      description: 'Check if an issue has all required Design Review approval labels. Returns missing approvals and what\'s blocking.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['issue', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, owner, repo }) => {
        const token = await getToken();
        const { runCheckDesignApproval } = await lib('design-review.mjs');
        return runCheckDesignApproval(REPO_ROOT, { issue, token, owner, repo });
      }),
    },

    // ── Review ─────────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_check_feedback',
      description: 'List all unresolved review threads across all reviewers for a PR. Shows what needs addressing.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['pr', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ pr, owner, repo }) => {
        const token = await getToken();
        const { runCheckFeedback } = await lib('feedback.mjs');
        return runCheckFeedback(REPO_ROOT, { pr, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_check_ci',
      description: 'Check CI status for a PR. Reports failures with actionable context.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['pr', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ pr, owner, repo }) => {
        const token = await getToken();
        const { runCheckCi } = await lib('feedback.mjs');
        return runCheckCi(REPO_ROOT, { pr, token, owner, repo });
      }),
    },

    // ── Merge ──────────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_merge_check',
      description: 'Full pre-merge validation: all approval labels + 0 unresolved threads + CI green + changeset present + branch current.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['pr', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ pr, owner, repo }) => {
        const token = await getToken();
        const { runMergeCheck } = await lib('merge-check.mjs');
        return runMergeCheck(REPO_ROOT, { pr, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_merge',
      description: 'Squash merge a PR + delete branch + check if wave is complete (nudge release if so).',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['pr', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ pr, owner, repo }) => {
        const token = await getToken();
        const { runMerge } = await lib('merge.mjs');
        return runMerge(REPO_ROOT, { pr, token, owner, repo });
      }),
    },

    // ── Utility ────────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_fast_lane',
      description: 'Check if an issue qualifies for fast-lane (estimate:S or squad:chore-auto). Returns which ceremonies can be skipped.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['issue', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, owner, repo }) => {
        const token = await getToken();
        const { runFastLane } = await lib('fast-lane.mjs');
        return runFastLane(REPO_ROOT, { issue, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_board_sync',
      description: 'Sync project board column based on current issue/PR state. Uses GraphQL project mutations.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue number' },
          targetColumn: { type: 'string', description: 'Target column name (e.g., "In Progress", "In Review")' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['issue', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, targetColumn, owner, repo }) => {
        const token = await getToken();
        const { runBoardSync } = await lib('board-sync.mjs');
        return runBoardSync(REPO_ROOT, { issue, targetColumn, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_wave_status',
      description: 'Show wave/milestone progress: which waves are complete, releasable, or blocking. Includes issue counts and demo criteria.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          milestone: { type: 'string', description: 'Specific milestone title (optional — shows all waves if omitted)' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
      handler: jsonHandler(async ({ milestone, owner, repo }) => {
        const token = await getToken();
        const { runWaveStatus } = await lib('wave-status.mjs');
        return runWaveStatus(REPO_ROOT, { milestone, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_status',
      description: 'Show current workflow state for an issue: which phase it\'s in, what\'s blocking, what\'s next.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['issue', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, owner, repo }) => {
        const token = await getToken();
        const { runStatus } = await lib('status.mjs');
        return runStatus(REPO_ROOT, { issue, token, owner, repo });
      }),
    },

    // ── Release ────────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_release_wave',
      description: 'Release a completed wave: validate all issues closed, run changeset version, close milestone, post summary. Use --dry-run to preview.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          milestone: { type: 'string', description: 'Milestone title (optional — picks first complete wave if omitted)' },
          dryRun: { type: 'boolean', description: 'Preview without making changes' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
      handler: jsonHandler(async ({ milestone, dryRun, owner, repo }) => {
        const token = await getToken();
        const { runReleaseWave } = await lib('release-wave.mjs');
        return runReleaseWave(REPO_ROOT, { milestone, dryRun, token, owner, repo });
      }),
    },

    // ── Scaffold: changeset release workflow ──────────────────────────────
    {
      name: 'squad_workflows_scaffold_release',
      description: 'Scaffold a manually-dispatched GitHub Actions workflow for changeset-based releases. Writes squad-changeset-release.yml into .github/workflows/.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'Preview without writing files' },
          force: { type: 'boolean', description: 'Overwrite existing workflow file' },
        },
      },
      handler: jsonHandler(async ({ dryRun, force }) => {
        const { scaffoldChangesetRelease } = await lib('scaffold-changeset-release.mjs');
        return scaffoldChangesetRelease(REPO_ROOT, { dryRun, force });
      }),
    },
  ],
});
