/**
 * squad-workflows — Copilot CLI extension entry point.
 *
 * Registers all squad_workflows_* tools for the issue-to-merge lifecycle.
 * Token auto-resolution: all tools resolve bot tokens internally via the
 * squad-identity lease system. No token parameters needed from callers.
 */

import { joinSession } from '@github/copilot-sdk/extension';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, 'lib');

function resolveRepoRoot() {
  // Walk up from extension dir: .github/extensions/squad-workflows/ → repo root
  return join(__dirname, '..', '..', '..');
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

// ---------------------------------------------------------------------------
// Token auto-resolution via squad-identity lease system
// ---------------------------------------------------------------------------
const IDENTITY_LIB = join(__dirname, '..', 'squad-identity', 'lib');

let _leaseState = null;

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
        _leaseState = null;
      }
    } else {
      _leaseState = null;
    }
  }

  // Resolve a fresh token and create a new lease
  const { resolveToken } = await import(join(IDENTITY_LIB, 'resolve-token.mjs'));
  const REPO_ROOT = resolveRepoRoot();
  const token = await resolveToken(REPO_ROOT, role);
  if (!token) {
    throw new Error(`Could not resolve token for role "${role}". Run squad_identity_doctor for diagnostics.`);
  }

  const { createLease, exchangeLease } = await import(join(IDENTITY_LIB, 'token-lease-store.mjs'));
  const lease = createLease({ role, token, maxOps: 500, maxTimeSec: 3500 });
  _leaseState = { scopeId: lease.scopeId, role, deadlineUnix: lease.deadlineUnix, remainingOps: lease.remainingOps };

  const result = exchangeLease(lease.scopeId, role);
  _leaseState.remainingOps = result.remainingOps;
  return result.token;
}

const REPO_ROOT = resolveRepoRoot();

// Lazy-load lib modules to keep startup fast
const lib = (name) => import(join(LIB_DIR, name));

