// Browser capability fallbacks: no Save-As picker (Firefox/Safari) downloads directly, a plot downloads PNG + SVG,
// a missing WebGPU stays silent, and a worker failure shows a dismissible notice.
import assert from 'node:assert/strict';
import { launchPage } from '../lib/launch.mjs';

const { browser, page } = await launchPage({ headless: true });
try {
  const noPicker = () => page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }));
  const noticeShown = () => page.locator('#compatNotice').isVisible();

  await noPicker();
  const download = page.waitForEvent('download');
  await page.evaluate(() => saveBlob(new Blob(['ok'], { type: 'text/plain' }), 'fallback.txt', 'Text', 'text/plain', '.txt'));
  assert.equal((await download).suggestedFilename(), 'fallback.txt');
  assert.equal(await noticeShown(), false, 'a missing save picker is normal: no banner');
  assert.doesNotMatch(await page.locator('#logText').textContent(), /need http\(s\)/i);

  // Save localisations (CSV/.smlm/.hdf5) shares the same no-picker path: a download target, no handle
  const locTarget = await page.evaluate(async () => { const t = await pickLocSaveTarget('csv', 'x_locs'); return { name: t.name, handle: t.handle }; });
  assert.deepEqual(locTarget, { name: 'x_locs.csv', handle: null });
  const locDownload = page.waitForEvent('download');
  await page.evaluate(() => writeLocSave({ handle: null, name: 'x_locs.csv' }, new Blob(['a,b'])));
  assert.equal((await locDownload).suggestedFilename(), 'x_locs.csv');

  await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => { throw new Error('permission denied'); } }));
  const rejected = page.waitForEvent('download');
  await page.evaluate(() => saveBlob(new Blob(['ok']), 'rejected.txt', 'Text', 'text/plain', '.txt'));
  assert.equal((await rejected).suggestedFilename(), 'rejected.txt');
  assert.match(await page.locator('#logText').textContent(), /permission denied/i);

  await noPicker();
  const names = [];
  page.on('download', d => names.push(d.suggestedFilename()));
  await page.evaluate(() => savePlotEither(new Blob(['png'], { type: 'image/png' }), '<svg/>', 'plot.png'));
  await page.waitForEvent('download', { predicate: d => d.suggestedFilename() === 'plot.svg' }).catch(() => {});
  assert.deepEqual(names.filter(n => n.startsWith('plot.')).sort(), ['plot.png', 'plot.svg']);

  const gpu = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    return (await getGpuEngine()).available;
  });
  assert.equal(gpu, false);
  assert.equal(await noticeShown(), false, 'no WebGPU is normal: CPU path, no banner');

  const worker = await page.evaluate(async () => {
    Object.defineProperty(window, 'Worker', { configurable: true, value: undefined });
    return await getPool();
  });
  assert.equal(worker, null);
  assert.equal(await noticeShown(), true);
  const workerNotice = await page.locator('#compatNotice').textContent();
  assert.match(workerNotice, /localization worker/i);
  assert.match(workerNotice, /single.threaded/i);
  await page.locator('#compatNoticeClose').click();
  assert.equal(await noticeShown(), false, 'the notice can be dismissed');

  assert.equal(await page.evaluate(() => getRenderWorker()), null);
  assert.match(await page.locator('#compatNotice').textContent(), /reconstruction worker.*main thread/i);
  console.log('PASS browser capability fallbacks');
} finally {
  await browser.close();
}
