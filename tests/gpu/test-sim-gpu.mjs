#!/usr/bin/env node
// Correctness gate for the simulator's summed-kernel splat, its counter-based camera-noise RNG, and
// (when WebGPU is available) the GPU frame stage that mirrors them.
// Deliberately SMALL (64 px frames, a 41-plane PSF, a few dozen emitters) so it runs in seconds on a
// laptop; bench-simulation.mjs is where the sizes that matter for speed live.
//
//  (a) pcg4d: the WGSL port produces the same u32 stream as pcg4dInto(), bit for bit.
//  (b) splatZernikeEmitter() (block sums, one interpolation per camera pixel) against the OLD
//      algorithm (interpolate every oversample^2 sub-cell, then sum), which is injected below as a
//      reference — it no longer exists in webSMLM.html. All four placement modes, emitters inside,
//      straddling and outside the frame edge, in-focus and defocused planes.
//  (c) GPU splat against CPU splat, noise-free.
//  (d) GPU camera noise against CPU camera noise on the same expectation image (sCMOS and EMCCD),
//      plus the noise statistics themselves.
//  (f) End to end: the same seeded Simulate movie (3D, haze, structured background, EMCCD and
//      sCMOS) generated on the CPU worker pool and on the GPU — events, splat and noise all agree,
//      so the two movies should match pixel for pixel up to f32 rounding.
import { launchPage, checkGpu } from '../lib/launch.mjs';

