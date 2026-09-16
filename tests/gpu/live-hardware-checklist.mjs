#!/usr/bin/env node
// Live-streaming Tier C — real Micro-Manager hardware. Nothing here can
// launch or click through Micro-Manager's GUI, so this is a guided WAIT, not
// automation: prints the exact steps, opens webSMLM.html, and polls
// window.webSMLM.liveStream.isActive() for a bounded time, reporting whether
// a real connection actually arrived. Opt-in only
// (run-suite.mjs --live-hardware) — never part of a default/unattended run.
//
// Usage: node tests/gpu/live-hardware-checklist.mjs [--timeout-s=N]
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';

const timeoutArg = process.argv.find(a => a.startsWith('--timeout-s='));
const TIMEOUT_S = timeoutArg ? Number(timeoutArg.split('=')[1]) : 300;

console.log(`
Live-streaming hardware checklist (waiting up to ${TIMEOUT_S}s for a connection):

  1. Open Micro-Manager 2.0 with the webSMLM_Streaming plugin loaded
     (micromanager_plugin/webSMLM_Streaming/README.md has build/install steps).
  2. Start Live or Snap (or run an MDA) so the plugin has frames to send.
  3. In the webSMLM window this script is about to open, expand
     "Memory & streaming", paste the plugin's WebSocket URL, click Connect.

This script cannot do steps 1-3 for you — Micro-Manager's GUI can't be driven
headlessly here. It only opens webSMLM.html and watches for the connection.
`);

const { browser, page } = await launchPage({ headless: false });
let connected = false;
try {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_S * 1000) {
    connected = await page.evaluate(() => window.webSMLM.liveStream.isActive());
    if (connected) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(connected
    ? '\nOK   a live-streaming session connected.'
    : `\nSKIP no connection seen within ${TIMEOUT_S}s — not a failure, just nothing to check without real hardware.`);

  const outFile = writeResults('live-hardware-checklist', { timeoutS: TIMEOUT_S, connected });
  console.log(`Full results written to ${outFile}`);
} finally {
  await browser.close();
}
