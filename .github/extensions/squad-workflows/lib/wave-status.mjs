/**
 * Wave status — show milestone/wave progress and releasability.
 */

import { getMilestones, getMilestoneIssues } from './github-api.mjs';
import { loadConfig } from './workflow-config.mjs';

export async function runWaveStatus(repoRoot, { milestone, token, owner, repo }) {
  const config = loadConfig(repoRoot);
  const prefix = config.waves?.milestonePrefix || 'Wave';

  const milestones = await getMilestones(owner, repo, token, 'all');

  // Filter to wave milestones (or specific one)
  let waveMilestones = milestones.filter((m) =>
    milestone ? m.title === milestone : m.title.startsWith(prefix)
  );

  if (waveMilestones.length === 0) {
    return {
      waves: [],
      message: milestone
        ? `No milestone found matching "${milestone}"`
        : `No wave milestones found (prefix: "${prefix}")`,
    };
  }

  // Sort by number (creation order)
  waveMilestones.sort((a, b) => a.number - b.number);

  const waves = [];
  let firstIncomplete = null;

  for (const ms of waveMilestones) {
    const issues = await getMilestoneIssues(owner, repo, ms.number, token);

    const openIssues = issues.filter((i) => i.state === 'open' && !i.pull_request);
    const closedIssues = issues.filter((i) => i.state === 'closed' && !i.pull_request);
    const totalIssues = issues.filter((i) => !i.pull_request);

    // Calculate points
    const totalPoints = totalIssues.reduce((sum, i) => sum + issuePoints(i), 0);
    const completedPoints = closedIssues.reduce((sum, i) => sum + issuePoints(i), 0);

    const complete = openIssues.length === 0 && totalIssues.length > 0;
    const releasable = complete && ms.state === 'open';

    if (!complete && !firstIncomplete) {
      firstIncomplete = ms.title;
    }

    waves.push({
      title: ms.title,
      milestone: ms.number,
      state: ms.state,
      complete,
      releasable,
      progress: {
        issues: `${closedIssues.length}/${totalIssues.length}`,
        points: `${completedPoints}/${totalPoints}`,
        percent: totalIssues.length > 0 ? Math.round((closedIssues.length / totalIssues.length) * 100) : 0,
      },
      openIssues: openIssues.length,
      demoCriteria: ms.description?.match(/\*\*Demo criteria:\*\*\s*(.+)/)?.[1] || null,
      blockers: openIssues.map((i) => ({
        number: i.number,
        title: i.title,
        assignee: i.assignee?.login || 'unassigned',
        labels: (i.labels || []).map((l) => l.name),
      })),
    });
  }

  const completedWaves = waves.filter((w) => w.complete).length;
  const releasableWaves = waves.filter((w) => w.releasable);

  return {
    totalWaves: waves.length,
    completedWaves,
    currentWave: firstIncomplete || (completedWaves === waves.length ? 'All complete' : null),
    releasable: releasableWaves.map((w) => w.title),
    waves,
    hint: releasableWaves.length > 0
      ? `🚀 ${releasableWaves.length} wave(s) ready to release: ${releasableWaves.map(w => w.title).join(', ')}`
      : undefined,
  };
}

function issuePoints(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const estLabel = labels.find((l) => l.startsWith('estimate:'));
  if (!estLabel) return 0;
  const est = estLabel.replace('estimate:', '');
  const pts = { S: 1, M: 3, L: 8, XL: 20 };
  return pts[est] || 0;
}
