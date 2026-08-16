'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImportProgress } = require('../server/import-progress');

function fixture() {
  let job = null;
  let stopRequested = false;
  let pauseRequested = false;
  let resumable = null;
  let timestamp = 1000;
  const broadcasts = [];
  const progress = createImportProgress({
    getJob: () => job,
    isStopRequested: () => stopRequested,
    isPauseRequested: () => pauseRequested,
    resumableCheckpoint: () => resumable,
    lastRescanMetadata: () => ({
      lastRescanAllStartedAt: 'start',
      lastRescanAllFinishedAt: 'finish',
      lastRescanAllDurationMs: 5000,
      lastRescanAllStatus: 'done',
    }),
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    progressMinMs: 100,
    logLimit: 3,
    now: () => timestamp,
    nowIso: () => `time-${timestamp}`,
  });
  return {
    progress,
    broadcasts,
    setJob(value) { job = value; },
    setFlags(stop, pause) { stopRequested = stop; pauseRequested = pause; },
    setResumable(value) { resumable = value; },
    advance(ms) { timestamp += ms; },
  };
}

function jobFixture(overrides = {}) {
  return {
    active: true,
    status: 'running',
    mode: 'all',
    message: 'Starting',
    startedAt: 'start',
    finishedAt: null,
    sourceUrl: 'source',
    modelName: 'Model',
    modelFolder: 'model',
    currentModelUrl: 'current',
    totals: { models: 2 },
    current: null,
    logs: [],
    ...overrides,
  };
}

test('snapshots expose idle resumability and active control flags', () => {
  const context = fixture();
  context.setResumable({ nextUrl: 'next' });
  assert.deepEqual(context.progress.snapshot(), { active: false, canResumeRescanAll: true });

  context.setJob(jobFixture());
  context.setFlags(true, true);
  const snapshot = context.progress.snapshot();
  assert.equal(snapshot.stopAfterCurrentModel, true);
  assert.equal(snapshot.pauseRescanAllRequested, true);
  assert.equal(snapshot.canResumeRescanAll, false);
  assert.equal(snapshot.lastRescanAll, null);
});

test('completed Rescan All snapshots include duration metadata', () => {
  const context = fixture();
  context.setJob(jobFixture({ active: false, status: 'done', finishedAt: 'finish' }));
  assert.deepEqual(context.progress.snapshot().lastRescanAll, {
    startedAt: 'start',
    finishedAt: 'finish',
    durationMs: 5000,
    status: 'done',
  });
});

test('updates retain bounded logs and throttle non-forced broadcasts', () => {
  const context = fixture();
  const job = jobFixture();
  context.setJob(job);
  context.progress.update('one');
  context.progress.update('two');
  context.advance(100);
  context.progress.update('three');
  context.advance(100);
  context.progress.update('four');

  assert.deepEqual(job.logs.map(entry => entry.message), ['two', 'three', 'four']);
  assert.equal(context.broadcasts.length, 3);
  assert.equal(context.broadcasts.every(entry => entry.event === 'import'), true);
  context.progress.update('forced', {}, { force: true, log: false });
  assert.equal(context.broadcasts.length, 4);
  assert.deepEqual(job.logs.map(entry => entry.message), ['two', 'three', 'four']);
});
