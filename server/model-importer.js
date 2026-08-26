'use strict';

const fs = require('fs');
const path = require('path');

function createModelImporter(ctx) {
  const {
    getJob,
    removeLoadedModel,
    requireSourceProfile,
    validateSourceUrl,
    canonicalRemoteUrl,
    updateImport,
    fetchText,
    extractModelName,
    sanitizeFolderName,
    mediaRoot,
    mkdirp,
    loadImportDb,
    getImportModelRecord,
    hydrateImportRecordFromManifests,
    extractSourceGalleries,
    saveImportDb,
    galleryStorageStats,
    pauseForForegroundBrowsing,
    findExistingGalleryForSource,
    rememberImportedGallery,
    readImageFiles,
    nextGalleryName,
    activeImportGalleryPaths,
    markImportPath,
    clearImportPath,
    extractDetailUrls,
    resolveGalleryImageUrls,
    downloadGalleryImagesPartial,
    recordImportError,
    refreshModelInState,
    recordRescanAllFinished,
    importSnapshot,
    nowIso,
  } = ctx;

  async function importModel(sourceUrl) {
    const job = getJob();
    try {
      job.currentModelUrl = canonicalRemoteUrl(sourceUrl);
      removeLoadedModel(job.currentModelUrl);
      const profile = requireSourceProfile();
      const { parsed } = validateSourceUrl(sourceUrl, '', profile.modelExample);
      if (!parsed.pathname.toLowerCase().startsWith(`/${profile.modelPathSegment.toLowerCase()}/`)) {
        throw new Error(profile.modelExample
          ? `Provide a URL such as ${profile.modelExample}.`
          : `The URL path must begin with /${profile.modelPathSegment}/.`);
      }

      updateImport(`Fetching model page: ${sourceUrl}`);
      const modelHtml = await fetchText(sourceUrl);
      const modelName = extractModelName(sourceUrl, modelHtml);
      removeLoadedModel(job.currentModelUrl, modelName);
      const modelFolder = sanitizeFolderName(modelName);
      const modelPath = path.join(mediaRoot(), modelFolder);
      mkdirp(modelPath);

      const importDb = loadImportDb();
      const modelRecord = getImportModelRecord(importDb, modelFolder, modelName, sourceUrl);
      hydrateImportRecordFromManifests(modelRecord, modelPath);
      let modelImportedGalleries = 0;

      const galleries = extractSourceGalleries(modelHtml, sourceUrl);
      const knownGalleryUrls = new Set(Object.keys(modelRecord.galleries));
      const newGalleries = galleries.filter(gallery => !knownGalleryUrls.has(canonicalRemoteUrl(gallery.sourceUrl)));
      job.modelName = modelName;
      job.modelFolder = modelFolder;
      job.totals.modelsChecked += 1;
      job.totals.galleries += galleries.length;
      job.totals.knownGalleries += galleries.length - newGalleries.length;
      job.totals.newGalleries += newGalleries.length;
      modelRecord.lastCheckedAt = nowIso();
      saveImportDb(importDb);
      updateImport(`Detected ${galleries.length} galleries for ${modelName}: ${newGalleries.length} new, ${galleries.length - newGalleries.length} already known.`);
      let modelNeedsThumbRefresh = false;

      for (const gallery of galleries) {
        await pauseForForegroundBrowsing();
        const canonicalGalleryUrl = canonicalRemoteUrl(gallery.sourceUrl);
        const knownGallery = modelRecord.galleries[canonicalGalleryUrl];
        if (knownGallery) {
          if (gallery.title) knownGallery.title = gallery.title;
          if (knownGallery.folder) {
            const galleryPath = path.join(modelPath, knownGallery.folder);
            const missingThumbs = galleryStorageStats(galleryPath).missingThumbs;
            if (missingThumbs > 0) {
              modelNeedsThumbRefresh = true;
              updateImport(`Known gallery ${knownGallery.folder} has ${missingThumbs} missing thumbnails; model refresh queued.`, {}, { force: true });
            }
          }
          job.totals.galleriesProcessed += 1;
          job.totals.galleriesSkipped += 1;
          updateImport(`Skipping known gallery ${knownGallery.folder || ''}: ${gallery.title}`.trim());
          continue;
        }

        const existing = findExistingGalleryForSource(modelPath, gallery.sourceUrl);
        if (existing) {
          rememberImportedGallery(modelRecord, gallery, existing, readImageFiles(path.join(modelPath, existing)).length, {
            preserveTimestamps: true,
          });
          if (galleryStorageStats(path.join(modelPath, existing)).missingThumbs > 0) {
            modelNeedsThumbRefresh = true;
            updateImport(`Existing gallery ${existing} has missing thumbnails; model refresh queued.`, {}, { force: true });
          }
          saveImportDb(importDb);
          job.totals.galleriesProcessed += 1;
          job.totals.galleriesSkipped += 1;
          updateImport(`Skipping existing gallery ${existing}: ${gallery.title}`);
          continue;
        }

        const galleryName = nextGalleryName(modelPath);
        const galleryPath = path.join(modelPath, galleryName);
        markImportPath(galleryPath);
        activeImportGalleryPaths.add(galleryPath);

        try {
          mkdirp(galleryPath);
          job.current = { gallery: galleryName, title: gallery.title, sourceUrl: gallery.sourceUrl, images: 0, imported: 0 };
          updateImport(`Fetching gallery ${galleryName}: ${gallery.title}`);
          const galleryHtml = await fetchText(gallery.sourceUrl);
          const detailUrls = extractDetailUrls(galleryHtml, gallery.sourceUrl);
          job.current.images = detailUrls.length;
          job.totals.images += detailUrls.length;
          updateImport(`Found ${detailUrls.length} image pages in gallery ${galleryName}.`);

          const resolved = await resolveGalleryImageUrls(detailUrls);
          for (const failure of resolved.failures) {
            job.totals.errors += 1;
            recordImportError({
              gallery: galleryName,
              title: gallery.title,
              sourceUrl: failure.detailUrl || gallery.sourceUrl,
              message: `Image page failed: ${failure.message}`,
            });
          }

          const downloads = await downloadGalleryImagesPartial(
            resolved.successes,
            galleryPath,
            gallery.title,
            (imported, total) => {
              job.current.imported = imported;
              job.totals.imagesImported += 1;
              updateImport(`Downloaded ${imported}/${total} images for gallery ${galleryName}.`, {}, { log: false });
            }
          );

          for (const failure of downloads.failures) {
            job.totals.errors += 1;
            recordImportError({
              gallery: galleryName,
              title: gallery.title,
              sourceUrl: failure.imageUrl || failure.detailUrl || gallery.sourceUrl,
              message: `Image download failed: ${failure.message}`,
            });
          }

          if (!downloads.downloaded.length) throw new Error('No images could be downloaded for this gallery.');

          job.totals.imagesSkipped += resolved.failures.length + downloads.failures.length;
          rememberImportedGallery(modelRecord, gallery, galleryName, downloads.downloaded.length);
          saveImportDb(importDb);
          job.totals.galleriesProcessed += 1;
          job.totals.galleriesImported += 1;
          modelImportedGalleries += 1;
          if (resolved.failures.length || downloads.failures.length) {
            updateImport(`Imported gallery ${galleryName}: ${gallery.title} (${downloads.downloaded.length}/${detailUrls.length} images).`);
          } else {
            updateImport(`Imported gallery ${galleryName}: ${gallery.title}`);
          }
        } catch (error) {
          fs.rmSync(galleryPath, { recursive: true, force: true });
          job.totals.galleriesProcessed += 1;
          job.totals.errors += 1;
          recordImportError({ gallery: galleryName, title: gallery.title, sourceUrl: gallery.sourceUrl, message: error.message });
          updateImport(`Failed gallery ${galleryName}: ${error.message}`);
        } finally {
          activeImportGalleryPaths.delete(galleryPath);
          clearImportPath(galleryPath);
        }
      }

      if (modelImportedGalleries > 0) {
        updateImport(`Refreshing ${modelName}.`);
        await refreshModelInState(modelFolder);
      } else if (modelNeedsThumbRefresh) {
        updateImport(`Refreshing ${modelName}; missing thumbnails found in known galleries.`, {}, { force: true });
        await refreshModelInState(modelFolder);
      } else {
        updateImport(`No new galleries for ${modelName}; gallery refresh skipped.`);
      }
      return importSnapshot();
    } catch (error) {
      job.active = false;
      job.status = 'error';
      job.finishedAt = nowIso();
      job.totals.errors += 1;
      recordRescanAllFinished(job.status);
      recordImportError({ sourceUrl, message: error.message || 'Import failed.' });
      updateImport(error.message || 'Import failed.', {}, { force: true });
      return importSnapshot();
    }
  }

  return { importModel };
}

module.exports = { createModelImporter };
