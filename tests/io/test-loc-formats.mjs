#!/usr/bin/env node
// Localization-table loading (Load data): CSV and .smlm share one column
// mapper (makeLocColumnMapper()).
//   1. CSV: the mapper reproduces the pre-mapper parseCsvLocs() (taken from
//      git, commit 194ade8) exactly, on a CSV with every optional column and
//      empty cells.
//   2. .smlm: a synthetic archive (deflate and stored entries, uint32/float64/
//      float32 columns, a shaped column to skip, a per-column offset, µm units)
//      loads to the expected values.
//   3. A real .smlm (ShareLoc export, optional) loads every row; first and last
//      rows match an independent decode in Node.
import { launchPage, repoRoot } from '../lib/launch.mjs';
import { resolveDataFile } from '../lib/data.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

// ---- a tiny ZIP writer (stored or deflate), enough for test archives ----
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {   // [{name, data:Buffer, deflate:bool}]
  const locals = [], central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), body = e.deflate ? zlib.deflateRawSync(e.data) : e.data, crc = crc32(e.data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body); central.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const dir = mkdtempSync(join(tmpdir(), 'websmlm-locfmt-'));
const PX = 100;

// ---- 1. CSV with every optional column, some cells empty ----
const csvHeader = '"id","frame","x [nm]","y [nm]","z [nm]","sigma [nm]","sigma_x [nm]","sigma_y [nm]","angle [deg]","intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]","sigma_z [nm]","dist [nm]","x2 [nm]","y2 [nm]","pairAngle [deg]","sigma1st [nm]","sx0th [nm]","sy0th [nm]","sx1st [nm]","sy1st [nm]","sx_AA [nm]","sy_AA [nm]","n_merged [frames]","track_id","D_coeff [um^2/s]","cell_id","cell_area [px]","llr"';
const csvRows = [
  '1,1,1234.5,2345.6,-120.3,130.2,120.1,140.4,12.5,1500.2,10.1,3.2,12.3,25.1,850.2,1300.1,2400.2,45.5,140.3,120,130,140,150,160,170,2,7,0.12,3,250,-0.45',
  '2,3,50.1,60.2,,0,,,,800,0,0,,,,,,,,,,,,,,,,,,,',
  '3,10,99999.9,12.5,10,150,100,200,-30,20000,5,1,5,8,0.5,1,2,3,4,5,6,7,8,9,10,0,-1,,-1,0,-0.2',
];
const csvText = [csvHeader, ...csvRows].join('\n');
const oldHtml = execFileSync('git', ['show', '194ade8:webSMLM.html'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });
const oldParse = oldHtml.slice(oldHtml.indexOf('function parseCsvLocs(text){'), oldHtml.indexOf('\n}\n', oldHtml.indexOf('function parseCsvLocs(text){')) + 2);

// ---- 2. synthetic .smlm ----
const N = 5;
const rowLen = 4 + 8 + 4 + 4 * 4 + 4;   // frame u32, x f64, y f32, patch 2x2 u32, intensity f32
const bin = Buffer.alloc(N * rowLen);
const truth = [];
for (let i = 0; i < N; i++) {
  const o = i * rowLen, fr = 1 + 2 * i, xUm = 1.5 + i * 0.25, yUm = 0.75 + i * 0.1, I = 1000 + i;
  bin.writeUInt32LE(fr, o); bin.writeDoubleLE(xUm, o + 4); bin.writeFloatLE(yUm, o + 12);
  for (let k = 0; k < 4; k++) bin.writeUInt32LE(99, o + 16 + 4 * k);
  bin.writeFloatLE(I, o + 32);
  truth.push({ frame: fr - 1, x: (xUm + 0.5) * 1000 / PX, y: Math.fround(yUm) * 1000 / PX, photons: I });
}
const manifest = {
  format_version: '0.2',
  formats: { 'smlm-table(binary)': { type: 'table', mode: 'binary', extension: '.bin', columns: 5,
    headers: ['frame', 'x', 'y', 'raw-patch', 'intensity'], dtype: ['uint32', 'float64', 'float32', 'uint32', 'float32'],
    shape: [1, 1, 1, [2, 2], 1], units: ['frame', 'um', 'um', 'photon', 'photon'] } },
  files: [{ name: 'table1.bin', type: 'table', format: 'smlm-table(binary)', channel: 'default', rows: N, offset: { x: 0.5 } }],
};
const smlmDeflate = join(dir, 'synthetic.smlm'), smlmStored = join(dir, 'synthetic-stored.smlm');
writeFileSync(smlmDeflate, makeZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)), deflate: true }, { name: 'table1.bin', data: bin, deflate: true }]));
writeFileSync(smlmStored, makeZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: 'table1.bin', data: bin }]));

