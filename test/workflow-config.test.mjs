import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const LIB_DIR = resolve(process.cwd(), 'extensions', 'squad-workflows', 'lib');

test('workflow-config: loadConfig returns defaults when no config file', async () => {
  const { loadConfig } = await import(`${LIB_DIR}/workflow-config.mjs`);
  const config = loadConfig('/nonexistent/path');
  assert.equal(config._source, 'defaults');
  assert.deepEqual(config.estimates.S, { points: 1, maxHours: 2 });
  assert.deepEqual(config.estimates.L, { points: 8, maxHours: 24, mustDecompose: true });
});

test('workflow-config: isFastLane detects estimate:S', async () => {
  const { loadConfig, isFastLane } = await import(`${LIB_DIR}/workflow-config.mjs`);
  const config = loadConfig('/nonexistent/path');
  assert.equal(isFastLane(config, ['estimate:S', 'bug']), true);
  assert.equal(isFastLane(config, ['estimate:M', 'bug']), false);
  assert.equal(isFastLane(config, ['squad:chore-auto']), true);
});

test('workflow-config: mustDecompose for L and XL', async () => {
  const { loadConfig, mustDecompose } = await import(`${LIB_DIR}/workflow-config.mjs`);
  const config = loadConfig('/nonexistent/path');
  assert.equal(mustDecompose(config, 'S'), false);
  assert.equal(mustDecompose(config, 'M'), false);
  assert.equal(mustDecompose(config, 'L'), true);
  assert.equal(mustDecompose(config, 'XL'), true);
});
