'use strict';

function createImportStateStore({
  db,
  upsertModelRecord,
  upsertGalleryRecord,
  normalizeModelName,
  canonicalRemoteUrl,
  nowIso,
  sourceUrlSnapshot,
  scheduleSourceUrlBroadcast,
}) {
  function empty() {
    return { version: 1, scannedUrls: [], models: {} };
  }

  function load() {
    const payload = empty();
    const modelRows = db.prepare('SELECT * FROM models ORDER BY folder').all();
    const urlRows = db.prepare(`
      SELECT model_urls.*, models.folder AS model_folder
      FROM model_urls
      JOIN models ON models.id = model_urls.model_id
      WHERE model_urls.source_url NOT IN (SELECT source_url FROM ignored_model_urls)
    `).all();
    const galleryRows = db.prepare(`
      SELECT galleries.*, models.folder AS model_folder, models.name AS model_name
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE galleries.status != 'failed'
      ORDER BY models.folder, galleries.folder
    `).all();

    for (const row of modelRows) {
      payload.models[row.folder] = {
        modelName: row.name,
        modelFolder: row.folder,
        modelUrls: [],
        galleries: {},
        createdAt: row.created_at,
        lastCheckedAt: row.last_checked_at,
      };
    }

    for (const row of urlRows) {
      if (!payload.scannedUrls.includes(row.source_url)) payload.scannedUrls.push(row.source_url);
      if (payload.models[row.model_folder] && !payload.models[row.model_folder].modelUrls.includes(row.source_url)) {
        payload.models[row.model_folder].modelUrls.push(row.source_url);
      }
    }

    for (const row of galleryRows) {
      const record = payload.models[row.model_folder];
      if (!record) continue;
      const key = row.source_url || `local:${row.folder}`;
      record.galleries[key] = {
        sourceUrl: row.source_url || '',
        title: row.title || '',
        folder: row.folder,
        imageCount: row.image_count || 0,
        firstSeenAt: row.created_at,
        importedAt: row.imported_at,
        lastSeenAt: row.last_seen_at,
      };
    }

    payload.scannedUrls.sort((a, b) => a.localeCompare(b));
    return payload;
  }

  function save(importDb) {
    const run = db.transaction(() => {
      for (const [modelFolder, record] of Object.entries(importDb.models || {})) {
        const modelName = record.modelName || normalizeModelName(modelFolder);
        const modelId = upsertModelRecord(
          modelFolder,
          modelName,
          record.modelUrls?.[0] || '',
          { touchUpdatedAt: false }
        );
        if (record.lastCheckedAt) {
          db.prepare('UPDATE models SET last_checked_at = ? WHERE id = ?').run(record.lastCheckedAt, modelId);
        }
        for (const modelUrl of record.modelUrls || []) {
          try {
            db.prepare(`
              INSERT INTO model_urls (model_id, source_url, created_at)
              VALUES (?, ?, ?)
              ON CONFLICT(source_url) DO UPDATE SET model_id = excluded.model_id
            `).run(modelId, canonicalRemoteUrl(modelUrl), nowIso());
          } catch {
            // Ignore malformed legacy values.
          }
        }

        const desired = new Set();
        for (const gallery of Object.values(record.galleries || {})) {
          if (!gallery.folder) continue;
          const galleryId = upsertGalleryRecord(modelFolder, modelName, gallery.folder, {
            sourceUrl: gallery.sourceUrl || null,
            title: gallery.title || `Gallery ${gallery.folder}`,
            imageCount: gallery.imageCount || 0,
            importedAt: gallery.importedAt,
            lastSeenAt: gallery.lastSeenAt,
            touchModelUpdatedAt: false,
            status: 'imported',
          });
          if (galleryId) desired.add(galleryId);
        }

        if (desired.size) {
          const existing = db.prepare('SELECT id FROM galleries WHERE model_id = ?').all(modelId);
          const deleteGallery = db.prepare('DELETE FROM galleries WHERE id = ?');
          for (const row of existing) {
            if (!desired.has(row.id)) deleteGallery.run(row.id);
          }
        }
      }
    });
    run();
    const payload = sourceUrlSnapshot();
    scheduleSourceUrlBroadcast(payload);
  }

  return { empty, load, save };
}

module.exports = { createImportStateStore };
