#!/usr/bin/env node
// Live-streaming Tier B — the REAL WebSocket wire protocol
// (liveStreamWsConnect(), MODULE: liveStreaming), automated end-to-end with
// no external process, no Python, no new dependency:
// tests/lib/mini-ws-server.mjs is a small vanilla-Node WebSocket server
// (node:http + node:crypto only) playing the SAME role
// tools/test_livestream_demo.py plays by hand — pushing binary TIFF chunks
// in and reading back the browser's own {"cmd":"ack"/"stopAck"} replies —
// but fully scripted, so it always runs (that Python script stays as the
// existing manual/visual dev tool, untouched).
//
// Usage: cd tests && npm install (once), then node bench-livestream-realtime.mjs
import { launchPage } from '../lib/launch.mjs';
import { writeResults } from '../lib/report.mjs';
import { encodeSingleFrameTiff16, makeSyntheticFrame } from '../lib/mini-tiff.mjs';
import { startMiniWsServer } from '../lib/mini-ws-server.mjs';

const W = 64, H = 64, N_FRAMES = 8, SEED = 8675309;
const chunkTiffs = [];
for (let i = 0; i < N_FRAMES; i++) chunkTiffs.push(encodeSingleFrameTiff16(makeSyntheticFrame(W, H, SEED + i), W, H));

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'}   ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };
const withTimeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)),
]);

let resolveConn;
const connPromise = new Promise(resolve => { resolveConn = resolve; });
const server = await startMiniWsServer({ onConnection: conn => resolveConn(conn) });
console.log(`Mini WS server listening on ws://127.0.0.1:${server.port}`);

const { browser, page } = await launchPage();
try {
  await page.evaluate(url => { document.getElementById('liveStreamWsUrl').value = url; }, `ws://127.0.0.1:${server.port}`);
  await page.evaluate(() => document.getElementById('liveStreamConnectBtn').click());

  const conn = await withTimeout(connPromise, 30000, 'browser connection');
  console.log('Browser connected.');

  let resolveReply = null;
  conn.onMessage((payload, isBinary) => {
    if (isBinary) return;   // this server only expects TEXT replies (ack/stopAck) from the browser
    let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (resolveReply) { const r = resolveReply; resolveReply = null; r(msg); }
  });
  const nextReply = () => withTimeout(new Promise(resolve => { resolveReply = resolve; }), 30000, 'a reply');

  const acks = [];
  for (let i = 0; i < chunkTiffs.length; i++) {
    conn.sendBinary(chunkTiffs[i]);
    acks.push(await nextReply());
  }
  console.log(`Sent ${chunkTiffs.length} chunks, got ${acks.length} acks.`);
  check('every chunk was acked', acks.length === N_FRAMES, `${acks.length}`);
  check('acks report frame counts in order', acks.every((a, i) => a.framesReceived === i + 1), JSON.stringify(acks.map(a => a.framesReceived)));

  conn.sendText(JSON.stringify({ cmd: 'stop' }));
  const stopAck = await nextReply();
  console.log(`stopAck: ${JSON.stringify(stopAck)}`);
  check('stopAck confirms the total frame count', stopAck.cmd === 'stopAck' && stopAck.framesReceived === N_FRAMES, JSON.stringify(stopAck));

  const outFile = writeResults('bench-livestream-realtime', { nFrames: N_FRAMES, acks, stopAck });
  console.log(`\nFull results written to ${outFile}`);
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll live-stream (Tier B, real-time WebSocket) checks passed.');
