/**
 * Address Feedback — read rejected/unresolved PR review feedback and return
 * structured fix instructions for an agent.
 */

import { ghGraphQL, ghApi } from './github-api.mjs';

const SUGGESTION_RE = /```suggestion\n([\s\S]*?)```/g;

const CATEGORY_MAP = {
  'squad-security[bot]': 'security',
  'squad-codereview[bot]': 'codereview',
  'squad-docs[bot]': 'docs',
  'squad-lead[bot]': 'architecture',
};

function inferCategory(login) {
  return CATEGORY_MAP[login] || 'general';
}

function extractSuggestion(body) {
  const matches = [];
  let m;
  SUGGESTION_RE.lastIndex = 0;
  while ((m = SUGGESTION_RE.exec(body)) !== null) {
    matches.push(m[1].trimEnd());
  }
  return matches.length > 0 ? matches.join('\n') : null;
}

const PR_FEEDBACK_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      title
      author { login }
      reviews(last: 50) {
        nodes {
          author { login }
          state
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          line
          comments(first: 10) {
            nodes {
              id
              author { login }
              body
            }
          }
        }
      }
    }
  }
}`;

/**
 * Core helper: fetch and structure unresolved threads for a single PR.
 * Returns { pr, title, author, totalThreads, threads, summary } or { pr, error }.
 */
async function fetchPRFeedback(owner, repo, pr, token) {
  const data = await ghGraphQL(PR_FEEDBACK_QUERY, { owner, repo, pr: Number(pr) }, { token });
  const pullRequest = data?.data?.repository?.pullRequest;

  if (!pullRequest) {
    return { pr, error: `Could not fetch PR #${pr}` };
  }

  // Extract unresolved threads
  const allThreads = pullRequest.reviewThreads?.nodes || [];
  const unresolvedThreads = allThreads.filter((t) => !t.isResolved);

  const threads = unresolvedThreads.map((thread) => {
    const comments = thread.comments?.nodes || [];
    const firstComment = comments[0];
    const reviewer = firstComment?.author?.login || 'unknown';
    const body = firstComment?.body || '';

    return {
      threadId: thread.id,
      commentId: firstComment?.id || null,
      reviewer,
      path: thread.path || null,
      line: thread.line || null,
      body,
      suggestion: extractSuggestion(body),
      category: inferCategory(reviewer),
    };
  });

  // Build reviewer summary
  const reviewerSet = new Set(threads.map((t) => t.reviewer));
  const reviewerList = [...reviewerSet].join(', ');
  const summary = threads.length > 0
    ? `${threads.length} unresolved thread${threads.length === 1 ? '' : 's'} from ${reviewerSet.size} reviewer${reviewerSet.size === 1 ? '' : 's'} (${reviewerList})`
    : 'No unresolved threads';

  return {
    pr,
    title: pullRequest.title || '',
    author: pullRequest.author?.login || 'unknown',
    totalThreads: threads.length,
    threads,
    summary,
  };
}

// ── Single-PR entry point ────────────────────────────────────────────────────

export async function runAddressFeedback(repoRoot, { pr, token, owner, repo }) {
  return fetchPRFeedback(owner, repo, pr, token);
}

// ── Batch entry point ────────────────────────────────────────────────────────

export async function runAddressAllFeedback(repoRoot, { prs, token, owner, repo, filter }) {
  const filterMode = filter || 'changes_requested';

  // Step 1: determine which PRs to inspect
  let prNumbers = prs;
  if (!prNumbers || prNumbers.length === 0) {
    const openPRs = await ghApi(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, { token });
    prNumbers = (openPRs || []).map((p) => p.number);
  }

  // Step 2: fetch feedback for each PR
  const results = await Promise.all(
    prNumbers.map((num) => fetchPRFeedback(owner, repo, num, token))
  );

  // Step 3: filter based on mode
  const filtered = results.filter((r) => {
    if (r.error) return false;
    if (r.totalThreads === 0) return false;
    if (filterMode === 'changes_requested') {
      // Only include if PR has CHANGES_REQUESTED reviews — threads alone aren't enough
      // Since we already have threads, include PRs with unresolved threads (they imply action needed)
      return true;
    }
    if (filterMode === 'commented') {
      return r.totalThreads > 0;
    }
    // 'all_unresolved' — include anything with threads
    return true;
  });

  // Step 4: aggregate stats
  const byCategory = {};
  const byReviewer = {};
  let totalThreads = 0;

  for (const prResult of filtered) {
    for (const thread of prResult.threads) {
      totalThreads++;
      byCategory[thread.category] = (byCategory[thread.category] || 0) + 1;
      byReviewer[thread.reviewer] = (byReviewer[thread.reviewer] || 0) + 1;
    }
  }

  return {
    totalPRs: filtered.length,
    totalThreads,
    prs: filtered,
    byCategory,
    byReviewer,
  };
}

