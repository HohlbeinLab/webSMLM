#!/usr/bin/env node
// Rendering-speed benchmark for webSMLM.html's two large-FOV-sensitive draw
// paths: renderSuperRes() (SR reconstruction, MODULE: render) and drawRaw()'s
// per-pixel contrast-mapping loop (raw-panel/streaming draw). A companion to
// webSMLM-cli.mjs, same Playwright/file:// pattern, but purely a timing
// harness — it never touches a real file, it synthesizes locs/frames and
// times the drawing functions directly via page.evaluate()/addScriptTag().
//
// Usage:
//   cd tools && npm install   (once, if not already done for webSMLM-cli.mjs)
//   node bench_render.mjs           # full sweep
//   node bench_render.mjs --quick   # fewer repeats/combos, for iterating on this script itself
//
// Candidate variants (injected into the page as real global functions
// alongside the existing ones — none of this touches webSMLM.html) are
// defined in VARIANTS_SRC below, each reusing the app's own existing helpers
// (boxInto/blur/getLUT/displayMax/checkRenderSize) so they measure a genuine
// alternative implementation, not a toy reimplementation.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const htmlUrl = pathToFileURL(join(repoRoot, 'webSMLM.html')).href;
const quick = process.argv.includes('--quick');

// ---------------------------------------------------------------------------
// Candidate variants, injected as real page-global functions via addScriptTag
// (not stringified page.evaluate closures) so they read like normal JS and
// can freely call the app's own already-global helpers.
// ---------------------------------------------------------------------------
const VARIANTS_SRC = `
// ---- renderSuperRes variants -----------------------------------------------

// Baseline is the app's own renderSuperRes() — no wrapper needed.

// Box-blur variant: swaps the true-Gaussian blur() for the 3-pass box cascade
// (boxInto/boxSizes) already used for detection's own background term
// (MODULE: detect) — same signature shape as blur(), same sigma argument.
function renderSuperResBoxBlur(locs,w,h,mag,blurPx,lutName,pct,zColor,zlo,zhi,normLocs,colorField='z',onLog=()=>{}){
  const W=w*mag, H=h*mag;
  checkRenderSize(W,H,w,h,mag,zColor,blurPx);
  const acc=new Uint16Array(W*H), zacc=zColor?new Float32Array(W*H):null;
  for(const L of locs){
    if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
    const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
    if(ix<0||iy<0||ix>=W||iy>=H) continue; const idx=iy*W+ix;
    if(acc[idx]<65535) acc[idx]++;
    if(zColor) zacc[idx]+=L[colorField]; }
  const boxSigma = blurPx*mag*0.3;
  const buf = blurPx>0 ? boxInto(acc,new Float32Array(W*H),new Float32Array(W*H),W,H,boxSigma) : acc;
  const zbuf = zColor ? (blurPx>0 ? boxInto(zacc,new Float32Array(W*H),new Float32Array(W*H),W,H,boxSigma) : zacc) : null;
  let normBuf=buf;
  if(normLocs && normLocs!==locs){
    const nacc=new Uint16Array(W*H);
    for(const L of normLocs){
      if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
      const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
      if(ix<0||iy<0||ix>=W||iy>=H) continue;
      const nidx=iy*W+ix; if(nacc[nidx]<65535) nacc[nidx]++; }
    normBuf = blurPx>0 ? boxInto(nacc,new Float32Array(W*H),new Float32Array(W*H),W,H,boxSigma) : nacc;
  }
  const norm=displayMax(normBuf,pct), lut=getLUT(lutName), zspan=Math.max(1e-9,zhi-zlo);
  const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
  const ctx=cv.getContext('2d'), out=ctx.createImageData(W,H);
  for(let i=0;i<buf.length;i++){
    const t=norm>0?Math.min(1,Math.sqrt(buf[i]/norm)):0;
    let j;
    if(zColor){ const meanz=buf[i]>0?zbuf[i]/buf[i]:zlo;
      j=(Math.max(0,Math.min(1,(meanz-zlo)/zspan))*255)|0;
      out.data[i*4]=lut[j*3]*t; out.data[i*4+1]=lut[j*3+1]*t; out.data[i*4+2]=lut[j*3+2]*t; }
    else{ j=(t*255)|0; out.data[i*4]=lut[j*3]; out.data[i*4+1]=lut[j*3+1]; out.data[i*4+2]=lut[j*3+2]; }
    out.data[i*4+3]=255; }
  ctx.putImageData(out,0,0); return cv;
}

// Persistent-buffer variant: reuses acc/zacc/canvas/ImageData across calls of
// the same W×H (the common "just dragged a slider" case in rerender()),
// instead of allocating fresh typed arrays + canvas + ImageData every call.
// Typed arrays must be explicitly zeroed on reuse (no auto-clear).
const _rsrCache = {};
function renderSuperResPersist(locs,w,h,mag,blurPx,lutName,pct,zColor,zlo,zhi,normLocs,colorField='z',onLog=()=>{}){
  const W=w*mag, H=h*mag;
  checkRenderSize(W,H,w,h,mag,zColor,blurPx);
  const key=W+'x'+H;
  let c = _rsrCache[key];
  if(!c || c.zColor!==zColor){
    c = _rsrCache[key] = {
      acc:new Uint16Array(W*H), zacc:zColor?new Float32Array(W*H):null,
      cv:document.createElement('canvas'), zColor
    };
    c.cv.width=W; c.cv.height=H;
  } else {
    c.acc.fill(0); if(c.zacc) c.zacc.fill(0);
  }
  const acc=c.acc, zacc=c.zacc;
  for(const L of locs){
    if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
    const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
    if(ix<0||iy<0||ix>=W||iy>=H) continue; const idx=iy*W+ix;
    if(acc[idx]<65535) acc[idx]++;
    if(zColor) zacc[idx]+=L[colorField]; }
  const buf = blurPx>0 ? blur(acc,W,H,blurPx*mag*0.3) : acc;
  const zbuf = zColor ? (blurPx>0 ? blur(zacc,W,H,blurPx*mag*0.3) : zacc) : null;
  let normBuf=buf;
  if(normLocs && normLocs!==locs){
    const nacc=new Uint16Array(W*H);
    for(const L of normLocs){
      if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
      const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
      if(ix<0||iy<0||ix>=W||iy>=H) continue;
      const nidx=iy*W+ix; if(nacc[nidx]<65535) nacc[nidx]++; }
    normBuf = blurPx>0 ? blur(nacc,W,H,blurPx*mag*0.3) : nacc;
  }
  const norm=displayMax(normBuf,pct), lut=getLUT(lutName), zspan=Math.max(1e-9,zhi-zlo);
  const ctx=c.cv.getContext('2d'), out=ctx.createImageData(W,H);
  for(let i=0;i<buf.length;i++){
    const t=norm>0?Math.min(1,Math.sqrt(buf[i]/norm)):0;
    let j;
    if(zColor){ const meanz=buf[i]>0?zbuf[i]/buf[i]:zlo;
      j=(Math.max(0,Math.min(1,(meanz-zlo)/zspan))*255)|0;
      out.data[i*4]=lut[j*3]*t; out.data[i*4+1]=lut[j*3+1]*t; out.data[i*4+2]=lut[j*3+2]*t; }
    else{ j=(t*255)|0; out.data[i*4]=lut[j*3]; out.data[i*4+1]=lut[j*3+1]; out.data[i*4+2]=lut[j*3+2]; }
    out.data[i*4+3]=255; }
  ctx.putImageData(out,0,0); return c.cv;
}

// Fused variant: precomputed sqrt lookup table for the density->brightness
// step (t=sqrt(buf[i]/norm)) instead of a Math.sqrt() call per pixel.
// _BENCH_-prefixed (not _SQRT_LUT_N/_sqrtLut) — this variant's own finding is
// exactly what webSMLM.html's real renderSuperResPixels() now does, under
// those unprefixed names, at module scope. addScriptTag() injects this whole
// string as a SECOND top-level script into the SAME page, so declaring
// _SQRT_LUT_N here would re-declare an identifier the page already has — a
// SyntaxError that fails this entire injected script silently (every variant
// function below goes undefined, baseline still "works" since it's the
// app's own real function, and every other page.evaluate() call then throws
// "fn is not a function" downstream). Confirmed by reproducing it.
const _BENCH_SQRT_LUT_N=65536, _benchSqrtLut=new Float32Array(_BENCH_SQRT_LUT_N+1);
for(let i=0;i<=_BENCH_SQRT_LUT_N;i++) _benchSqrtLut[i]=Math.sqrt(i/_BENCH_SQRT_LUT_N);
function renderSuperResFused(locs,w,h,mag,blurPx,lutName,pct,zColor,zlo,zhi,normLocs,colorField='z',onLog=()=>{}){
  const W=w*mag, H=h*mag;
  checkRenderSize(W,H,w,h,mag,zColor,blurPx);
  const acc=new Uint16Array(W*H), zacc=zColor?new Float32Array(W*H):null;
  for(const L of locs){
    if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
    const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
    if(ix<0||iy<0||ix>=W||iy>=H) continue; const idx=iy*W+ix;
    if(acc[idx]<65535) acc[idx]++;
    if(zColor) zacc[idx]+=L[colorField]; }
  const buf = blurPx>0 ? blur(acc,W,H,blurPx*mag*0.3) : acc;
  const zbuf = zColor ? (blurPx>0 ? blur(zacc,W,H,blurPx*mag*0.3) : zacc) : null;
  let normBuf=buf;
  if(normLocs && normLocs!==locs){
    const nacc=new Uint16Array(W*H);
    for(const L of normLocs){
      if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
      const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
      if(ix<0||iy<0||ix>=W||iy>=H) continue;
      const nidx=iy*W+ix; if(nacc[nidx]<65535) nacc[nidx]++; }
    normBuf = blurPx>0 ? blur(nacc,W,H,blurPx*mag*0.3) : nacc;
  }
  const norm=displayMax(normBuf,pct), lut=getLUT(lutName), zspan=Math.max(1e-9,zhi-zlo);
  const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
  const ctx=cv.getContext('2d'), out=ctx.createImageData(W,H);
  const invNorm = norm>0 ? 1/norm : 0;
  for(let i=0;i<buf.length;i++){
    const r = norm>0 ? Math.min(1,buf[i]*invNorm) : 0;
    const t = _benchSqrtLut[(r*_BENCH_SQRT_LUT_N)|0];
    let j;
    if(zColor){ const meanz=buf[i]>0?zbuf[i]/buf[i]:zlo;
      j=(Math.max(0,Math.min(1,(meanz-zlo)/zspan))*255)|0;
      out.data[i*4]=lut[j*3]*t; out.data[i*4+1]=lut[j*3+1]*t; out.data[i*4+2]=lut[j*3+2]*t; }
    else{ j=(t*255)|0; out.data[i*4]=lut[j*3]; out.data[i*4+1]=lut[j*3+1]; out.data[i*4+2]=lut[j*3+2]; }
    out.data[i*4+3]=255; }
  ctx.putImageData(out,0,0); return cv;
}

// Combined: persistent buffers + fused sqrt-LUT colorize, on top of the
// REAL Gaussian blur (blurInto), not the box cascade — boxInto's boxV() pass
// (column-major: outer loop over x, inner over y) turns out to be
// catastrophically cache-unfriendly at SR-render buffer sizes (tens of
// millions of pixels, each row far larger than L1/L2), unlike at the much
// smaller camera-frame sizes it was validated for in MODULE: detect. See the
// box-cascade rejection note in the benchmark report — boxBlur is kept as
// its own separate (losing) variant above for the record, not folded in here.
const _rsrCombCache = {};
function renderSuperResCombined(locs,w,h,mag,blurPx,lutName,pct,zColor,zlo,zhi,normLocs,colorField='z',onLog=()=>{}){
  const W=w*mag, H=h*mag;
  checkRenderSize(W,H,w,h,mag,zColor,blurPx);
  const key=W+'x'+H;
  let c = _rsrCombCache[key];
  if(!c || c.zColor!==zColor){
    c = _rsrCombCache[key] = {
      acc:new Uint16Array(W*H), zacc:zColor?new Float32Array(W*H):null,
      cv:document.createElement('canvas'), zColor
    };
    c.cv.width=W; c.cv.height=H;
  } else {
    c.acc.fill(0); if(c.zacc) c.zacc.fill(0);
  }
  const acc=c.acc, zacc=c.zacc;
  for(const L of locs){
    if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
    const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
    if(ix<0||iy<0||ix>=W||iy>=H) continue; const idx=iy*W+ix;
    if(acc[idx]<65535) acc[idx]++;
    if(zColor) zacc[idx]+=L[colorField]; }
  const buf = blurPx>0 ? blur(acc,W,H,blurPx*mag*0.3) : acc;
  const zbuf = zColor ? (blurPx>0 ? blur(zacc,W,H,blurPx*mag*0.3) : zacc) : null;
  let normBuf=buf;
  if(normLocs && normLocs!==locs){
    const nacc=new Uint16Array(W*H);
    for(const L of normLocs){
      if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
      const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
      if(ix<0||iy<0||ix>=W||iy>=H) continue;
      const nidx=iy*W+ix; if(nacc[nidx]<65535) nacc[nidx]++; }
    normBuf = blurPx>0 ? blur(nacc,W,H,blurPx*mag*0.3) : nacc;
  }
  const norm=displayMax(normBuf,pct), lut=getLUT(lutName), zspan=Math.max(1e-9,zhi-zlo);
  const ctx=c.cv.getContext('2d'), out=ctx.createImageData(W,H);
  const invNorm = norm>0 ? 1/norm : 0;
  for(let i=0;i<buf.length;i++){
    const r = norm>0 ? Math.min(1,buf[i]*invNorm) : 0;
    const t = _benchSqrtLut[(r*_BENCH_SQRT_LUT_N)|0];
    let j;
    if(zColor){ const meanz=buf[i]>0?zbuf[i]/buf[i]:zlo;
      j=(Math.max(0,Math.min(1,(meanz-zlo)/zspan))*255)|0;
      out.data[i*4]=lut[j*3]*t; out.data[i*4+1]=lut[j*3+1]*t; out.data[i*4+2]=lut[j*3+2]*t; }
    else{ j=(t*255)|0; out.data[i*4]=lut[j*3]; out.data[i*4+1]=lut[j*3+1]; out.data[i*4+2]=lut[j*3+2]; }
    out.data[i*4+3]=255; }
  ctx.putImageData(out,0,0); return c.cv;
}

// Persist-all: like "combined" (persistent acc/zacc/canvas + fused sqrt-LUT),
// PLUS calling blurInto() directly with persistent dst/tmp scratch instead of
// the blur() wrapper, which allocates 2 fresh W*H Float32Arrays EVERY call
// even in the other persist/fused/combined variants above (they all still
// call blur()). At the largest buffer sizes this turned out to be the real
// dominant allocation cost, not acc/zacc/ImageData — this variant isolates
// that specific remaining win.
const _rsrAllCache = {};
function renderSuperResPersistAll(locs,w,h,mag,blurPx,lutName,pct,zColor,zlo,zhi,normLocs,colorField='z',onLog=()=>{}){
  const W=w*mag, H=h*mag;
  checkRenderSize(W,H,w,h,mag,zColor,blurPx);
  const key=W+'x'+H;
  let c = _rsrAllCache[key];
  if(!c || c.zColor!==zColor){
    c = _rsrAllCache[key] = {
      acc:new Uint16Array(W*H), zacc:zColor?new Float32Array(W*H):null,
      blurDst:new Float32Array(W*H), blurTmp:new Float32Array(W*H),
      zBlurDst:zColor?new Float32Array(W*H):null, zBlurTmp:zColor?new Float32Array(W*H):null,
      cv:document.createElement('canvas'), zColor
    };
    c.cv.width=W; c.cv.height=H;
  } else {
    c.acc.fill(0); if(c.zacc) c.zacc.fill(0);
  }
  const acc=c.acc, zacc=c.zacc;
  for(const L of locs){
    if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
    const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
    if(ix<0||iy<0||ix>=W||iy>=H) continue; const idx=iy*W+ix;
    if(acc[idx]<65535) acc[idx]++;
    if(zColor) zacc[idx]+=L[colorField]; }
  const buf = blurPx>0 ? blurInto(acc,c.blurDst,c.blurTmp,W,H,blurPx*mag*0.3) : acc;
  const zbuf = zColor ? (blurPx>0 ? blurInto(zacc,c.zBlurDst,c.zBlurTmp,W,H,blurPx*mag*0.3) : zacc) : null;
  let normBuf=buf;
  if(normLocs && normLocs!==locs){
    const nacc=new Uint16Array(W*H);
    for(const L of normLocs){
      if(zColor && (!isFinite(L[colorField])||L[colorField]<zlo||L[colorField]>zhi)) continue;
      const ix=Math.round(L.x*mag), iy=Math.round(L.y*mag);
      if(ix<0||iy<0||ix>=W||iy>=H) continue;
      const nidx=iy*W+ix; if(nacc[nidx]<65535) nacc[nidx]++; }
    normBuf = blurPx>0 ? blurInto(nacc,new Float32Array(W*H),new Float32Array(W*H),W,H,blurPx*mag*0.3) : nacc;
  }
  const norm=displayMax(normBuf,pct), lut=getLUT(lutName), zspan=Math.max(1e-9,zhi-zlo);
  const ctx=c.cv.getContext('2d'), out=ctx.createImageData(W,H);
  const invNorm = norm>0 ? 1/norm : 0;
  for(let i=0;i<buf.length;i++){
    const r = norm>0 ? Math.min(1,buf[i]*invNorm) : 0;
    const t = _benchSqrtLut[(r*_BENCH_SQRT_LUT_N)|0];
    let j;
    if(zColor){ const meanz=buf[i]>0?zbuf[i]/buf[i]:zlo;
      j=(Math.max(0,Math.min(1,(meanz-zlo)/zspan))*255)|0;
      out.data[i*4]=lut[j*3]*t; out.data[i*4+1]=lut[j*3+1]*t; out.data[i*4+2]=lut[j*3+2]*t; }
    else{ j=(t*255)|0; out.data[i*4]=lut[j*3]; out.data[i*4+1]=lut[j*3+1]; out.data[i*4+2]=lut[j*3+2]; }
    out.data[i*4+3]=255; }
  ctx.putImageData(out,0,0); return c.cv;
}

// ---- drawRaw core-loop variants --------------------------------------------
// These isolate just the O(w*h) contrast-mapping loop drawRaw() does
// (webSMLM.html's drawRaw(), lines ~5757-5769), not the full function (which
// also touches the live #raw DOM canvas, view state, etc. — out of scope for
// a pure per-pixel-cost comparison).

function rawCoreBaseline(frame,w,h,mn,mx){
  const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
  const ctx=cv.getContext('2d'), im=ctx.createImageData(w,h);
  for(let i=0;i<frame.length;i++){ const t=mx>mn?(frame[i]-mn)/(mx-mn):0, g=t*255;
    im.data[i*4]=g;im.data[i*4+1]=g;im.data[i*4+2]=g;im.data[i*4+3]=255; }
  ctx.putImageData(im,0,0);
  return cv;
}

// Precomputed LUT: the ADU->grayscale mapping only depends on mn/mx, which
// stay fixed across scrub/stream bursts — rebuilt only when they change.
const _rawLutCache={mn:null,mx:null,lut:null};
function rawLutFor(mn,mx){
  if(_rawLutCache.mn===mn && _rawLutCache.mx===mx) return _rawLutCache.lut;
  const N=65536, lut=new Uint8ClampedArray(N);
  for(let v=0; v<N; v++){ const t=mx>mn?(v-mn)/(mx-mn):0; lut[v]=t*255; }
  _rawLutCache.mn=mn; _rawLutCache.mx=mx; _rawLutCache.lut=lut;
  return lut;
}
function rawCoreLUT(frame,w,h,mn,mx){
  const lut=rawLutFor(mn,mx);
  const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
  const ctx=cv.getContext('2d'), im=ctx.createImageData(w,h);
  for(let i=0;i<frame.length;i++){ const v=frame[i]; const g=lut[v<0?0:(v>65535?65535:v)|0];
    im.data[i*4]=g;im.data[i*4+1]=g;im.data[i*4+2]=g;im.data[i*4+3]=255; }
  ctx.putImageData(im,0,0);
  return cv;
}

// Persistent ImageData: reuse the backing store across same-size calls.
const _rawPersistCache={};
function rawCorePersist(frame,w,h,mn,mx){
  const key=w+'x'+h;
  let c=_rawPersistCache[key];
  if(!c){ c=_rawPersistCache[key]={cv:document.createElement('canvas')}; c.cv.width=w; c.cv.height=h;
    c.ctx=c.cv.getContext('2d'); c.im=c.ctx.createImageData(w,h); }
  const im=c.im;
  for(let i=0;i<frame.length;i++){ const t=mx>mn?(frame[i]-mn)/(mx-mn):0, g=t*255;
    im.data[i*4]=g;im.data[i*4+1]=g;im.data[i*4+2]=g;im.data[i*4+3]=255; }
  c.ctx.putImageData(im,0,0);
  return c.cv;
}

// Combined: LUT + persistent ImageData together.
const _rawCombCache={};
function rawCoreCombined(frame,w,h,mn,mx){
  const lut=rawLutFor(mn,mx);
  const key=w+'x'+h;
  let c=_rawCombCache[key];
  if(!c){ c=_rawCombCache[key]={cv:document.createElement('canvas')}; c.cv.width=w; c.cv.height=h;
    c.ctx=c.cv.getContext('2d'); c.im=c.ctx.createImageData(w,h); }
  const im=c.im;
  for(let i=0;i<frame.length;i++){ const v=frame[i]; const g=lut[v<0?0:(v>65535?65535:v)|0];
    im.data[i*4]=g;im.data[i*4+1]=g;im.data[i*4+2]=g;im.data[i*4+3]=255; }
  c.ctx.putImageData(im,0,0);
  return c.cv;
}
`;

