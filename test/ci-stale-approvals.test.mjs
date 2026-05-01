import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const WORKFLOWS = [
  '.github/workflows/squad-ci.yml',
  '.squad/templates/workflows/squad-ci.yml',
];

function extractStaleApprovalScript(path) {
  const content = readFileSync(path, 'utf8');
  const step = '      - name: Clear approvals for real content changes\n';
  const stepIndex = content.indexOf(step);
  assert.notEqual(stepIndex, -1, `${path} has stale approval clearing step`);

  const scriptMarker = '          script: |\n';
  const scriptIndex = content.indexOf(scriptMarker, stepIndex);
  assert.notEqual(scriptIndex, -1, `${path} has github-script body`);

  const lines = content.slice(scriptIndex + scriptMarker.length).split('\n');
  const scriptLines = [];
  for (const line of lines) {
    if (line.startsWith('            ')) {
      scriptLines.push(line.slice(12));
      continue;
    }
    if (line.trim() === '') {
      scriptLines.push('');
      continue;
    }
    break;
  }
  return scriptLines.join('\n');
}

function asCompareFiles(paths) {
  return paths.map((filename) => ({ filename, status: 'modified', sha: `sha-${filename}` }));
}

async function runScript(script, { labels, beforeFiles = [], afterFiles = [], pushedFiles = afterFiles }) {
  const removed = [];
  const infos = [];
  const warnings = [];
  const context = {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    payload: {
      before: 'before-sha',
      after: 'after-sha',
      pull_request: {
        number: 123,
        base: { sha: 'base-sha' },
        labels: labels.map((name) => ({ name })),
      },
    },
  };
  const github = {
    paginate: async () => asCompareFiles(afterFiles),
    rest: {
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          if (basehead === 'base-sha...before-sha') return { data: { files: asCompareFiles(beforeFiles) } };
          if (basehead === 'base-sha...after-sha') return { data: { files: asCompareFiles(afterFiles) } };
          if (basehead === 'before-sha...after-sha') return { data: { files: asCompareFiles(pushedFiles) } };
          throw new Error(`unexpected compare: ${basehead}`);
        },
      },
      pulls: {
        listFiles: async () => ({ data: asCompareFiles(afterFiles) }),
      },
      issues: {
        removeLabel: async ({ name }) => {
          removed.push(name);
          return {};
        },
      },
    },
  };
  const core = {
    info: (message) => infos.push(message),
    warning: (message) => warnings.push(message),
  };

  await new AsyncFunction('context', 'github', 'core', script)(context, github, core);
  return { removed, infos, warnings };
}

for (const workflowPath of WORKFLOWS) {
  test(`${workflowPath}: pure base-sync synchronize preserves approval labels`, async () => {
    const script = extractStaleApprovalScript(workflowPath);
    const result = await runScript(script, {
      labels: [
        'codereview:approved',
        'architecture:approved',
        'security:approved',
        'docs:approved',
        'docs:not-applicable',
        'docs:rejected',
      ],
      beforeFiles: ['src/index.mjs', 'lib/security-review-response.mjs', 'docs/usage.md'],
      afterFiles: ['src/index.mjs', 'lib/security-review-response.mjs', 'docs/usage.md'],
    });

    assert.deepEqual(result.removed, []);
    assert.ok(result.infos.some((message) => message.includes('Pure base-sync')));
  });

  test(`${workflowPath}: security-only relevant content clears security and preserves unrelated approvals`, async () => {
    const script = extractStaleApprovalScript(workflowPath);
    const result = await runScript(script, {
      labels: [
        'codereview:approved',
        'architecture:approved',
        'security:approved',
        'docs:approved',
        'docs:not-applicable',
        'docs:rejected',
      ],
      afterFiles: ['lib/security-review-response.mjs', 'test/security-review-response.test.mjs'],
    });

    assert.deepEqual(result.removed, ['security:approved']);
    assert.equal(result.removed.includes('docs:rejected'), false);
  });

  test(`${workflowPath}: architecture-relevant content clears architecture and preserves unrelated approvals`, async () => {
    const script = extractStaleApprovalScript(workflowPath);
    const result = await runScript(script, {
      labels: [
        'codereview:approved',
        'architecture:approved',
        'security:approved',
        'docs:approved',
        'docs:not-applicable',
      ],
      afterFiles: ['extensions/squad-workflows/extension.mjs', 'test/extension-tool-shape.test.mjs'],
    });

    assert.deepEqual(result.removed, ['architecture:approved']);
  });

  test(`${workflowPath}: docs-only synchronize clears docs approval signals only`, async () => {
    const script = extractStaleApprovalScript(workflowPath);
    const result = await runScript(script, {
      labels: [
        'codereview:approved',
        'architecture:approved',
        'security:approved',
        'docs:approved',
        'docs:not-applicable',
      ],
      afterFiles: ['docs/usage.md', '.changeset/docs-update.md'],
    });

    assert.deepEqual(result.removed, ['docs:approved', 'docs:not-applicable']);
  });

  test(`${workflowPath}: broad multi-domain changes clear only impacted domains`, async () => {
    const script = extractStaleApprovalScript(workflowPath);
    const result = await runScript(script, {
      labels: [
        'codereview:approved',
        'architecture:approved',
        'security:approved',
        'docs:approved',
        'docs:not-applicable',
        'docs:rejected',
      ],
      afterFiles: ['lib/security-review-response.mjs', 'docs/usage.md'],
    });

    assert.deepEqual(result.removed, ['security:approved', 'docs:approved', 'docs:not-applicable']);
    assert.equal(result.removed.includes('codereview:approved'), false);
    assert.equal(result.removed.includes('architecture:approved'), false);
    assert.equal(result.removed.includes('docs:rejected'), false);
  });
}