const { browser, page } = await launchPage({ headless: true });
try {
  await page.evaluate(px => { $('pxnm').value = px; $('pxnm').dispatchEvent(new Event('change')); }, PX);

  const csv = await page.evaluate(({ csvText, oldParse }) => {
    const oldFn = (0, eval)('(' + oldParse + ')');
    const a = oldFn(csvText), b = parseCsvLocs(csvText);
    // Property order differs (header order now); compare the values.
    const canon = r => JSON.stringify({ ...r, locs: r.locs.map(L => Object.fromEntries(Object.keys(L).sort().map(k => [k, L[k]]))) });
    return { a: canon(a), b: canon(b), n: b.locs.length };
  }, { csvText, oldParse });
  assert.equal(csv.b, csv.a, 'new CSV mapper differs from the old parser');
  console.log(`  CSV: ${csv.n} rows with all optional columns identical to the previous parser`);

  for (const path of [smlmDeflate, smlmStored]) {
    await page.setInputFiles('#file', path);
    await page.waitForFunction(n => lastResult && lastResult.fromCsv && lastResult.locs.length === n, N, { timeout: 30000 });
    const got = await page.evaluate(() => lastResult.locs.map(L => ({ frame: L.frame, x: L.x, y: L.y, photons: L.photons })));
    for (let i = 0; i < N; i++) for (const k of ['frame', 'x', 'y', 'photons'])
      assert.ok(Math.abs(got[i][k] - truth[i][k]) < 1e-6, `${path} row ${i} ${k}: ${got[i][k]} vs ${truth[i][k]}`);
    console.log(`  .smlm (${path.includes('stored') ? 'stored' : 'deflate'}): ${N} rows, µm units, offset and skipped 2x2 column correct`);
  }

  // Headless: analyze() takes a .smlm like a .csv.
  const head = await page.evaluate(async b64 => {
    const r = await window.webSMLM.analyze({ file: new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'synthetic.smlm'), pxnm: 100 });
    return { n: r.locs ? r.locs.length : null, csv: (r.csvText || (r.csvParts || []).join('')).split('\n').length };
  }, (await import('node:fs')).readFileSync(smlmDeflate).toString('base64'));
  assert.equal(head.n, N, `analyze() on .smlm: ${JSON.stringify(head)}`);
  console.log(`  analyze({file:'….smlm'}): ${head.n} locs`);

  // ---- 3. real ShareLoc .smlm (optional) ----
  const local = join(repoRoot, 'experimental_data', 'data.smlm');
  const real = existsSync(local) ? local : await resolveDataFile('SHARELOC_SMLM', 'shareloc/data.smlm');
  if (!real) console.log('  real .smlm: skipped (no file)');
  else {
    // Independent decode in Node: inflate the table entry, read rows 0, 1 and last.
    const fd = openSync(real, 'r'), size = statSync(real).size, tail = Buffer.alloc(Math.min(size, 65557));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdOff = tail.readUInt32LE(e + 16), cdSize = tail.readUInt32LE(e + 12), cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOff);
    const ents = {};
    for (let p = 0; p < cdSize;) {
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      ents[cd.toString('utf8', p + 46, p + 46 + nl)] = { csize: cd.readUInt32LE(p + 20), local: cd.readUInt32LE(p + 42), method: cd.readUInt16LE(p + 10) };
      p += 46 + nl + xl + cl;
    }
    const entryBytes = name => { const en = ents[name], lh = Buffer.alloc(30); readSync(fd, lh, 0, 30, en.local);
      const body = Buffer.alloc(en.csize); readSync(fd, body, 0, en.csize, en.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
      return en.method === 8 ? zlib.inflateRawSync(body) : body; };
    const man = JSON.parse(entryBytes('manifest.json').toString('utf8'));
    const fi = man.files[0], fmt = man.formats[fi.format], tbl = entryBytes(fi.name);
    closeSync(fd);
    const rl = fmt.headers.length * 4, col = h => fmt.headers.indexOf(h) * 4;
    const ref = r => ({ frame: tbl.readFloatLE(r * rl + col('frame')) - 1, x: tbl.readFloatLE(r * rl + col('x')) / PX, y: tbl.readFloatLE(r * rl + col('y')) / PX,
      photons: tbl.readFloatLE(r * rl + col('intensity_photon_')), sigma: tbl.readFloatLE(r * rl + col('sigma_nm_')) / PX, lpx: tbl.readFloatLE(r * rl + col('uncertainty_nm_')) / PX });
    const t0 = Date.now();
    await page.setInputFiles('#file', real);
    await page.waitForFunction(n => lastResult && lastResult.fromCsv && lastResult.locs.length === n, fi.rows, { timeout: 600000, polling: 1000 });
    const ms = Date.now() - t0;
    const last = fi.rows - 1;
    const got = await page.evaluate(idx => idx.map(i => { const L = lastResult.locs[i]; return { frame: L.frame, x: L.x, y: L.y, photons: L.photons, sigma: L.sigma, lpx: L.lpx }; }), [0, 1, last]);
    [0, 1, last].forEach((r, i) => { const want = ref(r);
      for (const k of Object.keys(want)) assert.ok(Math.abs(got[i][k] - want[k]) <= 1e-9 * Math.max(1, Math.abs(want[k])), `real row ${r} ${k}: ${got[i][k]} vs ${want[k]}`); });
    console.log(`  real .smlm: ${fi.rows.toLocaleString()} rows in ${(ms / 1000).toFixed(1)} s; rows 0, 1 and last match a Node decode`);
  }
  console.log('Localization formats: PASS');
} finally { await browser.close(); }
