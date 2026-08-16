'use strict';

function createLibraryStateService(options) {
  const {
    db,
    canonicalRemoteUrl,
    galleryCoverUrl,
    mediaUrlPrefix,
    sourceSlug,
    emptyState,
    emptyTotals,
    addTotals,
    appSetting,
    nowIso,
    runtimeStats,
    clock = () => Date.now(),
    log = console.log,
  } = options;

  function inferGalleryKey(gallery) {
    const manifestUrl = gallery.sourceUrl || '';
    if (manifestUrl) {
      try {
        return `source:${canonicalRemoteUrl(manifestUrl)}`;
      } catch {
        // Fall through to filename inference.
      }
    }
    const names = (gallery.images || [])
      .map(image => image.name.replace(/^\d+\W*/, '').replace(/\.[^.]+$/, ''))
      .filter(Boolean);
    if (!names.length) return `folder:${gallery.id}`;
    const counts = new Map();
    for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
    return `slug:${Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0]}`;
  }

  function dedupeScannedGalleries(galleries) {
    const bestByKey = new Map();
    for (const gallery of galleries) {
      const keys = [inferGalleryKey(gallery)];
      if (gallery.sourceSlug) keys.push(`slug:${gallery.sourceSlug}`);

      let duplicateOf = null;
      for (const key of keys) {
        if (bestByKey.has(key)) {
          duplicateOf = bestByKey.get(key);
          break;
        }
      }

      if (!duplicateOf) {
        for (const key of keys) bestByKey.set(key, gallery);
        continue;
      }

      const duplicateScore = Number(Boolean(duplicateOf.sourceUrl)) * 100000 + duplicateOf.count;
      const galleryScore = Number(Boolean(gallery.sourceUrl)) * 100000 + gallery.count;
      if (galleryScore > duplicateScore) {
        for (const key of keys) bestByKey.set(key, gallery);
      }
    }

    return Array.from(new Set(bestByKey.values()))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  function gallerySummary(gallery) {
    const { images, imageNames, ...summary } = gallery;
    return summary;
  }

  function latestGallerySummaries(models, limit = 60) {
    const galleries = [];
    for (const model of models || []) {
      for (const gallery of model.galleries || []) {
        galleries.push({
          ...gallery,
          modelId: model.id,
          modelName: model.name,
        });
      }
    }
    return galleries
      .sort((a, b) => {
        const timeDiff = Number(b.addedAtMs || 0) - Number(a.addedAtMs || 0);
        if (timeDiff) return timeDiff;
        const updatedDiff = Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0);
        if (updatedDiff) return updatedDiff;
        return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
      })
      .slice(0, limit);
  }

  function hydrateFromDatabase() {
    const hydrateStartedAt = clock();
    const modelRows = db.prepare(`
      SELECT
        models.id,
        models.folder,
        models.name
      FROM models
      WHERE EXISTS (
        SELECT 1
        FROM galleries
        WHERE galleries.model_id = models.id
          AND galleries.status != 'failed'
          AND galleries.image_count > 0
      )
      ORDER BY models.folder
    `).all();
    log(`[startup] Cached models query loaded ${modelRows.length} rows in ${clock() - hydrateStartedAt}ms.`);

    const galleriesStartedAt = clock();
    const galleryRows = db.prepare(`
      SELECT
        models.folder AS modelFolder,
        galleries.id AS dbId,
        galleries.folder AS galleryFolder,
        galleries.source_url AS sourceUrl,
        galleries.image_count AS imageCount,
        galleries.cover_name AS coverName,
        galleries.image_bytes AS imageBytes,
        galleries.thumb_bytes AS thumbBytes,
        galleries.last_seen_at AS lastSeenAt,
        galleries.imported_at AS importedAt,
        galleries.created_at AS createdAt
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE galleries.status != 'failed'
        AND galleries.image_count > 0
      ORDER BY models.folder, galleries.folder
    `).all();
    log(`[startup] Cached galleries query loaded ${galleryRows.length} rows in ${clock() - galleriesStartedAt}ms.`);

    const buildStartedAt = clock();
    const modelsById = new Map();
    for (const row of modelRows) {
      modelsById.set(row.folder, {
        id: row.folder,
        dbId: row.id,
        name: row.folder,
        count: 0,
        galleryCount: 0,
        cover: null,
        updatedAt: null,
        updatedAtMs: 0,
        _totals: emptyTotals(),
        galleries: [],
      });
    }

    for (const row of galleryRows) {
      const model = modelsById.get(row.modelFolder);
      if (!model) continue;
      const updatedAt = row.importedAt || row.createdAt || null;
      const updatedAtMs = updatedAt ? (Date.parse(updatedAt) || 0) : 0;
      const addedAt = row.importedAt || row.createdAt || updatedAt || null;
      const addedAtMs = addedAt ? (Date.parse(addedAt) || 0) : 0;
      const cover = galleryCoverUrl(row.modelFolder, row.galleryFolder, row.coverName, {
        cached: true,
        thumbBytes: row.thumbBytes,
      });
      const gallery = {
        id: `${row.modelFolder}/${row.galleryFolder}`,
        dbId: row.dbId,
        name: row.galleryFolder,
        path: `${mediaUrlPrefix()}/${encodeURIComponent(row.modelFolder)}/${encodeURIComponent(row.galleryFolder)}`,
        count: Number(row.imageCount || 0),
        cover,
        sourceUrl: row.sourceUrl || null,
        sourceSlug: sourceSlug(row.sourceUrl),
        missingThumbs: 0,
        staleThumbsRemoved: 0,
        imageBytes: Number(row.imageBytes || 0),
        thumbBytes: Number(row.thumbBytes || 0),
        addedAt,
        addedAtMs,
        updatedAt,
        updatedAtMs,
      };
      model.galleries.push(gallery);
      model.count += gallery.count;
      model.galleryCount += 1;
      model._totals.models = 1;
      model._totals.galleries += 1;
      model._totals.images += gallery.count;
      model._totals.thumbs += gallery.count;
      model._totals.missingThumbs += gallery.missingThumbs;
      model._totals.imageBytes += gallery.imageBytes;
      model._totals.thumbBytes += gallery.thumbBytes;
      model._totals.totalBytes = model._totals.imageBytes + model._totals.thumbBytes;
      if (updatedAtMs > model.updatedAtMs) {
        model.updatedAtMs = updatedAtMs;
        model.updatedAt = updatedAt;
        model.cover = gallery.cover;
      }
    }

    const models = Array.from(modelsById.values())
      .filter(model => model.galleryCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    const totals = emptyTotals();
    for (const model of models) {
      addTotals(totals, model._totals, 1);
    }

    const state = {
      ...emptyState(models.length ? 'ready' : 'idle'),
      message: models.length
        ? `Loaded cached library state for ${totals.galleries} galleries.`
        : 'Waiting for scan.',
      scannedAt: appSetting('last_startup_state_at', nowIso()),
      totals,
      runtime: runtimeStats(),
      models,
      latest: latestGallerySummaries(models),
    };
    log(`[startup] Cached library objects built in ${clock() - buildStartedAt}ms.`);
    return state;
  }

  return {
    dedupeScannedGalleries,
    gallerySummary,
    hydrateFromDatabase,
    inferGalleryKey,
    latestGallerySummaries,
  };
}

module.exports = { createLibraryStateService };
