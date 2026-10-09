#!/usr/bin/env node
// Loading a new movie discards every result of the previous one, including
// the localizations table: its data, committed filters, renderLocs, the rows
// in the page, the filter note and an open table (clearTableState()).
import { launchPage } from '../lib/launch.mjs';
import { encodeMultiFrameTiff16, makeSyntheticFrame } from '../lib/mini-tiff.mjs';
import assert from 'node:assert/strict';

const W = 64, H = 48;
const data = Buffer.from(encodeMultiFrameTiff16([0, 1, 2].map(i => makeSyntheticFrame(W, H, i + 3)), W, H)).toString('base64');
const { browser, page } = await launchPage({ headless: true });
try {
  const snap = () => page.evaluate(() => ({ locs: lastResult ? lastResult.locs.length : 0, renderLocs: renderLocs ? renderLocs.length : null,
    filters: _tableFilters.length, tableData: !!_tableData, rows: $('locTable').querySelectorAll('tbody tr').length,
    open: $('tableModal').classList.contains('open'), note: $('srFilterNote').style.display }));
  await page.evaluate(async () => { $('frames').value = 60; await runSimulation(); await run();
    openTable(); $('tableFilter').value = 'intensity > 0'; commitFilter(); });
  const before = await snap();
  assert.ok(before.locs > 0 && before.filters === 1 && before.renderLocs !== null && before.rows > 0 && before.open, JSON.stringify(before));
  await page.evaluate(async ({ data }) => { await loadFiles([new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'new.tif')]); }, { data });
  const after = await snap();
  assert.deepEqual(after, { locs: 0, renderLocs: null, filters: 0, tableData: false, rows: 0, open: false, note: 'none' });
  console.log(`  ${before.locs} locs, 1 filter, open table -> all cleared by the new load`);
  console.log('Load clears state: PASS');
} finally { await browser.close(); }