const session = await joinSession({
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
      description: 'Analyze an issue and auto-apply an estimate:S/M/L/XL label with story points.',
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
      description: 'Decompose a large issue into waves. Creates a GitHub milestone per wave and child issues with demo criteria.',
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
                title: { type: 'string', description: 'Wave title' },
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
      description: 'Post a Design Proposal comment on an issue. Validates completeness of required sections.',
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
      description: 'Check if an issue has all required Design Review approval labels.',
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
      description: 'List all unresolved review threads across all reviewers for a PR.',
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
      name: 'squad_workflows_address_feedback',
      description: 'Read rejected/unresolved PR review feedback and return structured fix instructions for an agent.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['pr'],
      },
      handler: jsonHandler(async ({ pr, owner, repo }) => {
        const token = await getToken();
        const { runAddressFeedback } = await lib('address-feedback.mjs');
        return runAddressFeedback(REPO_ROOT, { pr, token, owner, repo });
      }),
    },
    {
      name: 'squad_workflows_address_all_feedback',
      description: 'Read all unresolved PR review feedback across multiple PRs and return structured fix instructions.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          prs: { type: 'array', items: { type: 'number' }, description: 'Specific PR numbers to check. If omitted, scans all open PRs.' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          filter: { type: 'string', enum: ['changes_requested', 'all_unresolved', 'commented'], description: 'Filter by review state (default: changes_requested)' },
        },
        required: ['owner', 'repo'],
      },
      handler: jsonHandler(async ({ prs, owner, repo, filter }) => {
        const token = await getToken();
        const { runAddressAllFeedback } = await lib('address-feedback.mjs');
        return runAddressAllFeedback(REPO_ROOT, { prs, token, owner, repo, filter });
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

    // ── Branch Update ─────────────────────────────────────────────────────────
    {
      name: 'squad_workflows_update_branch',
      description: 'Check if a PR branch is behind the base branch and update it (rebase or merge) to make it mergeable.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          strategy: { type: 'string', enum: ['merge', 'rebase'], description: 'How to update the branch (default: merge)' },
        },
        required: ['pr', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ pr, owner, repo, strategy }) => {
        const token = await getToken();
        const { runUpdateBranch } = await lib('update-branch.mjs');
        return runUpdateBranch(REPO_ROOT, { pr, token, owner, repo, strategy });
      }),
    },
    {
      name: 'squad_workflows_update_all_branches',
      description: 'Check all open PR branches and update those that are behind their base branch.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          prs: { type: 'array', items: { type: 'number' }, description: 'Specific PR numbers. If omitted, checks all open PRs.' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          strategy: { type: 'string', enum: ['merge', 'rebase'], description: 'How to update branches (default: merge)' },
        },
        required: ['owner', 'repo'],
      },
      handler: jsonHandler(async ({ prs, owner, repo, strategy }) => {
        const token = await getToken();
        const { runUpdateAllBranches } = await lib('update-branch.mjs');
        return runUpdateAllBranches(REPO_ROOT, { prs, token, owner, repo, strategy });
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
      description: 'Check if an issue qualifies for fast-lane (estimate:S or squad:chore-auto).',
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
      description: 'Sync project board column based on current issue/PR state.',
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
      description: 'Show wave/milestone progress: which waves are complete, releasable, or blocking.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          milestone: { type: 'string', description: 'Specific milestone title (optional)' },
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
      description: 'Release a completed wave: validate all issues closed, run changeset version, close milestone, post summary.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          milestone: { type: 'string', description: 'Milestone title (optional)' },
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
    {
      name: 'squad_workflows_scaffold_release',
      description: 'Scaffold a manually-dispatched GitHub Actions workflow for changeset-based releases.',
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

    // ── Git/GitHub Write Wrappers (bot identity) ────────────────────────────
    {
      name: 'squad_workflows_push',
      description: 'Push (or force-push) a branch to GitHub using bot identity. Uses x-access-token URL so writes are attributed to the bot.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch name to push (e.g., "squad/184-fix-identity")' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          roleSlug: { type: 'string', description: 'Optional role slug for token resolution' },
          cwd: { type: 'string', description: 'Working directory (for worktrees). Defaults to repo root.' },
          force: { type: 'boolean', description: 'Use --force-with-lease for force push' },
        },
        required: ['branch', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ branch, owner, repo, roleSlug, cwd, force }) => {
        const token = await getToken(roleSlug);
        const pushUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
        const args = ['push'];
        if (force) args.push('--force-with-lease');
        args.push(pushUrl, `HEAD:refs/heads/${branch}`);
        await execFileAsync('git', args, {
          cwd: cwd || REPO_ROOT,
          timeout: 60_000,
        });
        return { pushed: branch, repo: `${owner}/${repo}`, force: !!force };
      }),
    },
    {
      name: 'squad_workflows_create_pr',
      description: 'Create a pull request using bot identity. Auto-attests the write. Returns PR number and URL (never the token).',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR title' },
          body: { type: 'string', description: 'PR body (markdown)' },
          head: { type: 'string', description: 'Head branch name' },
          base: { type: 'string', description: 'Base branch (default: dev)' },
          draft: { type: 'boolean', description: 'Create as draft PR (default: true)' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          roleSlug: { type: 'string', description: 'Optional role slug for token resolution' },
        },
        required: ['title', 'body', 'head', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ title, body, head, base, draft, owner, repo, roleSlug }) => {
        const token = await getToken(roleSlug);
        const { ghApi } = await lib('github-api.mjs');
        const pr = await ghApi(`/repos/${owner}/${repo}/pulls`, {
          token,
          method: 'POST',
          body: { title, body, head, base: base || 'dev', draft: draft !== false },
        });

        // Auto-attest the write (best-effort)
        try {
          const attestLib = join(__dirname, '..', 'squad-identity', 'lib', 'attest-write.mjs');
          if (existsSync(attestLib)) {
            const { attestWrite } = await import(attestLib);
            await attestWrite({
              owner, repo,
              writeType: 'pr',
              writeRef: String(pr.number),
              roleSlug: roleSlug || process.env.ROLE_SLUG || 'lead',
              token,
            });
          }
        } catch {
          // Attestation failure should not block PR creation
        }

        return { pr_number: pr.number, url: pr.html_url, author: pr.user?.login, draft: pr.draft };
      }),
    },
    {
      name: 'squad_workflows_close_issue',
      description: 'Close a GitHub issue using bot identity. Optionally posts a comment before closing.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue number' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          roleSlug: { type: 'string', description: 'Optional role slug for token resolution' },
          comment: { type: 'string', description: 'Optional comment to post before closing' },
        },
        required: ['issue', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, owner, repo, roleSlug, comment }) => {
        const token = await getToken(roleSlug);
        const { ghApi, postComment } = await lib('github-api.mjs');
        if (comment) {
          await postComment(owner, repo, issue, comment, token);
        }
        await ghApi(`/repos/${owner}/${repo}/issues/${issue}`, {
          token,
          method: 'PATCH',
          body: { state: 'closed' },
        });
        return { closed: issue, commented: !!comment };
      }),
    },
    {
      name: 'squad_workflows_comment',
      description: 'Post a comment on an issue or PR using bot identity.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue or PR number' },
          body: { type: 'string', description: 'Comment body (markdown)' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          roleSlug: { type: 'string', description: 'Optional role slug for token resolution' },
        },
        required: ['issue', 'body', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, body, owner, repo, roleSlug }) => {
        const token = await getToken(roleSlug);
        const { postComment } = await lib('github-api.mjs');
        const result = await postComment(owner, repo, issue, body, token);
        return { comment_id: result.id, url: result.html_url };
      }),
    },
    {
      name: 'squad_workflows_label',
      description: 'Add or remove labels on an issue/PR using bot identity.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number', description: 'Issue or PR number' },
          add: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Labels to remove' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          roleSlug: { type: 'string', description: 'Optional role slug for token resolution' },
        },
        required: ['issue', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ issue, add, remove, owner, repo, roleSlug }) => {
        const token = await getToken(roleSlug);
        const { addLabels, removeLabel } = await lib('github-api.mjs');
        if (add && add.length > 0) {
          await addLabels(owner, repo, issue, add, token);
        }
        if (remove && remove.length > 0) {
          for (const label of remove) {
            await removeLabel(owner, repo, issue, label, token);
          }
        }
        return { issue, added: add || [], removed: remove || [] };
      }),
    },
  ],
});
