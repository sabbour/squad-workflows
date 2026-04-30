/**
 * Merge — squash merge + cleanup + wave completion check.
 */

import { mergePR, getPR, ghApi } from './github-api.mjs';
import { runMergeCheck } from './merge-check.mjs';
import { runWaveStatus } from './wave-status.mjs';

export async function runMerge(repoRoot, { pr, token, owner, repo }) {
  // Run pre-merge check first
  const check = await runMergeCheck(repoRoot, { pr, token, owner, repo });

  if (!check.canMerge) {
    return {
      merged: false,
      reason: 'Pre-merge checks failed',
      blockers: check.blockers,
    };
  }

  // Get PR for title
  const prData = await getPR(owner, repo, pr, token);
  const commitTitle = `${prData.title} (#${pr})`;

  // Merge
  try {
    await mergePR(owner, repo, pr, commitTitle, token);
  } catch (err) {
    return {
      merged: false,
      reason: `Merge failed: ${err.message}`,
    };
  }

  // Delete branch
  const branchRef = prData.head?.ref;
  if (branchRef) {
    try {
      await ghApi(`/repos/${owner}/${repo}/git/refs/heads/${branchRef}`, {
        token,
        method: 'DELETE',
      });
    } catch {
      // Branch may already be deleted by GitHub
    }
  }

  // Check wave status — is this the last issue in a wave?
  let waveCompletion = null;
  const milestone = prData.milestone;
  if (milestone) {
    try {
      const waveStatus = await runWaveStatus(repoRoot, {
        milestone: milestone.title,
        token, owner, repo,
      });
      const wave = waveStatus.waves?.[0];
      if (wave && wave.openIssues === 0) {
        waveCompletion = {
          milestone: milestone.title,
          complete: true,
          message: `🎉 Wave complete: ${milestone.title}. Ready for changeset + release.`,
        };
      }
    } catch {
      // Non-critical
    }
  }

  return {
    merged: true,
    pr,
    commitTitle,
    branchDeleted: branchRef || null,
    waveCompletion,
  };
}
