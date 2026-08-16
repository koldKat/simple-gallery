'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImportRunner } = require('../server/import-runner');

function fixture(options = {}) {
  let job = null;
  let stopRequested = false;
  let pauseRequested = false;
  let checkpoint = options.checkpoint || null;
  const savedCheckpoints = [];
  const imported = [];
  const updates = [];
  let checkpointClears = 0;
  let thumbSkips = 0;
  let errorsCleared = 0;
  const canonical = value => {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  };
  const snapshot = () => job ? { status: job.status, active: job.active, totals: { ...job.totals } } : { active: false };
  const runner = createImportRunner({
    getJob: () => job,
    setJob: value => { job = value; },
    getStopRequested: () => stopRequested,
    setStopRequested: value => { stopRequested = value; },
    getPauseRequested: () => pauseRequested,
    setPauseRequested: value => { pauseRequested = value; },
    canonicalRemoteUrl: canonical,
    resetProgressThrottle() {},
    clearImportErrors: () => { errorsCleared += 1; },
    nowIso: () => '2026-08-16T12:00:00.000Z',
    recordRescanAllStarted() {},
    saveRescanAllCheckpoint: value => {
      checkpoint = value;
      savedCheckpoints.push(structuredClone(value));
    },
    broadcast() {},
    importSnapshot: snapshot,
    broadcastLoadedModels() {},
    pauseForForegroundBrowsing: async () => {},
    importModel: async sourceUrl => {
      imported.push(sourceUrl);
      job.modelsChecked = (job.modelsChecked || 0) + 1;
      job.totals.modelsChecked += 1;
      job.totals.galleriesImported += Number(options.importedPerModel ?? 1);
      job.modelName = sourceUrl.split('/').at(-1);
      if (options.pauseAfterFirst && imported.length === 1) pauseRequested = true;
      if (options.errorAt === imported.length) {
        job.status = 'error';
        job.active = false;
      }
      return snapshot();
    },
    updateImport: message => { updates.push(message); },
    skipNextThumbAutoRescan: () => { thumbSkips += 1; },
    clearRescanAllCheckpoint: () => { checkpoint = null; checkpointClears += 1; },
    recordRescanAllFinished() {},
    getScannedUrlPayload: () => ({
      urls: options.urls || ['https://example.test/model/a', 'https://example.test/model/b'],
    }),
    resumableRescanAllCheckpoint: () => checkpoint,
    getLoadedModelList: () => ({ models: [] }),
  });
  return {
    runner,
    imported,
    updates,
    savedCheckpoints,
    job: () => job,
    checkpoint: () => checkpoint,
    checkpointClears: () => checkpointClears,
    thumbSkips: () => thumbSkips,
    errorsCleared: () => errorsCleared,
  };
}

test('Rescan All deduplicates sources, advances checkpoints, and completes cleanly', async () => {
  const context = fixture();
  const result = await context.runner.importSources([
    'https://example.test/model/a?from=list',
    'https://example.test/model/a',
    'https://example.test/model/b',
  ], 'all');
  assert.deepEqual(context.imported, ['https://example.test/model/a', 'https://example.test/model/b']);
  assert.equal(result.status, 'done');
  assert.equal(context.job().totals.models, 2);
  assert.equal(context.job().totals.modelsChecked, 2);
  assert.equal(context.thumbSkips(), 1);
  assert.equal(context.checkpointClears(), 1);
  assert.equal(context.errorsCleared(), 1);
  assert.equal(context.savedCheckpoints.some(value => value.nextIndex === 1), true);
});

test('pause requests stop after the current model and retain a resumable checkpoint', async () => {
  const context = fixture({ pauseAfterFirst: true });
  const result = await context.runner.importAll();
  assert.deepEqual(context.imported, ['https://example.test/model/a']);
  assert.equal(result.status, 'paused');
  assert.equal(context.checkpoint().nextUrl, 'https://example.test/model/b');
  assert.equal(context.checkpoint().status, 'paused');
  assert.equal(context.checkpointClears(), 0);
});

test('resume starts at the checkpoint model and preserves accumulated totals', async () => {
  const context = fixture({
    checkpoint: {
      nextUrl: 'https://example.test/model/b',
      totals: { galleriesImported: 7, modelsChecked: 1 },
      startedAt: 'original-start',
    },
  });
  const result = await context.runner.resumeAll();
  assert.deepEqual(context.imported, ['https://example.test/model/b']);
  assert.equal(result.status, 'done');
  assert.equal(context.job().startedAt, 'original-start');
  assert.equal(context.job().totals.galleriesImported, 8);
  assert.equal(context.errorsCleared(), 0);
});

test('failed models retain an error checkpoint at the failed source', async () => {
  const context = fixture({ errorAt: 1 });
  const result = await context.runner.importAll();
  assert.equal(result.status, 'error');
  assert.equal(context.checkpoint().nextUrl, 'https://example.test/model/a');
  assert.equal(context.checkpoint().status, 'error');
  assert.equal(context.checkpointClears(), 0);
});
