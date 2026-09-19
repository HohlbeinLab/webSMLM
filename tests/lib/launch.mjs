// Shared Playwright launch for the tests/ benchmark scripts — mirrors
// tools/webSMLM-cli.mjs's own launch (chromium.launch/page.goto/ready-wait;
// see that file for the reference this was copied from). One deliberate
// difference: launches via the machine's own installed Chrome
// (channel:'chrome') instead of requiring the Playwright-bundled Chromium
// first. The shared Playwright dependency now lives in tools/, and a real
// installed Chrome gives more
// trustworthy WebGPU behaviour than a fresh headless-only Chromium. Falls
// back to Playwright's own Chromium if 'chrome' isn't found.
//
// Headed by default (unlike the CLI's headless default): these benchmarks
// exist to measure REAL GPU speed, and headless Chrome's GPU/WebGPU
// compositing path has historically been the less-tested one — a real,
// visible window removes that as a variable. Pass {headless:true} to force
// headless anyway once you've confirmed it behaves the same on your machine.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..');
export const htmlUrl = pathToFileURL(join(repoRoot, 'webSMLM.html')).href;
const requireFromTools = createRequire(pathToFileURL(join(repoRoot, 'tools', 'package.json')));
const { chromium } = requireFromTools('playwright');

export async function launchPage({ headless = false } = {}) {
  let browser;
  try {
    browser = await chromium.launch({ headless, channel: 'chrome' });
  } catch (err) {
    console.error(`(couldn't launch system Chrome (${err.message}) — trying Playwright's own Chromium. If that also fails: cd tools && npm install)`);
    browser = await chromium.launch({ headless });
  }
  // Explicit desktop-sized viewport: Playwright's own default (1280x720) has
  // a height of 720px, at or under isMemoryConstrainedDevice()'s own
  // min(innerWidth,innerHeight)<=860 threshold (webSMLM.html, MODULE: params)
  // — that check exists to catch a PHONE held in landscape (wide but short),
  // but a plain, unconfigured desktop test window is wide-but-short in
  // exactly the same way, and gets misclassified into it too. A real,
  // confirmed failure: bench-real-data.mjs --full on the ~4.9GB Leterrier
  // dataset hit "over the 512 MB Total memory budget" (the mobile default)
  // instead of the desktop default (Infinity/unset) purely because of this.
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', msg => { if (msg.type() === 'error') console.error('  [page error]', msg.text()); });
  page.on('pageerror', err => console.error('  [page exception]', err.message));
  await page.goto(htmlUrl);
  await page.waitForFunction(() => window.webSMLM && window.webSMLM.analyze);
  return { browser, page };
}

// One-time GPU probe, reused by every script so a missing/broken WebGPU
// stack fails ONE clear message instead of N confusing per-case ones.
export async function checkGpu(page) {
  return page.evaluate(async () => {
    const engine = await window.getGpuEngine();
    return { available: engine.available, limits: engine.limits || null };
  });
}
