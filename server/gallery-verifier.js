'use strict';

const fs = require('fs');
const path = require('path');

function createGalleryVerifier(ctx) {
  const {
    db,
    getJob,
    setJob,
    getStopRequested,
    setStopRequested,
    resetProgressThrottle,
    clearImportErrors,
    isVerifiableGalleryUrl,
    nowIso,
    updateImport,
    fetchText,
    extractDetailUrls,
    mediaRoot,
    galleryStorageStats,
    activeImportGalleryPaths,
    mkdirp,
    resolveGalleryImageUrls,
    downloadGalleryImagesPartial,
    recordImportError,
    refreshModelInState,
    importSnapshot,
  } = ctx;

  async function repairGallery(row, detailUrls, galleryPath) {
    const job = getJob();
    activeImportGalleryPaths.add(galleryPath);
    try {
      fs.rmSync(galleryPath, { recursive: true, force: true });
      mkdirp(galleryPath);

      const resolved = await resolveGalleryImageUrls(detailUrls);
      for (const failure of resolved.failures) {
        job.totals.errors += 1;
        recordImportError({
          gallery: row.gallery_folder,
          title: row.title,
          sourceUrl: failure.detailUrl || row.source_url,
          message: `Repair image page failed: ${failure.message}`,
        });
      }

      job.current.images = detailUrls.length;
      job.current.imported = 0;
      const downloads = await downloadGalleryImagesPartial(
        resolved.successes,
        galleryPath,
        row.title,
        (imported, total) => {
          job.current.imported = imported;
          updateImport(`Repaired ${imported}/${total} images for ${row.model_name} / ${row.gallery_folder}.`, {}, { log: false });
        }
      );

      for (const failure of downloads.failures) {
        job.totals.errors += 1;
        recordImportError({
          gallery: row.gallery_folder,
          title: row.title,
          sourceUrl: failure.imageUrl || failure.detailUrl || row.source_url,
          message: `Repair image download failed: ${failure.message}`,
        });
      }
      if (!downloads.downloaded.length) throw new Error('No images could be repaired for this gallery.');

      db.prepare('UPDATE galleries SET image_count = ?, last_seen_at = ? WHERE id = ?')
        .run(downloads.downloaded.length, nowIso(), row.gallery_id);
      job.totals.galleriesImported += 1;
      updateImport(`Repaired ${row.model_name} / ${row.gallery_folder}: downloaded ${downloads.downloaded.length}/${detailUrls.length} images.`, {}, { force: true });
      return true;
    } catch (error) {
      job.totals.errors += 1;
      recordImportError({
        gallery: row.gallery_folder,
        title: row.title,
        sourceUrl: row.source_url,
        message: `Repair failed: ${error.message}`,
      });
      return false;
    } finally {
      activeImportGalleryPaths.delete(galleryPath);
    }
  }

  async function verify() {
    if (getJob()?.active) throw new Error('An import is already running.');
    setStopRequested(false);
    resetProgressThrottle();
    clearImportErrors();

    const rows = db.prepare(`
      SELECT
        galleries.id AS gallery_id,
        galleries.folder AS gallery_folder,
        galleries.source_url,
        galleries.title,
        galleries.image_count,
        models.name AS model_name,
        models.folder AS model_folder,
        model_urls.source_url AS model_url
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      LEFT JOIN model_urls ON model_urls.model_id = models.id
      WHERE galleries.source_url IS NOT NULL AND galleries.source_url != ''
      GROUP BY galleries.id
      ORDER BY models.folder, galleries.folder
    `).all().filter(row => isVerifiableGalleryUrl(row.source_url));

    const job = {
      active: true,
      status: 'running',
      message: 'Verifying known galleries.',
      mode: 'verify',
      sourceUrl: '',
      sourceUrls: [],
      modelName: '',
      modelFolder: '',
      currentModelUrl: '',
      startedAt: nowIso(),
      finishedAt: null,
      totals: {
        models: 0,
        modelsChecked: 0,
        galleries: rows.length,
        knownGalleries: rows.length,
        newGalleries: 0,
        galleriesProcessed: 0,
        galleriesImported: 0,
        galleriesSkipped: 0,
        images: 0,
        imagesImported: 0,
        imagesSkipped: 0,
        errors: 0,
      },
      current: null,
      logs: [],
    };
    setJob(job);
    updateImport(`Verifying ${rows.length} known galleries.`, {}, { force: true });

    let lastModelFolder = '';
    const repairedModelFolders = new Set();
    for (const row of rows) {
      if (getStopRequested() && lastModelFolder && row.model_folder !== lastModelFolder) {
        updateImport('Stop after current model requested. Verify will stop now.', {}, { force: true });
        break;
      }
      lastModelFolder = row.model_folder;
      job.modelName = row.model_name;
      job.modelFolder = row.model_folder;
      job.currentModelUrl = row.model_url || '';
      job.current = {
        gallery: row.gallery_folder,
        title: row.title,
        sourceUrl: row.source_url,
        images: 0,
        imported: 0,
      };

      try {
        const galleryHtml = await fetchText(row.source_url);
        const detailUrls = extractDetailUrls(galleryHtml, row.source_url);
        const remoteCount = detailUrls.length;
        const galleryPath = path.join(mediaRoot(), row.model_folder, row.gallery_folder);
        const localStats = galleryStorageStats(galleryPath);
        const localCount = localStats.imageNames.length;
        job.current.images = remoteCount;
        job.current.imported = localCount;
        job.totals.images += remoteCount;
        job.totals.imagesImported += localCount;

        if (remoteCount !== localCount) {
          updateImport(`Repairing ${row.model_name} / ${row.gallery_folder}: local ${localCount}, remote ${remoteCount}`, {}, { force: true });
          if (await repairGallery(row, detailUrls, galleryPath)) repairedModelFolders.add(row.model_folder);
        } else if (localStats.missingThumbs > 0) {
          repairedModelFolders.add(row.model_folder);
        }
      } catch (error) {
        job.totals.errors += 1;
        recordImportError({
          gallery: row.gallery_folder,
          title: row.title,
          sourceUrl: row.source_url,
          message: `Verify failed: ${error.message}`,
        });
      }

      job.totals.galleriesProcessed += 1;
      updateImport(
        `Verified ${job.totals.galleriesProcessed}/${job.totals.galleries}: ${row.model_name} / ${row.gallery_folder}`,
        {},
        { log: job.totals.galleriesProcessed % 25 === 0 }
      );
    }

    for (const modelFolder of repairedModelFolders) {
      try {
        updateImport(`Refreshing repaired model ${modelFolder} and queuing thumbnails.`, {}, { force: true });
        await refreshModelInState(modelFolder);
      } catch (error) {
        job.totals.errors += 1;
        recordImportError({ folder: modelFolder, message: `Post-repair refresh failed: ${error.message}` });
        updateImport(`Failed to refresh repaired model ${modelFolder}: ${error.message}`, {}, { force: true });
      }
    }

    job.active = false;
    job.status = getStopRequested() ? 'stopped' : 'done';
    job.finishedAt = nowIso();
    updateImport(
      getStopRequested()
        ? `Verify stopped. ${job.totals.galleriesImported} galleries repaired, ${job.totals.errors} errors.`
        : `Verify complete. ${job.totals.galleriesImported} galleries repaired, ${job.totals.errors} errors.`,
      {},
      { force: true }
    );
    setStopRequested(false);
    return importSnapshot();
  }

  return { verify, repairGallery };
}

module.exports = { createGalleryVerifier };
