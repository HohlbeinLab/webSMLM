import assert from 'node:assert/strict';
import { launchPage } from '../lib/launch.mjs';

const expected = { firefox: 'firefox', webkit: 'webkit' }[process.env.WEBSMLM_BROWSER] || 'chromium';
const { browser, page } = await launchPage({ headless: true });
try {
  assert.equal(browser.browserType().name(), expected);
  assert.match(await page.title(), /^webSMLM/);
  console.log(`PASS ${expected} browser launch`);
} finally {
  await browser.close();
}
