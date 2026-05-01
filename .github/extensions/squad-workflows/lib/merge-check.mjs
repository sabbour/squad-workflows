/**
 * Merge check — holistic pre-merge validation.
 */

import { getPR } from './github-api.mjs';
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
    blockers.push({
      check: 'branch-current',
      message: `Branch is behind ${prData.base?.ref}. Must update before merge.`,
      remediation: {
        command: `gh api repos/${owner}/${repo}/pulls/${pr}/update-branch -X PUT`,
        autoFix: true,
        description: 'Update branch to include latest base branch changes',
      },
    });
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

  const files = await getPRFiles(owner, repo, pr, token);
  const filePaths = files.map((f) => f.filename);

  const prLabels = (prData.labels || []).map((l) => l.name);
  const labelSet = new Set(prLabels);
  const docsOnly = isDocsOnlyPr(filePaths);
  const sensitive = hasSensitivePaths(filePaths);
  const architectureLabeled = labelSet.has('architecture');

  // Check review exemptions (e.g., docs-only PRs skip security/docs/architecture review)
  const exemptReviews = docsOnly && !sensitive && !architectureLabeled
    ? ['security:approved', 'architecture:approved', 'docs:approved']
    : getExemptReviews(config, filePaths);
  const fastLaneLabels = config.designProposal?.fastLaneLabels || [];
  const fastLaneScope = config.fastLaneScope || [];
  const fastLaneActive = prLabels.some((label) => fastLaneLabels.includes(label));
  const roleOwnership = config.approvalFallback
    ? Object.keys(config.approvalFallback).reduce((map, label) => {
        map[label] = label.split(':')[0];
        return map;
      }, {})
    : {};
  const selfApprovalBlocks = Object.entries(roleOwnership)
    .filter(([, role]) => matchesRoleLogin(prAuthor, role))
    .map(([label]) => ({
      label,
      blockedAuthor: prAuthor,
      fallbackReviewers: config.approvalFallback?.[label] || [],
    }));

  // 6. Review approval gates.
  // squad:chore-auto and other fast-lane labels can only relax checks listed in
  // config.fastLaneScope. They NEVER bypass architecture/security/docs/codereview
  // approval gates, even when the PR is otherwise fast-lane eligible.
  const codeReviewApproved = labelSet.has('codereview:approved');
  const archApproved = labelSet.has('architecture:approved');
  const secApproved = labelSet.has('security:approved');
  const docsApproved = labelSet.has('docs:approved');
  const docsNotApplicable = labelSet.has('docs:not-applicable');
  const docsRejected = labelSet.has('docs:rejected');
  const architectureRequired = architectureLabeled;
  const securityRequired = !docsOnly || sensitive || architectureLabeled;
  const securityExempt = exemptReviews.includes('security:approved');
  const architectureExempt = exemptReviews.includes('architecture:approved');
  const docsSignalExempt = exemptReviews.includes('docs:approved');

  if (prLabels.includes('squad:chore-auto')) {
    const scopeSummary = fastLaneScope.length > 0 ? fastLaneScope.join(', ') : 'no checks';
    passed.push(`squad:chore-auto fast-lane scope: ${scopeSummary}; review approvals still required`);
  } else if (fastLaneActive && fastLaneScope.length > 0) {
    passed.push(`Fast-lane scope limited to: ${fastLaneScope.join(', ')}; review approvals still required`);
  }

  if (!codeReviewApproved) {
    blockers.push({ check: 'codereview-approval', message: 'Missing codereview:approved label. Code review required.' });
  } else {
    passed.push('Code review approved');
  }

  if (architectureRequired && !archApproved && !architectureExempt) {
    blockers.push({ check: 'architecture-approval', message: 'Missing architecture:approved label. Architecture review required.' });
  } else if (architectureExempt || !architectureRequired) {
    passed.push('Architecture review exempt');
  } else {
    passed.push('Architecture approved');
  }

  if (securityRequired && !secApproved && !securityExempt) {
    blockers.push({ check: 'security-approval', message: 'Missing security:approved label. Security review required.' });
  } else if (securityExempt || !securityRequired) {
    passed.push('Security review exempt');
  } else {
    passed.push('Security approved');
  }

  if (docsRejected) {
    blockers.push({ check: 'docs-rejected', message: 'docs:rejected is present. Docs reviewer rejection blocks merge.' });
  } else if (docsSignalExempt) {
    passed.push('Docs signal exempt (docs-only)');
  } else if (!docsApproved && !docsNotApplicable) {
    blockers.push({ check: 'docs-signal', message: 'Missing docs-impact signal. Add docs:approved or docs:not-applicable.' });
  } else {
    passed.push(docsApproved ? 'Docs approved' : 'Docs marked not applicable');
  }

  // 7. Check for changeset (look for .changeset/*.md files in PR diff)
  const hasChangeset = files.some((f) => f.filename.startsWith('.changeset/') && f.filename.endsWith('.md'));
  const canSkipChangeset = docsOnly || (
    fastLaneScope.includes('changeset') &&
    (prLabels.includes('estimate:S') || prLabels.includes('squad:chore-auto'))
  );
  if (!hasChangeset) {
    if (!canSkipChangeset) {
      blockers.push({ check: 'changeset', message: 'No changeset found. Run `npm run changeset` in the worktree.' });
    } else {
      passed.push(docsOnly ? 'Changeset exempt (docs-only)' : 'Changeset exempt (fast-lane scope)');
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
    selfApprovalBlocks,
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

function matchesRoleLogin(login, role) {
  return typeof login === 'string' && typeof role === 'string'
    ? login.toLowerCase().includes(role.toLowerCase())
    : false;
}

const DOCS_LIKE_RE = /(\.mdx?$)|^docs\/|^docs-site\/|^\.squad\/|^\.changeset\//i;
const SENSITIVE_RE_LIST = [
  /^\.github\/workflows\//i,
  /(^|[\/._-])(auth|guardrail|guardrails|security)([\/._-]|$)/i,
];

function isDocsOnlyPr(paths) {
  return paths.length > 0 && paths.every((path) => DOCS_LIKE_RE.test(path));
}

function hasSensitivePaths(paths) {
  return paths.some((path) => SENSITIVE_RE_LIST.some((pattern) => pattern.test(path)));
}
