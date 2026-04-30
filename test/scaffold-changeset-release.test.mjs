import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const LIB_DIR = resolve(process.cwd(), 'extensions', 'squad-workflows', 'lib');

test('scaffold-changeset-release: dry run returns workflow content', async () => {
  const { scaffoldChangesetRelease } = await import(`${LIB_DIR}/scaffold-changeset-release.mjs`);
  const tmpRoot = join(tmpdir(), `scaffold-test-${Date.now()}`);
  mkdirSync(join(tmpRoot, '.squad', 'workflows'), { recursive: true });

  const result = scaffoldChangesetRelease(tmpRoot, { dryRun: true });
  assert.equal(result.status, 'would write');
  assert.ok(result.content.includes('Squad Changeset Release'));
  assert.ok(result.content.includes('workflow_dispatch'));
  assert.ok(result.content.includes('changeset version'));
  assert.ok(result.content.includes('changeset publish'));

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('scaffold-changeset-release: writes file when not dry run', async () => {
  const { scaffoldChangesetRelease } = await import(`${LIB_DIR}/scaffold-changeset-release.mjs`);
  const tmpRoot = join(tmpdir(), `scaffold-test-${Date.now()}`);
  mkdirSync(join(tmpRoot, '.squad', 'workflows'), { recursive: true });

  const result = scaffoldChangesetRelease(tmpRoot, { dryRun: false });
  assert.equal(result.status, 'created');

  const filePath = join(tmpRoot, '.github', 'workflows', 'squad-changeset-release.yml');
  assert.ok(existsSync(filePath));
  const content = readFileSync(filePath, 'utf-8');
  assert.ok(content.includes('Squad Changeset Release'));

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('scaffold-changeset-release: skips existing file without force', async () => {
  const { scaffoldChangesetRelease } = await import(`${LIB_DIR}/scaffold-changeset-release.mjs`);
  const tmpRoot = join(tmpdir(), `scaffold-test-${Date.now()}`);
  mkdirSync(join(tmpRoot, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(tmpRoot, '.github', 'workflows', 'squad-changeset-release.yml'), 'existing');

  const result = scaffoldChangesetRelease(tmpRoot, { dryRun: false });
  assert.ok(result.status.includes('skipped'));

  // With force, it overwrites
  const forced = scaffoldChangesetRelease(tmpRoot, { dryRun: false, force: true });
  assert.equal(forced.status, 'updated');

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('scaffold-changeset-release: uses release branch from config', async () => {
  const { scaffoldChangesetRelease } = await import(`${LIB_DIR}/scaffold-changeset-release.mjs`);
  const tmpRoot = join(tmpdir(), `scaffold-test-${Date.now()}`);
  mkdirSync(join(tmpRoot, '.squad', 'workflows'), { recursive: true });
  writeFileSync(join(tmpRoot, '.squad', 'workflows', 'config.json'), JSON.stringify({
    branchModel: { base: 'dev', release: 'production' },
  }));

  const result = scaffoldChangesetRelease(tmpRoot, { dryRun: true });
  assert.ok(result.content.includes('git push origin production'));

  rmSync(tmpRoot, { recursive: true, force: true });
});
