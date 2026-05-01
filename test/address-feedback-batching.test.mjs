import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    'if [ "${2-}" = "graphql" ]; then',
    `  printf '%s\\n' '{"data":{"repository":{"pullRequest":{"title":"Fix feedback","author":{"login":"author"},"reviewDecision":"CHANGES_REQUESTED","reviews":{"nodes":[{"author":{"login":"squad-security[bot]"},"state":"CHANGES_REQUESTED"}]},"reviewThreads":{"nodes":[{"id":"T1","isResolved":false,"path":"lib/security.mjs","line":12,"comments":{"nodes":[{"id":"C1","author":{"login":"squad-security[bot]"},"body":"Tighten validation."}]}},{"id":"T2","isResolved":false,"path":"docs/usage.md","line":5,"comments":{"nodes":[{"id":"C2","author":{"login":"squad-docs[bot]"},"body":"Update docs."}]}}]}}}}}'`,
    '  exit 0',
    'fi',
    `printf '%s\\n' '[]'`,
    '',
  ].join('\n'));
  chmodSync(ghPath, 0o755);
}

test('address-feedback returns batched one-pass commit/comment instructions', async () => {
  const scratchDir = makeScratchDir('address-feedback-batching');
  const fakeBinDir = join(scratchDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeGh(fakeBinDir);

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${previousPath}`;

  try {
    const { runAddressFeedback } = await import(`${LIB_DIR}/address-feedback.mjs`);
    const result = await runAddressFeedback(scratchDir, {
      owner: 'test-owner',
      repo: 'test-repo',
      pr: 123,
      token: 'test-token',
    });

    assert.equal(result.totalThreads, 2);
    assert.equal(result.batchPlan.mode, 'batched-per-pr');
    assert.match(result.batchPlan.instruction, /one implementation pass/i);
    assert.match(result.batchPlan.commit, /one commit/i);
    assert.match(result.batchPlan.comment, /consolidated PR comment/i);
    assert.match(result.batchPlan.closure.roleGateApproval, /squad_reviews_execute_pr_review/i);
    assert.equal(result.reviewDecision, 'CHANGES_REQUESTED');
    assert.equal(result.closurePlan.readyAfterThreads, false);
    assert.deepEqual(result.batchPlan.byCategory, { security: 1, docs: 1 });
  } finally {
    process.env.PATH = previousPath;
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
