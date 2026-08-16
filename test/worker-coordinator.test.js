'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerCoordinator } = require('../server/worker-coordinator');

function fixture(overrides = {}) {
  let importJob = { active: true, mode: 'all', totals: { errors: 0 } };
  let state = {
    status: 'ready',
    totals: { models: 1, galleries: 1, images: 2 },
    models: [{ id: 'old', name: 'Old', galleryCount: 1, count: 2 }],
  };
  const calls = { broadcasts: [], loaded: [], pauses: [], stops: [], updates: [] };
  const coordinator = createWorkerCoordinator({
    workerService: { startProcess() {} },
    sourceModelLoader: { set: payload => calls.loaded.push(payload) },
    getImportJob: () => importJob,
    setImportJob: value => { importJob = value; },
    getState: () => state,
    setState: value => { state = value; },
    setPauseRequested: value => calls.pauses.push(value),
    setStopRequested: value => calls.stops.push(value),
    setForegroundActivity() {},
    broadcast: (...args) => calls.broadcasts.push(args),
    addTotals(totals, delta, direction) {
      totals.models += Number(delta.models || 0) * direction;
      totals.galleries += Number(delta.galleries || 0) * direction;
      totals.images += Number(delta.images || 0) * direction;
    },
    emptyTotals: () => ({ models: 0, galleries: 0, images: 0 }),
    latestGallerySummaries: models => models.map(model => model.id),
    runtimeStats: () => ({ rssBytes: 10 }),
    stateNotice: () => ({ status: state.status }),
    nowIso: () => '2026-01-01T00:00:00.000Z',
    recordImportError() {},
    updateImport: message => calls.updates.push(message),
    importSnapshot: () => ({ active: importJob?.active || false }),
    loadSourceModelList: async () => ({}),
    importLoadedModels: async () => ({}),
    importSourceModels: async () => ({}),
    importSourceModel: async () => ({}),
    importAllScannedUrls: async () => ({}),
    resumeRescanAll: async () => ({}),
    verifyKnownGalleries: async () => ({}),
    ...overrides,
  });
  return { calls, coordinator, getImportJob: () => importJob, getState: () => state };
}

test('worker import and loaded-model events update process state and rebroadcast', () => {
  const { calls, coordinator, getImportJob } = fixture();

  coordinator.handleEvent({ event: 'import', payload: { active: false } });
  coordinator.handleEvent({ event: 'loaded-models', payload: { models: ['a'] } });

  assert.deepEqual(getImportJob(), { active: false });
  assert.deepEqual(calls.loaded, [{ models: ['a'] }]);
  assert.deepEqual(calls.broadcasts, [
    ['import', { active: false }],
    ['loaded-models', { models: ['a'] }],
  ]);
});

test('model-state events replace totals and cached model summaries', () => {
  const { calls, coordinator, getState } = fixture();

  coordinator.handleEvent({
    event: 'model-state',
    payload: {
      modelName: 'old',
      model: { id: 'new', name: 'New' },
      totals: { models: 1, galleries: 3, images: 8 },
    },
  });

  assert.deepEqual(getState().models.map(model => model.id), ['new']);
  assert.deepEqual(getState().totals, { models: 1, galleries: 3, images: 8 });
  assert.deepEqual(getState().latest, ['new']);
  assert.deepEqual(calls.broadcasts.at(-1), ['state', { status: 'ready' }]);
});

test('pause and stop commands set their request flags', async () => {
  const { calls, coordinator } = fixture();

  await coordinator.commandHandlers['rescan-all-pause']();
  await coordinator.commandHandlers['stop-after-current-model']();

  assert.deepEqual(calls.pauses, [true]);
  assert.deepEqual(calls.stops, [true]);
  assert.match(calls.updates[0], /Pause requested/);
  assert.match(calls.updates[1], /Stop after current model/);
});
