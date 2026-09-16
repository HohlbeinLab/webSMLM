#!/usr/bin/env node
import assert from 'node:assert/strict';
import { launchPage, checkGpu } from '../lib/launch.mjs';

function numericArray(value){
  if(Array.isArray(value)||ArrayBuffer.isView(value)) return Array.from(value,Number);
  if(value&&typeof value==='object'){
    const keys=Number.isInteger(value.length)
      ? Array.from({length:value.length},(_,i)=>String(i))
      : Object.keys(value).filter(k=>/^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
    return keys.map(k=>Number(value[k])).filter(Number.isFinite);
  }
  return [];
}

const { browser, page } = await launchPage({ headless:true });
try {
  const gpu=await checkGpu(page);
  if(!gpu.available){ console.log('GPU FRC: SKIP (WebGPU unavailable)'); process.exit(0); }

  const result=await page.evaluate(async()=>{
    const locs=Array.from({length:768},(_,i)=>({
      frame:0,
      x:5+(i%32)*1.25+((i*17)%11)*0.013,
      y:5+((i/32)|0)*1.65+((i*29)%13)*0.011,
      photons:700,bg:4,bgstd:1,sigma:1.3,lpx:.2,lpy:.2,
    }));
    const prepared=await prepareFrc(locs,100,10,()=>{},()=>{});
    const cpu=await frcResolutionCpuPrepared(prepared,()=>{});
    const engine=await getGpuEngine();
    const gpuA=await frcResolutionGpuPrepared(engine,prepared,()=>{});
    const gpuB=await frcResolutionGpuPrepared(engine,prepared,()=>{});
    const lines=['"id","frame","x [nm]","y [nm]","sigma [nm]","intensity [photon]","offset [photon]","bkgstd [photon]","uncertainty [nm]"'];
    locs.forEach((L,i)=>lines.push(`${i+1},1,${L.x*100},${L.y*100},130,700,4,1,20`));
    const file=new File([lines.join('\n')],'frc.csv',{type:'text/csv'});
    const publicResult=await webSMLM.analyze({file,pxnm:100,useGpu:true,computeFRC:true,mag:10,renderMode:'dither'});
    return {N:prepared.N,cpu,gpuA,gpuB,execution:publicResult.execution};
  });
  assert.equal(result.N,512,'fixture must exercise the first GPU-eligible warm FFT bucket');
  for(const r of [result.cpu,result.gpuA,result.gpuB]) assert.equal(r.N,result.N);

  const cpuFrc=numericArray(result.cpu.curve.frc);
  const gpuAFrc=numericArray(result.gpuA.curve.frc);
  const gpuBFrc=numericArray(result.gpuB.curve.frc);
  assert.ok(cpuFrc.length>0,'CPU FRC curve must contain samples');
  assert.equal(gpuAFrc.length,cpuFrc.length,'GPU FRC curve length must match CPU');
  assert.equal(gpuBFrc.length,cpuFrc.length,'repeat GPU FRC curve length must match CPU');

  const abs=[];
  for(let i=0;i<cpuFrc.length;i++) abs.push(Math.abs(cpuFrc[i]-gpuAFrc[i]));
  abs.sort((a,b)=>a-b);
  assert.ok(abs[Math.floor(abs.length*.99)]<=5e-4,`curve p99 ${abs[Math.floor(abs.length*.99)]} exceeds 5e-4; cpu=${cpuFrc.slice(0,8)} gpu=${gpuAFrc.slice(0,8)}`);
  assert.ok(abs.at(-1)<=5e-3,`curve max ${abs.at(-1)} exceeds 5e-3`);
  if(Number.isFinite(result.cpu.res)&&Number.isFinite(result.gpuA.res)){
    const allowed=Math.max(result.cpu.pixNm,Math.abs(result.cpu.res)*.01);
    assert.ok(Math.abs(result.cpu.res-result.gpuA.res)<=allowed,'GPU resolution must match CPU within sampling/1% tolerance');
  } else assert.equal(Number.isFinite(result.gpuA.res),Number.isFinite(result.cpu.res),'finite-result status must match');

  let repeated=0;
  for(let i=0;i<gpuAFrc.length;i++) repeated=Math.max(repeated,Math.abs(gpuAFrc[i]-gpuBFrc[i]));
  assert.ok(repeated<=1e-6,`same-adapter repeated GPU FRC differs by ${repeated}`);
  assert.equal(result.execution.stages.frc.path,'gpu','headless FRC must use the shared GPU stage service when eligible and warm');
  assert.deepEqual(result.execution.stages.frc.reasons,['selected']);
  console.log('GPU FRC: PASS');
} finally { await browser.close(); }
