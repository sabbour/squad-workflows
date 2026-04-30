/**
 * Fast lane — check if an issue qualifies for ceremony bypass.
 */

import { getIssueLabels } from './github-api.mjs';
import { loadConfig, isFastLane } from './workflow-config.mjs';

export async function runFastLane(repoRoot, { issue, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const labels = await getIssueLabels(owner, repo, issue, token);
  const eligible = isFastLane(config, labels);
  const matchingLabels = labels.filter((l) => config.designProposal.fastLaneLabels.includes(l));

  return {
    issue,
    eligible,
    matchingLabels,
    skippedCeremonies: eligible
      ? ['Design Proposal', 'Design Review']
      : [],
    requiredCeremonies: eligible
      ? ['PR Review Gate']
      : ['Design Proposal', 'Design Review', 'PR Review Gate'],
    labels,
  };
}
