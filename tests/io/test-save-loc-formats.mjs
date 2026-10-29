#!/usr/bin/env node
// Save localisations as .smlm and Picasso .hdf5 (buildSmlmBlob(), buildPicassoBlob()).
//   1. .smlm: read back in Python (zipfile + numpy: manifest, header names, units,
//      values in nm in ThunderSTORM's pixel-edge frame) and through Load data
//      (parseLocTableFile()) — every field within float32 rounding.
//   2. Picasso .hdf5: read back with h5py (compound dtype, /metadata JSON, values in
//      camera px, frames from 0), through Load data, and — when picasso is
//      importable (PICASSO_PYTHON, or python3 with picassosr) — with Picasso's own
//      io.load_locs() and export_thunderstorm().
//   3. A column missing for some locs (z) is left out of the Picasso file, with a note.
// Needs python3 with numpy and h5py; skips otherwise.
import { launchPage, repoRoot } from '../lib/launch.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const python = process.env.PYTHON || 'python3';
try { execFileSync(python, ['-c', 'import h5py, numpy'], { stdio: 'ignore' }); }
catch { console.log('Skipping — python3 with h5py/numpy not found (set PYTHON=<path> to a Python that has them).'); process.exit(0); }
const picassoPython = process.env.PICASSO_PYTHON || python;
let havePicasso = true;
try { execFileSync(picassoPython, ['-c', 'import picasso.io'], { stdio: 'ignore' }); } catch { havePicasso = false; }

