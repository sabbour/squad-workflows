import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = process.cwd();
const LIB_DIR = resolve(repoRoot, 'extensions', 'squad-workflows', 'lib');

function makeScratchDir(name) {
  const dir = join(repoRoot, 'test', '.runtime', `${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFakeGh(dir) {
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, [
    '#!/bin/sh',
    'set -eu',
    'endpoint="${2-}"',
    'mode="${TEST_GH_MODE-merge-check}"',
    'if printf "%s" "$*" | grep -q "\\-\\-input"; then cat > /dev/null 2>/dev/null || true; fi',
    'if [ "$endpoint" = "graphql" ]; then',
    `  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'`,
    '  exit 0',
    'fi',
  'case "$endpoint" in',
  '  "/repos/test-owner/test-repo/pulls/123")',
    '    if [ -n "${TEST_PR_JSON:-}" ]; then',
    '      printf \'%s\\n\' "$TEST_PR_JSON"',
    '    else',
    `      printf '%s\\n' '{"draft":false,"mergeable_state":"behind","base":{"ref":"dev"},"head":{"sha":"abc123","ref":"feature/branch"},"user":{"login":"author"},"labels":[{"name":"codereview:approved"},{"name":"architecture:approved"},{"name":"security:approved"}]}'`,
    '    fi',
    '    ;;',
    '  "/repos/test-owner/test-repo/pulls/123/reviews")',
    `    printf '%s\\n' '[{"state":"APPROVED","user":{"login":"reviewer"}}]'`,
    '    ;;',
  '  "/repos/test-owner/test-repo/pulls/123/files")',
    '    if [ -n "${TEST_PR_FILES:-}" ]; then',
    '      printf \'%s\\n\' "$TEST_PR_FILES"',
    '    else',
    `      printf '%s\\n' '[{"filename":".changeset/freshness.md"}]'`,
    '    fi',
    '    ;;',
    '  "/repos/test-owner/test-repo/commits/abc123/check-runs")',
    `    printf '%s\\n' '{"check_runs":[]}'`,
    '    ;;',
    '  "/repos/test-owner/test-repo/commits/abc123/status")',
    `    printf '%s\\n' '{"statuses":[]}'`,
    '    ;;',
    '  "/repos/test-owner/test-repo/pulls/123/update-branch")',
    '    if [ "$mode" = "conflict" ]; then',
    `      printf '%s\\n' 'merge conflict' >&2`,
    '      exit 1',
    '    fi',
    `    printf '%s\\n' '{"message":"Branch update scheduled"}'`,
    '    ;;',
    '  *)',
    `    printf 'Unexpected gh endpoint: %s\\n' "$endpoint" >&2`,
    '    exit 1',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(ghPath, 0o755);
}

test('merge-check: behind branch blocker exposes auto-fix remediation', async () => {
  const scratchDir = makeScratchDir('merge-check');
  const fakeBinDir = join(scratchDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeGh(fakeBinDir);

  const previousPath = process.env.PATH;
  const previousMode = process.env.TEST_GH_MODE;
  process.env.PATH = `${fakeBinDir}:${previousPath}`;
  process.env.TEST_GH_MODE = 'merge-check';

  try {
    const { runMergeCheck } = await import(`${LIB_DIR}/merge-check.mjs`);
    const result = await runMergeCheck(scratchDir, {
      owner: 'test-owner',
      repo: 'test-repo',
      pr: 123,
      token: 'test-token',
    });

    assert.equal(result.canMerge, false);
    assert.equal(result.blockers.length, 1);
    assert.deepEqual(result.blockers[0], {
      check: 'branch-current',
      message: 'Branch is behind dev. Must update before merge.',
      remediation: {
        command: 'gh api repos/test-owner/test-repo/pulls/123/update-branch -X PUT',
        autoFix: true,
        description: 'Update branch to include latest base branch changes',
      },
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousMode === undefined) {
      delete process.env.TEST_GH_MODE;
    } else {
      process.env.TEST_GH_MODE = previousMode;
    }
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('merge-check: docs-only PR requires only code review and skips docs/security/architecture labels', async () => {
  const scratchDir = makeScratchDir('merge-check-docs-only');
  const fakeBinDir = join(scratchDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeGh(fakeBinDir);

  const previousPath = process.env.PATH;
  const previousMode = process.env.TEST_GH_MODE;
  const previousPr = process.env.TEST_PR_JSON;
  const previousFiles = process.env.TEST_PR_FILES;
  process.env.PATH = `${fakeBinDir}:${previousPath}`;
  process.env.TEST_GH_MODE = 'merge-check';
  process.env.TEST_PR_JSON = JSON.stringify({
    draft: false,
    mergeable_state: 'clean',
    base: { ref: 'dev' },
    head: { sha: 'abc123', ref: 'docs/guide' },
    user: { login: 'author' },
    labels: [{ name: 'codereview:approved' }],
  });
  process.env.TEST_PR_FILES = JSON.stringify([{ filename: 'docs/guide.md' }]);

  try {
    const { runMergeCheck } = await import(`${LIB_DIR}/merge-check.mjs`);
    const result = await runMergeCheck(scratchDir, {
      owner: 'test-owner',
      repo: 'test-repo',
      pr: 123,
      token: 'test-token',
    });

    assert.equal(result.canMerge, true);
    assert.ok(result.passed.includes('Docs signal exempt (docs-only)'));
    assert.ok(result.passed.includes('Security review exempt'));
    assert.ok(result.passed.includes('Architecture review exempt'));
  } finally {
    process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.TEST_GH_MODE; else process.env.TEST_GH_MODE = previousMode;
    if (previousPr === undefined) delete process.env.TEST_PR_JSON; else process.env.TEST_PR_JSON = previousPr;
    if (previousFiles === undefined) delete process.env.TEST_PR_FILES; else process.env.TEST_PR_FILES = previousFiles;
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('merge-check: docs rejection hard-blocks code PRs even when code approvals are present', async () => {
  const scratchDir = makeScratchDir('merge-check-docs-rejected');
  const fakeBinDir = join(scratchDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeGh(fakeBinDir);

  const previousPath = process.env.PATH;
  const previousMode = process.env.TEST_GH_MODE;
  const previousPr = process.env.TEST_PR_JSON;
  const previousFiles = process.env.TEST_PR_FILES;
  process.env.PATH = `${fakeBinDir}:${previousPath}`;
  process.env.TEST_GH_MODE = 'merge-check';
  process.env.TEST_PR_JSON = JSON.stringify({
    draft: false,
    mergeable_state: 'clean',
    base: { ref: 'dev' },
    head: { sha: 'abc123', ref: 'feature/code' },
    user: { login: 'author' },
    labels: [
      { name: 'codereview:approved' },
      { name: 'security:approved' },
      { name: 'docs:rejected' },
    ],
  });
  process.env.TEST_PR_FILES = JSON.stringify([{ filename: 'src/index.ts' }]);

  try {
    const { runMergeCheck } = await import(`${LIB_DIR}/merge-check.mjs`);
    const result = await runMergeCheck(scratchDir, {
      owner: 'test-owner',
      repo: 'test-repo',
      pr: 123,
      token: 'test-token',
    });

    assert.equal(result.canMerge, false);
    assert.ok(result.blockers.some((blocker) => blocker.check === 'docs-rejected'));
  } finally {
    process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.TEST_GH_MODE; else process.env.TEST_GH_MODE = previousMode;
    if (previousPr === undefined) delete process.env.TEST_PR_JSON; else process.env.TEST_PR_JSON = previousPr;
    if (previousFiles === undefined) delete process.env.TEST_PR_FILES; else process.env.TEST_PR_FILES = previousFiles;
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('merge-check: docs:not-applicable waives docs signal for tested code PRs', async () => {
  const scratchDir = makeScratchDir('merge-check-docs-not-applicable');
  const fakeBinDir = join(scratchDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeGh(fakeBinDir);

  const previousPath = process.env.PATH;
  const previousMode = process.env.TEST_GH_MODE;
  const previousPr = process.env.TEST_PR_JSON;
  const previousFiles = process.env.TEST_PR_FILES;
  process.env.PATH = `${fakeBinDir}:${previousPath}`;
  process.env.TEST_GH_MODE = 'merge-check';
  process.env.TEST_PR_JSON = JSON.stringify({
    draft: false,
    mergeable_state: 'clean',
    base: { ref: 'dev' },
    head: { sha: 'abc123', ref: 'feature/code' },
    user: { login: 'author' },
    labels: [
      { name: 'codereview:approved' },
      { name: 'security:approved' },
      { name: 'docs:not-applicable' },
    ],
  });
  process.env.TEST_PR_FILES = JSON.stringify([
    { filename: 'src/index.ts' },
    { filename: 'test/index.test.mjs' },
    { filename: '.changeset/docs-waiver.md' },
  ]);

  try {
    const { runMergeCheck } = await import(`${LIB_DIR}/merge-check.mjs`);
    const result = await runMergeCheck(scratchDir, {
      owner: 'test-owner',
      repo: 'test-repo',
      pr: 123,
      token: 'test-token',
    });

    assert.equal(result.canMerge, true);
    assert.ok(result.passed.includes('Docs marked not applicable'));
    assert.equal(result.blockers.some((blocker) => blocker.check === 'docs-signal'), false);
  } finally {
    process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.TEST_GH_MODE; else process.env.TEST_GH_MODE = previousMode;
    if (previousPr === undefined) delete process.env.TEST_PR_JSON; else process.env.TEST_PR_JSON = previousPr;
    if (previousFiles === undefined) delete process.env.TEST_PR_FILES; else process.env.TEST_PR_FILES = previousFiles;
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('update-branch: returns rebase guidance when API update fails', async () => {
  const scratchDir = makeScratchDir('update-branch');
  const fakeBinDir = join(scratchDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeGh(fakeBinDir);

  const previousPath = process.env.PATH;
  const previousMode = process.env.TEST_GH_MODE;
  process.env.PATH = `${fakeBinDir}:${previousPath}`;
  process.env.TEST_GH_MODE = 'conflict';

  try {
    const { runUpdateBranch } = await import(`${LIB_DIR}/update-branch.mjs`);
    const result = await runUpdateBranch(repoRoot, { owner: 'test-owner', repo: 'test-repo', pr: 123, token: 'test-token' });

    assert.equal(result.status, 'conflict');
    assert.ok(result.message.includes('conflict') || result.message.includes('Cannot auto-update'));
  } finally {
    process.env.PATH = previousPath;
    if (previousMode === undefined) {
      delete process.env.TEST_GH_MODE;
    } else {
      process.env.TEST_GH_MODE = previousMode;
    }
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('update-branch: returns success when API update succeeds', async () => {
  const scratchDir = makeScratchDir('update-branch-success');
  const fakeBinDir = join(scratchDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeGh(fakeBinDir);

  const previousPath = process.env.PATH;
  const previousMode = process.env.TEST_GH_MODE;
  process.env.PATH = `${fakeBinDir}:${previousPath}`;
  process.env.TEST_GH_MODE = 'success';

  try {
    const { runUpdateBranch } = await import(`${LIB_DIR}/update-branch.mjs`);
    const result = await runUpdateBranch(repoRoot, { owner: 'test-owner', repo: 'test-repo', pr: 123, token: 'test-token' });

    assert.equal(result.status, 'updated');
    assert.equal(result.message, 'Branch updated with base branch changes.');
  } finally {
    process.env.PATH = previousPath;
    if (previousMode === undefined) {
      delete process.env.TEST_GH_MODE;
    } else {
      process.env.TEST_GH_MODE = previousMode;
    }
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