const { browser, page } = await launchPage({ headless: true });
let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed = true;
};
try {
  // Small, fast PSF: 41 planes (±400 nm at 20 nm), default kernel width and oversample.
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
    set('simulation_psfZRange', 400); set('simulation_psfZStep', 20); set('simulation_psfZernikePreset', 'astigModerate');
  });

  // ---- (b) summed-kernel splat vs the old per-sub-cell algorithm --------------------------------
  const b = await page.evaluate(async () => {
    // ---- reference: the pre-2026-09-21b splat, verbatim apart from the ref_ prefixes ----
    function ref_psfKernelAt(kernel, nx, ny, ix, iy){ if(ix<0||iy<0||ix>=nx||iy>=ny) return 0; return kernel[iy*nx+ix]; }
    function ref_nearest(kernel, nx, ny, x, y){ return ref_psfKernelAt(kernel, nx, ny, Math.round(x), Math.round(y)); }
    function ref_bilinear(kernel, nx, ny, x, y){
      const x0=Math.floor(x), y0=Math.floor(y), fx=x-x0, fy=y-y0;
      const v00=ref_psfKernelAt(kernel,nx,ny,x0,y0),   v10=ref_psfKernelAt(kernel,nx,ny,x0+1,y0);
      const v01=ref_psfKernelAt(kernel,nx,ny,x0,y0+1), v11=ref_psfKernelAt(kernel,nx,ny,x0+1,y0+1);
      return (v00*(1-fx)+v10*fx)*(1-fy) + (v01*(1-fx)+v11*fx)*fy;
    }
    function ref_bicubic(kernel, nx, ny, x, y){
      const x0=Math.floor(x), y0=Math.floor(y), wx=catmullRomWeights(x-x0), wy=catmullRomWeights(y-y0);
      let acc=0;
      for(let j=-1;j<=2;j++){ let row=0; for(let i=-1;i<=2;i++) row+=wx[i+1]*ref_psfKernelAt(kernel,nx,ny,x0+i,y0+j); acc+=wy[j+1]*row; }
      return acc;
    }
    function ref_sampleKernelAt(mode, kernel, nx, ny, x, y){
      if(mode==='nearest') return ref_nearest(kernel,nx,ny,x,y);
      if(mode==='cubic')   return ref_bicubic(kernel,nx,ny,x,y);
      return ref_bilinear(kernel,nx,ny,x,y);
    }
    function ref_splatFFT(img, w, h, mx, my, photons, kernelObj, camRad){
      const {kernel, nx, ny, oversample}=kernelObj;
      const kcx=(nx-1)/2, kcy=(ny-1)/2, X0=Math.round(mx), Y0=Math.round(my);
      const refX=kcx+(X0-mx-0.5)*oversample+0.5, refY=kcy+(Y0-my-0.5)*oversample+0.5;
      const shiftX=refX-Math.round(refX), shiftY=refY-Math.round(refY);
      const shifted=fftShiftKernelTile(kernel, nx, ny, shiftX, shiftY);
      for(let dy=-camRad; dy<=camRad; dy++){ const Y=Y0+dy; if(Y<0||Y>=h) continue; const baseY=kcy+(Y-my-0.5)*oversample;
        for(let dx=-camRad; dx<=camRad; dx++){ const X=X0+dx; if(X<0||X>=w) continue; const baseX=kcx+(X-mx-0.5)*oversample;
          let sum=0;
          for(let sy=0; sy<oversample; sy++){ const iy=Math.round(baseY+sy+0.5-shiftY);
            for(let sx=0; sx<oversample; sx++){ const ix=Math.round(baseX+sx+0.5-shiftX); sum+=ref_psfKernelAt(shifted, nx, ny, ix, iy); } }
          img[Y*w+X]+=photons*sum; } }
    }
    function ref_splat(img, w, h, mx, my, photons, kernelObj, camRad, interpMode){
      if(interpMode==='fft') return ref_splatFFT(img, w, h, mx, my, photons, kernelObj, camRad);
      const {kernel, nx, ny, oversample}=kernelObj;
      const kcx=(nx-1)/2, kcy=(ny-1)/2, X0=Math.round(mx), Y0=Math.round(my);
      for(let dy=-camRad; dy<=camRad; dy++){ const Y=Y0+dy; if(Y<0||Y>=h) continue; const baseY=kcy+(Y-my-0.5)*oversample;
        for(let dx=-camRad; dx<=camRad; dx++){ const X=X0+dx; if(X<0||X>=w) continue; const baseX=kcx+(X-mx-0.5)*oversample;
          let sum=0;
          for(let sy=0; sy<oversample; sy++){ const ky=baseY+sy+0.5;
            for(let sx=0; sx<oversample; sx++) sum+=ref_sampleKernelAt(interpMode, kernel, nx, ny, baseX+sx+0.5, ky); }
          img[Y*w+X]+=photons*sum; } }
    }
    // ---- fixture ----
    const cfg = readPsfConfigFromUI();
    const kstack = await getOrBuildPsfKernelStack(cfg);
    const W = 64, H = 64, os = cfg.oversample, camRad = Math.max(1, Math.ceil(cfg.halfWidthPx / os));
    const rng = mulberry32(99);
    const inside = Array.from({ length: 6 }, () => [4 + rng() * 56, 4 + rng() * 56]);
    const edges = [[-2.3, 30.1], [0.49, 0.51], [63.5, 12.25], [66.2, 70.7], [31.999, -0.5], [20.5, 63.5]];
    const out = [];
    for (const zi of [kstack.focusIndex, 3]) {
      const norm = normalizePsfPlane(kstack.slices[zi]).norm;
      for (const mode of ['nearest', 'linear', 'cubic', 'fft']) {
        const pts = mode === 'fft' ? [...inside.slice(0, 2), edges[0], edges[2]] : [...inside, ...edges];
        const plane = simKernelPlane(norm, kstack.nx, kstack.ny, os, mode);
        const objNew = { ...plane, nx: kstack.nx, ny: kstack.ny, oversample: os };
        const objOld = { kernel: norm, nx: kstack.nx, ny: kstack.ny, oversample: os };
        const a = new Float64Array(W * H), c = new Float64Array(W * H);
        let tNew = 0, tOld = 0;
        for (const [x, y] of pts) {
          let t = performance.now(); splatZernikeEmitter(a, W, H, x, y, 1000, objNew, camRad, mode); tNew += performance.now() - t;
          t = performance.now(); ref_splat(c, W, H, x, y, 1000, objOld, camRad, mode); tOld += performance.now() - t;
        }
        let peak = 0, maxd = 0, sa = 0, sc = 0;
        for (let i = 0; i < a.length; i++) { peak = Math.max(peak, Math.abs(c[i])); maxd = Math.max(maxd, Math.abs(a[i] - c[i])); sa += a[i]; sc += c[i]; }
        out.push({ zi, mode, n: pts.length, relMax: maxd / peak, relSum: Math.abs(sa - sc) / sc, tNew, tOld });
      }
    }
    return { camRad, nx: kstack.nx, os, out };
  });
  console.log(`(b) kernel ${b.nx}² oversample ${b.os}, camRad ${b.camRad}`);
  for (const r of b.out)
    check(`(b) summed splat = old splat  plane ${String(r.zi).padStart(2)} ${r.mode.padEnd(7)} (${r.n} emitters)`,
      r.relMax < 1e-5 && r.relSum < 1e-6,
      `max|Δ|/peak ${r.relMax.toExponential(2)}, Δsum ${r.relSum.toExponential(2)}, ${r.tOld.toFixed(0)} → ${r.tNew.toFixed(0)} ms`);

  // ---- noise statistics on the CPU (no GPU needed) ----------------------------------------------
  const st = await page.evaluate(() => {
    const res = {};
    for (const [type, lam] of [['scmos', 5], ['scmos', 200], ['emccd', 5], ['emccd', 200]]) {
      const n = 64 * 64 * 8, img = new Float32Array(n).fill(lam);
      const cam = { type, qe: 1, emGain: 1e6, cic: 0, bitDepth: 30 };
      // gain 1 ADU/e, zero read noise, zero offset: the ADU values ARE the counts
      applySimCameraNoise(img, new Float32Array(n), 1, 0, 777, 3, cam);
      let m = 0, v = 0; for (const x of img) m += x; m /= n; for (const x of img) v += (x - m) ** 2; v /= n - 1;
      res[`${type} λ=${lam}`] = { mean: m, fano: v / m };
    }
    // reproducible and address-only: the same (seed, frame) twice gives the same frame
    const a = new Float32Array(4096).fill(12), c = new Float32Array(4096).fill(12);
    applySimCameraNoise(a, new Float32Array(4096), 1, 2, 5, 9, { type: 'scmos' });
    applySimCameraNoise(c, new Float32Array(4096), 1, 2, 5, 9, { type: 'scmos' });
    res.repeat = a.every((x, i) => x === c[i]);
    return res;
  });
  for (const [k, r] of Object.entries(st)) if (k !== 'repeat') {
    const lam = Number(k.split('=')[1]), fanoWant = k.startsWith('emccd') ? 2 : 1;
    check(`noise statistics ${k}`, Math.abs(r.mean - lam) / lam < 0.02 && Math.abs(r.fano - fanoWant) < 0.08,
      `mean ${r.mean.toFixed(3)}, var/mean ${r.fano.toFixed(3)} (want ${fanoWant})`);
  }
  check('noise reproducible from (seed, frame)', st.repeat);

  // ---- which PSF evaluator is physically right on a wide kernel -----------------------------------
  // The removed 'direct' polar quadrature sampled the pupil at 40 angles and aliased beyond ~1.6 µm (660 nm, NA_eff
  // 1.33); on the default 6 µm kernel it put 17% of the light past 3 µm (the square's corners). An
  // exact Airy disk sampled on the same grid has 0.157% there.
  // Chirp-Z, now the only evaluator, must stay physical.
  const tail = await page.evaluate(async () => {
    const cfg = readPsfConfigFromUI(); cfg.nz = 1; cfg.zernikeCoeffs = cfg.zernikeCoeffs.map(() => 0);
    const nx = 2 * cfg.halfWidthPx + 1, c = (nx - 1) / 2, res = cfg.resLateralM * 1e6;
    const s = (await buildPsfPlanesSerial(cfg, nx, nx)).slices[0];
    let tot = 0, out3 = 0;
    for (let y = 0; y < nx; y++) for (let x = 0; x < nx; x++) { tot += s[y * nx + x]; if (Math.hypot(x - c, y - c) * res > 3) out3 += s[y * nx + x]; }
    return { frac: out3 / tot, halfUm: cfg.halfWidthPx * res };
  });
  check('chirp-Z PSF tail is physical (light beyond 3 µm < 1%)', tail.frac < 0.01,
    `${(100 * tail.frac).toFixed(2)}% on a ±${tail.halfUm.toFixed(1)} µm kernel (exact Airy on the same grid: 0.157%; the removed Direct quadrature gave ~17%)`);

  const gpu = await checkGpu(page);
  if (!gpu.available) console.log('GPU checks: SKIP (WebGPU unavailable)');
  else {
    // ---- (a) pcg4d and the uniform stream, WGSL vs JS, bit-exact ----
    const a = await page.evaluate(async () => {
      const engine = await getGpuEngine(), dev = engine.device, NPIX = 1 << 15, DRAWS = 8;
      const code = `${WGSL_SIM_NOISE_FNS}
@group(0) @binding(0) var<storage,read_write> o:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  let i=id.x; if(i>=${NPIX}u){return;}
  let v=pcg4d(vec4u(0x9e3779b9u, 17u, i, 3u));
  for(var k=0u;k<4u;k++){ o[i*${4 + DRAWS}u+k]=v[k]; }
  rngStart(12345u, 7u, i);
  for(var k=0u;k<${DRAWS}u;k++){ o[i*${4 + DRAWS}u+4u+k]=bitcast<u32>(uni()); }
}`;
      const pipe = await engine.compilePipeline('test-sim-rng', code, 'main');
      const bytes = NPIX * (4 + DRAWS) * 4;
      const buf = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const rd = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
      const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(NPIX / 64); pass.end();
      enc.copyBufferToBuffer(buf, 0, rd, 0, bytes); dev.queue.submit([enc.finish()]);
      await rd.mapAsync(GPUMapMode.READ); const g = new Uint32Array(rd.getMappedRange().slice(0)); rd.unmap();
      buf.destroy(); rd.destroy();
      const ref = new Uint32Array(4), fbits = new Float32Array(1), ubits = new Uint32Array(fbits.buffer);
      let mismatches = 0, n = 0;
      for (let i = 0; i < NPIX; i++) {
        pcg4dInto(0x9e3779b9, 17, i, 3, ref);
        for (let k = 0; k < 4; k++, n++) if (g[i * (4 + DRAWS) + k] !== ref[k]) mismatches++;
        const u = makeSimNoiseRng(12345, 7); u.pixel(i);
        for (let k = 0; k < DRAWS; k++, n++) { fbits[0] = u(); if (g[i * (4 + DRAWS) + 4 + k] !== ubits[0]) mismatches++; }
      }
      return { n, mismatches };
    });
    check('(a) pcg4d + uniforms: WGSL = JS, bit-exact', a.mismatches === 0, `${a.n.toLocaleString()} values compared, ${a.mismatches} mismatches`);

    // ---- (psf) GPU PSF planes = CPU chirp-Z planes, astigmatic and double helix ----
    // The device evaluates the transform's defining sum directly (two matrix products) instead of
    // chirp-Z, so the two may differ only by f32 rounding.
    const psf = await page.evaluate(async () => {
      const engine = await getGpuEngine(), out = {};
      for (const mask of ['none', 'doubleHelix']) {
        const cfg = readPsfConfigFromUI(); cfg.nz = 9; cfg.maskType = mask;
        const nx = 2 * cfg.halfWidthPx + 1;
        const cpu = await buildPsfPlanesSerial(cfg, nx, nx), gpu = await gpuPsfPlanes(engine, cfg, nx, nx);
        let worst = 0;
        for (let z = 0; z < cfg.nz; z++) for (let i = 0; i < nx * nx; i++)
          worst = Math.max(worst, Math.abs(cpu.slices[z][i] - gpu.slices[z][i]) / cpu.globalMax);
        out[mask] = worst;
      }
      return out;
    });
    for (const [mask, worst] of Object.entries(psf))
      check(`(psf) GPU PSF planes = CPU (mask ${mask}) within 1e-5 of peak`, worst < 1e-5, `worst ${worst.toExponential(2)} of peak`);

    // ---- (c) GPU splat = CPU splat, (d) GPU noise = CPU noise ----
    const cd = await page.evaluate(async () => {
      const engine = await getGpuEngine();
      const cfg = readPsfConfigFromUI(), kstack = await getOrBuildPsfKernelStack(cfg);
      const W = 64, H = 64, n = 6, rng = mulberry32(4242);
      const camRad = Math.max(1, Math.ceil(cfg.halfWidthPx / cfg.oversample));
      const frameEvents = Array.from({ length: n }, (_, fi) => Array.from({ length: 14 }, (_, k) =>
        [k < 3 ? [-3.2, 0.4, 66.1][k] : 2 + rng() * 60, 2 + rng() * 60, (rng() - 0.5) * 900, 0.3 + rng()]));
      const offsetMap = new Float32Array(W * H).map(() => 100 + 2 * rng());
      const bgMap = new Float32Array(W * H).map(() => 3 + 4 * rng());
      const out = { splat: [], noise: [] };
      for (const mode of ['nearest', 'linear', 'cubic']) for (const withMap of [false, true]) {
        const zks = { planes: null, nx: kstack.nx, ny: kstack.ny, oversample: cfg.oversample, camRad, interpMode: mode,
                      focusIndex: kstack.focusIndex, zStepNm: kstack.zStepNm, nz: kstack.nz };
        prepareSimKernelPlanes(zks, kstack.slices, frameEvents);
        const ctx = { w: W, h: H, n, bg: 5, bgMap: withMap ? bgMap : null, bgDecay: withMap ? 40 : 0, frameEvents, driftPx: 1.5, ddx: 0.6, ddy: 0.8,
                      photPerFrame: 2000, sigma: 1.3, rad: 4, zKernelStack: zks, zKernel: null, offsetMap, simGain: 0.8, readNoiseE: 1.6,
                      cam: { type: 'scmos' }, noiseSeed: 99, onProgress: () => {} };
        const gClean = await gpuSimFrames(engine, { ...simGpuSpecFromMovie(ctx), doNoise: false });
        let peak = 0, maxd = 0, sc = 0, sg = 0;
        for (let fi = 0; fi < n; fi++) {
          const dmag = fi / (n - 1) * ctx.driftPx;
          const cpu = splatSimFrame(W, H, withMap ? { map: bgMap, scale: simBgScale(fi, 40) } : 5, frameEvents[fi], dmag * 0.6, dmag * 0.8, 2000, 1.3, 4, zks, null).img;
          for (let i = 0; i < cpu.length; i++) { peak = Math.max(peak, cpu[i]); maxd = Math.max(maxd, Math.abs(cpu[i] - gClean.frames[fi][i])); sc += cpu[i]; sg += gClean.frames[fi][i]; }
        }
        out.splat.push({ label: `${mode.padEnd(7)} ${withMap ? 'bg map' : 'flat bg'}`, relMax: maxd / peak, relSum: Math.abs(sc - sg) / sc });
        if (mode !== 'cubic') continue;
        for (const cam of [{ type: 'scmos' }, { type: 'emccd', qe: 0.9, emGain: 300, cic: 0.005, bitDepth: 16 }]) {
          const c2 = { ...ctx, cam };
          const gNoisy = await gpuSimFrames(engine, simGpuSpecFromMovie(c2));
          let close = 0, tot = 0, maxAbs = 0;
          for (let fi = 0; fi < n; fi++) {
            const img = Float32Array.from(gClean.frames[fi]);
            applySimCameraNoise(img, offsetMap, c2.simGain, c2.readNoiseE, c2.noiseSeed, fi, cam);
            for (let i = 0; i < img.length; i++) { const d = Math.abs(img[i] - gNoisy.frames[fi][i]); tot++; if (d <= 1e-3) close++; maxAbs = Math.max(maxAbs, d); }
          }
          out.noise.push({ label: `${cam.type}${withMap ? ', bg map' : ''}`, fracClose: close / tot, maxAbs });
        }
      }
      return out;
    });
    for (const r of cd.splat)
      check(`(c) GPU splat = CPU splat  ${r.label}`, r.relMax < 2e-5 && r.relSum < 1e-5,
        `max|Δ|/peak ${r.relMax.toExponential(2)}, Δsum ${r.relSum.toExponential(2)}`);
    for (const r of cd.noise)
      check(`(d) GPU noise = CPU noise  ${r.label}`, r.fracClose >= 0.999,
        `${(100 * r.fracClose).toFixed(3)}% of pixels within 1e-3 ADU, max|Δ| ${r.maxAbs.toExponential(2)}`);

    const f = await page.evaluate(async () => {
      const set = (id, v) => { const el = document.getElementById(id); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; el.dispatchEvent(new Event('change')); };
      set('simulation_seed', 31); set('simulation_fov', 64); set('frames', 20); set('simulation_3d', true); set('simulation_zRange', 300);
      set('dens', 0.4); set('simbg', 8); set('simulation_bgCellContrast', 3); set('simulation_hazeRatio', 0.5);
      const out = [];
      for (const camType of ['scmos', 'emccd']) {
        set('simulation_cameraType', camType);
        const movies = [];
        for (const g of [false, true]) {
          set('useGpu', g);
          const st = await generateSynthetic();
          movies.push({ path: lastSimTimings.path, frames: await st.getFrames(0, st.n) });
        }
        let close = 0, tot = 0, maxAbs = 0;
        for (let fi = 0; fi < movies[0].frames.length; fi++) for (let i = 0; i < movies[0].frames[fi].length; i++) {
          const d = Math.abs(movies[0].frames[fi][i] - movies[1].frames[fi][i]); tot++; if (d <= 1e-3) close++; if (d > maxAbs) maxAbs = d; }
        out.push({ camType, paths: movies.map(m => m.path).join('/'), fracClose: close / tot, maxAbs });
      }
      set('useGpu', false); set('simulation_hazeRatio', 0); set('simulation_bgCellContrast', 1); set('simbg', 0);
      return out;
    });
    for (const r of f)
      check(`(f) seeded movie CPU = GPU  ${r.camType} (3D, haze, bg field)`, r.paths === 'cpu/gpu' && r.fracClose >= 0.999,
        `paths ${r.paths}, ${(100 * r.fracClose).toFixed(3)}% of pixels within 1e-3 ADU, max|Δ| ${r.maxAbs.toExponential(2)}`);

  }
} finally {
  await browser.close();
}
if (failed) { console.log('\nSOME CHECKS FAILED'); process.exitCode = 1; } else console.log('\nALL CHECKS PASSED');
