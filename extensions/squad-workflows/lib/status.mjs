/**
 * Status — show current workflow state for an issue.
 *
 * Determines which phase the issue is in and what's next.
 */

import { getIssue, getIssueLabels } from './github-api.mjs';
import { loadConfig, isFastLane, mustDecompose } from './workflow-config.mjs';

const PHASES = [
  'untriaged',
  'estimated',
  'decomposed',
  'design-proposed',
  'design-approved',
  'in-progress',
  'pr-open',
  'in-review',
  'approved',
  'merged',
];

export async function runStatus(repoRoot, { issue, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const issueData = await getIssue(owner, repo, issue, token);
  const labels = (issueData.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

  const fastLane = isFastLane(config, labels);
  const phase = determinePhase(issueData, labels, config);
  const nextSteps = getNextSteps(phase, labels, config, fastLane, issue);

  // Find associated PR (if any)
  const prRef = issueData.pull_request?.html_url || null;

  // Estimate info
  const estLabel = labels.find((l) => l.startsWith('estimate:'));
  const estimate = estLabel ? estLabel.replace('estimate:', '') : null;

  return {
    issue,
    title: issueData.title,
    state: issueData.state,
    phase,
    phaseIndex: PHASES.indexOf(phase),
    totalPhases: PHASES.length,
    fastLane,
    estimate,
    mustDecompose: estimate ? mustDecompose(config, estimate) : false,
    assignee: issueData.assignee?.login || null,
    milestone: issueData.milestone?.title || null,
    pr: prRef,
    labels,
    nextSteps,
  };
}

function determinePhase(issueData, labels, config) {
  if (issueData.state === 'closed') return 'merged';

  const approvalLabels = config.labels.designApprovals || [];
  const hasAllApprovals = approvalLabels.every((l) => labels.includes(l));

  if (hasAllApprovals && labels.includes('design-proposal')) return 'design-approved';
  if (labels.includes('design-proposal')) return 'design-proposed';
  if (labels.includes('decomposed')) return 'decomposed';
  if (labels.some((l) => l.startsWith('estimate:'))) return 'estimated';
  if (issueData.assignee) return 'untriaged'; // assigned but not estimated

  return 'untriaged';
}

function getNextSteps(phase, labels, config, fastLane, issue) {
  const steps = [];

  switch (phase) {
    case 'untriaged':
      steps.push(`Run \`squad_workflows_estimate\` to estimate issue #${issue}`);
      break;
    case 'estimated': {
      const est = labels.find((l) => l.startsWith('estimate:'))?.replace('estimate:', '');
      if (est && mustDecompose(config, est)) {
        steps.push(`Issue is ${est} — run \`squad_workflows_decompose\` to break into waves`);
      } else if (fastLane) {
        steps.push('Fast-lane eligible — skip to coding');
      } else {
        steps.push(`Run \`squad_workflows_post_design_proposal\` for issue #${issue}`);
      }
      break;
    }
    case 'decomposed':
      if (!fastLane) {
        steps.push('Post design proposals on child issues');
      }
      break;
    case 'design-proposed':
      steps.push(`Waiting for Design Review. Check with \`squad_workflows_check_design_approval --issue ${issue}\``);
      break;
    case 'design-approved':
      steps.push('Design approved — create worktree and start coding');
      steps.push(`git worktree add .worktrees/${issue} -b squad/${issue}-slug origin/${config.branchModel.base}`);
      break;
    case 'in-progress':
      steps.push('Push and create PR: squad_workflows_push then squad_workflows_create_pr --base ' + config.branchModel.base);
      break;
    case 'pr-open':
      steps.push('Dispatch reviews: squad_reviews_dispatch_review');
      break;
    case 'in-review':
      steps.push('Check feedback: squad_workflows_check_feedback');
      steps.push('Check CI: squad_workflows_check_ci');
      break;
    case 'approved':
      steps.push('Run squad_workflows_merge_check, then squad_workflows_merge');
      break;
    case 'merged':
      steps.push('Done! Check wave status: squad_workflows_wave_status');
      break;
  }

  return steps;
}
