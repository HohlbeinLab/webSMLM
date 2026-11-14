#!/usr/bin/env node
// Native Firefox smoke check. Playwright's Firefox build is patched and cannot
// represent release Firefox's WebGPU or download behavior.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { htmlUrl, repoRoot } from '../lib/launch.mjs';
import { encodeMultiFrameTiff16, encodeBigTiff16, makeSyntheticFrame } from '../lib/mini-tiff.mjs';

assert.ok(globalThis.WebSocket, 'Native check requires Node 22 or newer');
const executable = process.env.WEBSMLM_NATIVE_FIREFOX || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
const headless = process.env.WEBSMLM_NATIVE_HEADLESS !== '0';
const root = mkdtempSync(join(tmpdir(), 'websmlm-firefox-'));
const profile = join(root, 'profile'), downloads = join(root, 'downloads');
mkdirSync(profile); mkdirSync(downloads);
writeFileSync(join(profile, 'user.js'), [
  'user_pref("browser.download.folderList", 2);',
  `user_pref("browser.download.dir", ${JSON.stringify(downloads)});`,
  'user_pref("browser.download.useDownloadDir", true);',
  'user_pref("browser.download.always_ask_before_handling_new_types", false);',
  'user_pref("browser.helperApps.neverAsk.saveToDisk", "image/png");',
].join('\n'));

let proc, socket, server;
const pending = new Map(), errors = [];
let nextId = 0;
const frames = [makeSyntheticFrame(32, 32, 1), makeSyntheticFrame(32, 32, 2)];
const imports = [
  ['compat.tif', Buffer.from(encodeMultiFrameTiff16(frames, 32, 32)).toString('base64')],
  ['compat-big.tif', Buffer.from(encodeBigTiff16(frames, 32, 32)).toString('base64')],
];
async function command(method, params = {}) {
  const id = ++nextId;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 90000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(context, expression) {
  const r = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
  if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || JSON.stringify(r));
  return JSON.parse(r.result.value);
}
async function waitFor(test, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await test();
    if (value) return value;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Firefox check timed out');
}

