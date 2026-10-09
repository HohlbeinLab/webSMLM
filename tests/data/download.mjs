#!/usr/bin/env node
import { createHash, X509Certificate } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import * as tls from 'node:tls';
import { DATASETS, getDataset } from '../lib/datasets.mjs';
import { repoRoot } from '../lib/launch.mjs';

const key = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const force = process.argv.includes('--force');
let epflCaPromise;

if (tls.getCACertificates && tls.setDefaultCACertificates) {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

if (!key || key === 'list') {
  for (const [name, dataset] of Object.entries(DATASETS)) {
    const action = dataset.download ? `download: ${dataset.download.type}` : 'private fixture';
    console.log(`${name.padEnd(22)} ${action.padEnd(20)} ${dataset.label}`);
  }
  process.exit(0);
}

const dataset = getDataset(key);
if (!dataset.download) throw new Error(`${key} has no automated public download. See ${dataset.source || 'tests/README.md'}.`);

const tempRoot = resolve(repoRoot, 'temp');
const destination = resolve(tempRoot, dataset.localPath);
if (!destination.startsWith(tempRoot)) throw new Error(`Unsafe dataset destination: ${destination}`);
// A zip has no per-file checksums to re-check, so an extracted folder is trusted; figshare files are re-verified
// individually below (hashing a cached file costs seconds, far less than trusting a corrupt one).
const requiredFilesPresent = Object.values(dataset.files || {}).every(role =>
  (role.paths || []).some(path => existsSync(join(destination, path))));
const zipReady = requiredFilesPresent && (!dataset.download.marker || existsSync(join(destination, dataset.download.marker)));
if (dataset.download.type === 'zip' && zipReady && !force) {
  console.log(`${key} already exists at ${destination}\nUse --force to download it again.`);
  process.exit(0);
}
if (dataset.download.type === 'zip') {
  mkdirSync(tempRoot, { recursive: true });
  const archive = join(tempRoot, dataset.download.archive || basename(new URL(dataset.download.url).pathname));
  await downloadFile(dataset.download.url, archive, dataset.sha256, dataset.bytes);
  const extractTo = dataset.download.intoDestination ? destination : tempRoot;
  mkdirSync(extractTo, { recursive: true });
  const extracted = spawnSync('tar', ['-xf', archive, '-C', extractTo], { stdio: 'inherit', windowsHide: true });
  if (extracted.error) throw new Error(`Could not run tar: ${extracted.error.message}`);
  if (extracted.status !== 0) throw new Error(`tar exited with status ${extracted.status}`);
  if (dataset.download.marker) writeFileSync(join(destination, dataset.download.marker), `${new Date().toISOString()}\n`);
  console.log(`Extracted ${key} under ${extractTo}`);
} else if (dataset.download.type === 'zip-file') {
  const output = join(destination, dataset.download.file);
  if (zipReady && !force) {
    console.log(`${key} already exists at ${destination}\nUse --force to download it again.`);
    if (dataset.extracted) await verifyFile(output, dataset.extracted.sha256, dataset.extracted.bytes, false);
    process.exit(0);
  }
  mkdirSync(destination, { recursive: true });
  if (!existsSync(output) || force) {
    const archive = join(tempRoot, basename(new URL(dataset.download.url).pathname));
    await downloadFile(dataset.download.url, archive, dataset.sha256, dataset.bytes);
    const extracted = spawnSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit', windowsHide: true });
    if (extracted.error) throw new Error(`Could not run tar: ${extracted.error.message}`);
    if (extracted.status !== 0) throw new Error(`tar exited with status ${extracted.status}`);
    const found = findFile(destination, dataset.download.file);
    if (!found) throw new Error(`Downloaded archive does not contain ${dataset.download.file}.`);
    if (resolve(found) !== resolve(output)) {
      if (existsSync(output)) unlinkSync(output);
      renameSync(found, output);
    }
    if (dataset.extracted) await verifyFile(output, dataset.extracted.sha256, dataset.extracted.bytes, false);
  }
  for (const remote of dataset.download.files || []) {
    if (!remote?.url || !remote.name || basename(remote.name) !== remote.name) throw new Error(`Invalid file download entry for ${key}.`);
    await downloadFile(remote.url, join(destination, remote.name), dataset.sha256?.[remote.name], dataset.bytes?.[remote.name] ?? remote.bytes);
  }
  console.log(`Extracted ${key} to ${output}`);
} else if (dataset.download.type === 'figshare') {
  mkdirSync(destination, { recursive: true });
  const metadata = await fetchJson(`https://api.figshare.com/v2/articles/${dataset.download.articleId}`);
  for (const name of dataset.download.files) {
    const remote = metadata.files?.find(entry => entry.name === name);
    if (!remote?.download_url) throw new Error(`Figshare article does not contain "${name}".`);
    await downloadFile(remote.download_url, join(destination, name), dataset.sha256?.[name], dataset.bytes?.[name]);
  }
} else if (dataset.download.type === 'files') {
  mkdirSync(destination, { recursive: true });
  for (const remote of dataset.download.files) {
    if (!remote?.url || !remote.name || basename(remote.name) !== remote.name) throw new Error(`Invalid file download entry for ${key}.`);
    await downloadFile(remote.url, join(destination, remote.name), dataset.sha256?.[remote.name], dataset.bytes?.[remote.name] ?? remote.bytes);
  }
} else {
  throw new Error(`Unsupported download type: ${dataset.download.type}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download metadata failed (${response.status} ${response.statusText}): ${url}`);
  return response.json();
}

// Fetches to <output>.part, verifies it, and only then renames into place: the final path is never
// half-written or unverified. An existing file is re-verified (not trusted) unless --force.
async function downloadFile(url, output, sha256, bytes) {
  if (existsSync(output) && !force) {
    console.log(`Keeping existing ${output}`);
    await verifyFile(output, sha256, bytes, false);
    return;
  }
  mkdirSync(resolve(output, '..'), { recursive: true });
  const part = `${output}.part`;
  console.log(`Downloading ${url}
  -> ${output}`);
  await prepareCertificateChain(url);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  const total = response.headers.get('content-encoding')
    ? Number(bytes) || 0
    : Number(response.headers.get('content-length')) || Number(bytes) || 0;
  const started = Date.now();
  let received = 0, lastReport = 0;
  const report = (done = false) => {
    const now = Date.now();
    if (!done && now - lastReport < 5000) return;
    lastReport = now;
    const seconds = Math.max(0.001, (now - started) / 1000), speed = received / seconds;
    const percent = total ? Math.min(100, received / total * 100) : null;
    const eta = total && speed ? Math.max(0, (total - received) / speed) : null;
    console.log(`[download:${key}] ${basename(output)} | ${percent == null ? '?' : percent.toFixed(1)}% | ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''} | ${formatBytes(speed)}/s | ETA ${eta == null ? 'unknown' : formatTime(eta)}`);
  };
  const meter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; report(); callback(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part));
  report(true);
  await verifyFile(part, sha256, bytes, true);
  renameSync(part, output);
}