const dir = mkdtempSync(join(tmpdir(), 'websmlm-saveloc-'));
const py = (exe, code, ...args) => execFileSync(exe, ['-I', '-c', code, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const PX = 107;

const { browser, page } = await launchPage({ headless: true });
try {
  await page.evaluate(px => { window.PX0 = px; $('pxnm').value = px; $('pxnm').dispatchEvent(new Event('change')); }, PX);
  // Three loc sets: 2D (some with per-axis widths), 3D complete, 3D with z missing for some.
  const out = await page.evaluate(async px => {
    let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const mk = (n, kind, ell = false) => Array.from({ length: n }, (_, i) => {
      const L = { frame: Math.floor(rnd() * 400), x: rnd() * 63 + 0.25, y: rnd() * 47 + 0.25, photons: 300 + rnd() * 9000, bg: rnd() * 50, bgstd: 1 + rnd() * 3,
                  sigma: 1 + rnd() * 0.5, lpx: 0.03 + rnd() * 0.2, lpy: 0.03 + rnd() * 0.2 };
      if (ell && i % 2) { L.sx = 1 + rnd() * 0.4; L.sy = 1 + rnd() * 0.4; L.angle = rnd(); }
      if (kind !== '2d') { L.z = (rnd() - 0.5) * 800; L.lpz = 10 + rnd() * 30; }
      if (kind === 'zpartial' && i % 7 === 0) { L.z = NaN; L.lpz = NaN; }
      return L;
    });
    const sets = { '2d': mk(300, '2d', true), '3d': mk(200, '3d'), zpartial: mk(200, 'zpartial') };
    sets['2d'][5].x = -0.25;   // Picasso discards negative positions on load
    const b64 = async blob => { const u8 = new Uint8Array(await blob.arrayBuffer()); let r = ''; for (let i = 0; i < u8.length; i += 32768) r += String.fromCharCode(...u8.subarray(i, i + 32768)); return btoa(r); };
    const res = {};
    for (const [k, locs] of Object.entries(sets)) {
      const smlm = await buildSmlmBlob(locs, px, 1.3, `${k}.smlm`), pic = await buildPicassoBlob(locs, px, 1.3, `${k}.hdf5`);
      // Load data on the written bytes
      const reSmlm = await parseLocTableFile(new File([smlm], `${k}.smlm`), {});
      const rePic = await parseLocTableFile(new File([pic.blob], `${k}.hdf5`), {});
      const pick = L => ({ frame: L.frame, x: L.x, y: L.y, z: L.z ?? null, photons: L.photons, bg: L.bg, sigma: L.sigma, lpx: L.lpx, lpy: L.lpy, lpz: L.lpz ?? null, sx: L.sx ?? null, sy: L.sy ?? null });
      const clean = v => (typeof v === 'number' && !isFinite(v)) ? null : v;
      const norm = L => Object.fromEntries(Object.entries(pick(L)).map(([a, v]) => [a, clean(v)]));
      res[k] = { locs: locs.map(norm), smlm: await b64(smlm), hdf5: await b64(pic.blob), notes: pic.notes,
                 reSmlm: reSmlm.locs.map(norm), rePic: rePic.locs.map(norm), picMeta: rePic.picassoMeta };
    }
    return res;
  }, PX);

  const close = (a, b, tol, what) => assert.ok(a === b || (a !== null && b !== null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))), `${what}: ${a} vs ${b}`);
  for (const [k, r] of Object.entries(out)) {
    const smlmPath = join(dir, `${k}.smlm`), h5Path = join(dir, `${k}.hdf5`);
    writeFileSync(smlmPath, Buffer.from(r.smlm, 'base64')); writeFileSync(h5Path, Buffer.from(r.hdf5, 'base64'));
    writeFileSync(join(dir, `${k}.json`), JSON.stringify(r.locs));

    // ---- .smlm: independent decode in Python ----
    const dec = JSON.parse(py(python, `
import zipfile, json, sys, numpy as np
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
man = json.loads(z.read('manifest.json')); fmt = list(man['formats'].values())[0]; fi = man['files'][0]
raw = z.read(fi['name']); h = fmt['headers']; assert len(h) == len(fmt['dtype']) == len(fmt['units']) == len(fmt['shape']) == fmt['columns']
a = np.frombuffer(raw, dtype=np.dtype([(n, '<u4' if t == 'uint32' else '<f4') for n, t in zip(h, fmt['dtype'])]))
assert len(a) == fi['rows']
print(json.dumps({'headers': h, 'units': fmt['units'], 'rows': int(len(a)), 'first': {n: (None if np.isnan(a[n][0]) else float(a[n][0])) for n in h}}))`, smlmPath));
    assert.deepEqual(dec.headers.slice(0, 3), ['frame', 'x', 'y']);
    assert.equal(dec.rows, r.locs.length);
    assert.equal(dec.units[1], 'nm');
    const L0 = r.locs[0];
    assert.equal(dec.first.frame, L0.frame + 1, `${k}: .smlm frames are 1-based`);
    close(dec.first.x, (L0.x + 0.5) * PX, 1e-6, `${k} .smlm x in nm, pixel-edge frame`);
    close(dec.first.y, (L0.y + 0.5) * PX, 1e-6, `${k} .smlm y`);
    // ---- .smlm through Load data ----
    r.locs.forEach((L, i) => { const B = r.reSmlm[i];
      assert.equal(B.frame, L.frame); for (const f of ['x', 'y', 'photons', 'bg', 'sigma']) close(B[f], L[f], 2e-6, `${k} .smlm reload row ${i} ${f}`);
      const rms = Math.sqrt((L.lpx ** 2 + L.lpy ** 2) / 2);   // one precision per loc, as in the CSV
      close(B.lpx, rms, 2e-6, `${k} .smlm lpx`); close(B.lpy, rms, 2e-6, `${k} .smlm lpy`);
      if (L.z !== null) { close(B.z, L.z, 2e-6, `${k} z`); close(B.lpz, L.lpz, 2e-6, `${k} lpz`); } else assert.equal(B.z, null, `${k} row ${i}: missing z stays missing`); });
    console.log(`  ${k}: .smlm — ${dec.rows} rows × ${dec.headers.length} columns decoded in Python; Load data returns every field`);

    // ---- .hdf5: h5py ----
    const h5 = JSON.parse(py(python, `
import h5py, json, sys, numpy as np
f = h5py.File(sys.argv[1], 'r'); d = f['locs'][...]; meta = json.loads(f['metadata'][()].decode() if isinstance(f['metadata'][()], bytes) else f['metadata'][()])
print(json.dumps({'names': list(d.dtype.names), 'types': [str(d.dtype[n]) for n in d.dtype.names], 'n': int(len(d)), 'first': {n: float(d[n][0]) for n in d.dtype.names}, 'meta': meta}))`, h5Path));
    assert.deepEqual(h5.names.slice(0, 9), ['frame', 'x', 'y', 'photons', 'sx', 'sy', 'bg', 'lpx', 'lpy']);
    assert.equal(h5.types[0], 'uint32'); assert.ok(h5.types.slice(1).every(t => t === 'float32'));
    assert.equal(h5.n, r.locs.length);
    assert.equal(h5.first.frame, L0.frame); close(h5.first.x, L0.x, 2e-6, `${k} hdf5 x in camera px, centres at i`);
    assert.equal(h5.meta[0].Pixelsize, PX); assert.ok(h5.meta[0].Width >= 64 && h5.meta[0].Height >= 48 && h5.meta[0].Frames >= 1);
    if (k === 'zpartial') { assert.ok(!h5.names.includes('z'), 'z is missing for some locs: left out'); assert.ok(r.notes.some(n => n.includes('z') && n.includes('left out'))); }
    else if (k === '3d') { assert.ok(h5.names.includes('z') && h5.names.includes('lpz')); close(h5.first.z, L0.z, 2e-6, '3d hdf5 z (nm)'); }
    // ---- .hdf5 through Load data ----
    r.locs.forEach((L, i) => { const B = r.rePic[i];
      assert.equal(B.frame, L.frame); for (const f of ['x', 'y', 'photons', 'bg', 'lpx', 'lpy']) close(B[f], L[f], 2e-6, `${k} hdf5 reload row ${i} ${f}`); });
    assert.equal(r.picMeta.pixelsize, PX);
    // ---- .hdf5 with Picasso itself ----
    if (havePicasso) {
      const pc = JSON.parse(py(picassoPython, `
import sys, json, numpy as np
from picasso import io
locs, info = io.load_locs(sys.argv[1]); io.export_thunderstorm(sys.argv[2], locs, info)
print(json.dumps({'n': int(len(locs)), 'cols': list(locs.columns), 'x0': float(locs['x'].iloc[0]), 'px': info[0]['Pixelsize']}))`, h5Path, join(dir, `${k}_ts.csv`)));
      const nNeg = r.locs.filter(L => L.x < 0 || L.y < 0).length;
      assert.equal(pc.n, r.locs.length - nNeg, `${k}: Picasso keeps every row but the negative positions`);
      assert.equal(pc.px, PX); close(pc.x0, L0.x, 2e-6, `${k} Picasso x`);
      console.log(`  ${k}: .hdf5 — h5py, Load data and Picasso io.load_locs() agree (${pc.n} rows kept${nNeg ? `, ${nNeg} negative dropped by Picasso` : ''}); columns ${pc.cols.join(', ')}`);
    } else console.log(`  ${k}: .hdf5 — h5py and Load data agree (Picasso not installed: set PICASSO_PYTHON to check with io.load_locs())`);
  }
  // CSV: ThunderSTORM skips any row with an empty cell, so a column that is empty for some locs is left out whole.
  const csv = await page.evaluate(() => {
    const base = i => ({ frame: i, x: 1 + i, y: 2 + i, photons: 1000, bg: 2, bgstd: 1, sigma: 1.2, lpx: 0.1, lpy: 0.1 });
    const part = Array.from({ length: 6 }, (_, i) => ({ ...base(i), z: i % 3 ? i * 10 : NaN, lpz: 12, D_coeff: i < 2 ? 0.5 : undefined, track_id: i }));
    const full = Array.from({ length: 6 }, (_, i) => ({ ...base(i), z: i * 10, lpz: 12 }));
    const f = locs => { const r = buildCsvText(locs, 100, 1.3), lines = r.parts.join('').trim().split('\n'); return { head: lines[0], omitted: r.omitted, empty: lines.slice(1).filter(l => l.split(',').some(c => c === '')).length }; };
    return { part: f(part), full: f(full) };
  });
  assert.deepEqual(csv.part.omitted, ['z [nm]', 'D_coeff [um^2/s]']);
  assert.ok(!csv.part.head.includes('z [nm]') && !csv.part.head.includes('D_coeff') && csv.part.head.includes('track_id') && !csv.part.head.includes('sigma_z'), csv.part.head);   // sigma_z goes with z
  assert.equal(csv.part.empty, 0, 'no row of the CSV has an empty cell');
  assert.deepEqual(csv.full.omitted, []); assert.ok(csv.full.head.includes('z [nm]')); assert.equal(csv.full.empty, 0);
  console.log('  CSV: a column empty for some localizations (z, D_coeff) is left out and named; complete columns stay');
  // Headless: analyze({exportLocFormats}) returns Blobs; the CLI streams the same files (--exportSmlm --exportPicasso).
  const csvIn = ['"id [webSMLM]","frame","x [nm]","y [nm]","sigma [nm]","intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]"',
    ...Array.from({ length: 400 }, (_, i) => `${i + 1},${1 + (i % 20)},${1000 + 13 * i},${800 + 7 * i},130,${900 + i},5,2,15`)].join('\n') + '\n';
  const head = await page.evaluate(async text => {
    const r = await window.webSMLM.analyze({ file: new File([text], 'in.csv'), pxnm: PX0, exportLocFormats: ['smlm', 'hdf5'] });
    let bad = null; try { await window.webSMLM.analyze({ file: new File([text], 'in.csv'), pxnm: PX0, exportLocFormats: ['xml'] }); } catch (e) { bad = e.message; }
    return { smlm: r.locFiles.smlm.size, hdf5: r.locFiles.hdf5.size, bad };
  }, csvIn);
  assert.ok(head.smlm > 1000 && head.hdf5 > 1000, JSON.stringify(head)); assert.match(head.bad, /exportLocFormats lists "xml"/);
  const inCsv = join(dir, 'in.csv'); writeFileSync(inCsv, csvIn);
  execFileSync('node', [join(repoRoot, 'tools', 'webSMLM-cli.mjs'), '--file', inCsv, '--pxnm', String(PX), '--exportSmlm', '--exportPicasso', '--out', join(dir, 'cli')], { stdio: 'ignore' });
  const cli = JSON.parse(py(python, `
import zipfile, json, sys, h5py, numpy as np
z = zipfile.ZipFile(sys.argv[1] + '/result.smlm'); assert z.testzip() is None
man = json.loads(z.read('manifest.json')); n = man['files'][0]['rows']
f = h5py.File(sys.argv[1] + '/result.hdf5', 'r'); d = f['locs'][...]
print(json.dumps({'smlm_rows': n, 'h5_rows': int(len(d)), 'x0': float(d['x'][0]), 'px': json.loads(f['metadata'][()])[0]['Pixelsize']}))`, join(dir, 'cli')));
  assert.equal(cli.smlm_rows, 400); assert.equal(cli.h5_rows, 400); assert.equal(cli.px, PX);
  close(cli.x0, 1000 / PX - 0.5, 2e-6, 'CLI hdf5 x');
  console.log('  analyze({exportLocFormats}) returns Blobs; the CLI writes result.smlm / result.hdf5 (400 rows, read in Python)');
  // The button path without the File System Access API: each format downloads under the name of the source stack.
  for (const [fmt, ext] of [['csv', '.csv'], ['smlm', '.smlm'], ['hdf5', '.hdf5']]) {
    await page.evaluate(() => {
      window.showSaveFilePicker = undefined; stackName = 'movie.ome.tif';
      lastResult = { locs: [{ frame: 0, x: 3.25, y: 7.75, photons: 1000, bg: 2, bgstd: 1, sigma: 1.2, lpx: 0.1, lpy: 0.1 }], w: 64, h: 48, px: 107 };
    });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(f => ({ csv: exportCSV, smlm: exportSmlm, hdf5: exportPicasso })[f](), fmt)]);
    assert.equal(dl.suggestedFilename(), 'movie_locs' + ext);
  }
  console.log('  exportCSV() / exportSmlm() / exportPicasso(): download as movie_locs.csv / .smlm / .hdf5');
  console.log('Save localisation formats: PASS');
} finally { await browser.close(); }
