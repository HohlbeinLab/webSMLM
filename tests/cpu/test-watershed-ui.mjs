#!/usr/bin/env node
import assert from 'node:assert/strict';
import { launchPage } from '../lib/launch.mjs';
import { encodeMultiFrameTiff16 } from '../lib/mini-tiff.mjs';
import { resolveDatasetFile } from '../lib/data.mjs';

const W = 32, H = 32;
const frames = [0, 1].map(i => {
  const a = new Uint16Array(W * H).fill(10);
  a[(i ? 23 : 8) * W + (i ? 23 : 8)] = 100;
  return a;
});
const movie = Buffer.from(encodeMultiFrameTiff16(frames, W, H)).toString('base64');
const single = Buffer.from(encodeMultiFrameTiff16([frames[0]], W, H));
const maskPixels = new Uint16Array(W*H); maskPixels[8*W+8]=1;
const mask = Buffer.from(encodeMultiFrameTiff16([maskPixels], W, H));
const sourcePixels = new Uint16Array(W*H).fill(10); sourcePixels[15*W+16]=100;
const sourceImage = Buffer.from(encodeMultiFrameTiff16([sourcePixels], W, H));
const { browser, page } = await launchPage({ headless: true });
try {
  await page.setInputFiles('#file', {name:'single.tif',mimeType:'image/tiff',buffer:single});
  await page.waitForFunction(() => stack?.w === 32 && segDefaultsFor === stack);
  const initial = await page.evaluate(() => ({
    method: $('segMethod')?.value,
    hMin: +$('segHMin')?.value,
    threshold: +$('segThreshold')?.value,
    peak: +$('segPeakFlooding')?.value,
    invert: $('segInvert')?.checked,
    applied: $('applySegmentation').checked,
    sourceDisabled: $('segSourceBtn').disabled,
  }));
  assert.deepEqual(initial, { method: 'watershed', hMin: 4.5, threshold: 10,
    peak: 100, invert: false, applied: false, sourceDisabled:true });
  assert.equal(await page.locator('#segMethod').getAttribute('class'), 'sel');
  assert.deepEqual(await page.evaluate(() => ({
    loadsTogether: $('segSourceBtn').parentElement === $('segLoadBtn').parentElement,
    showSeparate: $('segShowBtn').parentElement !== $('segLoadBtn').parentElement,
    noSourceSwitch: !$('segSourceClearBtn'),
  })), { loadsTogether:true, showSeparate:true, noSourceSwitch:true });
  await page.evaluate(() => { $('sptBox').open=true; });

  await page.evaluate(() => {
    $('applySegmentation').checked = true;
    $('applySegmentation').dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => segmentedImageLabels?.w === 32);
  assert.equal(await page.evaluate(() => $('segSourceBtn').disabled), false);
  const generated = await page.evaluate(() => {
    const settings=buildSettingsJson(buildConfigFromParams()).values;
    return { cells:segmentedImageData.length, visible:rawSegView,
      settings:Object.fromEntries(['segMethod','segHMin','segThreshold','segPeakFlooding','segInvert','segOpacity'].map(id=>[id,settings[id]])) };
  });
  assert.ok(generated.cells > 0 && generated.visible, JSON.stringify(generated));
  assert.deepEqual(generated.settings, {segMethod:'watershed',segHMin:4.5,segThreshold:10,segPeakFlooding:100,segInvert:false,segOpacity:50});
  const views = await page.evaluate(() => {
    const overlayWidth=buildSegOverlayCanvas().width;
    segShowMode='hist'; drawSegShow();
    const histogram=rawIsPlot;
    segShowMode='image'; drawSegShow();
    return {overlayWidth,histogram,restored:rawSegView};
  });
  assert.deepEqual(views, {overlayWidth:32,histogram:true,restored:true});

  await page.setInputFiles('#segFile', {name:'mask.tif',mimeType:'image/tiff',buffer:mask});
  await page.waitForFunction(() => segmentedImageLabels?.source === 'imported' && segmentedImageData?.length === 1);
  await page.evaluate(() => { $('segHMin').value = '45'; $('segHMin').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => segmentedImageLabels?.source === 'watershed' && segmentedImageData?.length === 1 && !segPending);
  const regenerated = await page.evaluate(() => ({
    source: segmentedImageLabels.source,
    active: $('applySegmentation').checked,
  }));
  assert.deepEqual(regenerated, { source: 'watershed', active: true });

  await page.evaluate(async ({ movie }) => {
    const file = new File([Uint8Array.from(atob(movie), c => c.charCodeAt(0))], 'two-frame.tif');
    await loadFiles([file]);
  }, { movie });
  await page.waitForFunction(() => segDefaultsFor === stack);
  const reset = await page.evaluate(() => ({ applied: $('applySegmentation').checked,
    mask: segmentedImageLabels, w: stack.w, hMin: +$('segHMin').value,
    sourceDisabled:$('segSourceBtn').disabled }));
  assert.deepEqual(reset, { applied: false, mask: null, w: W, hMin: 2.25, sourceDisabled:true });
  await page.evaluate(() => { $('applySegmentation').checked = true; $('applySegmentation').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => segmentedImageLabels?.w === 32);
  const projection = await page.evaluate(() => {
    const a = segmentedImageLabels.arr;
    return [a[8 * 32 + 8], a[23 * 32 + 23], segmentedImageLabels.source];
  });
  assert.ok(projection[0] > 0 && projection[1] > 0 && projection[0] !== projection[1], JSON.stringify(projection));
  assert.equal(projection[2], 'watershed');
  await page.evaluate(() => { $('segOpacity').value='0'; $('segOpacity').dispatchEvent(new Event('input')); });
  assert.deepEqual(await page.evaluate(() => ({
    title:$('rawTitle').textContent,
    first:Array.from(rawFull.getContext('2d').getImageData(8,8,1,1).data).slice(0,3),
    second:Array.from(rawFull.getContext('2d').getImageData(23,23,1,1).data).slice(0,3),
  })), {title:'Segmented image',first:[255,255,255],second:[255,255,255]});
  await page.locator('#segShowBtn').dispatchEvent('pointerdown', {pointerId:1,pointerType:'mouse',button:0});
  await page.waitForFunction(() => $('rawTitle').textContent==='Source image');
  await page.locator('#segShowBtn').dispatchEvent('pointerup', {pointerId:1,pointerType:'mouse',button:0});
  assert.equal(await page.evaluate(() => $('rawTitle').textContent), 'Segmented image');
  await page.evaluate(() => { $('segOpacity').value='50'; $('segOpacity').dispatchEvent(new Event('input')); });
  await page.evaluate(() => {
    window.segFrameReads=0;
    const read=stack.getFrames.bind(stack);
    stack.getFrames=async (...args) => { window.segFrameReads++; return read(...args); };
  });
  await page.evaluate(() => { $('segThreshold').value='11'; $('segInvert').checked = true; $('segInvert').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => segmentedImageLabels?.source === 'watershed' && !segPending);
  const inverted = await page.evaluate(() => {
    const a=segmentedImageLabels.arr; return [a[8*32+8], a[23*32+23], a[0]];
  });
  assert.deepEqual(inverted.slice(0,2), [0,0]);
  assert.ok(inverted[2]>0);
  assert.equal(await page.evaluate(() => window.segFrameReads), 0, 'Changing a watershed control reread the movie');

  await page.evaluate(() => { $('segInvert').checked=false; $('segThreshold').value='10'; });
  await page.setInputFiles('#segSourceFile', {name:'separate-brightfield.tif',mimeType:'image/tiff',buffer:sourceImage});
  await page.waitForFunction(() => segSourceImage?.name==='separate-brightfield.tif' && segmentedImageLabels?.source==='watershed' && !segPending);
  const separate = await page.evaluate(() => ({
    peak:segmentedImageLabels.arr[15*32+16], moviePeak:segmentedImageLabels.arr[8*32+8],
    hMin:+$('segHMin').value, threshold:+$('segThreshold').value,
    localizationFrames:stack.n,
    areaMax:+$('segAreaMax').value,
  }));
  assert.ok(separate.peak>0 && separate.localizationFrames===2 && separate.areaMax===1024, JSON.stringify(separate));
  assert.deepEqual([separate.hMin,separate.threshold], [4.5,10]);
  await page.evaluate(() => { $('segThreshold').value='11'; $('segThreshold').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => !segPending);
  assert.ok(await page.evaluate(() => segmentedImageLabels.arr[15*32+16]>0 && segmentedImageLabels.arr[8*32+8]===0));
  const preview = await page.evaluate(() => {
    const slider=$('segOpacity');
    const sample=()=>Array.from(rawFull.getContext('2d').getImageData(16,15,1,1).data).slice(0,3);
    slider.value='0'; slider.dispatchEvent(new Event('input')); const image=sample();
    slider.value='100'; slider.dispatchEvent(new Event('input')); const mask=sample();
    slider.value='50'; slider.dispatchEvent(new Event('input')); const mixed=sample();
    return {image,mask,mixed,value:$('segOpacityValue').textContent,
      title:$('rawTitle').textContent, button:$('segShowBtn').textContent};
  });
  assert.deepEqual(preview.image, [255,255,255]);
  assert.notDeepEqual(preview.mask, preview.image);
  assert.ok(preview.mixed.every((v,i)=>Math.abs(v-(preview.image[i]+preview.mask[i])/2)<=1), JSON.stringify(preview));
  assert.equal(preview.value, '50%');
  assert.deepEqual([preview.title,preview.button], ['Segmented image','Show image']);
  const zoomBeforeHold=await page.evaluate(() => {
    rawView.zoom*=2; drawRawView(); return rawView.zoom;
  });
  await page.locator('#segShowBtn').dispatchEvent('pointerdown', {pointerId:1,pointerType:'mouse',button:0});
  await page.waitForFunction(() => $('rawTitle').textContent==='Source image');
  assert.deepEqual(await page.evaluate(() => Array.from(rawFull.getContext('2d').getImageData(16,15,1,1).data).slice(0,3)), preview.image);
  await page.locator('#segShowBtn').dispatchEvent('pointerleave', {pointerId:1,pointerType:'mouse',button:0});
  assert.deepEqual(await page.evaluate(() => ({
    title:$('rawTitle').textContent, button:$('segShowBtn').textContent,
    opacity:$('segOpacity').value,
    zoom:rawView.zoom,
    pixel:Array.from(rawFull.getContext('2d').getImageData(16,15,1,1).data).slice(0,3),
  })), {title:'Segmented image',button:'Show image',opacity:'50',zoom:zoomBeforeHold,pixel:preview.mixed});
  await page.locator('#segShowBtn').focus();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => $('rawTitle').textContent==='Source image');
  await page.keyboard.up('Space');
  assert.equal(await page.evaluate(() => $('rawTitle').textContent), 'Segmented image');
  await page.evaluate(() => {
    const btn=$('segShowBtn');
    btn.dispatchEvent(new PointerEvent('pointerdown',{pointerId:2,pointerType:'mouse',button:0}));
    btn.dispatchEvent(new PointerEvent('pointerup',{pointerId:2,pointerType:'mouse',button:0}));
  });
  await page.waitForTimeout(0);
  assert.equal(await page.evaluate(() => $('rawTitle').textContent), 'Segmented image');
  await page.evaluate(() => { $('segThreshold').value='12'; $('segThreshold').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => !segPending);
  assert.deepEqual(await page.evaluate(() => ({
    opacity:$('segOpacity').value,
    pixel:Array.from(rawFull.getContext('2d').getImageData(16,15,1,1).data).slice(0,3),
  })), {opacity:'50',pixel:preview.mixed});
  await page.evaluate(() => { $('alexEnabled').checked=true; $('alexEnabled').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => !segPending);
  assert.ok(await page.evaluate(() => segmentedImageLabels.arr[15*32+16]>0 && segmentedImageLabels.arr[8*32+8]===0));
  await page.evaluate(() => { $('alexEnabled').checked=false; $('alexEnabled').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => !segPending);
  await page.setInputFiles('#segFile', {name:'mask.tif',mimeType:'image/tiff',buffer:mask});
  await page.waitForFunction(() => segmentedImageLabels?.source==='imported' && !segPending);
  await page.evaluate(() => { $('segHMin').value='5'; $('segHMin').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => segmentedImageLabels?.source==='watershed' && !segPending);
  assert.ok(await page.evaluate(() => segmentedImageLabels.arr[15*32+16]>0 && segmentedImageLabels.arr[8*32+8]===0));
  assert.ok(await page.evaluate(() => segSourceImage?.name==='separate-brightfield.tif'));

  await page.evaluate(() => applyCropToRaw(0,0,24,24));
  assert.deepEqual(await page.evaluate(() => ({ applied:$('applySegmentation').checked,
    mask:segmentedImageLabels, source:segSourceImage, width:stack.w })), { applied:false, mask:null, source:null, width:24 });
  await page.setInputFiles('#segSourceFile', {name:'wrong-size.tif',mimeType:'image/tiff',buffer:sourceImage});
  await page.waitForFunction(() => !segPending && $('logText').textContent.includes('Use an image of the same pixel dimensions'));
  assert.equal(await page.evaluate(() => segSourceImage), null);
  assert.match(await page.evaluate(() => $('logText').textContent), /Use an image of the same pixel dimensions/);
  await page.setInputFiles('#segSourceFile', {name:'two-frame-source.tif',mimeType:'image/tiff',buffer:Buffer.from(movie,'base64')});
  await page.waitForFunction(() => !segPending && $('logText').textContent.includes('select a single image, not a stack'));
  assert.equal(await page.evaluate(() => segSourceImage), null);
  await page.waitForFunction(() => segDefaultsFor === stack);
  await page.evaluate(() => { $('applySegmentation').checked=true; $('applySegmentation').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => segmentedImageLabels?.w === 24);
  await page.evaluate(async () => { $('rotateMovie').value='90'; await applyMovieRotation(); });
  assert.deepEqual(await page.evaluate(() => ({ applied:$('applySegmentation').checked,
    mask:segmentedImageLabels, width:stack.w })), { applied:false, mask:null, width:32 });

  await page.evaluate(async () => {
    $('applySegmentation').checked=true;
    lastResult={locs:[{x:5,y:5,frame:0}],px:100};
    await runSptTrack();
  });
  const error = await page.evaluate(() => $('logText').textContent);
  assert.match(error, /no segmentation mask is ready/);

  await page.evaluate(() => { clearSegmentationForNewData(); stack=null; lastResult={locs:[{x:16,y:15,frame:0}],px:100}; });
  await page.setInputFiles('#segSourceFile', {name:'csv-brightfield.tif',mimeType:'image/tiff',buffer:sourceImage});
  await page.waitForFunction(() => segSourceImage?.name==='csv-brightfield.tif' && !segPending);
  await page.evaluate(() => { $('applySegmentation').checked=true; $('applySegmentation').dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => segmentedImageLabels?.source==='watershed' && !segPending);
  assert.ok(await page.evaluate(() => segmentedImageLabels.arr[15*32+16]>0));
  const invalidAreaRange = await page.evaluate(async () => {
    $('segAreaMin').value='5'; $('segAreaMax').value='1';
    await runSptTrack();
    const shown=$('logText').textContent.includes('Min. cell area cannot exceed Max. cell area');
    $('segAreaMin').value='0'; $('segAreaMax').value='';
    return shown;
  });
  assert.equal(invalidAreaRange,true);

  // The area limits gate tracking, using the same pixel coordinates as the overlay.
  const areaAndScale = await page.evaluate(async () => {
    const cfg={sptSearchRange:800,sptMemory:0,frametime:0.02,sptLocError:0,sptTrackLenMin:2};
    const labels={arr:Int32Array.from([1,1,0,0,2,2,2,2]),w:4,h:2};
    const locs=[{x:0,y:0,frame:0},{x:1,y:0,frame:1},
      {x:1,y:1,frame:0},{x:2,y:1,frame:1}];
    const run=async (min,max)=>(await sptCore(locs,100,cfg,{onLog:()=>{},onProgress:()=>{}},
      {labels,areaMin:min,areaMax:max})).locs.map(L=>L.cell_id);
    return {small:await run(0,2),large:await run(3,4),all:await run(0,Infinity)};
  });
  assert.deepEqual(areaAndScale, {small:[1,1,-1,-1],large:[2,2,-1,-1],all:[1,1,2,2]});

  // The displayed mask pixel under a subpixel localization is its containing
  // image pixel. Tracking and the out-of-field check must use that same pixel.
  const subpixelCells=await page.evaluate(() => {
    const labels={arr:Int32Array.from([1,0,0,2]),w:2,h:2};
    return [[0.75,0.25],[0.75,0.75],[1.75,1.75],[-0.2,0.2],[2,1]]
      .map(([x,y])=>cellIdForLoc({x,y},labels));
  });
  assert.deepEqual(subpixelCells,[1,1,2,-1,-1]);

  const reconstructionOpacity = await page.evaluate(async () => {
    const oldSr=srFull, oldRecon=srIsRecon, oldResult=lastResult, oldOverlay=srSegOverlayOn;
    const oldPx=$('pxnm').value;
    try{
      $('pxnm').value='100';
      srFull=document.createElement('canvas'); srFull.width=37; srFull.height=32;
      srFull.getContext('2d').fillRect(0,0,37,32);
      srFull.getContext('2d').fillStyle='rgb(80, 40, 20)';
      srFull.getContext('2d').fillRect(16,16,1,1);
      srIsRecon=true; lastResult={locs:[{x:36,y:20,frame:0}],px:100,mag:1,w:37,h:32,fromCsv:true,csvInferredW:40,csvInferredH:40};
       const labels=new Int32Array(32*32).fill(1); labels[20*32+30]=2;
       acceptSegmentation(labels,32,32,'imported');
      srSegOverlayOn=true; fitView();
      const sample=(px=16.5,py=16.5)=>{
        drawView(); const d=$('sr'), x=Math.round((px-view.cx)*view.zoom+d.clientWidth/2),
          y=Math.round((py-view.cy)*view.zoom+d.clientHeight/2), q=d.width/d.clientWidth;
        return Array.from(d.getContext('2d').getImageData(Math.round(x*q),Math.round(y*q),1,1).data).slice(0,3);
      };
      $('segOpacity').value='0'; $('segOpacity').dispatchEvent(new Event('input')); const zero=sample();
      $('segOpacity').value='100'; $('segOpacity').dispatchEvent(new Event('input')); const full=sample();
       const maskCtx=buildSegOverlayCanvas().getContext('2d');
       const maskColor=(x,y)=>Array.from(maskCtx.getImageData(x,y,1,1).data).slice(0,3);
       const fitCell=sample(30.5,20.5), fitEdge=sample(2.5,2.5);
       const expectedCell=maskColor(30,20), expectedEdge=maskColor(2,2);
       const outsideAt100=sample(36.5,20.5);
      const noteAt100=$('segAlignmentNote').textContent;
       $('pxnm').value='125'; const outside=sample(36.5,20.5);
      const noteAt125=$('segAlignmentNote').textContent;
      view.zoom*=2; view.cx=30; view.cy=20;
       const zoomedCell=sample(30.5,20.5);
       const zoomedOutside=sample(36.5,20.5);
      fitView();
      $('segOpacity').value='50'; $('segOpacity').dispatchEvent(new Event('input')); const half=sample();
       const beforeHold=sample(16.5,15.5);
       await showSegmentationSourceWhileHeld();
       const heldImage=sample(16.5,15.5), heldSignal=sample(16.5,16.5), heldOutside=sample(36.5,20.5);
       restoreSegmentationAfterHold();
       const afterHold=sample(16.5,15.5);
       const overview=document.createElement('canvas'); overview.width=20; overview.height=20;
       const patch=document.createElement('canvas'); patch.width=8; patch.height=8;
        srFull={width:32,height:32,_viewport:true,ovK:2,overview,
         patch:{rx:24,ry:16,k:1,img:patch}};
       fitView(); $('segOpacity').value='100'; $('segOpacity').dispatchEvent(new Event('input'));
       const viewportCell=sample(30.5,20.5), viewportOutside=sample(36.5,20.5);
       return {zero,full,half,fitCell,fitEdge,zoomedCell,viewportCell,viewportOutside,expectedCell,expectedEdge,
         outsideAt100,outside,zoomedOutside,noteAt100,noteAt125,beforeHold,heldImage,heldSignal,heldOutside,afterHold};
    }finally{
      srFull=oldSr; srIsRecon=oldRecon; lastResult=oldResult; srSegOverlayOn=oldOverlay;
      $('pxnm').value=oldPx;
      $('segOpacity').value='50'; $('segOpacity').dispatchEvent(new Event('input'));
    }
  });
  assert.deepEqual(reconstructionOpacity.zero, [80,40,20]);
  assert.ok(reconstructionOpacity.full.some(v=>v>100), JSON.stringify(reconstructionOpacity));
   assert.deepEqual(reconstructionOpacity.fitCell,reconstructionOpacity.expectedCell);
   assert.deepEqual(reconstructionOpacity.zoomedCell,reconstructionOpacity.expectedCell);
   assert.deepEqual(reconstructionOpacity.viewportCell,reconstructionOpacity.expectedCell);
   assert.deepEqual(reconstructionOpacity.fitEdge,reconstructionOpacity.expectedEdge);
   assert.deepEqual(reconstructionOpacity.outsideAt100,[0,0,0]);
   assert.deepEqual(reconstructionOpacity.outside,[0,0,0]);
   assert.deepEqual(reconstructionOpacity.zoomedOutside,[0,0,0]);
   assert.deepEqual(reconstructionOpacity.viewportOutside,[0,0,0]);
   assert.match(reconstructionOpacity.noteAt100,/outside the segmentation image/);
  assert.equal(reconstructionOpacity.noteAt125,reconstructionOpacity.noteAt100);
  assert.ok(reconstructionOpacity.half.every((v,i)=>Math.abs(v-(reconstructionOpacity.zero[i]+reconstructionOpacity.full[i])/2)<=2), JSON.stringify(reconstructionOpacity));
   assert.deepEqual(reconstructionOpacity.heldImage,[255,255,255]);
   assert.ok(reconstructionOpacity.heldSignal.some(v=>v>0),JSON.stringify(reconstructionOpacity));
   assert.deepEqual(reconstructionOpacity.heldOutside,[0,0,0]);
   assert.deepEqual(reconstructionOpacity.afterHold,reconstructionOpacity.beforeHold);

  const interactiveAreaAndScale = await page.evaluate(async () => {
    $('pxnm').value='100';
     lastResult={locs:[{x:0,y:0,frame:0},{x:1,y:0,frame:1},{x:3,y:0,frame:0}],px:100,mag:1,w:4,h:2,fromCsv:true,csvInferredW:4,csvInferredH:2};
    acceptSegmentation(Int32Array.from([1,1,0,0,2,2,2,2]),4,2,'imported');
    $('applySegmentation').checked=true;
    $('pxnm').value='200';
    $('segAreaMin').value='0'; $('segAreaMax').value='2';
    await runSptTrack();
    const included=lastResult.locs.map(L=>L.cell_id);
    $('segAreaMax').value='1';
    await runSptTrack();
    const excluded=lastResult.locs.map(L=>L.cell_id);
    return {included,excluded};
  });
  assert.deepEqual(interactiveAreaAndScale,{included:[1,1,-1],excluded:[-1,-1,-1]});

  const stale = await page.evaluate(async () => {
    let release;
    clearSegmentationForNewData();
    $('applySegmentation').checked=true;
    stack={w:3,h:3,n:1,getFrames:() => new Promise(resolve => { release=() => resolve([Float32Array.from([0,0,0,0,10,0,0,0,0])]); })};
    segSource=null; segDefaultsFor=null;
    const pending=runAutoSegmentation();
    while(!release) await Promise.resolve();
    stack={w:3,h:3,n:1,getFrames:async()=>[new Float32Array(9)]};
    clearSegmentationForNewData();
    release(); await pending;
    return { applied:$('applySegmentation').checked, mask:segmentedImageLabels };
  });
  assert.deepEqual(stale, { applied:false, mask:null });
  await page.evaluate(async () => {
    stack=null;
    acceptSegmentation(Int32Array.from([1,0,0,0]),2,2,'imported');
    await showSegmentationSourceWhileHeld();
  });
  assert.match(await page.evaluate(() => $('logText').textContent), /Show image: no source image is available/);
  const csvField = await page.evaluate(() => {
    stack=null; $('pxnm').value='119';
    lastResult={locs:[{x:35,y:30,frame:0}],w:40,h:40,px:119,mag:1,fromCsv:true};
    acceptSegmentation(new Int32Array(32*32).fill(1),32,32,'imported');
    const preserved={w:lastResult.w,h:lastResult.h,note:segmentationAlignmentNote().includes('outside')};
    lastResult={locs:[{x:31.75,y:31.75,frame:0}],w:40,h:40,px:119,mag:1,fromCsv:true};
    acceptSegmentation(new Int32Array(32*32).fill(1),32,32,'imported');
    return {preserved,fitted:{w:lastResult.w,h:lastResult.h,note:segmentationAlignmentNote().includes('outside')}};
  });
  assert.deepEqual(csvField,{preserved:{w:36,h:32,note:true},fitted:{w:32,h:32,note:false}});
  const mismatchedField = await page.evaluate(async () => {
    lastResult={locs:[{x:35,y:10,frame:0}],w:40,h:20,px:100,mag:1,fromCsv:true,csvInferredW:40,csvInferredH:20};
    acceptSegmentation(new Int32Array(32*32).fill(1),32,32,'imported');
    $('applySegmentation').checked=true;
    await runSptTrack();
    return {outside:segmentedImageLabels.csvOutside,
      blocked:$('logText').textContent.includes('outside the segmentation image')};
  });
  assert.deepEqual(mismatchedField,{outside:1,blocked:true});
  const movieRegistration = await page.evaluate(() => {
    stack={w:32,h:32}; $('pxnm').value='200';
    return cellIdForLoc({x:31,y:31},segmentedImageLabels);
  });
  assert.equal(movieRegistration,1);
  const trackedResize=await page.evaluate(async () => {
    stack=null; $('pxnm').value='100'; $('applySegmentation').checked=true;
    $('segAreaMin').value='0'; $('segAreaMax').value='2';
    lastResult={locs:[{x:0,y:0,x0:0,sigma:1,lpx:0.2,frame:0},{x:1,y:0,x0:1,sigma:1,lpx:0.2,frame:1}],
      w:4,h:2,px:100,mag:1,fromCsv:true,csvCoordinatePx:100,csvInferredW:4,csvInferredH:2};
    lastDrift={fdx:Float64Array.from([2]),fdy:Float64Array.from([4]),segdx:[2],segdy:[4]};
    sSmlmOriginalLocs=[{x:2,y:1}]; sSmlmPairedLocs=[{x:3,y:1}];
    acceptSegmentation(Int32Array.from([1,1,0,0,0,0,0,0]),4,2,'imported');
    await runSptTrack();
    const tracked=!!lastSpt && lastResult.locs.every(L=>L.cell_id===1 && L.track_id>=0);
    $('pxnm').value='200'; $('pxnm').dispatchEvent(new Event('change'));
    const resized={tracked,scaled:lastResult.locs[1].x===0.5 && lastResult.locs[1].x0===0.5
        && lastResult.locs[1].sigma===0.5 && lastResult.locs[1].lpx===0.1,
      drift:lastDrift.fdx[0]===1 && lastDrift.fdy[0]===2 && lastDrift.segdx[0]===1,
      paired:sSmlmOriginalLocs[0].x===1 && sSmlmPairedLocs[0].x===1.5,
      invalidated:lastSpt===null && lastResult.locs.every(L=>L.track_id===undefined && L.cell_id===undefined),
      maskReady:segmentedImageLabels.csvOutside===0};
    await runSptTrack();
    resized.retracked=!!lastSpt && lastResult.locs.every(L=>L.cell_id===1 && L.track_id>=0);
    lastDrift=null; sSmlmOriginalLocs=null; sSmlmPairedLocs=null;
    return resized;
  });
  assert.deepEqual(trackedResize,{tracked:true,scaled:true,drift:true,paired:true,invalidated:true,maskReady:true,retracked:true});
  const fullCsvMask=await page.evaluate(async () => {
    stack=null; $('pxnm').value='100'; $('applySegmentation').checked=true;
    $('segOpacity').value='37'; $('segOpacity').dispatchEvent(new Event('input'));
    const labels=new Int32Array(64).fill(1);
    for(let i=0;i<8;i++){ labels[i]=2; labels[56+i]=2; labels[i*8]=2; labels[i*8+7]=2; }
    labels[3*8+3]=3;
    lastResult={locs:[{x:2,y:2,frame:0},{x:6,y:6,frame:1},{x:2,y:6,frame:2}],
      w:8,h:8,px:100,mag:1,fromCsv:true,csvCoordinatePx:100,csvInferredW:8,csvInferredH:8};
    acceptSegmentation(labels,8,8,'imported');
    $('segAreaMin').value='30'; $('segAreaMax').value='40';
    await runSptTrack();
    const first={cells:segmentedImageData.length,area:segmentedImageData[0]?.areaPx,
      border:segmentedImageLabels.arr[0],emptyCell:segmentedImageLabels.arr[3*8+3],
      original:segmentedImageLabels.arr===labels,
      tracked:lastResult.locs.every(L=>L.cell_id===1 && L.cell_area===35)};
    $('pxnm').value='125'; $('pxnm').dispatchEvent(new Event('change'));
    await runSptTrack();
    const resized={cells:segmentedImageData.length,area:segmentedImageData[0]?.areaPx,
      original:segmentedImageLabels.arr===labels,opacity:+$('segOpacity').value,
      border:segmentedImageLabels.arr[0],
      emptyCell:segmentedImageLabels.arr[3*8+3],
      field:[lastResult.w,lastResult.h],
      tracked:lastResult.locs.every(L=>L.cell_id===1 && L.cell_area===35)};
    acceptSegmentation(new Int32Array(64).fill(4),8,8,'imported');
    const replaced={staleTrackCleared:lastSpt===null,
      assignmentsCleared:lastResult.locs.every(L=>L.cell_id===undefined && L.track_id===undefined),
      trackControlsDisabled:$('sptHistBtn').disabled && $('sptSaveBtn').disabled,
      opacity:+$('segOpacity').value};
    const originalSptCore=sptCore;
    let staleDiscarded;
    try{
      let release;
      $('segAreaMin').value='0'; $('segAreaMax').value='40';
      sptCore=()=>new Promise(resolve=>{ release=()=>resolve({locs:lastResult.locs,trackLengths:[],diffCoeffs:[]}); });
      const pending=runSptTrack();
      for(let i=0;i<10 && !release;i++) await new Promise(requestAnimationFrame);
      if(!release) throw new Error('Track did not reach the in-flight mask replacement check');
      acceptSegmentation(new Int32Array(64).fill(5),8,8,'imported');
      release(); await pending;
      staleDiscarded=lastSpt===null;
    }finally{ sptCore=originalSptCore; }
    return {first,resized,replaced,staleDiscarded};
  });
  assert.deepEqual(fullCsvMask,{first:{cells:3,area:35,border:2,emptyCell:3,original:true,tracked:true},
    resized:{cells:3,area:35,original:true,opacity:37,border:2,emptyCell:3,field:[8,8],tracked:true},
    replaced:{staleTrackCleared:true,assignmentsCleared:true,trackControlsDisabled:true,opacity:37},
    staleDiscarded:true});
  for(const [dataset,count,fullCells] of [['cas12a-scrambled',106906,338],['cas12a-segmentation',159937,188]]){
    const brightfield=await resolveDatasetFile(dataset,'brightfield');
    const publishedMask=await resolveDatasetFile(dataset,'mask');
    const locFile=await resolveDatasetFile(dataset,'localizationsPart1');
    if(!brightfield || !publishedMask || !locFile) continue;
    await page.evaluate(() => { $('pxnm').value='100'; });
    await page.setInputFiles('#file',locFile);
    await page.waitForFunction(n => lastResult?.fromCsv && lastResult.locs.length===n,count);
    await page.evaluate(() => { $('applySegmentation').checked=true; $('applySegmentation').dispatchEvent(new Event('change')); });
    await page.setInputFiles('#segSourceFile',brightfield);
    await page.waitForFunction(() => segSourceImage && segmentedImageLabels?.source==='watershed' && !segPending);
    assert.ok(await page.evaluate(() => lastResult.w>=segSourceImage.w && lastResult.h>=segSourceImage.h));
    assert.match(await page.evaluate(() => segmentationAlignmentNote()),/labels every image pixel/);
    await page.setInputFiles('#segFile',publishedMask);
    await page.waitForFunction(() => segmentedImageLabels?.source==='imported' && !segPending);
    await page.waitForFunction(() => srFull?.width===lastResult.w*lastResult.mag && srFull?.height===lastResult.h*lastResult.mag);
    const uncalibrated=await page.evaluate(async () => {
      const outside=segmentedImageLabels.csvOutside;
      const render=srFull.getContext('2d'), mag=lastResult.mag;
      let outsideVisible=false;
      for(const L of lastResult.locs){
        if(segIndexForLoc(L,segmentedImageLabels.w,segmentedImageLabels.h)>=0) continue;
        const x=Math.round(L.x*mag),y=Math.round(L.y*mag);
        if(x<0||y<0||x>=srFull.width||y>=srFull.height) continue;
        const p=render.getImageData(x,y,1,1).data;
        if(p[0]||p[1]||p[2]){ outsideVisible=true; break; }
      }
      await runSptTrack();
      let maxX=0,maxY=0;
      for(const L of lastResult.locs){ maxX=Math.max(maxX,L.x); maxY=Math.max(maxY,L.y); }
      return {outside,fieldW:lastResult.w,fieldH:lastResult.h,maskW:segmentedImageLabels.w,maskH:segmentedImageLabels.h,
        dataW:Math.floor(maxX)+1,dataH:Math.floor(maxY)+1,outsideVisible,
        blocked:$('logText').textContent.includes('outside the segmentation image')};
    });
    assert.ok(uncalibrated.outside>0 && uncalibrated.fieldW>=uncalibrated.dataW && uncalibrated.fieldH>=uncalibrated.dataH &&
      (uncalibrated.fieldW>uncalibrated.maskW || uncalibrated.fieldH>uncalibrated.maskH) &&
      uncalibrated.outsideVisible && uncalibrated.blocked,JSON.stringify(uncalibrated));
    await page.evaluate(() => {
      window.__csvRefs={result:lastResult,mask:segmentedImageLabels,source:segSourceImage};
      window.__csvNm=Object.fromEntries(['x','y','sigma','lpx','lpy'].filter(k=>Number.isFinite(lastResult.locs[0][k]))
        .map(k=>[k,lastResult.locs[0][k]*lastResult.px]));
      $('segOpacity').value='37'; $('segOpacity').dispatchEvent(new Event('input'));
      $('pxnm').value='119'; $('pxnm').dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => lastResult?.csvCoordinatePx===119 && segmentedImageLabels?.csvOutside===0 && srFull?.width===lastResult.w*lastResult.mag);
    const calibrated=await page.evaluate(() => {
      const mask=segmentedImageLabels;
      const refsPreserved=lastResult===window.__csvRefs.result && mask===window.__csvRefs.mask && segSourceImage===window.__csvRefs.source;
      const nmPreserved=Object.entries(window.__csvNm).every(([k,nm])=>Math.abs(lastResult.locs[0][k]*lastResult.px-nm)<1e-6);
      const opacity=+$('segOpacity').value;
       segShowMode='hist'; drawSegShow(); const histogramCells=histData?.n;
       segShowMode='image'; drawSegShow();
      let same=0;
      for(const L of lastResult.locs){
        const px=Math.floor(L.x),py=Math.floor(L.y);
        const reference=mask.arr[py*mask.w+px]||-1;
        if(cellIdForLoc(L,mask)===reference) same++;
      }
       const panel=$('sr');
       const overlay=buildSegOverlayCanvas().getContext('2d');
       const previousOverlay=srSegOverlayOn;
       const borderPixel=()=>{
         const x=((mask.w/2)*lastResult.mag-view.cx)*view.zoom+panel.clientWidth/2;
         const y=((mask.h-0.5)*lastResult.mag-view.cy)*view.zoom+panel.clientHeight/2;
         const scale=panel.width/panel.clientWidth;
         return Array.from(panel.getContext('2d').getImageData(Math.round(x*scale),Math.round(y*scale),1,1).data);
       };
       srSegOverlayOn=false; drawView(); const plainBorder=borderPixel();
       srSegOverlayOn=true; drawView(); const maskedBorder=borderPixel();
       srSegOverlayOn=previousOverlay; drawView();
       return {fieldW:lastResult.w,fieldH:lastResult.h,maskW:mask.w,maskH:mask.h,refsPreserved,nmPreserved,opacity,
         panelCoverageX:srFull.width*view.zoom/panel.clientWidth,
         panelCoverageY:srFull.height*view.zoom/panel.clientHeight,
          activeCells:segmentedImageData.length,
         histogramCells,
          borderCovered:overlay.getImageData(0,mask.h-1,1,1).data[3]>0,
          borderCompositeChanged:plainBorder.some((v,i)=>v!==maskedBorder[i]),
          fullMaskPreserved:mask.arr[0]>0 && mask.arr[(mask.h-1)*mask.w]>0,
         edgeNote:/CSV detections leave at least 3\.7 image pixels around every edge/.test(segmentationAlignmentNote()),
        outside:mask.csvOutside,retainedOutside:segmentedImageLabels.csvOutside,
        cellAgreement:same/lastResult.locs.length};
    });
    assert.equal(calibrated.fieldW,calibrated.maskW,JSON.stringify(calibrated));
    assert.equal(calibrated.fieldH,calibrated.maskH,JSON.stringify(calibrated));
    assert.equal(calibrated.outside,0,JSON.stringify(calibrated));
    assert.equal(calibrated.retainedOutside,0,JSON.stringify(calibrated));
    assert.equal(calibrated.cellAgreement,1,JSON.stringify(calibrated));
     assert.ok(calibrated.panelCoverageX>0.98 && calibrated.panelCoverageY>0.98,JSON.stringify(calibrated));
      assert.equal(calibrated.activeCells,fullCells,JSON.stringify(calibrated));
      assert.equal(calibrated.histogramCells,fullCells,JSON.stringify(calibrated));
      assert.equal(calibrated.borderCovered,true,JSON.stringify(calibrated));
      assert.equal(calibrated.borderCompositeChanged,true,JSON.stringify(calibrated));
     assert.equal(calibrated.fullMaskPreserved,true,JSON.stringify(calibrated));
      if(dataset==='cas12a-scrambled') assert.equal(calibrated.edgeNote,true,JSON.stringify(calibrated));
    assert.equal(calibrated.refsPreserved,true);
    assert.equal(calibrated.nmPreserved,true);
    assert.equal(calibrated.opacity,37);
    const roundTrip=await page.evaluate(async () => {
      const mask=segmentedImageLabels,source=segSourceImage;
      $('pxnm').value='100'; $('pxnm').dispatchEvent(new Event('change'));
      while(lastResult.csvCoordinatePx!==100 || srFull.width!==lastResult.w*lastResult.mag) await new Promise(requestAnimationFrame);
      const outsideAt100=segmentedImageLabels.csvOutside,fieldAt100=lastResult.w;
       const borderAt100=segmentedImageLabels.arr[0],fullAt100=segmentedImageLabels.arr[0]>0,
         cellsAt100=segmentedImageData.length;
      $('pxnm').value='119'; $('pxnm').dispatchEvent(new Event('change'));
      while(lastResult.csvCoordinatePx!==119 || srFull.width!==lastResult.w*lastResult.mag) await new Promise(requestAnimationFrame);
        return {outsideAt100,fieldAt100,fieldAt119:lastResult.w,borderAt100,fullAt100,cellsAt100,
        maskSame:segmentedImageLabels===mask,sourceSame:segSourceImage===source,
        nmPreserved:Object.entries(window.__csvNm).every(([k,nm])=>Math.abs(lastResult.locs[0][k]*lastResult.px-nm)<1e-6),
        opacity:+$('segOpacity').value};
    });
    assert.ok(roundTrip.outsideAt100>0 && roundTrip.fieldAt100>roundTrip.fieldAt119 && roundTrip.cellsAt100===fullCells,JSON.stringify(roundTrip));
     assert.ok(roundTrip.borderAt100>0 && roundTrip.fullAt100,JSON.stringify(roundTrip));
    assert.equal(roundTrip.maskSame,true);
    assert.equal(roundTrip.sourceSame,true);
    assert.equal(roundTrip.nmPreserved,true);
    assert.equal(roundTrip.opacity,37);
     console.log(`${dataset}: 100→119→100→119 nm/px preserves the full mask and ${count} localizations without reload.`);
  }
  console.log('Watershed UI checks passed.');
} finally { await browser.close(); }