try {
  server = createServer((req, res) => {
    if (req.url !== '/webSMLM.html') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(repoRoot, 'webSMLM.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  proc = spawn(executable, ['--no-remote', '--profile', profile, ...(headless ? ['--headless'] : []), '--remote-debugging-port', '0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`Firefox BiDi did not start: ${diagnostic.slice(-600)}`)), 30000);
    proc.on('error', reject);
    proc.stderr.on('data', chunk => {
      diagnostic += String(chunk);
      const match = diagnostic.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
  });
  socket = new WebSocket(endpoint.endsWith('/session') ? endpoint : endpoint.replace(/\/$/, '') + '/session');
  await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (p) message.type === 'error' ? p.reject(new Error(message.message)) : p.resolve(message.result);
    } else if (message.method === 'log.entryAdded' && message.params?.level === 'error') errors.push(message.params.text);
  };
  await command('session.new', { capabilities: { alwaysMatch: { browserName: 'firefox' } } });
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const tree = await command('browsingContext.getTree');
  const context = tree.contexts[0].context;
  const results = [];
  for (const [label, url] of [['file', htmlUrl], ['localhost', `http://127.0.0.1:${port}/webSMLM.html`]]) {
    await command('browsingContext.navigate', { context, url, wait: 'complete' });
    await waitFor(() => evaluate(context, 'JSON.stringify(!!(window.webSMLM && window.webSMLM.analyze))'));
    const result = await evaluate(context, `(async()=>JSON.stringify(await (async()=>{
      const set=(id,value)=>{const el=document.getElementById(id); el.value=String(value); el.dispatchEvent(new Event('change'));};
      set('frames',50); set('simulation_fov',32); set('dens',0.5); set('simulation_seed',1337); set('simulation_mt_seed',1337); document.getElementById('useGpu').checked=false;
      const start=performance.now(); await runSimulation(); const simulationMs=performance.now()-start;
      const first=(await stack.getFrames(0,1))[0]; let frameHash=2166136261;
      for(const v of first) frameHash=Math.imul(frameHash^Math.round(v),16777619)>>>0;
      const middle=performance.now(); await run(); const localizationMs=performance.now()-middle;
      const canvas=id=>{const c=document.getElementById(id), d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return {width:c.width,height:c.height,nonempty:d.some(v=>v!==0)};};
      const raw=canvas('raw'), sr=canvas('sr');
      await exportPanel('raw'); await exportPanel('sr'); await exportCSV();
      return {title:document.title,simulationMs,localizationMs,seed:paramValue('simulation_seed'),frameHash,frames:stack?.n,locs:lastResult?.locs?.length,raw,sr,gpu:!!(await getGpuEngine()).available,noticeShown:!document.getElementById('compatNotice').hidden};
    })()))()`);
    assert.equal(result.frames, 50);
    assert.ok(result.locs > 0 && result.raw.nonempty && result.sr.nonempty, JSON.stringify(result));
    assert.equal(result.noticeShown, false, `a healthy native Firefox shows no capability banner: ${JSON.stringify(result)}`);
    await waitFor(() => readdirSync(downloads).filter(x => /\.(png|csv)$/.test(x)).length >= (label === 'file' ? 3 : 6), 10000)
      .catch(() => { throw new Error(`Firefox downloads missing (${label}): ${JSON.stringify({ files: readdirSync(downloads), result })}`); });
    if (label === 'localhost' && process.env.WEBSMLM_NATIVE_GPU === '1' && result.gpu) {
      result.gpuCheck = await evaluate(context, `(async()=>JSON.stringify(await (async()=>{
        const set=(id,value)=>{const el=document.getElementById(id);el.value=String(value);el.dispatchEvent(new Event('change'));};
        set('frames',200);set('simulation_fov',208);set('dens',0.5);set('simulation_seed',1337);set('simulation_mt_seed',1337);
        document.getElementById('useGpu').checked=false;
        await runSimulation();
        const config={pcfoFrames:20,pcfoK:paramValue('pcfoK'),pcfoRnstd:paramValue('pcfoRnstd')};
        const cpuStart=performance.now();const cpu=await pcfoCore({...config,useGpu:false},stack);const pcfoCpuMs=performance.now()-cpuStart;
        document.getElementById('useGpu').checked=true;
        const pcfoStages=newStageTimings(),gpuStart=performance.now();
        const gpu=await pcfoCore({...config,useGpu:true},stack,{stageTimings:pcfoStages});const pcfoGpuMs=performance.now()-gpuStart;
        let fullPcfo=null;
        if(${process.env.WEBSMLM_NATIVE_GPU_BENCH_FULL === '1' ? 'true' : 'false'}){
          const fullConfig={...config,pcfoFrames:200};
          const tCpu=performance.now(),fullCpu=await pcfoCore({...fullConfig,useGpu:false},stack),fullCpuMs=performance.now()-tCpu;
          const fullStages=newStageTimings(),tGpu=performance.now(),fullGpu=await pcfoCore({...fullConfig,useGpu:true},stack,{stageTimings:fullStages});
          fullPcfo={cpuMs:fullCpuMs,gpuMs:performance.now()-tGpu,path:fullStages.pcfo?.path,cpuGain:fullCpu?.gain,gpuGain:fullGpu?.gain,gpuTiming:fullGpu?.pts?.timing};
        }
          const W=512,NF=100,frames=[];let rng=1337;
          for(let f=0;f<NF;f++){
            const img=new Float32Array(W*W);
            for(let i=0;i<img.length;i++){
              rng=(Math.imul(rng,1664525)+1013904223)>>>0;
              const x=i%W,y=(i/W)|0,mean=100+20*((x/128)|0)+30*((y/128)|0);
              img[i]=mean+(rng/4294967296-0.5)*Math.sqrt(mean)*3;
            }
            frames.push(img);
          }
          const large={w:W,h:W,n:NF,async getFrames(a,b){return frames.slice(a,b);}};
          const cfg={...config,pcfoFrames:NF};
          const tCpu=performance.now(),c=await pcfoCore({...cfg,useGpu:false},large),cpuMs=performance.now()-tCpu;
          const stage=newStageTimings(),tGpu=performance.now(),g=await pcfoCore({...cfg,useGpu:true},large,{stageTimings:stage});
          const largePcfo={cpuMs,gpuMs:performance.now()-tGpu,path:stage.pcfo?.path,cpuGain:c?.gain,gpuGain:g?.gain,gpuTiming:g?.pts?.timing};
        await run();
        const fitPath=_lastStageRun.gpu?.fit?.path,renderPath=_renderStageTimings.render?.path;
        const frcStages=newStageTimings(),frc=await runFrcStage({useGpu:true,stageTimings:frcStages,onLog:()=>{}},lastResult.locs,lastResult.px,lastResult.mag,()=>{},()=>{});
        return {frames:stack.n,width:stack.w,locs:lastResult.locs.length,pcfoCpuMs,pcfoGpuMs,pcfoPath:pcfoStages.pcfo?.path,pcfoGpuTiming:gpu?.pts?.timing,pcfoGainCpu:cpu?.gain,pcfoGainGpu:gpu?.gain,fullPcfo,largePcfo,fitPath,renderPath,frcPath:frcStages.frc?.path,frcError:frc.err||null,logErrors:document.getElementById('logText').textContent.split('\\n').filter(x=>x.includes('!!!')&&/GPU|failed/i.test(x)).slice(-5)};
      })()))()`);
      assert.ok(result.gpuCheck.locs > 0, JSON.stringify(result.gpuCheck));
      for (const stage of ['fitPath', 'renderPath', 'frcPath'])
        assert.equal(result.gpuCheck[stage], 'gpu', `${stage}: ${JSON.stringify(result.gpuCheck)}`);
      // The PCFO path follows the measured readback latency (pcfoGpuEligible()), not a fixed browser rule.
      const expectGpu = await evaluate(context, `(async()=>{const ms=(await getGpuEngine()).readbackMs; return JSON.stringify([pcfoGpuEligible(20,9,128,ms), pcfoGpuEligible(100,16,256,ms)]);})()`);
      assert.equal(result.gpuCheck.pcfoPath, expectGpu[0] ? 'gpu' : 'cpu', 'small PCFO job path follows the readback latency');
      assert.equal(result.gpuCheck.largePcfo.path, expectGpu[1] ? 'gpu' : 'cpu', 'large PCFO job path follows the readback latency');
      assert.ok(Math.abs(result.gpuCheck.largePcfo.cpuGain - result.gpuCheck.largePcfo.gpuGain) / result.gpuCheck.largePcfo.cpuGain < 1e-4);
      assert.deepEqual(result.gpuCheck.logErrors, []);
    }
    for (const [name, b64] of imports) {
      await evaluate(context, `JSON.stringify((()=>{const bytes=Uint8Array.from(atob('${b64}'),c=>c.charCodeAt(0)); const transfer=new DataTransfer(); transfer.items.add(new File([bytes],'${name}')); const input=document.getElementById('file'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); return true})())`);
      const loaded = await waitFor(() => evaluate(context, `JSON.stringify(stackName==='${name}' && stack?.n===2 ? {n:stack.n,w:stack.w,h:stack.h} : null)`));
      assert.deepEqual(loaded, { n: 2, w: 32, h: 32 }, `${name} import`);
    }
    results.push({ mode: label, ...result });
  }
  assert.equal(results[0].frameHash, results[1].frameHash, 'seeded movie changed between file and localhost');
  assert.deepEqual(errors, [], `Firefox console errors: ${errors.join(' | ')}`);
  const saved = readdirSync(downloads).filter(x => /\.(png|csv)$/.test(x));
  assert.ok(saved.every(x => statSync(join(downloads, x)).size > 0), 'empty export');
  console.log(JSON.stringify({ browser: executable, results, downloads: saved.length, imports: imports.length * results.length, consoleErrors: errors.length }));
} finally {
  socket?.close(); proc?.kill(); server?.close();
  if (proc && proc.exitCode === null) await Promise.race([
    new Promise(resolveExit => proc.once('exit', resolveExit)),
    new Promise(resolveExit => setTimeout(resolveExit, 2000)),
  ]);
  const safe = resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('websmlm-firefox-');
  if (safe && existsSync(root)) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
    catch (err) { console.error(`Could not remove temporary Firefox profile ${root}: ${err.message}`); }
  }
}