// ---------------------------------------------------------------------------
// Sweep definitions
// ---------------------------------------------------------------------------
// (w,h,mag) combos kept within CANVAS_MAX_DIM (16384/side) and a generous
// memory budget (set below) — chosen to reach large W×H via both "large FOV,
// modest mag" and "modest FOV, high mag" shapes.
const RENDER_COMBOS = quick ? [
  { w: 512, h: 512, mag: 16 },   // combo where persist/fused/combined underperformed
  { w: 4096, h: 4096, mag: 3 },  // combo where persist/fused/combined underperformed
] : [
  { w: 512, h: 512, mag: 16 },   // 8192x8192
  { w: 1024, h: 1024, mag: 8 },  // 8192x8192, different FOV/mag split
  { w: 2048, h: 2048, mag: 5 },  // 10240x10240, large FOV
  { w: 4096, h: 4096, mag: 3 },  // 12288x12288, largest FOV tested
];
const RENDER_LOC_COUNT = quick ? 20000 : 50000;
// boxBlur already confirmed a consistent, worsening-with-size loser in the
// quick run (0.87x -> 0.27x) — its boxV() pass is column-major (outer loop
// over x, inner over y) and thrashes cache badly once a row no longer fits
// comfortably in L2, unlike at the much smaller camera-frame sizes it was
// validated for in MODULE: detect. Left out of the full sweep to save time;
// the two quick-run data points are enough to reject it. See bench_render
// output notes at the bottom of this file's git history / the report.
const RENDER_VARIANTS = ['baseline', 'persist', 'fused', 'combined', 'persistAll'];
const RENDER_REPEATS = quick ? 2 : 3;

