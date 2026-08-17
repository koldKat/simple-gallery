'use strict';

function createWorkerCoordinator({
  workerService,
  sourceModelLoader,
  getImportJob,
  setImportJob,
  getState,
  setState,
  setPauseRequested,
  setStopRequested,
  setForegroundActivity,
  broadcast,
  addTotals,
  emptyTotals,
  latestGallerySummaries,
  runtimeStats,
  stateNotice,
  nowIso,
  recordImportError,
  updateImport,
  importSnapshot,
  loadSourceModelList,
  importLoadedModels,
  importSourceModels,
  importSourceModel,
  importAllScannedUrls,
  resumeRescanAll,
  verifyKnownGalleries,
  importDirectGallery,
  logError = console.error,
}) {
  function mergeModelState(payload) {
    const currentState = getState();
    const oldModel = (currentState.models || []).find(model => model.id === payload.modelName);
    const models = (currentState.models || []).filter(model => model.id !== payload.modelName);
    if (oldModel) {
      addTotals(currentState.totals, oldModel._totals || {
        models: 1,
        galleries: oldModel.galleryCount,
        images: oldModel.count,
        thumbs: Number(oldModel.count || 0) - Number(oldModel.missingThumbs || 0),
        missingThumbs: Number(oldModel.missingThumbs || 0),
        imageBytes: Number(oldModel.imageBytes || 0),
        thumbBytes: Number(oldModel.thumbBytes || 0),
        totalBytes: Number(oldModel.imageBytes || 0) + Number(oldModel.thumbBytes || 0),
      }, -1);
    }
    if (payload.model) {
      models.push(payload.model);
      addTotals(currentState.totals, payload.totals || emptyTotals(), 1);
    }
    models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    setState({
      ...currentState,
      status: 'ready',
      message: `Loaded ${currentState.totals.images} images across ${currentState.totals.galleries} galleries.`,
      scannedAt: payload.scannedAt || nowIso(),
      models,
      latest: latestGallerySummaries(models),
      runtime: runtimeStats(),
      scanProgress: null,
    });
    broadcast('state', stateNotice());
  }

  function handleEvent(message) {
    if (!message || typeof message !== 'object') return;
    const { event, payload } = message;
    if (event === 'import') {
      setImportJob(payload || null);
      broadcast('import', payload);
    } else if (event === 'loaded-models') {
      sourceModelLoader.set(payload);
      broadcast('loaded-models', payload);
    } else if (event === 'import-errors' || event === 'scanned-urls') {
      broadcast(event, payload);
    } else if (event === 'model-state') {
      mergeModelState(payload);
    }
  }

  function startImportInBackground(runner) {
    runner().catch(error => {
      const message = error?.message || 'Background import failed.';
      const job = getImportJob();
      if (job?.active) {
        job.active = false;
        job.status = 'error';
        job.finishedAt = nowIso();
        job.totals.errors += 1;
        recordImportError({ sourceUrl: job.currentModelUrl || job.sourceUrl || '', message });
        updateImport(message, {}, { force: true });
        return;
      }
      logError(message);
    });
    return importSnapshot();
  }

  const commandHandlers = {
    'load-model-list': async ({ url }) => loadSourceModelList(url),
    'load-missing-models': async ({ url }) => loadSourceModelList(url, { missingOnly: true }),
    'import-start': async payload => startImportInBackground(async () => {
      const urls = Array.isArray(payload.urls) ? payload.urls.map(url => String(url).trim()).filter(Boolean) : [];
      if (payload.loaded) return importLoadedModels();
      if (urls.length) return importSourceModels(urls, 'loaded');
      if (!payload.url) throw new Error('Missing URL.');
      return importSourceModel(String(payload.url).trim());
    }),
    'rescan-all-start': async () => startImportInBackground(() => importAllScannedUrls()),
    'rescan-all-resume': async () => startImportInBackground(() => resumeRescanAll()),
    'rescan-all-pause': async () => {
      const job = getImportJob();
      if (!job?.active || job.mode !== 'all') throw new Error('No Rescan All run is active.');
      setPauseRequested(true);
      updateImport('Pause requested; Rescan All will pause after the current model.', {}, { force: true });
      return importSnapshot();
    },
    'verify-known-start': async () => startImportInBackground(() => verifyKnownGalleries()),
    'direct-gallery-import': async payload => {
      if (getImportJob()?.active) throw new Error('An import is already running.');
      return startImportInBackground(() => importDirectGallery(payload));
    },
    'stop-after-current-model': async () => {
      if (!getImportJob()?.active) throw new Error('No active import.');
      setStopRequested(true);
      updateImport('Stop after current model requested.', {}, { force: true });
      return importSnapshot();
    },
  };

  function start() {
    workerService.startProcess(commandHandlers, setForegroundActivity);
  }

  return { commandHandlers, handleEvent, mergeModelState, start, startImportInBackground };
}

module.exports = { createWorkerCoordinator };
