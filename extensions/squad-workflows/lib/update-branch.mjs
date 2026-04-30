/**
 * Update Branch — check if PR branches are behind base and update them.
 */

import { ghApi } from './github-api.mjs';

/**
 * Core helper: check and update a single PR branch.
 */
async function updatePRBranch(owner, repo, pr, strategy, token) {
  // Fetch PR merge state
  const prData = await ghApi(`/repos/${owner}/${repo}/pulls/${pr}`, { token });

  if (!prData || prData.message) {
    return { pr, status: 'error', message: prData?.message || `Could not fetch PR #${pr}` };
  }

  const baseRef = prData.base?.ref || 'unknown';
  const headRef = prData.head?.ref || 'unknown';
  const mergeable = prData.mergeable;
  const mergeableState = prData.mergeable_state;

  // Check if already up to date
  if (mergeableState === 'clean' || mergeableState === 'has_hooks' || mergeableState === 'unstable') {
    if (mergeable === true) {
      return { pr, status: 'up_to_date', message: 'Branch is already current with base.' };
    }
  }

  // If mergeable is null, GitHub is still computing — treat as needs check
  if (mergeable === false) {
    return {
      pr,
      status: 'conflict',
      message: 'Cannot auto-update — merge conflicts require manual resolution.',
      baseRef,
      headRef,
    };
  }

  // Attempt to update the branch
  const updateMethod = strategy === 'rebase' ? 'rebase' : 'merge';

  try {
    const result = await ghApi(`/repos/${owner}/${repo}/pulls/${pr}/update-branch`, {
      token,
      method: 'PUT',
      body: { update_method: updateMethod },
    });

    if (result?.message && /conflict/i.test(result.message)) {
      return {
        pr,
        status: 'conflict',
        message: 'Cannot auto-update — merge conflicts require manual resolution.',
        baseRef,
        headRef,
      };
    }

    return {
      pr,
      status: 'updated',
      strategy: updateMethod,
      message: 'Branch updated with base branch changes.',
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/conflict/i.test(errMsg) || /merge/i.test(errMsg)) {
      return {
        pr,
        status: 'conflict',
        message: 'Cannot auto-update — merge conflicts require manual resolution.',
        baseRef,
        headRef,
      };
    }
    return { pr, status: 'error', message: errMsg };
  }
}

// ── Single-PR entry point ────────────────────────────────────────────────────

export async function runUpdateBranch(repoRoot, { pr, token, owner, repo, strategy }) {
  return updatePRBranch(owner, repo, pr, strategy || 'merge', token);
}

// ── Batch entry point ────────────────────────────────────────────────────────

export async function runUpdateAllBranches(repoRoot, { prs, token, owner, repo, strategy }) {
  const strat = strategy || 'merge';

  // Determine which PRs to check
  let prNumbers = prs;
  if (!prNumbers || prNumbers.length === 0) {
    const openPRs = await ghApi(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, { token });
    prNumbers = (openPRs || []).map((p) => p.number);
  }

  // Process each PR (sequential to avoid rate-limiting on write operations)
  const results = [];
  for (const num of prNumbers) {
    const result = await updatePRBranch(owner, repo, num, strat, token);
    results.push(result);
  }

  const upToDate = results.filter((r) => r.status === 'up_to_date').length;
  const updated = results.filter((r) => r.status === 'updated').length;
  const conflicted = results.filter((r) => r.status === 'conflict').length;

  return {
    total: prNumbers.length,
    upToDate,
    updated,
    conflicted,
    results,
  };
}