const RAW_SIZES = quick ? [1024, 4096] : [512, 1024, 2048, 4096];
const RAW_VARIANTS = ['baseline', 'lut', 'persist', 'combined'];
const RAW_BURST = quick ? 6 : 30; // consecutive calls, simulating a scrub/stream burst

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function fmtTable(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const line = r => r.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  const out = [line(headers), widths.map(w => '-'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

console.log(`Launching Chromium (headless)...`);
// --expose-gc lets each variant force a GC before its own timed block, so an
// earlier variant's leftover garbage (multi-hundred-MB typed arrays at the
// largest combos) doesn't randomly stall a later variant's measurement.
const browser = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc'] });
const page = await browser.newPage();
page.on('console', msg => { if (msg.type() === 'error') console.log('  [page error] ' + msg.text()); });

try {
  await page.goto(htmlUrl);
  await page.waitForFunction(() => window.webSMLM && window.webSMLM.analyze);
  await page.addScriptTag({ content: VARIANTS_SRC });
  // Raise the Memory budget so checkRenderSize() never blocks a benchmark
  // combo — this only affects this headless page's own DOM state.
  await page.evaluate(() => { const el = document.getElementById('memgb'); if (el) el.value = 64; });

  // -------------------------------------------------------------------
  // renderSuperRes() sweep
  // -------------------------------------------------------------------
  console.log(`\n=== renderSuperRes() — ${RENDER_LOC_COUNT.toLocaleString()} locs, ${RENDER_REPEATS} repeats/combo ===\n`);
  const renderRows = [];
  for (const { w, h, mag } of RENDER_COMBOS) {
    for (const blurPx of [0, 1.5]) {
      const baselineMs = await page.evaluate(({ w, h, mag, blurPx, n, reps }) => {
        const locs = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, z: 0 }));
        const fn = window['renderSuperRes'];
        fn(locs, w, h, mag, blurPx, 'fire', 99.5, false, 0, 0, locs); // warm-up
        if (window.gc) window.gc();
        const times = [];
        for (let i = 0; i < reps; i++) { const t0 = performance.now(); fn(locs, w, h, mag, blurPx, 'fire', 99.5, false, 0, 0, locs); times.push(performance.now() - t0); }
        return times;
      }, { w, h, mag, blurPx, n: RENDER_LOC_COUNT, reps: RENDER_REPEATS });
      const baseMed = median(baselineMs);
      renderRows.push([`${w}x${h}`, mag, `${w * mag}x${h * mag}`, blurPx, 'baseline', baseMed.toFixed(1), '1.00x']);
      console.log(`  ${w}x${h} mag=${mag} blurPx=${blurPx} baseline: ${baseMed.toFixed(1)}ms`);

      for (const variant of RENDER_VARIANTS) {
        if (variant === 'baseline') continue;
        if (variant === 'boxBlur' && blurPx === 0) continue; // identical to baseline when blur is off
        const fnName = { boxBlur: 'renderSuperResBoxBlur', persist: 'renderSuperResPersist', fused: 'renderSuperResFused', combined: 'renderSuperResCombined', persistAll: 'renderSuperResPersistAll' }[variant];
        const ms = await page.evaluate(({ w, h, mag, blurPx, n, reps, fnName }) => {
          const locs = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, z: 0 }));
          const fn = window[fnName];
          fn(locs, w, h, mag, blurPx, 'fire', 99.5, false, 0, 0, locs); // warm-up
          if (window.gc) window.gc();
          const times = [];
          for (let i = 0; i < reps; i++) { const t0 = performance.now(); fn(locs, w, h, mag, blurPx, 'fire', 99.5, false, 0, 0, locs); times.push(performance.now() - t0); }
          return times;
        }, { w, h, mag, blurPx, n: RENDER_LOC_COUNT, reps: RENDER_REPEATS, fnName });
        const med = median(ms);
        renderRows.push([`${w}x${h}`, mag, `${w * mag}x${h * mag}`, blurPx, variant, med.toFixed(1), (baseMed / med).toFixed(2) + 'x']);
        console.log(`  ${w}x${h} mag=${mag} blurPx=${blurPx} ${variant}: ${med.toFixed(1)}ms (${(baseMed / med).toFixed(2)}x)`);
      }
    }
  }
  console.log(fmtTable(renderRows, ['FOV', 'mag', 'W×H', 'blurPx', 'variant', 'median ms', 'speedup']));

  // -------------------------------------------------------------------
  // drawRaw() core-loop sweep
  // -------------------------------------------------------------------
  console.log(`\n=== drawRaw() contrast-mapping loop — ${RAW_BURST}-call burst/combo ===\n`);
  const rawRows = [];
  for (const size of RAW_SIZES) {
    for (const variant of RAW_VARIANTS) {
      const fnName = { baseline: 'rawCoreBaseline', lut: 'rawCoreLUT', persist: 'rawCorePersist', combined: 'rawCoreCombined' }[variant];
      const ms = await page.evaluate(({ size, fnName, burst }) => {
        const w = size, h = size;
        const frame = new Float32Array(w * h);
        for (let i = 0; i < frame.length; i++) frame[i] = Math.random() * 4096; // typical camera ADU range
        const mn = 100, mx = 3000;
        const fn = window[fnName];
        fn(frame, w, h, mn, mx); // warm-up
        if (window.gc) window.gc();
        const times = [];
        for (let i = 0; i < burst; i++) { const t0 = performance.now(); fn(frame, w, h, mn, mx); times.push(performance.now() - t0); }
        return times;
      }, { size, fnName, burst: RAW_BURST });
      const med = median(ms);
      rawRows.push([`${size}x${size}`, variant, med.toFixed(2)]);
      console.log(`  ${size}x${size} ${variant}: ${med.toFixed(2)}ms/call`);
    }
  }
  // Recompute speedups against each size's own baseline for readability.
  const rawRowsWithSpeedup = rawRows.map((r, i) => {
    const base = rawRows.find(x => x[0] === r[0] && x[1] === 'baseline');
    return [...r, (parseFloat(base[2]) / parseFloat(r[2])).toFixed(2) + 'x'];
  });
  console.log(fmtTable(rawRowsWithSpeedup, ['FOV', 'variant', 'median ms/call', 'speedup']));

} finally {
  await browser.close();
}
