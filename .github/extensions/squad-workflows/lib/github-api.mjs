/**
 * Shared GitHub API helpers for squad-workflows.
 *
 * All calls use token-per-call pattern (no exported/persisted tokens).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run gh with stdin input via spawn (needed for --input -).
 */
function spawnGh(args, { env, cwd, input, timeout = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed: gh ${args.join(' ')}\n${stderr}`));
      } else {
        resolve({ stdout });
      }
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/**
 * Call the GitHub REST API via `gh api`.
 * @param {string} endpoint - API path (e.g., /repos/{owner}/{repo}/issues/42)
 * @param {object} opts
 * @param {string} opts.token - GitHub token
 * @param {string} [opts.method] - HTTP method (default: GET)
 * @param {object} [opts.body] - Request body (for POST/PUT/PATCH)
 * @param {string[]} [opts.fields] - gh api -f field=value pairs
 * @param {string} [opts.cwd] - working directory
 */
export async function ghApi(endpoint, { token, method, body, fields, cwd } = {}) {
  const args = ['api', endpoint];

  // --paginate is only valid for GET requests
  if (!method || method === 'GET') args.push('--paginate');

  if (method) args.push('-X', method);

  if (body) {
    args.push('--input', '-');
  }

  if (fields) {
    for (const f of fields) {
      args.push('-f', f);
    }
  }

  const env = { ...process.env, GH_TOKEN: token };
  const input = body ? JSON.stringify(body) : undefined;

  let stdout;
  if (body) {
    // Use spawn to pipe stdin for request body
    ({ stdout } = await spawnGh(args, { env, cwd, input, timeout: 30_000 }));
  } else {
    ({ stdout } = await execFileAsync('gh', args, {
      env,
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    }));
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return stdout.trim();
  }
}

/**
 * Call the GitHub GraphQL API via `gh api graphql`.
 */
export async function ghGraphQL(query, variables, { token, cwd } = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];

  for (const [key, val] of Object.entries(variables || {})) {
    if (typeof val === 'string') {
      args.push('-f', `${key}=${val}`);
    } else {
      args.push('-F', `${key}=${JSON.stringify(val)}`);
    }
  }

  const env = { ...process.env, GH_TOKEN: token };

  const { stdout } = await execFileAsync('gh', args, {
    env,
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  return JSON.parse(stdout);
}

/**
 * Get an issue with labels.
 */
export async function getIssue(owner, repo, issue, token) {
  return ghApi(`/repos/${owner}/${repo}/issues/${issue}`, { token });
}

/**
 * Get labels on an issue.
 */
export async function getIssueLabels(owner, repo, issue, token) {
  const data = await getIssue(owner, repo, issue, token);
  return (data.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

/**
 * Add labels to an issue.
 */
export async function addLabels(owner, repo, issue, labels, token) {
  return ghApi(`/repos/${owner}/${repo}/issues/${issue}/labels`, {
    token,
    method: 'POST',
    body: { labels },
  });
}

/**
 * Remove a label from an issue.
 */
export async function removeLabel(owner, repo, issue, label, token) {
  try {
    return await ghApi(`/repos/${owner}/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`, {
      token,
      method: 'DELETE',
    });
  } catch {
    // Label not present — ignore
  }
}

/**
 * Post a comment on an issue.
 */
export async function postComment(owner, repo, issue, body, token) {
  return ghApi(`/repos/${owner}/${repo}/issues/${issue}/comments`, {
    token,
    method: 'POST',
    body: { body },
  });
}

/**
 * Create a label if it doesn't exist.
 */
export async function ensureLabel(owner, repo, name, color, description, token) {
  try {
    await ghApi(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, { token });
  } catch {
    await ghApi(`/repos/${owner}/${repo}/labels`, {
      token,
      method: 'POST',
      body: { name, color, description },
    });
  }
}

/**
 * Create a milestone if it doesn't exist. Returns milestone number.
 */
export async function ensureMilestone(owner, repo, title, description, token) {
  const milestones = await ghApi(`/repos/${owner}/${repo}/milestones?state=open&per_page=100`, { token });
  const existing = milestones.find((m) => m.title === title);
  if (existing) return existing.number;

  const created = await ghApi(`/repos/${owner}/${repo}/milestones`, {
    token,
    method: 'POST',
    body: { title, description },
  });
  return created.number;
}

/**
 * Create an issue. Returns the created issue.
 */
export async function createIssue(owner, repo, { title, body, labels, milestone, assignees }, token) {
  return ghApi(`/repos/${owner}/${repo}/issues`, {
    token,
    method: 'POST',
    body: { title, body, labels, milestone, assignees },
  });
}

/**
 * Get PR details.
 */
export async function getPR(owner, repo, pr, token) {
  return ghApi(`/repos/${owner}/${repo}/pulls/${pr}`, { token });
}

/**
 * Get combined commit status for a ref.
 */
export async function getCommitStatus(owner, repo, ref, token) {
  return ghApi(`/repos/${owner}/${repo}/commits/${ref}/status`, { token });
}

/**
 * Get check runs for a ref.
 */
export async function getCheckRuns(owner, repo, ref, token) {
  return ghApi(`/repos/${owner}/${repo}/commits/${ref}/check-runs`, { token });
}

/**
 * List review threads for a PR via GraphQL.
 */
export async function getReviewThreads(owner, repo, pr, token) {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first: 10) {
              nodes {
                id
                body
                author { login }
                createdAt
              }
            }
          }
        }
      }
    }
  }`;

  return ghGraphQL(query, { owner, repo, pr: String(pr) }, { token });
}

/**
 * Get milestones for a repo.
 */
export async function getMilestones(owner, repo, token, state = 'open') {
  return ghApi(`/repos/${owner}/${repo}/milestones?state=${state}&per_page=100&sort=due_on&direction=asc`, { token });
}

/**
 * Get issues for a milestone.
 */
export async function getMilestoneIssues(owner, repo, milestoneNumber, token) {
  return ghApi(`/repos/${owner}/${repo}/issues?milestone=${milestoneNumber}&state=all&per_page=100`, { token });
}

/**
 * Merge a PR via squash.
 */
export async function mergePR(owner, repo, pr, commitTitle, token) {
  return ghApi(`/repos/${owner}/${repo}/pulls/${pr}/merge`, {
    token,
    method: 'PUT',
    body: { merge_method: 'squash', commit_title: commitTitle },
  });
}
