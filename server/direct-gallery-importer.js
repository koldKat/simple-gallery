'use strict';

const fs = require('fs');
const path = require('path');

function emptyTotals() {
  return {
    models: 1,
    modelsChecked: 0,
    galleries: 1,
    knownGalleries: 0,
    newGalleries: 1,
    galleriesProcessed: 0,
    galleriesImported: 0,
    galleriesSkipped: 0,
    images: 0,
    imagesImported: 0,
    imagesSkipped: 0,
    errors: 0,
  };
}

function createDirectGalleryImporter(ctx) {
  const {
    db,
    getJob,
    setJob,
    resetProgressThrottle,
    clearImportErrors,
    galleryProviderRegistry,
    canonicalRemoteUrl,
    fetchText,
    mediaRoot,
    mkdirp,
    loadImportDb,
    saveImportDb,
    getImportModelRecord,
    hydrateImportRecordFromManifests,
    findExistingGalleryForSource,
    nextGalleryName,
    rememberImportedGallery,
    activeImportGalleryPaths,
    markImportPath,
    clearImportPath,
    downloadGalleryImagesPartial,
    galleryStorageStats,
    refreshModelInState,
    recordImportError,
    updateImport,
    importSnapshot,
    nowIso,
  } = ctx;

  function findModel(value) {
    const requested = String(value || '').trim();
    if (!requested) throw new Error('Enter an existing model name or folder.');
    const exactFolder = db.prepare('SELECT id, name, folder FROM models WHERE folder = ?').get(requested);
    if (exactFolder) return exactFolder;
    const rows = db.prepare('SELECT id, name, folder FROM models WHERE lower(name) = lower(?) OR lower(folder) = lower(?)').all(requested, requested);
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) throw new Error('More than one model matches; enter the exact model folder.');
    throw new Error(`Model "${requested}" was not found.`);
  }

  async function importGallery({ model: modelValue, url: sourceValue, providerId = '' } = {}) {
    if (getJob()?.active) throw new Error('An import is already running.');
    resetProgressThrottle();
    clearImportErrors();
    const requestedModel = String(modelValue || '').trim();
    let sourceUrl = String(sourceValue || '').trim();
    let model = null;
    const startedAt = nowIso();
    const job = {
      active: true,
      status: 'running',
      message: 'Importing external gallery.',
      mode: 'direct-gallery',
      sourceUrl,
      sourceUrls: sourceUrl ? [sourceUrl] : [],
      modelName: requestedModel,
      modelFolder: '',
      currentModelUrl: '',
      startedAt,
      finishedAt: null,
      totals: emptyTotals(),
      current: { gallery: '', title: '', sourceUrl, images: 0, imported: 0 },
      logs: [],
    };
    setJob(job);

    let galleryPath = '';
    let persisted = false;
    try {
      model = findModel(requestedModel);
      sourceUrl = canonicalRemoteUrl(sourceUrl);
      const provider = galleryProviderRegistry.identify(sourceUrl, providerId);
      Object.assign(job, {
        sourceUrl,
        sourceUrls: [sourceUrl],
        modelName: model.name,
        modelFolder: model.folder,
      });
      job.current.sourceUrl = sourceUrl;
      updateImport(`Fetching external gallery for ${model.name}: ${sourceUrl}`, {}, { force: true });
      const modelPath = path.join(mediaRoot(), model.folder);
      mkdirp(modelPath);
      const existingFolder = findExistingGalleryForSource(modelPath, sourceUrl);
      if (existingFolder) {
        job.totals.knownGalleries = 1;
        job.totals.newGalleries = 0;
        job.totals.galleriesProcessed = 1;
        job.totals.galleriesSkipped = 1;
        job.totals.modelsChecked = 1;
        await refreshModelInState(model.folder);
        job.active = false;
        job.status = 'done';
        job.finishedAt = nowIso();
        updateImport(`Gallery is already imported as ${model.name} / ${existingFolder}.`, {}, { force: true });
        return importSnapshot();
      }

      const html = await fetchText(sourceUrl, { allowedHosts: provider.allowedHosts });
      const extracted = galleryProviderRegistry.extract(provider, html, sourceUrl);
      const galleryName = nextGalleryName(modelPath);
      galleryPath = path.join(modelPath, galleryName);
      markImportPath(galleryPath);
      activeImportGalleryPaths.add(galleryPath);
      mkdirp(galleryPath);
      job.current = {
        gallery: galleryName,
        title: extracted.title,
        sourceUrl,
        images: extracted.imageUrls.length,
        imported: 0,
      };
      job.totals.images = extracted.imageUrls.length;
      const items = extracted.imageUrls.map((imageUrl, index) => ({
        index,
        imageUrl,
        referer: extracted.referer,
        allowedHosts: extracted.allowedImageHosts,
      }));
      const downloads = await downloadGalleryImagesPartial(items, galleryPath, extracted.title, (imported, total) => {
        job.current.imported = imported;
        updateImport(`Imported ${imported}/${total} images for ${model.name} / ${galleryName}.`, {}, { log: false });
      });
      for (const failure of downloads.failures) {
        job.totals.errors += 1;
        recordImportError({
          gallery: galleryName,
          title: extracted.title,
          sourceUrl: failure.imageUrl || sourceUrl,
          message: `External image download failed: ${failure.message}`,
        });
      }
      if (!downloads.downloaded.length) throw new Error('No images could be downloaded from the external gallery.');

      const storage = galleryStorageStats(galleryPath);
      const importDb = loadImportDb();
      const modelRecord = getImportModelRecord(importDb, model.folder, model.name, '');
      hydrateImportRecordFromManifests(modelRecord, modelPath);
      rememberImportedGallery(modelRecord, {
        sourceUrl,
        sourceProvider: extracted.providerId,
        title: extracted.title,
      }, galleryName, downloads.downloaded.length, {
        sourceProvider: extracted.providerId,
        coverName: storage.imageNames?.[0] || null,
        imageBytes: storage.imageBytes,
        thumbBytes: storage.thumbBytes,
      });
      persisted = true;
      saveImportDb(importDb);
      job.totals.modelsChecked = 1;
      job.totals.galleriesProcessed = 1;
      job.totals.galleriesImported = 1;
      job.totals.imagesImported = downloads.downloaded.length;
      job.totals.imagesSkipped = downloads.failures.length;
      // The scanner deliberately ignores locked folders. The files and database
      // record are complete now, so release this gallery before rebuilding model state.
      activeImportGalleryPaths.delete(galleryPath);
      clearImportPath(galleryPath);
      await refreshModelInState(model.folder);
      job.active = false;
      job.status = 'done';
      job.finishedAt = nowIso();
      updateImport(`Imported ${model.name} / ${galleryName}: ${downloads.downloaded.length} images from provider ${extracted.providerId}.`, {}, { force: true });
      return importSnapshot();
    } catch (error) {
      if (galleryPath && !persisted) fs.rmSync(galleryPath, { recursive: true, force: true });
      job.active = false;
      job.status = 'error';
      job.finishedAt = nowIso();
      job.totals.errors += 1;
      recordImportError({ sourceUrl, folder: model?.folder || '', message: error.message || 'External gallery import failed.' });
      updateImport(error.message || 'External gallery import failed.', {}, { force: true });
      return importSnapshot();
    } finally {
      if (galleryPath) activeImportGalleryPaths.delete(galleryPath);
      if (galleryPath) clearImportPath(galleryPath);
    }
  }

  return { findModel, importGallery };
}

module.exports = { createDirectGalleryImporter };