async function prepareCertificateChain(url) {
  if (new URL(url).hostname !== 'bigwww.epfl.ch' || !tls.getCACertificates || !tls.setDefaultCACertificates) return;
  epflCaPromise ||= new Promise((resolveCa, rejectCa) => {
    httpsGet('https://cacerts.digicert.com/DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) return rejectCa(new Error(`Could not load EPFL certificate chain (${response.statusCode}).`));
        const intermediate = new X509Certificate(Buffer.concat(chunks)).toString();
        tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system'), intermediate]);
        resolveCa();
      });
    }).on('error', rejectCa);
  });
  await epflCaPromise;
}

function findFile(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = findFile(path, name); if (found) return found; }
  }
  return null;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes) || 0), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatTime(seconds) {
  seconds = Math.ceil(seconds);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil(seconds % 3600 / 60)}m`;
}

// Exits 1 when size or sha256 differ from the registry (removing the file if it is a .part); null = skipped.
async function verifyFile(path, sha256, bytes, isPart) {
  const name = basename(path).replace(/\.part$/, '');
  if (!sha256 && !bytes) {
    console.log(`  (no checksum in the registry for ${name}; not verified)`);
    return;
  }
  const actualBytes = statSync(path).size;
  let problem = bytes && actualBytes !== bytes ? `size expected ${bytes}, got ${actualBytes}` : null;
  if (!problem && sha256) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const actual = hash.digest('hex');
    if (actual !== sha256) problem = `sha256 expected ${sha256}, got ${actual}`;
  }
  if (problem) {
    console.error(`Checksum mismatch for ${name}: ${problem}.${isPart ? ' Download discarded.' : ' Re-run with --force to replace it.'}`);
    if (isPart) unlinkSync(path);
    process.exit(1);
  }
  console.log(`  verified ${name}`);
}
