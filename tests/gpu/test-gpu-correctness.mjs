#!/usr/bin/env node
import assert from 'node:assert/strict';
import { launchPage, checkGpu } from '../lib/launch.mjs';

const { browser, page } = await launchPage({ headless: true });
try {
  const gpu = await checkGpu(page);
  if (!gpu.available) {
    console.log('GPU correctness: SKIP (WebGPU unavailable)');
    process.exit(0);
  }

  const poolLifecycle = await page.evaluate(() => {
    let created=0,destroyed=0;
    const engine={stats:{slotWaits:0},mkBuf(){ created++; return {destroy(){destroyed++;}}; }};
    const pool=makeGpuFitSlotPool(engine,{key:'test',results:[16,16,4]},1,1,1);
    const pooled=pool.acquire(), unusedOverflow=pool.acquire();
    const waitsBeforeDispatch=engine.stats.slotWaits;
    pool.release(unusedOverflow); pool.release(pooled); pool.destroy();
    return {created,destroyed,waitsBeforeDispatch};
  });
  assert.equal(poolLifecycle.waitsBeforeDispatch,0,'overflow metrics must count dispatched batches, not unused acquisitions');
  assert.equal(poolLifecycle.destroyed,poolLifecycle.created,'all pooled and temporary slot buffers must be destroyed');

  const fit = await page.evaluate(async () => {
    const w = 21, h = 21, cx = 10, cy = 10, win = 9, r = 4, sigma0 = 1.3;
    const truth = [10.37, 9.71, 713.5, 6.25, 1.62];
    const img = new Float32Array(w * h).fill(truth[3]);
    for (let y = cy-r; y <= cy+r; y++) for (let x = cx-r; x <= cx+r; x++) {
      const signal = truth[2] * mleGInt(x, truth[0], truth[4]) * mleGInt(y, truth[1], truth[4]);
      img[y*w+x] = truth[3] + signal + (((x*17+y*31)%7)-3)*0.17;
    }
    const cpu = gaussianMLEspheric(img,w,h,cx,cy,win,sigma0,1,0,0.001);
    const seedsA = new Float32Array(4), seedsB = new Float32Array(4), windows = new Float32Array(win*win);
    buildFitSeedRow(img,w,cx,cy,r,win,win*win,sigma0,1,0,seedsA,seedsB,windows,0);
    const engine = await getGpuEngine();
    const gpuLocs = await fitBatchGpuFlat(engine,seedsA,seedsB,windows,new Int32Array([0]),1,r,0.001);
    return { cpu, gpu:gpuLocs[0]||null };
  });
  assert.ok(fit.cpu && fit.gpu, 'the deterministic fit must be accepted by both paths');
  for (const key of ['lpx','lpy']) {
    assert.ok(Number.isFinite(fit.gpu[key]) && fit.gpu[key] > 0, `GPU ${key} must be finite and positive`);
    const rel = 2*Math.abs(fit.cpu[key]-fit.gpu[key])/(Math.abs(fit.cpu[key])+Math.abs(fit.gpu[key]));
    assert.ok(rel <= 0.001, `${key} symmetric relative error ${rel} exceeds 0.1% on a deterministic model`);
  }

  const render = await page.evaluate(async () => {
    const original = window.renderSuperRes;
    let active = 0, maxActive = 0;
    window.renderSuperRes = async function (...args) {
      active++; maxActive=Math.max(maxActive,active);
      try {
        if(args[5]==='fire') await new Promise(resolve=>setTimeout(resolve,40));
        const canvas=await original.apply(this,args);
        canvas._testLut=args[5];
        return canvas;
      } finally { active--; }
    };
    try {
      const locs=Array.from({length:64},(_,i)=>({frame:i%4,x:4+(i%8),y:4+((i/8)|0),photons:500,bg:3,bgstd:1,sigma:1.3,lpx:.15,lpy:.15}));
      lastResult={locs,w:20,h:20,px:100,mag:5,det:{}};
      document.getElementById('useGpu').checked=false;
      document.getElementById('lut').value='fire';
      const first=window.rerender(true,false);
      await new Promise(resolve=>setTimeout(resolve,0));
      document.getElementById('lut').value='grey';
      const second=window.rerender(true,false);
      await Promise.all([first,second]);
      return {maxActive,published:srFull&&srFull._testLut};
    } finally { window.renderSuperRes=original; }
  });
  assert.equal(render.maxActive,1,'rerender must serialize the shared renderer');
  assert.equal(render.published,'grey','the latest queued render must be published');

  const finalRender = await page.evaluate(async () => {
    for(const [id,value] of Object.entries({frames:2,dens:.2,phot:700,method:'gaussmle'})){
      const el=document.getElementById(id); el.value=String(value); el.dispatchEvent(new Event('change'));
    }
    document.getElementById('useGpu').checked=false;
    stack=await generateSynthetic(); stackName='final-render-test';
    const original=window.renderSuperRes;
    let active=0,started=0;
    window.renderSuperRes=async function(...args){
      started++; active++;
      try{ await new Promise(resolve=>setTimeout(resolve,40)); return await original.apply(this,args); }
      finally{ active--; }
    };
    try{ await window.run(); return {active,started,log:document.getElementById('log').textContent}; }
    finally{ window.renderSuperRes=original; }
  });
  assert.ok(finalRender.started>0,'the run must request a final reconstruction');
  assert.equal(finalRender.active,0,'run completion must await the final reconstruction');
  assert.match(finalRender.log,/including final reconstruction/,'the UI total must include the awaited final reconstruction');

  const directRender = await page.evaluate(async () => {
    const engine=await getGpuEngine(), errors=[];
    const onError=event=>errors.push(event.error&&event.error.message||String(event.error));
    engine.device.addEventListener('uncapturederror',onError);
    const locs=Array.from({length:512},(_,i)=>({frame:i%4,x:2+(i%16),y:2+((i/16)%16),photons:500,bg:3,bgstd:1,sigma:1.3,lpx:.15,lpy:.15}));
    const args=mag=>[engine,locs,20,20,mag,.25,'fire',99.5,false,0,1,locs,'z','fixed'];
    try {
      await renderSuperResGpu(...args(5));
      const [a,b]=await Promise.all([renderSuperResGpu(...args(6)),renderSuperResGpu(...args(7))]);
      await engine.device.queue.onSubmittedWorkDone();
      await new Promise(resolve=>setTimeout(resolve,0));
      return {errors,widthA:a.width,widthB:b.width};
    } finally { engine.device.removeEventListener('uncapturederror',onError); }
  });
  assert.deepEqual(directRender.errors,[],'concurrent direct GPU renders must not emit validation errors');
  assert.equal(directRender.widthA,120);
  assert.equal(directRender.widthB,140);

  const scopedFailure = await page.evaluate(async () => {
    const engine=await getGpuEngine(), original=engine.mkBuf, errors=[];
    const onError=event=>errors.push(event.error&&event.error.message||String(event.error));
    engine.device.addEventListener('uncapturederror',onError);
    engine.mkBuf=(size,usage,label)=>engine.device.createBuffer({label,size:Math.max(4,size),usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.STORAGE});
    let rejected=false;
    try {
      const locs=[{frame:0,x:5,y:5,photons:500,bg:3,bgstd:1,sigma:1.3,lpx:.15,lpy:.15}];
      try { await renderSuperResGpu(engine,locs,20,20,8,.25,'fire',99.5,false,0,1,locs,'z','fixed'); }
      catch(_) { rejected=true; }
      await new Promise(resolve=>setTimeout(resolve,0));
      return {rejected,errors};
    } finally { engine.mkBuf=original; engine.device.removeEventListener('uncapturederror',onError); }
  });
  assert.equal(scopedFailure.rejected,true,'a GPU validation failure must reject so runStage can fall back');
  assert.deepEqual(scopedFailure.errors,[],'render validation failures must be captured instead of escaping globally');

  const fitFallback=await page.evaluate(async()=>{
    for(const [id,value] of Object.entries({frames:125,dens:.08,phot:700,method:'gaussmle'})){
      const el=document.getElementById(id);el.value=String(value);el.dispatchEvent(new Event('change'));
    }
    const source=await generateSynthetic(),cfg=buildConfigFromParams(),messages=[];
    Object.assign(cfg,{useGpu:true,workerMinFrames:1e9,rawPreviewMs:1e9,srPreviewMs:1e9});
    await getGpuEngine();
    const original=window.fitBatchGpuFlat;
    window.fitBatchGpuFlat=async()=>{throw new Error('induced fit failure');};
    try{
      const r=await runCore(cfg,source,{}, {onLog:m=>messages.push(m),onProgress(){},onRawPreview(){},onSrPreview(){},shouldStop(){return false;}});
      return {n:r.locs.length,stage:r.stageTimings.fit,messages};
    }finally{window.fitBatchGpuFlat=original;}
  });
  assert.ok(fitFallback.n>0,'a failed GPU fit batch must be recomputed on CPU');
  assert.equal(fitFallback.stage.path,'mixed');
  assert.ok(fitFallback.stage.fallbackCalls>0);
  assert.ok(fitFallback.messages.some(m=>m.includes('using CPU for this and remaining fit batches')),'fit fallback must be visible');

  console.log('GPU correctness: PASS');
} finally {
  await browser.close();
}
