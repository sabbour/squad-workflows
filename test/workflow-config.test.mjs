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
  assert.deepEqual(config.approvalFallback['docs:approved'], ['architecture', 'lead', 'codereview']);
  assert.deepEqual(config.fastLaneScope, ['changeset', 'design-proposal']);
  assert.deepEqual(config.labels.reviewSignals, ['docs:not-applicable', 'docs:rejected']);
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

// Tests for matchGlob regex-metachar escape fix (backport from kickstart)
test('matchGlob: dot in pattern must not match arbitrary chars (regression)', async () => {
  const { matchGlob } = await import(`${LIB_DIR}/workflow-config.mjs`);
  // Before the fix, '.' in a glob pattern was passed raw to RegExp, making it
  // match any character.  After the fix it must match only a literal dot.
  assert.equal(matchGlob('docs/README.md', '**/*.md'), true,  'should match literal .md');
  assert.equal(matchGlob('docs/READMEXmd', '**/*.md'), false, 'dot must not match X');
  assert.equal(matchGlob('docs/READMExmd', '**/*.md'), false, 'dot must not match x');
});

test('matchGlob: other regex metacharacters are escaped', async () => {
  const { matchGlob } = await import(`${LIB_DIR}/workflow-config.mjs`);
  // Pattern containing + — must not act as a regex quantifier.
  assert.equal(matchGlob('src/c++/file.cpp', 'src/c++/*.cpp'), true,  'literal + in dir name');
  assert.equal(matchGlob('src/cXX/file.cpp', 'src/c++/*.cpp'), false, '+ must not be a quantifier');
  // Pattern containing ( and ) — must be treated as literals.
  assert.equal(matchGlob('lib/(utils)/helper.mjs', 'lib/(utils)/*.mjs'), true);
  assert.equal(matchGlob('lib/Xutils)/helper.mjs', 'lib/(utils)/*.mjs'), false);
});

test('matchGlob: ** and * wildcards still work after escaping', async () => {
  const { matchGlob } = await import(`${LIB_DIR}/workflow-config.mjs`);
  assert.equal(matchGlob('a/b/c/file.ts',  '**/*.ts'), true);
  assert.equal(matchGlob('src/file.ts',     '**/*.ts'), true);
  assert.equal(matchGlob('src/file.ts',     'src/*.ts'), true);
  assert.equal(matchGlob('src/sub/file.ts', 'src/*.ts'), false, '* must not cross dir boundary');
  assert.equal(matchGlob('.changeset/foo.md', '.changeset/**'), true);
});
