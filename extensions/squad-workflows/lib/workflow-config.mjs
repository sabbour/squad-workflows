/**
 * Workflow configuration loader.
 *
 * Reads .squad/workflows/config.json with sensible defaults.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  branchModel: { base: 'dev', release: 'main' },
  estimates: {
    S: { points: 1, maxHours: 2 },
    M: { points: 3, maxHours: 8 },
    L: { points: 8, maxHours: 24, mustDecompose: true },
    XL: { points: 20, maxHours: 80, mustDecompose: true },
  },
  designProposal: {
    requiredSections: ['problem', 'approach', 'subtasks', 'files', 'security', 'docs', 'alternatives'],
    fastLaneLabels: ['estimate:S', 'squad:chore-auto'],
  },
  approvalFallback: {
    // When PR author matches a role that owns a required approval,
    // these roles can review and apply the label on their behalf.
    // Order matters — first available reviewer is preferred.
    'docs:approved': ['architecture', 'lead', 'codereview'],
    'architecture:approved': ['lead', 'codereview'],
    'security:approved': ['architecture', 'lead'],
    'codereview:approved': ['architecture', 'lead'],
  },
  fastLaneScope: ['changeset', 'design-proposal'],
  waves: {
    milestonePrefix: 'Wave',
    requireDemoCriteria: true,
    maxIssueEstimate: 'M',
  },
  labels: {
    estimates: ['estimate:S', 'estimate:M', 'estimate:L', 'estimate:XL'],
    fastLane: ['estimate:S', 'squad:chore-auto'],
    designApprovals: ['architecture:approved', 'security:approved', 'codereview:approved', 'docs:approved'],
    reviewSignals: ['docs:not-applicable', 'docs:rejected'],
    types: ['type:feature', 'type:bug', 'type:spike', 'type:docs', 'type:chore', 'type:epic'],
    priorities: ['priority:p0', 'priority:p1', 'priority:p2'],
  },
  reviewExemptions: {
    docsOnly: {
      paths: ['docs/**', 'docs-site/**', '**/*.md', '**/*.mdx', '.squad/**', '.changeset/**'],
      skipReviews: ['security:approved', 'architecture:approved', 'docs:approved'],
    },
  },
  board: {
    columns: ['Backlog', 'Assigned', 'In Progress', 'In Review', 'Approved', 'Merged'],
  },
};

/**
 * Load workflow config, merging with defaults.
 * @param {string} repoRoot - Repository root path
 * @returns {object} Merged config
 */
export function loadConfig(repoRoot) {
  const configPath = join(repoRoot, '.squad', 'workflows', 'config.json');

  if (!existsSync(configPath)) {
    return { ...DEFAULTS, _source: 'defaults' };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const user = JSON.parse(raw);
    return deepMerge(DEFAULTS, user);
  } catch (err) {
    throw new Error(`Invalid workflow config at ${configPath}: ${err.message}`);
  }
}

/**
 * Check if config file exists.
 */
export function configExists(repoRoot) {
  return existsSync(join(repoRoot, '.squad', 'workflows', 'config.json'));
}

/**
 * Get the config file path.
 */
export function configPath(repoRoot) {
  return join(repoRoot, '.squad', 'workflows', 'config.json');
}

/**
 * Get the template config as a string.
 */
export function getTemplate() {
  return JSON.stringify(DEFAULTS, null, 2);
}

/**
 * Check if an estimate requires decomposition.
 */
export function mustDecompose(config, estimate) {
  const est = config.estimates?.[estimate];
  return est?.mustDecompose === true;
}

/**
 * Check if an issue is fast-lane eligible based on labels.
 */
export function isFastLane(config, issueLabels) {
  const fastLaneLabels = config.designProposal?.fastLaneLabels || [];
  return issueLabels.some((l) => fastLaneLabels.includes(l));
}

/**
 * Get reviews that can be skipped based on changed file paths.
 * Returns an array of approval labels that are exempt (e.g., ['security:approved']).
 */
export function getExemptReviews(config, changedPaths) {
  const exemptions = config.reviewExemptions || {};
  const exempt = new Set();

  for (const [, rule] of Object.entries(exemptions)) {
    const patterns = rule.paths || [];
    if (patterns.length === 0) continue;

    // Check if ALL changed files match at least one exemption pattern
    const allMatch = changedPaths.every((filePath) =>
      patterns.some((pattern) => matchGlob(filePath, pattern))
    );

    if (allMatch && changedPaths.length > 0) {
      for (const skip of rule.skipReviews || []) {
        exempt.add(skip);
      }
    }
  }

  return [...exempt];
}

/**
 * Simple glob matching (supports ** and * wildcards).
 * Escape regex metacharacters by splitting on wildcards so that literal
 * segments are escaped before being joined with their regex equivalents.
 */
export function matchGlob(filePath, pattern) {
  const escaped = pattern
    .split('**')
    .map(seg =>
      seg
        .split('*')
        .map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')
    )
    .join('.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
