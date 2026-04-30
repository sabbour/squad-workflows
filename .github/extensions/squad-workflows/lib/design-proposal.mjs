/**
 * Design Proposal — post a DP comment on an issue.
 *
 * Validates completeness and includes subtasks grouped by wave.
 */

import { postComment, addLabels, getIssue } from './github-api.mjs';
import { loadConfig } from './workflow-config.mjs';

export async function runPostDesignProposal(repoRoot, { issue, proposal, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const required = config.designProposal?.requiredSections || [];

  // Validate completeness
  const missing = required.filter((section) => {
    const value = proposal[section];
    return !value || (typeof value === 'string' && value.trim().length === 0);
  });

  if (missing.length > 0) {
    return {
      error: 'Design Proposal is incomplete.',
      missingSections: missing,
      hint: `Required sections: ${required.join(', ')}`,
    };
  }

  // Format the DP comment
  const dpBody = formatDesignProposal(proposal, issue);

  // Post the comment
  const comment = await postComment(owner, repo, issue, dpBody, token);

  // Add label to indicate DP posted
  await addLabels(owner, repo, issue, ['design-proposal'], token);

  return {
    issue,
    commentId: comment.id,
    commentUrl: comment.html_url,
    status: 'posted',
    sections: required.length,
    label: 'design-proposal',
  };
}

function formatDesignProposal(proposal, issueNumber) {
  return `## 📐 Design Proposal

> For issue #${issueNumber}

### Problem Statement
${proposal.problem}

### Estimate
\`${proposal.estimate}\`

### Proposed Approach
${proposal.approach}

### Subtasks
${proposal.subtasks}

### Files to Modify
${proposal.files}

### Security Considerations
${proposal.security}

### Documentation Plan
${proposal.docs}

### Alternatives Considered
${proposal.alternatives}

---
_Posted by squad-workflows. Review required before implementation._`;
}
