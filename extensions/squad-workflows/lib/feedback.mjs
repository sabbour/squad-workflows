/**
 * Feedback — check unresolved review threads and CI status for a PR.
 */

import { getReviewThreads, getPR, getCheckRuns, getCommitStatus } from './github-api.mjs';

export async function runCheckFeedback(repoRoot, { pr, token, owner, repo }) {
  const threadData = await getReviewThreads(owner, repo, pr, token);
  const threads = threadData?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];

  const unresolved = threads
    .filter((t) => !t.isResolved)
    .map((t) => {
      const comments = t.comments?.nodes || [];
      const firstComment = comments[0];
      return {
        threadId: t.id,
        isOutdated: t.isOutdated,
        author: firstComment?.author?.login || 'unknown',
        body: firstComment?.body?.slice(0, 200) || '',
        commentCount: comments.length,
        lastComment: comments[comments.length - 1]?.author?.login || 'unknown',
      };
    });

  const resolved = threads.filter((t) => t.isResolved).length;

  return {
    pr,
    totalThreads: threads.length,
    resolved,
    unresolved: unresolved.length,
    threads: unresolved,
    readyToMerge: unresolved.length === 0,
    hint: unresolved.length > 0
      ? 'Address each thread: fix → reply → resolve (GraphQL). Use squad_reviews_resolve_thread.'
      : 'All threads resolved ✓',
  };
}

export async function runCheckCi(repoRoot, { pr, token, owner, repo }) {
  const prData = await getPR(owner, repo, pr, token);
  const headSha = prData.head?.sha;

  if (!headSha) {
    return { pr, error: 'Could not determine HEAD SHA' };
  }

  // Get both check runs and commit status
  const [checkRunsData, statusData] = await Promise.all([
    getCheckRuns(owner, repo, headSha, token),
    getCommitStatus(owner, repo, headSha, token),
  ]);

  const checkRuns = (checkRunsData.check_runs || []).map((cr) => ({
    name: cr.name,
    status: cr.status,
    conclusion: cr.conclusion,
    url: cr.html_url,
  }));

  const statuses = (statusData.statuses || []).map((s) => ({
    context: s.context,
    state: s.state,
    description: s.description,
    url: s.target_url,
  }));

  const failedChecks = checkRuns.filter((cr) => cr.conclusion === 'failure');
  const pendingChecks = checkRuns.filter((cr) => cr.status !== 'completed');
  const failedStatuses = statuses.filter((s) => s.state === 'failure' || s.state === 'error');
  const pendingStatuses = statuses.filter((s) => s.state === 'pending');

  const allGreen = failedChecks.length === 0 && failedStatuses.length === 0 && pendingChecks.length === 0 && pendingStatuses.length === 0;

  return {
    pr,
    headSha,
    allGreen,
    summary: {
      checks: { total: checkRuns.length, failed: failedChecks.length, pending: pendingChecks.length },
      statuses: { total: statuses.length, failed: failedStatuses.length, pending: pendingStatuses.length },
    },
    failures: [...failedChecks, ...failedStatuses],
    pending: [...pendingChecks, ...pendingStatuses],
    hint: !allGreen
      ? 'Fix CI failures before requesting merge. Check the URLs above for details.'
      : 'All CI checks green ✓',
  };
}
