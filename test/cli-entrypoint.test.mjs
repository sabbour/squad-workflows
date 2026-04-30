import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const binPath = resolve(repoRoot, 'bin', 'squad-workflows.mjs');

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: cwd || repoRoot,
    env: {
      ...process.env,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      ...env,
    },
    encoding: 'utf8',
  });

  return {
    ...result,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('prints help with --help', () => {
  const result = runCli(['--help']);
  // --help prints to stderr via usage() and exits 0
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  const output = result.stderr || result.stdout;
  assert.match(output, /Usage: squad-workflows <command>/);
  assert.match(output, /init/);
  assert.match(output, /doctor/);
  assert.match(output, /estimate/);
});

test('prints help with no command', () => {
  const result = runCli([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: squad-workflows/);
});

test('errors on unknown command', () => {
  const result = runCli(['nonexistent']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: nonexistent/);
});
