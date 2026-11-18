// Shared by tests/cpu/test-point-cloud.mjs and tests/gpu/test-point-cloud-gpu.mjs: a Run on a small simulated
// movie with Render as = Bitmap, then the same Run with Render as = Point cloud. Reports, for each, the bitmap
// renders and point-cloud index builds made while runCore() ran, the point-cloud frames that reached the panel
// meanwhile (_pcFramesDrawn) and whether srFull was the live point cloud (_pcOnly); after the point-cloud Run,
// whether its final image equals a point cloud built afresh from the final locs, and the live display maximum
// (pcLiveNorm() over all the locs) against the final bitmap's.
// method: a fit method for the Run ('gaussls' fits on the CPU, so a GPU-session Run lasts long enough to have
// several previews while the point cloud stays on the GPU).
export async function pointCloudRunCheck(page, { useGpu, frames = 2000, fov = 64, method = null }) {
  return page.evaluate(async ({ useGpu, frames, fov, method }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    $('useGpu').checked = useGpu; $('useGpu').dispatchEvent(new Event('change'));
    for (const [k, v] of Object.entries({ frames, simulation_fov: fov, simulation_seed: 5, simulation_psfModel: 'gaussian', simulation_structureType: 'uniform3D', dens: 1 })) {
      const el = $(k); el.value = v; el.dispatchEvent(new Event('change')); }
    await runSimulation();
    const method0 = $('method').value; if (method) { $('method').value = method; $('method').dispatchEvent(new Event('change')); }
    paramOverrides.srPreviewMs = 50; paramOverrides.srPreviewMaxMs = 400;   // frequent previews, so a short Run has several
    const oRS = renderSuperRes, oRG = renderSuperResGpu, oB = pcBuildIndex, oRC = runCore;
    let c = null;
    renderSuperRes = function (...a) { if (c && c.inRun) c.bitmap++; return oRS.apply(this, a); };
    renderSuperResGpu = function (...a) { if (c && c.inRun) c.bitmap++; return oRG.apply(this, a); };
    pcBuildIndex = function (...a) { if (c && c.inRun) c.builds++; return oB.apply(this, a); };
    runCore = async function (...a) { c.inRun = true; try { return await oRC.apply(this, a); } finally { c.inRun = false; c.runMs = performance.now() - c.t0; } };
    const frameImg = async () => {
      await sleep(useGpu ? 300 : SR_PATCH_DELAY_MS + 900);
      const q = srFull._pc && srFull._pc.frame; if (!q) return null;
      const t = document.createElement('canvas'); t.width = q.img.width; t.height = q.img.height;
      t.getContext('2d').drawImage(q.img, 0, 0); return t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    };
    const out = {};
    try {
      for (const mode of ['bitmap', 'pointCloud']) {
        $('renderAs').value = mode; $('renderAs').dispatchEvent(new Event('change'));
        await rerender(true);   // the previous result redrawn in this mode before the Run starts
        c = { inRun: false, bitmap: 0, builds: 0, t0: performance.now(), frames0: _pcFramesDrawn, framesDuringRun: 0, pcOnlyPolls: 0, polls: 0, tailPolls: 0, maxLocsShown: 0 };
        const p = run();
        while (!c.inRun && $('runBtn').disabled) await sleep(5);
        while (c.inRun) {
          c.polls++;
          if (srFull && srFull._pcOnly) { c.pcOnlyPolls++; c.maxLocsShown = Math.max(c.maxLocsShown, _pcIndex ? _pcIndex.key.n : 0); }
          if (_pcIndex && _pcIndex.tn > 0) c.tailPolls++;
          c.framesDuringRun = _pcFramesDrawn - c.frames0;
          await sleep(15);
        }
        await p;
        const r = { runMs: c.runMs, totalMs: performance.now() - c.t0, bitmapDuringRun: c.bitmap, buildsDuringRun: c.builds, framesDuringRun: c.framesDuringRun,
          pcOnlyPolls: c.pcOnlyPolls, polls: c.polls, tailPolls: c.tailPolls, maxLocsShown: c.maxLocsShown, locs: lastResult.locs.length };
        if (mode === 'pointCloud') {
          const a = await frameImg(), normFinal = srFull._pc && srFull._pc.norm;
          r.where = srFull._pc && srFull._pc.index.where; r.finalPc = !!srFull._pc && !srFull._pcOnly;
          const p0 = lastResult.locs, mag = paramValue('mag');
          _pcLiveNorm = null;
          r.liveNorm = pcLiveNorm(p0, lastResult.w, lastResult.h, mag, paramValue('rblur'), paramValue('renderMode'), !!srFull._zColor, srFull._zlo, srFull._zhi, 'z', +paramValue('lutpct'));
          r.bitmapNorm = srImageNorm(srFull); r.pcNorm = normFinal;
          pcForgetIndex(); await rerender(true);
          const b = await frameImg();
          let bad = 0; if (a && b && a.length === b.length) { for (let k = 0; k < a.length; k += 4) if (Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2])) > 1) bad++; }
          else bad = -1;
          r.finalVsFresh = bad; r.px = a ? a.length / 4 : 0;
        }
        out[mode] = r;
      }
    } finally { renderSuperRes = oRS; renderSuperResGpu = oRG; pcBuildIndex = oB; runCore = oRC; delete paramOverrides.srPreviewMs; delete paramOverrides.srPreviewMaxMs; $('method').value = method0; $('method').dispatchEvent(new Event('change')); }
    return out;
  }, { useGpu, frames, fov, method });
}

// The assertions both tests make on pointCloudRunCheck()'s result, and its summary line.
export function assertPointCloudRun(assert, r, label) {
  const pc = r.pointCloud, bm = r.bitmap;
  assert.ok(pc.framesDuringRun >= 2 && pc.pcOnlyPolls > 0, `(g) ${label}: no live point cloud during the Run ${JSON.stringify(pc)}`);
  assert.equal(pc.bitmapDuringRun, 0, `(g) ${label}: bitmap previews rendered during a point-cloud Run`);
  assert.ok(pc.buildsDuringRun <= 1, `(g) ${label}: ${pc.buildsDuringRun} index builds during the Run (one, then extended)`);
  assert.ok(pc.finalPc && pc.finalVsFresh === 0, `(g) ${label}: final image vs a fresh point cloud: ${pc.finalVsFresh} of ${pc.px} px differ`);
  assert.ok(Math.abs(pc.liveNorm / pc.bitmapNorm - 1) < 0.1, `(g) ${label}: live display max ${pc.liveNorm} vs the bitmap's ${pc.bitmapNorm}`);
  assert.ok(bm.bitmapDuringRun > 0 && bm.pcOnlyPolls === 0, `(g) ${label}: Bitmap mode previews ${JSON.stringify(bm)}`);
  return `  (g) ${label} Run, ${pc.locs.toLocaleString()} locs: ${pc.framesDuringRun} point-cloud frames during the Run (index ${pc.where}, ${pc.buildsDuringRun} build, a tail in ${pc.tailPolls}/${pc.polls} polls), no bitmap preview; final image = a fresh point cloud (${pc.px.toLocaleString()} px); live display max ${(pc.liveNorm / pc.bitmapNorm).toFixed(3)} × the bitmap's; Run ${(pc.runMs / 1000).toFixed(2)} s vs ${(bm.runMs / 1000).toFixed(2)} s in Bitmap mode (${bm.bitmapDuringRun} bitmap previews)`;
}
