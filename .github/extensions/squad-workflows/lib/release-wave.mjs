/**
 * Release wave — validate wave completeness, aggregate changesets,
 * version packages, close milestone, and post summary.
 */

import { getMilestones, getMilestoneIssues, ghApi, postComment } from './github-api.mjs';
import { loadConfig } from './workflow-config.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export async function runReleaseWave(repoRoot, { milestone, token, owner, repo, dryRun }) {
  const config = loadConfig(repoRoot);
  const prefix = config.waves?.milestonePrefix || 'Wave';

  // ── 1. Find the milestone ───────────────────────────────────────────
  const milestones = await getMilestones(owner, repo, token, 'open');
  const ms = milestones.find((m) =>
    milestone ? m.title === milestone : m.title.startsWith(prefix)
  );

  if (!ms) {
    return {
      released: false,
      reason: milestone
        ? `No open milestone matching "${milestone}"`
        : `No open wave milestones found (prefix: "${prefix}")`,
    };
  }

  // ── 2. Validate completeness ────────────────────────────────────────
  const issues = await getMilestoneIssues(owner, repo, ms.number, token);
  const realIssues = issues.filter((i) => !i.pull_request);
  const openIssues = realIssues.filter((i) => i.state === 'open');

  if (openIssues.length > 0) {
    return {
      released: false,
      reason: `Wave "${ms.title}" has ${openIssues.length} open issue(s)`,
      blockers: openIssues.map((i) => ({
        number: i.number,
        title: i.title,
        assignee: i.assignee?.login || 'unassigned',
      })),
    };
  }

  if (realIssues.length === 0) {
    return {
      released: false,
      reason: `Wave "${ms.title}" has no issues`,
    };
  }

  // ── 3. Check for pending changesets ─────────────────────────────────
  const changesetDir = join(repoRoot, '.changeset');
  let pendingChangesets = [];
  if (existsSync(changesetDir)) {
    const files = await readdir(changesetDir);
    pendingChangesets = files.filter((f) => f.endsWith('.md') && f !== 'README.md');
  }

  // ── 4. Run changeset version (bumps packages + CHANGELOG) ──────────
  let versionResult = null;
  if (pendingChangesets.length > 0 && !dryRun) {
    try {
      const { stdout, stderr } = await execFileAsync('npx', ['changeset', 'version'], {
        cwd: repoRoot,
        timeout: 60_000,
      });
      versionResult = { success: true, output: (stdout + stderr).trim() };
    } catch (err) {
      versionResult = { success: false, error: err.message };
    }
  }

  // ── 5. Close the milestone ──────────────────────────────────────────
  let milestoneClosed = false;
  if (!dryRun) {
    try {
      await ghApi(`/repos/${owner}/${repo}/milestones/${ms.number}`, {
        token,
        method: 'PATCH',
        body: { state: 'closed' },
      });
      milestoneClosed = true;
    } catch (err) {
      milestoneClosed = false;
    }
  }

  // ── 6. Build wave summary ───────────────────────────────────────────
  const closedIssues = realIssues.filter((i) => i.state === 'closed');
  const demoCriteria = ms.description?.match(/\*\*Demo criteria:\*\*\s*(.+)/)?.[1] || null;

  const totalPoints = closedIssues.reduce((sum, i) => sum + issuePoints(i), 0);

  const summary = {
    wave: ms.title,
    milestone: ms.number,
    demoCriteria,
    issuesClosed: closedIssues.length,
    totalPoints,
    issues: closedIssues.map((i) => ({
      number: i.number,
      title: i.title,
      estimate: getEstimate(i),
    })),
  };

  // ── 7. Post summary comment on parent issue (if linked) ────────────
  // Look for a parent issue reference in the milestone description
  const parentMatch = ms.description?.match(/#(\d+)/);
  if (parentMatch && !dryRun) {
    const parentIssue = parseInt(parentMatch[1], 10);
    const summaryBody = buildSummaryComment(summary, milestoneClosed);
    try {
      await postComment(owner, repo, parentIssue, summaryBody, token);
    } catch {
      // Non-critical — parent issue may not exist
    }
  }

  return {
    released: true,
    dryRun: !!dryRun,
    ...summary,
    milestoneClosed,
    pendingChangesets: pendingChangesets.length,
    versionResult,
    nextStep: versionResult?.success
      ? 'Commit version bumps, then push to trigger release pipeline.'
      : pendingChangesets.length > 0
        ? 'Run `npx changeset version` to bump packages, then commit and push.'
        : 'No pending changesets — add changesets to PRs in future waves.',
  };
}

function buildSummaryComment(summary, milestoneClosed) {
  const issueList = summary.issues
    .map((i) => `- #${i.number} — ${i.title} (${i.estimate || '?'})`)
    .join('\n');

  return [
    `### 🚀 Wave Complete: ${summary.wave}`,
    '',
    summary.demoCriteria ? `**Demo criteria:** ${summary.demoCriteria}` : '',
    '',
    `**Issues:** ${summary.issuesClosed} closed (${summary.totalPoints} points)`,
    '',
    issueList,
    '',
    milestoneClosed ? '✅ Milestone closed.' : '⚠️ Milestone still open (close manually or re-run).',
    '',
    '> Ready for changeset version + release.',
  ].filter(Boolean).join('\n');
}

function issuePoints(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const estLabel = labels.find((l) => l.startsWith('estimate:'));
  if (!estLabel) return 0;
  const pts = { S: 1, M: 3, L: 8, XL: 20 };
  return pts[estLabel.replace('estimate:', '')] || 0;
}

function getEstimate(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const estLabel = labels.find((l) => l.startsWith('estimate:'));
  return estLabel ? estLabel.replace('estimate:', '') : null;
}
