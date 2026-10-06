#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkScript } from '../lib/datasets.mjs';

const args = process.argv.slice(2);
const dataset = args.find(arg => !arg.startsWith('-'));
if (!dataset) throw new Error('Usage: node tests/data/bench.mjs <dataset> [--gpu=cpu|gpu|both] [--full]');

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const benchName = benchmarkScript(dataset);
// The benchmark lives in whichever group folder owns it (gpu/ or io/).
const script = ['gpu', 'io', 'cpu'].map(g => join(testsDir, g, benchName)).find(existsSync);
if (!script) throw new Error(`Benchmark ${benchName} not found in tests/{gpu,io,cpu}.`);
const childArgs = args.filter(arg => arg !== dataset);
if (!childArgs.some(arg => arg.startsWith('--dataset='))) childArgs.push(`--dataset=${dataset}`);
const result = spawnSync(process.execPath, [script, ...childArgs], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
