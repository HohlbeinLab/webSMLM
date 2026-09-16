// Real-data path resolution shared by every bench script that reads from the
// git-ignored temp/ folder. Every real-data bench used to hardcode
// join(repoRoot,'temp','19165061',<name>) and just skip if that exact file
// was missing — fine for the one dataset temp/ started with, but no way to
// point a bench at your own copy sitting somewhere else, and no chance to
// answer "what file do you mean?" before giving up.
//
// Resolution order, each one a fallback for the last:
//   1. temp/<defaultRelPath> — today's common case, unchanged.
//   2. process.env.WEBSMLM_TEST_DATA_<key> — an explicit override.
//   3. tests/results/.data-paths.json — a path this same helper was told
//      interactively on a previous run (so you're only asked once).
//   4. an interactive prompt (only when stdin is a real TTY — a script
//      spawned by run-suite.mjs runs with stdio:['ignore',...], so this step
//      is automatically a no-op there, same as CI).
//   5. skip, naming the env var that would satisfy it — the same "skip,
//      don't fail" contract every real-data bench already has.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { repoRoot } from './launch.mjs';

const cacheFile = join(repoRoot, 'tests', 'results', '.data-paths.json');

function readCache() {
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return {}; }
}

function writeCache(cache) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error(`  (could not save remembered path: ${err.message})`);
  }
}

// key: a short UPPER_SNAKE identifier (becomes WEBSMLM_TEST_DATA_<key> and
// the cache entry name). defaultRelPath: the usual location under temp/, as
// it would be joined with 'temp' (e.g. join('19165061','Aquired STORM.tif')).
// Returns the resolved absolute path, or null if nothing was found/given.
export async function resolveDataFile(key, defaultRelPath) {
  const defaultPath = join(repoRoot, 'temp', defaultRelPath);
  if (existsSync(defaultPath)) return defaultPath;

  const envVar = `WEBSMLM_TEST_DATA_${key}`;
  const envPath = process.env[envVar];
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    console.log(`  (${envVar} is set to "${envPath}", but that path doesn't exist — ignoring it.)`);
  }

  const cache = readCache();
  if (cache[key] && existsSync(cache[key])) return cache[key];

  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(
        `\n${key}: not found at the usual place\n  ${defaultPath}\nEnter a path to use instead (blank to skip this test): `
      )).trim();
      if (answer) {
        if (existsSync(answer)) {
          cache[key] = answer;
          writeCache(cache);
          return answer;
        }
        console.log(`  "${answer}" does not exist — skipping.`);
      }
    } finally {
      rl.close();
    }
  } else {
    console.log(`Skipping — ${key} not found at:\n  ${defaultPath}\nSet ${envVar}=<path> to point at your own copy (see experimental_data/README.md).`);
  }
  return null;
}
