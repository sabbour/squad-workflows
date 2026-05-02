import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@sabbour/squad-workflows';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_CACHE_PATTERN = /(^|[\\/])_npx([\\/]|$)/;

function readVersion(packageJsonUrl) {
  return JSON.parse(readFileSync(packageJsonUrl, 'utf8')).version;
}

function detectInstallMode(packageRootUrl) {
  const hints = [fileURLToPath(packageRootUrl), process.argv[1] ?? '', process.env.npm_execpath ?? ''];
  if (hints.some((hint) => NPX_CACHE_PATTERN.test(hint)) || process.env.npm_command === 'exec') {
    return 'npx';
  }

  return 'global';
}

function getLatestVersion(packageName) {
  return execFileSync(NPM_COMMAND, ['view', packageName, 'version'], { encoding: 'utf8' }).trim();
}

function getGlobalInstalledVersion(packageName) {
  const globalRoot = execFileSync(NPM_COMMAND, ['root', '-g'], { encoding: 'utf8' }).trim();
  const packageJsonPath = join(globalRoot, ...packageName.split('/'), 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
}

export async function runUpgrade() {
  const packageJsonUrl = new URL('../../../package.json', import.meta.url);
  const packageRootUrl = new URL('../../../', import.meta.url);
  const currentVersion = readVersion(packageJsonUrl);
  const installMode = detectInstallMode(packageRootUrl);

  console.log(`Current version: ${currentVersion}`);

  if (installMode === 'npx') {
    const latestVersion = getLatestVersion(PACKAGE_NAME);
    if (latestVersion === currentVersion) {
      console.log(`✅ Already on latest (${currentVersion}) via npx.`);
    } else {
      console.log(`⬆️  Update available: ${currentVersion} → ${latestVersion}`);
      console.log(`Re-run with: npx ${PACKAGE_NAME}@latest upgrade`);
    }
    return;
  }

  console.log(`Upgrading ${PACKAGE_NAME}...`);

  try {
    execFileSync(NPM_COMMAND, ['install', '-g', `${PACKAGE_NAME}@latest`], { stdio: 'inherit' });
    const newVersion = getGlobalInstalledVersion(PACKAGE_NAME);
    if (newVersion === currentVersion) {
      console.log(`✅ Already on latest: ${newVersion}`);
    } else {
      console.log(`✅ Upgraded ${PACKAGE_NAME}: ${currentVersion} → ${newVersion}`);
    }
    console.log(`ℹ️  Re-run \`squad-workflows setup\` in each target repo to pick up new workflow/instruction changes.`);
  } catch {
    throw new Error(`Upgrade failed. Try manually: npm install -g ${PACKAGE_NAME}@latest`);
  }
}
