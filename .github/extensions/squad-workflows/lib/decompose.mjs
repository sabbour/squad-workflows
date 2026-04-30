/**
 * Decompose — slice a large issue into waves.
 *
 * Creates a GitHub milestone per wave and child issues
 * with demo criteria. Enforces max estimate:M per issue.
 */

import { ensureMilestone, createIssue, addLabels, postComment, getIssue } from './github-api.mjs';
import { loadConfig } from './workflow-config.mjs';

export async function runDecompose(repoRoot, { issue, waves, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const maxEstimate = config.waves.maxIssueEstimate || 'M';
  const prefix = config.waves.milestonePrefix || 'Wave';

  // Validate: no issue exceeds max estimate
  const oversized = [];
  for (const wave of waves) {
    for (const child of wave.issues || []) {
      if (estimateRank(child.estimate) > estimateRank(maxEstimate)) {
        oversized.push({ wave: wave.title, issue: child.title, estimate: child.estimate });
      }
    }
  }

  if (oversized.length > 0) {
    return {
      error: `Issues exceed max estimate (${maxEstimate}). Decompose further.`,
      oversized,
    };
  }

  // Validate: demo criteria required
  if (config.waves.requireDemoCriteria) {
    const missingDemo = waves.filter((w) => !w.demoCriteria?.trim());
    if (missingDemo.length > 0) {
      return {
        error: 'All waves require demo criteria.',
        missingDemo: missingDemo.map((w) => w.title),
      };
    }
  }

  // Get parent issue for context
  const parentIssue = await getIssue(owner, repo, issue, token);

  const results = { parentIssue: issue, waves: [] };

  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    const waveNum = i + 1;
    const milestoneTitle = `${prefix} ${waveNum}: ${wave.title}`;
    const milestoneDesc = `**Demo criteria:** ${wave.demoCriteria}\n\nParent issue: #${issue}`;

    // Create milestone
    const milestoneNumber = await ensureMilestone(owner, repo, milestoneTitle, milestoneDesc, token);

    const waveResult = {
      wave: waveNum,
      title: milestoneTitle,
      milestone: milestoneNumber,
      demoCriteria: wave.demoCriteria,
      issues: [],
    };

    // Create child issues
    for (const child of wave.issues || []) {
      const issueBody = formatChildIssueBody(child, wave, parentIssue, waveNum);
      const labels = [
        `estimate:${child.estimate}`,
        ...(child.labels || []),
      ];

      const created = await createIssue(owner, repo, {
        title: child.title,
        body: issueBody,
        labels,
        milestone: milestoneNumber,
      }, token);

      waveResult.issues.push({
        number: created.number,
        title: child.title,
        estimate: child.estimate,
        url: created.html_url,
      });
    }

    results.waves.push(waveResult);
  }

  // Post summary comment on parent issue
  const summaryComment = formatDecompositionSummary(results);
  await postComment(owner, repo, issue, summaryComment, token);

  // Add decomposed label to parent
  await addLabels(owner, repo, issue, ['decomposed'], token);

  return results;
}

function estimateRank(est) {
  const ranks = { S: 1, M: 2, L: 3, XL: 4 };
  return ranks[est] || 0;
}

function formatChildIssueBody(child, wave, parentIssue, waveNum) {
  const body = child.body || '';
  return `## Context

Part of **Wave ${waveNum}: ${wave.title}** (parent: #${parentIssue.number})

**Demo criteria for this wave:** ${wave.demoCriteria}

## Description

${body || '_To be filled in during Design Proposal._'}

## Acceptance Criteria

${child.acceptanceCriteria || '_To be defined in Design Proposal._'}
`;
}

function formatDecompositionSummary(results) {
  let md = `## 📋 Decomposition Summary\n\n`;
  md += `This issue has been decomposed into **${results.waves.length} waves**:\n\n`;

  for (const wave of results.waves) {
    const totalPoints = wave.issues.reduce((sum, i) => {
      const pts = { S: 1, M: 3, L: 8, XL: 20 };
      return sum + (pts[i.estimate] || 0);
    }, 0);

    md += `### ${wave.title}\n`;
    md += `**Demo criteria:** ${wave.demoCriteria}\n`;
    md += `**Total points:** ${totalPoints}\n\n`;

    for (const issue of wave.issues) {
      md += `- [ ] #${issue.number} — ${issue.title} (${issue.estimate})\n`;
    }
    md += '\n';
  }

  return md;
}
