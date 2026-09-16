#!/usr/bin/env node
import assert from 'node:assert/strict';
import {launchPage,checkGpu} from '../lib/launch.mjs';

const {browser,page}=await launchPage({headless:true});
try{
  const gpu=await checkGpu(page);
  if(!gpu.available){console.log('candidate audit: SKIP (WebGPU unavailable)');process.exit(0);}
  const result=await page.evaluate(async()=>{
    for(const [id,value] of Object.entries({frames:125,dens:.25,phot:800,method:'gaussmle',winr:4})){
      const el=document.getElementById(id);el.value=String(value);el.dispatchEvent(new Event('change'));
    }
    const oldRandom=Math.random;
    Math.random=mulberry32(0x5EED1234);
    if(typeof _g!=='undefined')_g=null;
    let source;
    try{source=await generateSynthetic();}finally{Math.random=oldRandom;if(typeof _g!=='undefined')_g=null;}
    const base=buildConfigFromParams();
    Object.assign(base,{auditCandidates:true,workerMinFrames:1e9,rawPreviewMs:1e9,srPreviewMs:1e9});
    const hooks={onLog(){},onProgress(){},onRawPreview(){},onSrPreview(){},shouldStop(){return false;}};
    const cpu=await runCore({...base,useGpu:false},source,{},hooks);
    await getGpuEngine();
    const gpuRun=await runCore({...base,useGpu:true},source,{},hooks);
    return {
      wh:cpu.w*cpu.h,cpuN:cpu.locs.length,gpuN:gpuRun.locs.length,
      cpuCandidates:cpu.timings.nCand,gpuCandidates:gpuRun.timings.nCand,
      cpuTimings:cpu.timings,gpuTimings:gpuRun.timings,
      cpuKeys:Array.from(cpu.auditCandidatePixels||[],(p,i)=>`${cpu.locs[i].frame}:${p}`),
      gpuKeys:Array.from(gpuRun.auditCandidatePixels||[],(p,i)=>`${gpuRun.locs[i].frame}:${p}`),
    };
  });
  assert.equal(result.cpuCandidates,result.gpuCandidates,'detection candidate counts must be exact');
  for(const t of [result.cpuTimings,result.gpuTimings]){
    assert.ok(t.dt<=t.runMs+1,'localization wall must not exceed its enclosing runCore wall');
    assert.ok(Math.abs(t.otherMs-Math.max(0,t.runMs-t.dt))<=1,'setup must be the raw runCore-minus-localization wall gap');
  }
  assert.equal(result.cpuKeys.length,result.cpuN,'CPU audit array must be parallel to accepted localizations');
  assert.equal(result.gpuKeys.length,result.gpuN,'GPU audit array must be parallel to accepted localizations');
  const cpuSet=new Set(result.cpuKeys),gpuSet=new Set(result.gpuKeys);
  let onlyCpu=0,onlyGpu=0;
  for(const key of cpuSet)if(!gpuSet.has(key))onlyCpu++;
  for(const key of gpuSet)if(!cpuSet.has(key))onlyGpu++;
  const discordance=(onlyCpu+onlyGpu)/Math.max(1,result.cpuCandidates);
  const bias=Math.abs(result.gpuN-result.cpuN)/Math.max(1,result.cpuCandidates);
  // CPU and GPU use different arithmetic precision (CPU f64, WebGPU f32), so
  // candidates close to the accept/reject boundary can legitimately swap sides.
  // Guard the important invariant instead: bounded net acceptance drift.
  assert.ok(discordance<=0.02,`acceptance discordance ${discordance} exceeds 0.02`);
  assert.ok(bias<=0.02,`net acceptance bias ${bias} exceeds 0.02`);
  console.log('candidate audit: PASS');
}finally{await browser.close();}
