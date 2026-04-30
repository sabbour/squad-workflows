/**
 * Update a PR branch to the latest base branch state.
 */

import { ghApi, getPR } from './github-api.mjs';

export async function updateBranch(owner, repo, pr, token) {
  const prData = await getPR(owner, repo, pr, token);
  const baseBranch = prData.base?.ref || 'main';
  const rebaseCommand = `git fetch origin && git rebase origin/${baseBranch} && git push --force-with-lease`;

  try {
    const result = await ghApi(`/repos/${owner}/${repo}/pulls/${pr}/update-branch`, {
      token,
      method: 'PUT',
    });

    return {
      success: true,
      pr,
      baseBranch,
      result,
      message: `Branch updated with latest ${baseBranch} changes.`,
    };
  } catch (err) {
    return {
      success: false,
      pr,
      baseBranch,
      rebaseRequired: true,
      error: `Branch update failed, likely due to conflicts. Rebase locally: ${rebaseCommand}`,
      rebaseCommand,
      details: err.message,
    };
  }
}
