#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandReason, commandStatus, snapshotMutableArtifacts, startDashboardServer } from '../dashboard-server.mjs';

assert.equal(commandStatus(0, 'Skipping real-data benchmark.'), 'skip');
assert.equal(commandStatus(0, 'Benchmark complete.'), 'pass');
assert.equal(commandStatus(1, 'Dataset missing.'), 'fail');
assert.match(commandReason('skip', ['Skipping.'], [{ label: 'Example data', present: false, downloadable: true }]), /Please download Example data/);

const artifactDir = mkdtempSync(join(tmpdir(), 'websmlm-dashboard-artifacts-'));
try {
  writeFileSync(join(artifactDir, 'picasso-report.html'), '<h1>exact run</h1>');
  writeFileSync(join(artifactDir, 'picasso-latest.json'), '{"run":1}');
  writeFileSync(join(artifactDir, 'picasso-compare-timestamp.json'), '{"run":1}');
  const preserved = snapshotMutableArtifacts(
    ['picasso-report.html', 'picasso-latest.json', 'picasso-compare-timestamp.json'],
    'run-1',
    'picasso:compare',
    artifactDir,
  );
  assert.deepEqual(preserved, [
    'picasso-report-run-1-picasso-compare.html',
    'picasso-latest-run-1-picasso-compare.json',
    'picasso-compare-timestamp.json',
  ]);
  assert.match(readFileSync(join(artifactDir, preserved[0]), 'utf8'), /exact run/);
} finally {
  rmSync(artifactDir, { recursive: true, force: true });
}

const dashboard = await startDashboardServer({ port: 0, open: false });

async function api(path, options = {}) {
  return fetch(`${dashboard.url}${path}`, options);
}

try {
  const page = await api('/');
  assert.equal(page.status, 200);
  const dashboardHtml = await page.text();
  assert.match(dashboardHtml, /webSMLM test dashboard/i);
  assert.match(dashboardHtml, /Artifacts from selected run/i);
  assert.match(dashboardHtml, /Reports from selected run/i);
  assert.match(dashboardHtml, /\.report-list button\s*\{[^}]*white-space:\s*normal/);

  const stateResponse = await api('/api/state');
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.ok(!state.results.some(result => result.name === 'dashboard-runs.json'), 'run history is not a test artifact');
  assert.ok(state.scripts.some(script => script.name === 'data:list'));
  assert.equal(state.scripts.find(script => script.name === 'everything')?.kind, 'suite');
  assert.match(state.scripts.find(script => script.name === 'everything')?.description || '', /physical simulation regime matrix/i);
  assert.equal(state.scripts.find(script => script.name === 'validation:bench:regimes')?.label, 'Physical simulation accuracy matrix');
  assert.deepEqual(state.scripts.find(script => script.name === 'everything')?.datasets, []);
  assert.deepEqual(state.scripts.find(script => script.name === 'gpu:bench:real')?.datasets.map(dataset => dataset.key), ['storm3d']);
  assert.deepEqual(state.scripts.find(script => script.name === 'harness:test:datasets')?.datasets, []);
  assert.deepEqual(state.scripts.find(script => script.name === 'io:test:bigtiff')?.datasets, []);
  assert.deepEqual(state.scripts.find(script => script.name === 'cpu:bench:segmentation')?.datasets.map(dataset => dataset.key), ['cas12a-segmentation']);
  assert.deepEqual(state.scripts.find(script => script.name === 'cpu:bench:segmentation-scrambled')?.datasets.map(dataset => dataset.key), ['cas12a-scrambled']);
  assert.equal(state.datasets.length, 11, 'only downloadable datasets must appear');
  assert.ok(state.datasets.every(dataset => dataset.downloadable));
  assert.deepEqual(state.datasets.filter(dataset => dataset.downloadable).map(dataset => dataset.key).sort(), [
    'cas12a-scrambled', 'cas12a-segmentation', 'epfl-as-beads', 'epfl-as-hd', 'epfl-as-ld', 'epfl-bp250', 'epfl-dh', 'gatta80r', 'npc-beads', 'ssmlm', 'storm3d',
  ]);
  assert.ok(!state.scripts.some(script => script.name === 'postinstall'));
  assert.ok(!state.scripts.some(script => script.name === 'validation:setup'));
  assert.ok(!state.scripts.some(script => script.name.startsWith('data:download')));

  const unauthorized = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scripts: ['data:list'] }),
  });
  assert.equal(unauthorized.status, 403);

  const invalid = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-token': dashboard.token },
    body: JSON.stringify({ scripts: ['not:a:script'] }),
  });
  assert.equal(invalid.status, 400);

  const duplicateSuite = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-token': dashboard.token },
    body: JSON.stringify({ scripts: ['gpu:all', 'gpu:test:foundation'] }),
  });
  assert.equal(duplicateSuite.status, 400);

  const traversal = await api('/api/result?file=..%2F..%2Ftools%2Fpackage.json', {
    headers: { 'x-dashboard-token': dashboard.token },
  });
  assert.equal(traversal.status, 400);

  const started = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-token': dashboard.token },
    body: JSON.stringify({ scripts: ['data:list'] }),
  });
  assert.equal(started.status, 202);

  const deadline = Date.now() + 20_000;
  let finished;
  do {
    await new Promise(resolve => setTimeout(resolve, 100));
    finished = await (await api('/api/state')).json();
  } while (finished.run.busy && Date.now() < deadline);

  assert.equal(finished.run.busy, false);
  assert.equal(finished.run.commands.at(-1)?.name, 'data:list');
  assert.equal(finished.run.commands.at(-1)?.status, 'pass');
  const savedRun = finished.runs.find(run => run.id === finished.run.id);
  assert.ok(savedRun, 'completed dashboard run must be saved separately');
  assert.deepEqual(savedRun.selection, ['data:list']);
  assert.equal(savedRun.commands.length, 1, 'runs must not combine commands from earlier runs');
  assert.equal(savedRun.commands[0].status, 'pass');
  assert.ok(savedRun.commands[0].log.some(line => line.includes('storm3d')), 'each command must retain its own log');

  const standalone = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dashboard-token': dashboard.token },
    body: JSON.stringify({ scripts: ['harness:test:report'] }),
  });
  assert.equal(standalone.status, 202);
  const secondDeadline = Date.now() + 20_000;
  let second;
  do {
    await new Promise(resolve => setTimeout(resolve, 100));
    second = await (await api('/api/state')).json();
  } while (second.run.busy && Date.now() < secondDeadline);
  const standaloneRun = second.runs.find(run => run.id === second.run.id);
  assert.equal(standaloneRun.summary.total, 1, 'standalone reports must not be expanded as aggregate suites');
  assert.equal(standaloneRun.summary.passed, 1);
  assert.equal(standaloneRun.commands[0].children.length, 0);
  console.log('Dashboard server: PASS');
} finally {
  await dashboard.close();
}
