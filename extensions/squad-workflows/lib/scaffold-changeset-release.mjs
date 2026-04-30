/**
 * Scaffold the squad-changeset-release workflow into .github/workflows/.
 *
 * This is a manually-dispatched workflow that runs `changeset version`
 * and `changeset publish` on demand — complementing the upstream Squad
 * release workflow (which is tag-based).
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './workflow-config.mjs';

const WORKFLOW_NAME = 'squad-changeset-release.yml';

/**
 * Generate and write the changeset release workflow.
 * @param {string} repoRoot
 * @param {{ dryRun?: boolean, force?: boolean }} opts
 * @returns {{ path: string, status: string, content?: string }}
 */
export function scaffoldChangesetRelease(repoRoot, { dryRun = false, force = false } = {}) {
  const config = loadConfig(repoRoot);
  const workflowDir = join(repoRoot, '.github', 'workflows');
  const filePath = join(workflowDir, WORKFLOW_NAME);
  const exists = existsSync(filePath);

  if (exists && !force) {
    return { path: `.github/workflows/${WORKFLOW_NAME}`, status: 'skipped (exists, use --force)' };
  }

  const releaseBranch = config.branchModel?.release || 'main';
  const content = generateWorkflow(releaseBranch);

  if (dryRun) {
    return { path: `.github/workflows/${WORKFLOW_NAME}`, status: 'would write', content };
  }

  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(filePath, content);
  return { path: `.github/workflows/${WORKFLOW_NAME}`, status: exists ? 'updated' : 'created' };
}

function generateWorkflow(releaseBranch) {
  return `# Squad Changeset Release — manually-dispatched
# Runs changeset version + publish on demand. Complement to the upstream
# tag-based Squad release workflow.
#
# Dispatched by: squad_workflows_release_wave tool or manual workflow_dispatch.
name: Squad Changeset Release

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Dry run — version and log what would publish, but don't push or publish"
        required: false
        default: "false"
        type: choice
        options: ["false", "true"]

permissions:
  contents: write
  pull-requests: write
  id-token: write
  packages: write

concurrency:
  group: changeset-release
  cancel-in-progress: false

jobs:
  release:
    name: Changeset Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org

      - run: npm ci

      - run: npm test

      # Version packages (bumps package.json, writes CHANGELOG entries)
      - name: Changeset version
        id: version
        run: |
          npx changeset version
          VERSION=$(node -e "console.log(require('./package.json').version)")
          echo "version=\$VERSION" >> "\$GITHUB_OUTPUT"
          echo "📦 Versioned to \$VERSION"

      - name: Check for changes
        id: changes
        run: |
          if git diff --quiet; then
            echo "has_changes=false" >> "\$GITHUB_OUTPUT"
            echo "ℹ️ No version changes — nothing to release"
          else
            echo "has_changes=true" >> "\$GITHUB_OUTPUT"
            git diff --stat
          fi

      # Commit version bumps
      - name: Commit version bumps
        if: steps.changes.outputs.has_changes == 'true' && inputs.dry_run == 'false'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -m "chore: version packages (v\${{ steps.version.outputs.version }})"
          git push origin ${releaseBranch}

      # Tag the release
      - name: Create git tag
        if: steps.changes.outputs.has_changes == 'true' && inputs.dry_run == 'false'
        run: |
          TAG="v\${{ steps.version.outputs.version }}"
          git tag -a "\$TAG" -m "Release \$TAG"
          git push origin "\$TAG"

      # Publish to npmjs
      - name: Publish to npmjs
        if: steps.changes.outputs.has_changes == 'true' && inputs.dry_run == 'false'
        run: npx changeset publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"

      # Mirror to GitHub Packages
      - name: Setup GitHub Packages registry
        if: steps.changes.outputs.has_changes == 'true' && inputs.dry_run == 'false'
        uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://npm.pkg.github.com

      - name: Publish to GitHub Packages
        if: steps.changes.outputs.has_changes == 'true' && inputs.dry_run == 'false'
        run: npm publish --registry https://npm.pkg.github.com
        env:
          NODE_AUTH_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      # Create GitHub Release
      - name: Create GitHub Release
        if: steps.changes.outputs.has_changes == 'true' && inputs.dry_run == 'false'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="v\${{ steps.version.outputs.version }}"
          gh release create "\$TAG" \\
            --title "\$TAG" \\
            --generate-notes \\
            --latest

      # Dry-run summary
      - name: Dry-run summary
        if: inputs.dry_run == 'true' && steps.changes.outputs.has_changes == 'true'
        run: |
          echo "## 🏜️ Dry Run Summary" >> "\$GITHUB_STEP_SUMMARY"
          echo "" >> "\$GITHUB_STEP_SUMMARY"
          echo "Would release **v\${{ steps.version.outputs.version }}**" >> "\$GITHUB_STEP_SUMMARY"
          echo "" >> "\$GITHUB_STEP_SUMMARY"
          echo "### Changes" >> "\$GITHUB_STEP_SUMMARY"
          git diff --stat >> "\$GITHUB_STEP_SUMMARY"
`;
}
