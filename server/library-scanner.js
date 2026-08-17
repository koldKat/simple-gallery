'use strict';

const fs = require('fs');
const path = require('path');

function emptyTotals() {
  return {
    models: 0,
    galleries: 0,
    images: 0,
    thumbs: 0,
    missingThumbs: 0,
    staleThumbsRemoved: 0,
    imageBytes: 0,
    thumbBytes: 0,
    totalBytes: 0,
  };
}

function addTotals(target, delta, direction = 1) {
  for (const key of Object.keys(emptyTotals())) {
    target[key] = Number(target[key] || 0) + Number(delta[key] || 0) * direction;
  }
  target.totalBytes = Number(target.imageBytes || 0) + Number(target.thumbBytes || 0);
}

function createLibraryScanner({
  mediaRoot,
  mediaUrlPrefix,
  thumbDirectory,
  readDirs,
  readImageFiles,
  safeName,
  mkdirp,
  cleanupStaleThumbs,
  removeEmptyThumbDir,
  needsThumb,
  enqueueThumb,
  toUrl,
  fileSize,
  galleryDbRecord,
  galleryRecordsForModel,
  upsertModelRecord,
  upsertGalleryRecord,
  cleanupSeenRecordsForGallery,
  normalizeModelName,
  sourceSlug,
  repairGallerySequence,
  loadImportDb,
  saveImportDb,
  activeImportGalleryPaths,
  dedupeScannedGalleries,
  gallerySummary,
  latestGallerySummaries,
  emptyState,
  runtimeStats,
  getState,
  setState,
  broadcastState,
  isWorker,
  sendWorkerMessage,
  sleep,
  nowIso,
}) {
  let inFlight = null;

  async function scanGallery(modelName, galleryName, galleryRecord = galleryDbRecord(modelName, galleryName)) {
    const galleryPath = path.join(mediaRoot(), modelName, galleryName);
    const thumbRoot = path.join(galleryPath, thumbDirectory);
    const files = readImageFiles(galleryPath);
    let missing = 0;
    let staleThumbsRemoved = 0;
    let imageBytes = 0;
    let thumbBytes = 0;
    let newestMtimeMs = 0;
    let cover = null;
    let coverName = null;
    const wantedThumbNames = new Set(files.map(safeName));

    if (files.length) {
      mkdirp(thumbRoot);
      staleThumbsRemoved = cleanupStaleThumbs(thumbRoot, wantedThumbNames);
    } else {
      staleThumbsRemoved = cleanupStaleThumbs(thumbRoot, wantedThumbNames);
      removeEmptyThumbDir(thumbRoot);
    }

    for (const fileName of files) {
      const sourcePath = path.join(galleryPath, fileName);
      const thumbPath = path.join(thumbRoot, safeName(fileName));
      const hasThumb = fs.existsSync(thumbPath);
      if (needsThumb(sourcePath, thumbPath)) enqueueThumb(sourcePath, thumbPath);
      if (!cover) {
        cover = hasThumb ? toUrl(thumbPath) : toUrl(sourcePath);
        coverName = fileName;
      }
      if (!hasThumb) missing += 1;
      imageBytes += fileSize(sourcePath);
      thumbBytes += hasThumb ? fileSize(thumbPath) : 0;
      try {
        newestMtimeMs = Math.max(newestMtimeMs, fs.statSync(sourcePath).mtimeMs);
      } catch {
        // Ignore files that disappeared during scan.
      }
    }

    return {
      id: `${modelName}/${galleryName}`,
      name: galleryName,
      path: `${mediaUrlPrefix()}/${encodeURIComponent(modelName)}/${encodeURIComponent(galleryName)}`,
      count: files.length,
      cover,
      sourceUrl: galleryRecord?.source_url || null,
      title: galleryRecord?.title || '',
      sourceSlug: sourceSlug(galleryRecord?.source_url),
      imageNames: files,
      createdThumbs: 0,
      missingThumbs: missing,
      staleThumbsRemoved,
      imageBytes,
      thumbBytes,
      coverName,
      addedAt: galleryRecord?.imported_at || galleryRecord?.created_at || (newestMtimeMs ? new Date(newestMtimeMs).toISOString() : null),
      addedAtMs: galleryRecord?.imported_at || galleryRecord?.created_at
        ? (Date.parse(galleryRecord.imported_at || galleryRecord.created_at) || 0)
        : newestMtimeMs,
      updatedAt: newestMtimeMs ? new Date(newestMtimeMs).toISOString() : null,
      updatedAtMs: newestMtimeMs,
    };
  }

  async function scanModelState(modelName, importDb = loadImportDb()) {
    const modelPath = path.join(mediaRoot(), modelName);
    const totals = emptyTotals();
    const modelDbId = upsertModelRecord(modelName, normalizeModelName(modelName), '', { touchUpdatedAt: false });
    const hasActiveImportGallery = Array.from(activeImportGalleryPaths)
      .some(galleryPath => galleryPath === modelPath || galleryPath.startsWith(`${modelPath}${path.sep}`));
    const repairedSequence = !hasActiveImportGallery && repairGallerySequence(modelName, modelPath, importDb);
    const galleryRecords = galleryRecordsForModel(modelName);
    const scannedGalleries = [];

    for (const galleryName of readDirs(modelPath)) {
      const gallery = await scanGallery(modelName, galleryName, galleryRecords.get(galleryName) || null);
      if (!gallery.count) continue;
      gallery.dbId = upsertGalleryRecord(modelName, normalizeModelName(modelName), galleryName, {
        sourceUrl: gallery.sourceUrl,
        title: gallery.title || (gallery.sourceSlug ? normalizeModelName(gallery.sourceSlug) : `Gallery ${galleryName}`),
        imageCount: gallery.count,
        coverName: gallery.coverName,
        imageBytes: gallery.imageBytes,
        thumbBytes: gallery.thumbBytes,
        lastSeenAt: gallery.updatedAt,
        touchModelUpdatedAt: false,
        status: 'imported',
      });
      cleanupSeenRecordsForGallery(gallery.dbId, gallery.imageNames || []);
      scannedGalleries.push(gallery);
    }

    const galleries = dedupeScannedGalleries(scannedGalleries);
    for (const gallery of galleries) {
      totals.galleries += 1;
      totals.images += gallery.count;
      totals.thumbs += gallery.count - gallery.missingThumbs;
      totals.missingThumbs += gallery.missingThumbs;
      totals.staleThumbsRemoved += gallery.staleThumbsRemoved;
      totals.imageBytes += gallery.imageBytes;
      totals.thumbBytes += gallery.thumbBytes;
    }
    totals.totalBytes = totals.imageBytes + totals.thumbBytes;

    if (!galleries.length) return { model: null, totals, repairedSequence };
    const latestGallery = galleries.slice().sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0))[0];
    const model = {
      id: modelName,
      dbId: modelDbId,
      name: modelName,
      count: galleries.reduce((sum, gallery) => sum + gallery.count, 0),
      galleryCount: galleries.length,
      cover: latestGallery?.cover || null,
      updatedAt: latestGallery?.updatedAt || null,
      updatedAtMs: latestGallery?.updatedAtMs || 0,
      _totals: { ...totals, models: 1 },
      galleries: galleries.map(gallerySummary),
    };
    totals.models = 1;
    return { model, totals, repairedSequence };
  }

  async function refreshModel(modelName) {
    const importDb = loadImportDb();
    const scanned = await scanModelState(modelName, importDb);
    if (scanned.repairedSequence) saveImportDb(importDb);

    const currentState = getState();
    const oldModel = (currentState.models || []).find(model => model.id === modelName);
    const models = (currentState.models || []).filter(model => model.id !== modelName);
    if (oldModel) {
      addTotals(currentState.totals, oldModel._totals || {
        models: 1,
        galleries: oldModel.galleryCount,
        images: oldModel.count,
      }, -1);
    }
    if (scanned.model) {
      models.push(scanned.model);
      addTotals(currentState.totals, scanned.totals, 1);
    }
    models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    const nextState = {
      ...currentState,
      status: 'ready',
      message: `Loaded ${currentState.totals.images} images across ${currentState.totals.galleries} galleries.`,
      scannedAt: nowIso(),
      models,
      latest: latestGallerySummaries(models),
    };
    setState(nextState);
    broadcastState();
    if (isWorker) {
      sendWorkerMessage({
        type: 'event',
        event: 'model-state',
        payload: {
          modelName,
          model: scanned.model,
          totals: scanned.totals,
          scannedAt: nextState.scannedAt,
          message: nextState.message,
        },
      });
    }
    return nextState;
  }

  async function scan() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      setState({
        ...getState(),
        status: 'scanning',
        message: 'Scanning galleries and creating thumbnails.',
        scanProgress: { current: 0, total: 0, model: '', totals: emptyTotals() },
      });
      broadcastState();

      mkdirp(mediaRoot());
      const modelNames = readDirs(mediaRoot());
      const importDb = loadImportDb();
      let repairedSequences = false;
      const models = [];
      const totals = emptyTotals();
      let scannedModels = 0;
      let lastScanProgressAt = 0;

      for (const modelName of modelNames) {
        const scanned = await scanModelState(modelName, importDb);
        scannedModels += 1;
        if (scanned.repairedSequence) repairedSequences = true;
        addTotals(totals, scanned.totals, 1);
        if (scanned.model) models.push(scanned.model);
        const timestamp = Date.now();
        if (timestamp - lastScanProgressAt >= 1000 || scannedModels === modelNames.length) {
          lastScanProgressAt = timestamp;
          setState({
            ...getState(),
            status: 'scanning',
            message: `Scanning ${scannedModels}/${modelNames.length} models: ${normalizeModelName(modelName)}`,
            scanProgress: { current: scannedModels, total: modelNames.length, model: modelName, totals },
          });
          broadcastState();
          await sleep(0);
        }
      }

      if (repairedSequences) saveImportDb(importDb);
      totals.totalBytes = totals.imageBytes + totals.thumbBytes;
      const nextState = {
        ...emptyState('ready'),
        message: `Loaded ${totals.images} images across ${totals.galleries} galleries.`,
        scannedAt: nowIso(),
        scanProgress: null,
        totals,
        runtime: runtimeStats(),
        models,
        latest: latestGallerySummaries(models),
      };
      setState(nextState);
      broadcastState();
      inFlight = null;
      return nextState;
    })().catch(error => {
      inFlight = null;
      const nextState = {
        ...getState(),
        status: 'error',
        message: error.message || 'Scan failed.',
        scanProgress: null,
        runtime: runtimeStats(),
      };
      setState(nextState);
      broadcastState();
      return nextState;
    });
    return inFlight;
  }

  return {
    scanGallery,
    scanModelState,
    refreshModel,
    scan,
    isScanning: () => Boolean(inFlight),
  };
}

module.exports = { createLibraryScanner, emptyTotals, addTotals };
