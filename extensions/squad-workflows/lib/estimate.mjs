/**
 * Estimate — analyze an issue and auto-apply estimate label.
 *
 * Combines issue description, acceptance criteria, referenced files,
 * and historical patterns to suggest S/M/L/XL.
 */

import { getIssue, getIssueLabels, addLabels, removeLabel } from './github-api.mjs';
import { loadConfig, mustDecompose } from './workflow-config.mjs';

/**
 * Heuristic scoring for issue complexity.
 * Returns { estimate, points, confidence, factors, mustDecompose }.
 */
function analyzeComplexity(issue, config) {
  const body = (issue.body || '').toLowerCase();
  const title = (issue.title || '').toLowerCase();
  const text = `${title}\n${body}`;

  const factors = [];
  let score = 0;

  // Word count as proxy for scope
  const wordCount = (issue.body || '').split(/\s+/).length;
  if (wordCount > 500) {
    score += 3;
    factors.push({ factor: 'Long description', weight: 3, detail: `${wordCount} words` });
  } else if (wordCount > 200) {
    score += 1;
    factors.push({ factor: 'Medium description', weight: 1, detail: `${wordCount} words` });
  }

  // Acceptance criteria count
  const checkboxCount = (issue.body || '').match(/- \[[ x]\]/g)?.length || 0;
  if (checkboxCount > 8) {
    score += 3;
    factors.push({ factor: 'Many acceptance criteria', weight: 3, detail: `${checkboxCount} checkboxes` });
  } else if (checkboxCount > 4) {
    score += 2;
    factors.push({ factor: 'Several acceptance criteria', weight: 2, detail: `${checkboxCount} checkboxes` });
  } else if (checkboxCount > 0) {
    score += 1;
    factors.push({ factor: 'Some acceptance criteria', weight: 1, detail: `${checkboxCount} checkboxes` });
  }

  // File references
  const fileRefs = (issue.body || '').match(/[a-zA-Z0-9_/-]+\.(ts|tsx|js|mjs|json|md|yml|yaml)/g) || [];
  const uniqueFiles = [...new Set(fileRefs)];
  if (uniqueFiles.length > 10) {
    score += 3;
    factors.push({ factor: 'Many files referenced', weight: 3, detail: `${uniqueFiles.length} files` });
  } else if (uniqueFiles.length > 4) {
    score += 2;
    factors.push({ factor: 'Several files referenced', weight: 2, detail: `${uniqueFiles.length} files` });
  } else if (uniqueFiles.length > 0) {
    score += 1;
    factors.push({ factor: 'Some files referenced', weight: 1, detail: `${uniqueFiles.length} files` });
  }

  // Complexity signals in text
  const complexitySignals = [
    { pattern: /migration|schema change|database/g, label: 'Database/migration work', weight: 2 },
    { pattern: /security|auth|token|credential/g, label: 'Security-sensitive', weight: 2 },
    { pattern: /breaking change|backward compat/g, label: 'Breaking change', weight: 3 },
    { pattern: /multi.?package|cross.?cutting|monorepo/g, label: 'Cross-cutting change', weight: 2 },
    { pattern: /new (api|endpoint|route|service)/g, label: 'New API surface', weight: 2 },
    { pattern: /refactor|restructure|rewrite/g, label: 'Refactoring', weight: 1 },
    { pattern: /test|spec/g, label: 'Test work needed', weight: 1 },
  ];

  for (const { pattern, label, weight } of complexitySignals) {
    const matches = text.match(pattern);
    if (matches) {
      score += weight;
      factors.push({ factor: label, weight, detail: `${matches.length} mention(s)` });
    }
  }

  // Multiple packages
  const packageRefs = (issue.body || '').match(/packages\/[a-zA-Z0-9-]+/g) || [];
  const uniquePackages = [...new Set(packageRefs)];
  if (uniquePackages.length > 2) {
    score += 2;
    factors.push({ factor: 'Multi-package change', weight: 2, detail: uniquePackages.join(', ') });
  }

  // Map score to estimate
  let estimate;
  let confidence;
  if (score <= 2) {
    estimate = 'S';
    confidence = score <= 1 ? 'high' : 'medium';
  } else if (score <= 5) {
    estimate = 'M';
    confidence = score <= 4 ? 'high' : 'medium';
  } else if (score <= 9) {
    estimate = 'L';
    confidence = 'medium';
  } else {
    estimate = 'XL';
    confidence = 'medium';
  }

  const estConfig = config.estimates[estimate];

  return {
    estimate,
    points: estConfig.points,
    maxHours: estConfig.maxHours,
    confidence,
    score,
    factors,
    mustDecompose: mustDecompose(config, estimate),
  };
}

export async function runEstimate(repoRoot, { issue, token, owner, repo }) {
  const config = loadConfig(repoRoot);

  // Fetch issue
  const issueData = await getIssue(owner, repo, issue, token);
  const currentLabels = (issueData.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

  // Analyze
  const analysis = analyzeComplexity(issueData, config);

  // Remove any existing estimate labels
  const existingEstimate = currentLabels.find((l) => l.startsWith('estimate:'));
  if (existingEstimate) {
    await removeLabel(owner, repo, issue, existingEstimate, token);
  }

  // Apply new label
  const newLabel = `estimate:${analysis.estimate}`;
  await addLabels(owner, repo, issue, [newLabel], token);

  return {
    issue,
    title: issueData.title,
    estimate: analysis.estimate,
    points: analysis.points,
    maxHours: analysis.maxHours,
    confidence: analysis.confidence,
    mustDecompose: analysis.mustDecompose,
    previousEstimate: existingEstimate || null,
    appliedLabel: newLabel,
    factors: analysis.factors,
    note: analysis.mustDecompose
      ? `⚠️ estimate:${analysis.estimate} requires decomposition into waves (max issue size: ${config.waves.maxIssueEstimate}). Use squad_workflows_decompose.`
      : undefined,
  };
}
