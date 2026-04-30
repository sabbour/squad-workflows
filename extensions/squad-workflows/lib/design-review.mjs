/**
 * Design Review — check if an issue has all required approval labels.
 */

import { getIssueLabels } from './github-api.mjs';
import { loadConfig, isFastLane } from './workflow-config.mjs';

export async function runCheckDesignApproval(repoRoot, { issue, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const issueLabels = await getIssueLabels(owner, repo, issue, token);

  // Check fast-lane
  if (isFastLane(config, issueLabels)) {
    return {
      issue,
      approved: true,
      fastLane: true,
      reason: 'Fast-lane eligible — Design Review skipped.',
      labels: issueLabels,
    };
  }

  // Check required approvals
  const requiredApprovals = config.labels.designApprovals || [];
  const present = requiredApprovals.filter((l) => issueLabels.includes(l));
  const missing = requiredApprovals.filter((l) => !issueLabels.includes(l));

  const approved = missing.length === 0;

  return {
    issue,
    approved,
    fastLane: false,
    approvals: {
      required: requiredApprovals,
      present,
      missing,
    },
    blockers: missing.length > 0
      ? missing.map((l) => {
          const role = l.replace(':approved', '');
          return `Waiting for ${role} approval (${l})`;
        })
      : [],
    labels: issueLabels,
  };
}
