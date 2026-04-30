/**
 * Merge check — holistic pre-merge validation.
 */

import { getPR, getIssueLabels } from './github-api.mjs';
import { loadConfig, getExemptReviews } from './workflow-config.mjs';
import { runCheckFeedback, runCheckCi } from './feedback.mjs';

export async function runMergeCheck(repoRoot, { pr, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const blockers = [];
  const passed = [];

  // Get PR details
  const prData = await getPR(owner, repo, pr, token);

  // 1. Check PR is not draft
  if (prData.draft) {
    blockers.push({ check: 'draft', message: 'PR is still a draft. Run `gh pr ready`.' });
  } else {
    passed.push('Not a draft');
  }

  // 2. Check branch is current (not behind base)
  if (prData.mergeable_state === 'behind') {
    blockers.push({ check: 'branch-current', message: `Branch is behind ${prData.base?.ref}. Run: gh api repos/${owner}/${repo}/pulls/${pr}/update-branch -X PUT` });
  } else if (prData.mergeable_state === 'dirty') {
    blockers.push({ check: 'conflicts', message: 'PR has merge conflicts. Rebase required.' });
  } else {
    passed.push('Branch is current');
  }

  // 3. Check review approvals (via PR reviews, not just issue labels)
  // Self-approvals don't count — the PR author cannot approve their own PR
  const prAuthor = prData.user?.login;
  const reviews = await getPRReviews(owner, repo, pr, token);
  const approvals = reviews.filter((r) => r.state === 'APPROVED' && r.user?.login !== prAuthor);
  const selfApprovals = reviews.filter((r) => r.state === 'APPROVED' && r.user?.login === prAuthor);
  const changesRequested = reviews.filter((r) => r.state === 'CHANGES_REQUESTED');

  if (changesRequested.length > 0) {
    const reviewers = changesRequested.map((r) => r.user?.login).join(', ');
    blockers.push({ check: 'changes-requested', message: `Changes requested by: ${reviewers}` });
  }

  if (selfApprovals.length > 0) {
    passed.push(`${selfApprovals.length} self-approval(s) ignored (author cannot approve own PR)`);
  }

  if (approvals.length === 0) {
    blockers.push({ check: 'no-approvals', message: 'No review approvals yet (self-approvals do not count).' });
  } else {
    passed.push(`${approvals.length} approval(s)`);
  }

  // 4. Check unresolved threads
  const feedback = await runCheckFeedback(repoRoot, { pr, token, owner, repo });
  if (feedback.unresolved > 0) {
    blockers.push({ check: 'unresolved-threads', message: `${feedback.unresolved} unresolved review thread(s)` });
  } else {
    passed.push('All threads resolved');
  }

  // 5. Check CI
  const ci = await runCheckCi(repoRoot, { pr, token, owner, repo });
  if (!ci.allGreen) {
    const failCount = (ci.summary?.checks?.failed || 0) + (ci.summary?.statuses?.failed || 0);
    const pendCount = (ci.summary?.checks?.pending || 0) + (ci.summary?.statuses?.pending || 0);
    if (failCount > 0) {
      blockers.push({ check: 'ci-failures', message: `${failCount} CI check(s) failed` });
    }
    if (pendCount > 0) {
      blockers.push({ check: 'ci-pending', message: `${pendCount} CI check(s) still running` });
    }
  } else {
    passed.push('CI green');
  }

  // 6. Check for changeset (look for .changeset/*.md files in PR diff)
  const files = await getPRFiles(owner, repo, pr, token);
  const filePaths = files.map((f) => f.filename);

  // Check review exemptions (e.g., docs-only PRs skip security review)
  const exemptReviews = getExemptReviews(config, filePaths);

  const hasChangeset = files.some((f) => f.filename.startsWith('.changeset/') && f.filename.endsWith('.md'));
  if (!hasChangeset) {
    // Check if exempt
    const prLabels = (prData.labels || []).map((l) => l.name);
    const isExempt = prLabels.includes('estimate:S') || prLabels.includes('squad:chore-auto');
    if (!isExempt) {
      blockers.push({ check: 'changeset', message: 'No changeset found. Run `npm run changeset` in the worktree.' });
    } else {
      passed.push('Changeset exempt (fast-lane)');
    }
  } else {
    passed.push('Changeset present');
  }

  const canMerge = blockers.length === 0;

  return {
    pr,
    canMerge,
    blockers,
    passed,
    exemptReviews,
    summary: canMerge
      ? '✅ Ready to merge'
      : `❌ ${blockers.length} blocker(s) remaining`,
  };
}

async function getPRReviews(owner, repo, pr, token) {
  const { ghApi } = await import('./github-api.mjs');
  return ghApi(`/repos/${owner}/${repo}/pulls/${pr}/reviews`, { token });
}

async function getPRFiles(owner, repo, pr, token) {
  const { ghApi } = await import('./github-api.mjs');
  return ghApi(`/repos/${owner}/${repo}/pulls/${pr}/files`, { token });
}
