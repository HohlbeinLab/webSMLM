#!/usr/bin/env node
// Tilt/rotate view of a 3D reconstruction: packSrLocs3d() geometry (identity at 0°/0°, side view puts z
// on the vertical axis, 180° flips about the pivot, 360° = 0°, field-of-view culling, subsample cap,
// projected precision), then the interactive flow (enter freezes the field, angles re-render, controls
// and gizmo state, crop/measure locked, exit restores the reconstruction and the view).
import { launchPage } from '../lib/launch.mjs';
import assert from 'node:assert/strict';

const { browser, page } = await launchPage({ headless: true });
try {
  const g = await page.evaluate(() => {
    const rnd = mulberry32(11), locs = [];
    for (let i = 0; i < 3000; i++) locs.push({ x: 20 + rnd() * 60, y: 20 + rnd() * 60, z: rnd() * 600 - 300, lpx: 0.05, lpy: 0.08, lpz: 0.9 * 100 });
    const base = { bx0: 30, by0: 30, bx1: 70, by1: 70, X0: 50, Y0: 50, Z0: 0, ox: 12, oy: 7, px: 100 };
    const xfOf = (tilt, rot, maxN = 0) => { const th = tilt * Math.PI / 180, ph = rot * Math.PI / 180;
      return { ...base, ct: Math.cos(th), st: Math.sin(th), cr: Math.cos(ph), sr: Math.sin(ph), maxN }; };
    const pk = (t, r, mode = 'fixed', maxN = 0) => { const xf = xfOf(t, r, maxN); const P = packSrLocs3d(locs, 'z', true, mode, xf); return { P, xf }; };
    const inBox = locs.filter(L => L.x >= 30 && L.x < 70 && L.y >= 30 && L.y < 70);
    const a = pk(0, 0), s90 = pk(90, 0), s180 = pk(180, 0), r360 = pk(0, 360), r90 = pk(0, 90), prec = pk(60, 30, 'precision'), cap = pk(0, 0, 'fixed', 500);
    const maxd = (A, B, f) => { let m = 0; for (let i = 0; i < A.n; i++) m = Math.max(m, Math.abs(A[f][i] - B[f][i])); return m; };
    const L0 = inBox[5];
    // Pixel identity: normal render of the box's locs vs the 0°/0° 3D pack, whose domain origin is an integer srFull-px offset.
    const mag = 8, Ox = 100, Oy = 60, W = 800, H = 800, bxl = locs.filter(L => L.x >= 30 && L.x < 70 && L.y >= 30 && L.y < 70);
    const xi = xfOf(0, 0); xi.ox = Ox / mag; xi.oy = Oy / mag;
    const PN = packSrLocs(bxl, 'z', false, 'fixed'), P3 = packSrLocs3d(locs, 'z', false, 'fixed', xi);
    const rn = srRenderRegion(PN, null, W, H, 240, 240, 320, 320, 1, mag, 0, false, 0, 1, 'fixed', null);
    const r3 = srRenderRegion(P3, null, W, H, 240 - Ox, 240 - Oy, 320, 320, 1, mag, 0, false, 0, 1, 'fixed', null);
    let pixDiff = 0; for (let i = 0; i < rn.dv.length; i++) if (rn.dv[i] !== r3.dv[i]) pixDiff++;
    return {
      pixDiff, nIn: inBox.length, n0: a.P.n, nInReported: a.xf.nIn,
      ident: Math.max(...inBox.map((L, i) => Math.max(Math.abs(a.P.x[i] - (L.x - 12)), Math.abs(a.P.y[i] - (L.y - 7))))),
      zc: a.P.c[5] === L0.z,
      side: [s90.P.x[5] - (L0.x - 12), s90.P.y[5] - (50 - 7 - L0.z / 100)],
      flip: [s180.P.x[5] - (L0.x - 12), s180.P.y[5] - (2 * 50 - 7 - L0.y)],
      rot360: Math.max(maxd(a.P, r360.P, 'x'), maxd(a.P, r360.P, 'y')),
      rot90: [r90.P.x[5] - (50 - 12 + (L0.y - 50)), r90.P.y[5] - (50 - 7 - (L0.x - 50))],
      precHasLp: !!prec.P.lpx && prec.P.lpx.every(Number.isFinite),
      fixedNoLp: a.P.lpx === null,
      capN: cap.P.n, capIn: cap.xf.nIn,
    };
  });
  assert.equal(g.pixDiff, 0, 'top view = the normal render of the box, pixel for pixel');
  assert.equal(g.n0, g.nIn); assert.equal(g.nInReported, g.nIn);
  assert.ok(g.ident < 1e-9, `0°/0° identity ${g.ident}`);
  assert.ok(g.zc, 'colour stays the world z');
  assert.ok(Math.abs(g.side[0]) < 1e-9 && Math.abs(g.side[1]) < 1e-9, `side view ${g.side}`);
  assert.ok(Math.abs(g.flip[0]) < 1e-9 && Math.abs(g.flip[1]) < 1e-9, `180° flip ${g.flip}`);
  assert.ok(g.rot360 < 1e-9, `rotate 360 = 0: ${g.rot360}`);
  assert.ok(Math.abs(g.rot90[0]) < 1e-9 && Math.abs(g.rot90[1]) < 1e-9, `rotate 90 ${g.rot90}`);
  assert.ok(g.precHasLp && g.fixedNoLp, 'projected precision only in precision/dither modes');
  assert.ok(g.capN <= 500 && g.capN >= 250 && g.capIn === g.nIn, `drag subsample ${g.capN}`);
  console.log(`  geometry: identity, side view, 180° flip, rotate 90/360, culling (${g.nIn} in box), subsample cap (${g.capN})`);

  const f = await page.evaluate(async () => {
    const rnd = mulberry32(5), locs = [];
    for (let i = 0; i < 6000; i++) locs.push({ x: rnd() * 100, y: rnd() * 100, z: rnd() * 800 - 400, frame: 0, lpx: 0.05, lpy: 0.05, lpz: 60, photons: 800 });
    applyHeadlessResultToSession({ locs, w: 100, h: 100, px: 100, mag: 8 });
    $('mag').value = 8; await rerender(false);
    await new Promise(r => setTimeout(r, 400));
    const out = { before: [srFull.width, srFull.height], btn: $('view3dBtn').style.display !== 'none', ctlHidden: $('view3dCtl').style.display === 'none' };
    // zoom into the central quarter, then enter
    view.zoom = fitZoom() * 2; view.cx = srFull.width / 2; view.cy = srFull.height / 2; clampView(); drawView();
    const saved = { ...view }, cropWas = $('cropBtn').disabled;
    await enterView3D();
    out.on = view3d.on; out.vp = srFull === view3d.vp && !!srFull._viewport; out.ctl = $('view3dCtl').style.display !== 'none';
    out.cropLocked = $('cropBtn').disabled && $('measureBtn').disabled && !cropWas; out.projHidden = $('srProjToggleBtn').style.display === 'none';
    out.nBox = view3d.nBox; out.boxW = view3d.box.x1 - view3d.box.x0;
    out.side = view3d.side; out.dom = srFull.width;
    out.viewKept = Math.abs(view.zoom - saved.zoom) < 1e-9;
    const grab = async () => { const k = srFull.ovK; const img = await srViewportRegion(srFull, 0, 0, srFull.width, srFull.height, Math.max(k, 4)); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
    const d0 = await grab();
    await setView3D(90, 0, false); out.t90 = [view3d.tilt, view3d.rot, $('srTitle').textContent]; const d90 = await grab();
    await setView3D(90, 400, false); out.rotWrap = view3d.rot;
    await setView3D(200, 10, false); out.tiltClamp = view3d.tilt;
    let diff = 0; for (let i = 0; i < d0.length; i += 4) if (d0[i] + d0[i + 1] + d0[i + 2] !== d90[i] + d90[i + 1] + d90[i + 2]) diff++;
    out.diffPx = diff; out.fieldBtnOffAtTilt = $('view3dFieldBtn').disabled;
    await resetView3dAngles(); out.fieldBtnOn = !$('view3dFieldBtn').disabled;
    const d0b = await grab(); let same = true; for (let i = 0; i < d0.length; i++) if (d0[i] !== d0b[i]) { same = false; break; }
    out.resetSame = same;
    // The pivot follows the screen centre: pan the top view, then rotate; the pivot is the world point that was at the centre.
    await resetView3dAngles();
    const pv0 = [view3d.X0, view3d.Y0]; view.cx += 40; view.cy -= 24; const mg = view3d.mag, expect = [view3d.X0 + 40 / mg, view3d.Y0 - 24 / mg];
    await setView3D(0, 90, false);
    out.pivot = [view3d.X0 - expect[0], view3d.Y0 - expect[1]]; out.centred = Math.abs(view.cx - (view3d.X0 * mg - view3d.Ox)) < 1e-6;
    out.logTxt = $('logText').textContent;
    await exitView3D();
    out.off = !view3d.on; out.after = [srFull.width, srFull.height, !!srFull._viewport];
    out.cropBack = !$('cropBtn').disabled; out.ctlGone = $('view3dCtl').style.display === 'none';
    out.viewBack = Math.abs(view.zoom - saved.zoom) < 1e-9 && Math.abs(view.cx - saved.cx) < 1e-6 && Math.abs(view.cy - saved.cy) < 1e-6;
    return out;
  });
  assert.ok(f.btn && f.ctlHidden, 'button shown for a 3D result, controls hidden until entered');
  assert.ok(f.on && f.vp && f.ctl && f.cropLocked && f.projHidden, `entered: ${JSON.stringify(f)}`);
  assert.ok(f.nBox > 500 && f.nBox < 3000, `field frozen to the visible part: ${f.nBox}`);
  assert.ok(f.viewKept, 'entering keeps the on-screen scale');
  assert.deepEqual(f.t90.slice(0, 2), [90, 0]); assert.match(f.t90[2], /tilt 90° · rotate 0°/);
  assert.equal(f.rotWrap, 40); assert.equal(f.tiltClamp, 180);
  assert.ok(f.diffPx > 200, `side view differs from the top view (${f.diffPx} px)`);
  assert.ok(f.fieldBtnOffAtTilt && f.fieldBtnOn, 'Set field of view only at 0°/0°');
  assert.ok(f.resetSame, 'Reset angles reproduces the top view exactly');
  assert.ok(Math.abs(f.pivot[0]) < 1e-9 && Math.abs(f.pivot[1]) < 1e-9 && f.centred, `pivot follows the screen centre: ${JSON.stringify(f.pivot)}`);
  assert.ok(/enterView3D\(\)/.test(f.logTxt) && /setView3D\(90, 40\)|setView3D\(180, 10\)/.test(f.logTxt) && /setView3D\(0, 0\)/.test(f.logTxt), `commands logged: ${f.logTxt.slice(-300)}`);
  assert.ok(f.off && f.cropBack && f.ctlGone && f.viewBack, `exit restores: ${JSON.stringify(f)}`);
  assert.deepEqual(f.after.slice(0, 2), f.before, 'normal reconstruction size back');
  console.log('  interactive: enter freezes the field, angles re-render, reset = top view, exit restores view and controls');
  console.log('View3D: PASS');
} finally { await browser.close(); }
