import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const EXTENSION_PATH = resolve(process.cwd(), 'extensions', 'squad-workflows', 'extension.mjs');

function loadRegisteredTools() {
  const script = `
    import { readFileSync } from 'node:fs';
    import vm from 'node:vm';
    import { pathToFileURL } from 'node:url';

    const extensionPath = process.argv[1];
    const source = readFileSync(extensionPath, 'utf8');
    const context = vm.createContext({ console, process, setTimeout, clearTimeout, URL });
    const cache = new Map();
    let capturedTools = null;

    async function createNamespaceModule(specifier) {
      if (cache.has(specifier)) {
        return cache.get(specifier);
      }

      const namespace = await import(specifier);
      const exportNames = Object.keys(namespace);
      const module = new vm.SyntheticModule(exportNames, function () {
        for (const name of exportNames) {
          this.setExport(name, namespace[name]);
        }
      }, { context, identifier: specifier });

      cache.set(specifier, module);
      return module;
    }

    const identifier = pathToFileURL(extensionPath).href;
    const module = new vm.SourceTextModule(source, {
      context,
      identifier,
      initializeImportMeta(meta) {
        meta.url = identifier;
      },
    });

    await module.link(async (specifier) => {
      if (specifier === '@github/copilot-sdk/extension') {
        return new vm.SyntheticModule(['joinSession'], function () {
          this.setExport('joinSession', async ({ tools } = {}) => {
            capturedTools = tools;
            return {};
          });
        }, { context, identifier: specifier });
      }

      if (specifier.startsWith('node:')) {
        return createNamespaceModule(specifier);
      }

      throw new Error('Unexpected import: ' + specifier);
    });

    await module.evaluate();

    if (!Array.isArray(capturedTools)) {
      throw new Error('Failed to capture tools array from joinSession');
    }

    const summary = capturedTools.map((tool) => ({
      name: tool?.name,
      description: tool?.description,
      skipPermission: tool?.skipPermission,
      parameters: tool?.parameters,
      handlerType: typeof tool?.handler,
    }));

    console.log(JSON.stringify(summary));
  `;

  const stdout = execFileSync('node', ['--experimental-vm-modules', '--input-type=module', '-e', script, EXTENSION_PATH], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  return JSON.parse(stdout);
}

test('extension registers squad workflow tools with allow-all permissions and valid shapes', () => {
  const tools = loadRegisteredTools();
  const names = tools.map((tool) => tool.name);

  assert.ok(tools.length >= 15, `Expected at least 15 tools, got ${tools.length}`);
  assert.equal(new Set(names).size, names.length, 'Expected tool names to be unique');

  for (const tool of tools) {
    assert.match(tool.name, /^squad_workflows_/, `Expected tool name to start with squad_workflows_: ${tool.name}`);
    assert.equal(typeof tool.description, 'string', `Expected ${tool.name} to have a string description`);
    assert.notEqual(tool.description.trim(), '', `Expected ${tool.name} to have a non-empty description`);
    assert.equal(tool.skipPermission, true, `Expected ${tool.name} to skip permission checks`);
    assert.equal(tool.parameters?.type, 'object', `Expected ${tool.name} parameters.type to be object`);
    assert.equal(typeof tool.parameters?.properties, 'object', `Expected ${tool.name} parameters.properties to be an object`);
    assert.notEqual(tool.parameters?.properties, null, `Expected ${tool.name} parameters.properties to be non-null`);
    assert.ok(Array.isArray(tool.parameters?.required), `Expected ${tool.name} parameters.required to be an array`);
    assert.equal(tool.handlerType, 'function', `Expected ${tool.name} handler to be a function`);
  }
});
