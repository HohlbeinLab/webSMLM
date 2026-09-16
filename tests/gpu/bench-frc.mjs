#!/usr/bin/env node
// Interleaved CPU/WebGPU FRC scaling benchmark. Correctness is enforced by
// test-frc-gpu.mjs; this file mechanically checks the production crossover.
import {launchPage,checkGpu} from '../lib/launch.mjs';
import {printTable,writeResults} from '../lib/report.mjs';

const median=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};
const mad=a=>{const m=median(a);return median(a.map(x=>Math.abs(x-m)));};
const {browser,page}=await launchPage();
try{
  const gpu=await checkGpu(page);
  if(!gpu.available){console.log('WebGPU unavailable — FRC crossover benchmark skipped.');process.exit(0);}
  const rows=[];
  for(const bucket of [{N:256,extent:20},{N:512,extent:40},{N:1024,extent:80}]){
    process.stdout.write(`FRC ${bucket.N}²...`);
    const r=await page.evaluate(async({extent,expectedN})=>{
      const locs=Array.from({length:4096},(_,i)=>({frame:0,x:5+(i%64)*extent/63,y:5+((i/64)|0)*extent/63,
        photons:700,bg:4,bgstd:1,sigma:1.3,lpx:.2,lpy:.2}));
      const p=await prepareFrc(locs,100,10,()=>{},()=>{});
      if(p.N!==expectedN)throw new Error(`fixture expected N=${expectedN}, got ${p.N}`);
      const engine=await getGpuEngine();
      await frcResolutionCpuPrepared(p,()=>{});await frcResolutionGpuPrepared(engine,p,()=>{});
      const cpu=[],gpu=[];
      for(let i=0;i<5;i++){
        const one=async(kind)=>{const t=performance.now();if(kind==='cpu')await frcResolutionCpuPrepared(p,()=>{});else await frcResolutionGpuPrepared(engine,p,()=>{});(kind==='cpu'?cpu:gpu).push(performance.now()-t);};
        if(i&1){await one('gpu');await one('cpu');}else{await one('cpu');await one('gpu');}
      }
      return {cpu,gpu};
    },{extent:bucket.extent,expectedN:bucket.N});
    const cpuMedian=median(r.cpu),gpuMedian=median(r.gpu),speedup=cpuMedian/gpuMedian;
    rows.push({N:bucket.N,cpuMedian,gpuMedian,cpuMad:mad(r.cpu),gpuMad:mad(r.gpu),speedup,
      selected:bucket.N>=512,pass:bucket.N<512||speedup>=1.2});
    console.log(' done.');
  }
  printTable(rows,[
    {key:'N',label:'FFT N',width:6},{key:'cpuMedian',label:'CPU median',width:11,fmt:v=>v.toFixed(1)},
    {key:'gpuMedian',label:'GPU median',width:11,fmt:v=>v.toFixed(1)},
    {key:'cpuMad',label:'CPU MAD',width:8,fmt:v=>v.toFixed(1)},{key:'gpuMad',label:'GPU MAD',width:8,fmt:v=>v.toFixed(1)},
    {key:'speedup',label:'speedup',width:8,fmt:v=>v.toFixed(2)+'x'},{key:'pass',label:'gate',width:5,fmt:v=>v?'PASS':'FAIL'},
  ]);
  const file=writeResults('bench-frc',{gpu,rows,orders:'CPU/GPU alternated; one warm-up each'});
  console.log(`\nFull results written to ${file}`);
  if(rows.some(r=>!r.pass))process.exitCode=1;
}finally{await browser.close();}
