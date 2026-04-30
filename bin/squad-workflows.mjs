#!/usr/bin/env node

/**
 * squad-workflows CLI — issue-to-merge workflow orchestration.
 *
 * Usage: squad-workflows <command> [options]
 *
 * Commands:
 *   init          One-time repo setup (labels, config, instructions)
 *   doctor        Health check
 *   estimate      Estimate an issue (S/M/L/XL)
 *   decompose     Decompose issue into waves
 *   status        Show workflow status for an issue
 *   wave-status   Show wave/milestone progress
 *
 * Options:
 *   --help        Show help
 *   --json        Output as JSON
 *   --issue <N>   Issue number
 *   --pr <N>      PR number
 */

import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = resolve(__dirname, '..', 'extensions', 'squad-workflows', 'lib');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    json: { type: 'boolean' },
    issue: { type: 'string' },
    pr: { type: 'string' },
    token: { type: 'string' },
    owner: { type: 'string' },
    repo: { type: 'string' },
  },
  strict: false,
});

const command = positionals[0];

function usage() {
  console.error(`Usage: squad-workflows <command> [options]

Commands:
  init              One-time repo setup (labels, config, instructions)
  doctor            Health check
  estimate          Estimate an issue (S/M/L/XL)
  decompose         Decompose issue into waves
  status            Show workflow status for an issue
  wave-status       Show wave/milestone progress
  merge-check       Pre-merge validation for a PR
  fast-lane         Check fast-lane eligibility

Options:
  --help, -h        Show help
  --json            Output as JSON
  --issue <N>       Issue number
  --pr <N>          PR number
  --token <T>       GitHub token (from squad-identity)
  --owner <O>       Repository owner
  --repo <R>        Repository name`);
}

if (values.help || !command) {
  usage();
  process.exit(values.help ? 0 : 1);
}

async function run() {
  const repoRoot = process.cwd();

  switch (command) {
    case 'init': {
      const { runInit } = await import(`${LIB_DIR}/init.mjs`);
      return runInit(repoRoot, values);
    }
    case 'doctor': {
      const { runDoctor } = await import(`${LIB_DIR}/doctor.mjs`);
      return runDoctor(repoRoot, values);
    }
    case 'estimate': {
      const { runEstimate } = await import(`${LIB_DIR}/estimate.mjs`);
      return runEstimate(repoRoot, values);
    }
    case 'decompose': {
      const { runDecompose } = await import(`${LIB_DIR}/decompose.mjs`);
      return runDecompose(repoRoot, values);
    }
    case 'status': {
      const { runStatus } = await import(`${LIB_DIR}/status.mjs`);
      return runStatus(repoRoot, values);
    }
    case 'wave-status': {
      const { runWaveStatus } = await import(`${LIB_DIR}/wave-status.mjs`);
      return runWaveStatus(repoRoot, values);
    }
    case 'merge-check': {
      const { runMergeCheck } = await import(`${LIB_DIR}/merge-check.mjs`);
      return runMergeCheck(repoRoot, values);
    }
    case 'fast-lane': {
      const { runFastLane } = await import(`${LIB_DIR}/fast-lane.mjs`);
      return runFastLane(repoRoot, values);
    }
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

try {
  const result = await run();
  if (result !== undefined) {
    const output = values.json ? JSON.stringify(result, null, 2) : formatHuman(result);
    console.log(output);
  }
} catch (err) {
  if (values.json) {
    console.log(JSON.stringify({ error: err.message }, null, 2));
  } else {
    console.error(`❌ ${err.message}`);
  }
  process.exit(1);
}

function formatHuman(result) {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}
