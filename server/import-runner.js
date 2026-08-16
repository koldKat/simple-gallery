'use strict';

function createImportRunner(ctx) {
  const {
    getJob,
    setJob,
    getStopRequested,
    setStopRequested,
    getPauseRequested,
    setPauseRequested,
    canonicalRemoteUrl,
    resetProgressThrottle,
    clearImportErrors,
    nowIso,
    recordRescanAllStarted,
    saveRescanAllCheckpoint,
    broadcast,
    importSnapshot,
    broadcastLoadedModels,
    pauseForForegroundBrowsing,
    importModel,
    updateImport,
    skipNextThumbAutoRescan,
    clearRescanAllCheckpoint,
    recordRescanAllFinished,
    getScannedUrlPayload,
    resumableRescanAllCheckpoint,
    getLoadedModelList,
  } = ctx;

  async function importSources(sourceUrls, mode = 'single', options = {}) {
    if (getJob()?.active) throw new Error('An import is already running.');
    const uniqueSourceUrls = Array.from(new Set(sourceUrls.map(url => canonicalRemoteUrl(url))));
    const startIndex = mode === 'all'
      ? Math.max(0, Math.min(uniqueSourceUrls.length, Number(options.startIndex || 0)))
      : 0;
    const resumedTotals = options.totals && typeof options.totals === 'object' ? options.totals : {};
    setStopRequested(false);
    setPauseRequested(false);
    resetProgressThrottle();
    if (!options.resume) clearImportErrors();

    const job = {
      active: true,
      status: 'running',
      message: mode === 'all'
        ? (options.resume ? `Resuming rescan all at model ${startIndex + 1}/${uniqueSourceUrls.length}.` : 'Starting rescan all.')
        : 'Starting import.',
      mode,
      sourceUrl: uniqueSourceUrls[0] || '',
      sourceUrls: uniqueSourceUrls,
      modelName: '',
      modelFolder: '',
      currentModelUrl: '',
      startedAt: options.startedAt || nowIso(),
      finishedAt: null,
      totals: {
        models: uniqueSourceUrls.length,
        modelsChecked: startIndex,
        galleries: Number(resumedTotals.galleries || 0),
        knownGalleries: Number(resumedTotals.knownGalleries || 0),
        newGalleries: Number(resumedTotals.newGalleries || 0),
        galleriesProcessed: Number(resumedTotals.galleriesProcessed || 0),
        galleriesImported: Number(resumedTotals.galleriesImported || 0),
        galleriesSkipped: Number(resumedTotals.galleriesSkipped || 0),
        images: Number(resumedTotals.images || 0),
        imagesImported: Number(resumedTotals.imagesImported || 0),
        imagesSkipped: Number(resumedTotals.imagesSkipped || 0),
        errors: Number(resumedTotals.errors || 0),
      },
      current: null,
      logs: [],
    };
    setJob(job);
    if (mode === 'all') {
      recordRescanAllStarted(job.startedAt);
      if (uniqueSourceUrls[startIndex]) {
        saveRescanAllCheckpoint({
          nextUrl: uniqueSourceUrls[startIndex],
          nextIndex: startIndex,
          total: uniqueSourceUrls.length,
          totals: job.totals,
          startedAt: job.startedAt,
        });
      }
    }
    broadcast('import', importSnapshot());
    broadcastLoadedModels();

    for (let modelIndex = startIndex; modelIndex < uniqueSourceUrls.length; modelIndex += 1) {
      const sourceUrl = uniqueSourceUrls[modelIndex];
      await pauseForForegroundBrowsing();
      const totalsBeforeModel = { ...job.totals, modelsChecked: modelIndex };
      if (mode === 'all') {
        saveRescanAllCheckpoint({
          nextUrl: sourceUrl,
          nextIndex: modelIndex,
          total: uniqueSourceUrls.length,
          totals: totalsBeforeModel,
          startedAt: job.startedAt,
        });
      }
      const lastSnapshot = await importModel(sourceUrl);
      if (lastSnapshot.status === 'error') {
        if (mode === 'all') {
          saveRescanAllCheckpoint({
            nextUrl: sourceUrl,
            nextIndex: modelIndex,
            total: uniqueSourceUrls.length,
            totals: { ...totalsBeforeModel, errors: Number(totalsBeforeModel.errors || 0) + 1 },
            startedAt: job.startedAt,
            status: 'error',
          });
        }
        break;
      }
      if (mode === 'all' && uniqueSourceUrls[modelIndex + 1]) {
        saveRescanAllCheckpoint({
          nextUrl: uniqueSourceUrls[modelIndex + 1],
          nextIndex: modelIndex + 1,
          total: uniqueSourceUrls.length,
          totals: job.totals,
          startedAt: job.startedAt,
        });
      }
      if (mode === 'all' && getPauseRequested() && uniqueSourceUrls[modelIndex + 1]) {
        saveRescanAllCheckpoint({
          nextUrl: uniqueSourceUrls[modelIndex + 1],
          nextIndex: modelIndex + 1,
          total: uniqueSourceUrls.length,
          totals: job.totals,
          startedAt: job.startedAt,
          status: 'paused',
        });
        updateImport('Rescan All paused after the current model.', {}, { force: true });
        break;
      }
      if (getPauseRequested() && !uniqueSourceUrls[modelIndex + 1]) setPauseRequested(false);
      if (getStopRequested()) {
        if (mode === 'all' && uniqueSourceUrls[modelIndex + 1]) {
          saveRescanAllCheckpoint({
            nextUrl: uniqueSourceUrls[modelIndex + 1],
            nextIndex: modelIndex + 1,
            total: uniqueSourceUrls.length,
            totals: job.totals,
            startedAt: job.startedAt,
            status: 'stopped',
          });
        }
        updateImport('Stop after current model requested. Import will stop now.', {}, { force: true });
        break;
      }
    }

    if (job.status !== 'error') {
      if (job.totals.galleriesImported === 0) updateImport('No new galleries imported; gallery refresh skipped.');
      if (job.totals.galleriesImported > 0) skipNextThumbAutoRescan();
      job.active = false;
      job.status = getPauseRequested() ? 'paused' : (getStopRequested() ? 'stopped' : 'done');
      job.finishedAt = nowIso();
      const doneMessage = mode === 'all' ? 'Rescan all complete.' : `Import complete for ${job.modelName}.`;
      if (mode === 'all' && !getStopRequested() && !getPauseRequested()) clearRescanAllCheckpoint();
      if (mode === 'all') recordRescanAllFinished(job.status);
      updateImport(
        getPauseRequested()
          ? 'Rescan All paused after the current model.'
          : (getStopRequested() ? 'Import stopped after current model.' : doneMessage),
        {},
        { force: true }
      );
      setStopRequested(false);
      setPauseRequested(false);
    }
    return importSnapshot();
  }

  async function importOne(sourceUrl) {
    return importSources([sourceUrl], 'single');
  }

  async function importLoaded() {
    const urls = (getLoadedModelList()?.models || []).map(model => model.sourceUrl).filter(Boolean);
    if (!urls.length) throw new Error('No loaded models to import.');
    return importSources(urls, 'loaded');
  }

  async function importAll() {
    const payload = getScannedUrlPayload();
    if (!payload.urls.length) throw new Error('No scanned URLs recorded yet.');
    return importSources(payload.urls, 'all');
  }

  async function resumeAll() {
    const checkpoint = resumableRescanAllCheckpoint();
    if (!checkpoint) throw new Error('No failed or stopped Rescan All run is available to resume.');
    const payload = getScannedUrlPayload();
    if (!payload.urls.length) throw new Error('No scanned URLs recorded yet.');
    const startIndex = payload.urls.findIndex(sourceUrl => {
      try {
        return canonicalRemoteUrl(sourceUrl) === canonicalRemoteUrl(checkpoint.nextUrl);
      } catch {
        return sourceUrl === checkpoint.nextUrl;
      }
    });
    if (startIndex < 0 || !payload.urls[startIndex]) {
      throw new Error(`The saved resume model is no longer in the Rescan All URL list: ${checkpoint.nextUrl}`);
    }
    return importSources(payload.urls, 'all', {
      resume: true,
      startIndex,
      totals: checkpoint.totals,
      startedAt: checkpoint.startedAt,
    });
  }

  return { importSources, importOne, importLoaded, importAll, resumeAll };
}

module.exports = { createImportRunner };
