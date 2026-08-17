'use strict';

function createLibraryRepository({
  db,
  nowIso,
  withBusyRetry,
  normalizeModelName,
  canonicalRemoteUrl,
  getState,
}) {
  function upsertModelRecord(modelFolder, modelName, sourceUrl = '', options = {}) {
    return withBusyRetry(() => {
      const touchUpdatedAt = options.touchUpdatedAt !== false;
      const now = nowIso();
      db.prepare(`
        INSERT INTO models (name, folder, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(folder) DO UPDATE SET
          name = excluded.name,
          updated_at = CASE
            WHEN ? THEN excluded.updated_at
            ELSE models.updated_at
          END
      `).run(modelName || normalizeModelName(modelFolder), modelFolder, now, now, touchUpdatedAt ? 1 : 0);
      const model = db.prepare('SELECT id FROM models WHERE folder = ?').get(modelFolder);
      if (sourceUrl) {
        db.prepare(`
          INSERT INTO model_urls (model_id, source_url, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(source_url) DO UPDATE SET model_id = excluded.model_id
        `).run(model.id, canonicalRemoteUrl(sourceUrl), now);
      }
      return model.id;
    });
  }

  function upsertGalleryRecord(modelFolder, modelName, galleryName, gallery = {}) {
    return withBusyRetry(() => {
      const modelId = upsertModelRecord(
        modelFolder,
        modelName || normalizeModelName(modelFolder),
        '',
        { touchUpdatedAt: gallery.touchModelUpdatedAt !== false }
      );
      const now = nowIso();
      const sourceUrl = gallery.sourceUrl ? canonicalRemoteUrl(gallery.sourceUrl) : null;
      const hasSourceProvider = gallery.sourceProvider != null;
      const sourceProvider = String(gallery.sourceProvider || 'primary').trim().toLowerCase() || 'primary';
      const lastSeenAt = gallery.lastSeenAt || gallery.updatedAt || now;
      const coverName = gallery.coverName == null ? null : String(gallery.coverName || '').trim() || null;
      const imageBytes = gallery.imageBytes == null ? null : Number(gallery.imageBytes || 0);
      const thumbBytes = gallery.thumbBytes == null ? null : Number(gallery.thumbBytes || 0);
      db.prepare(`
        INSERT INTO galleries (
          model_id, source_url, source_provider, title, folder, image_count, cover_name, image_bytes, thumb_bytes, status, created_at, imported_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), COALESCE(?, 0), ?, ?, ?, ?)
        ON CONFLICT(model_id, folder) DO UPDATE SET
          source_url = COALESCE(excluded.source_url, galleries.source_url),
          source_provider = CASE WHEN ? THEN excluded.source_provider ELSE galleries.source_provider END,
          title = excluded.title,
          image_count = excluded.image_count,
          cover_name = COALESCE(excluded.cover_name, galleries.cover_name),
          image_bytes = COALESCE(?, galleries.image_bytes),
          thumb_bytes = COALESCE(?, galleries.thumb_bytes),
          status = excluded.status,
          imported_at = COALESCE(galleries.imported_at, excluded.imported_at),
          last_seen_at = excluded.last_seen_at
      `).run(
        modelId,
        sourceUrl,
        sourceProvider,
        gallery.title || `Gallery ${galleryName}`,
        galleryName,
        Number(gallery.imageCount || gallery.count || 0),
        coverName,
        imageBytes,
        thumbBytes,
        gallery.status || 'imported',
        now,
        gallery.importedAt || now,
        lastSeenAt,
        hasSourceProvider ? 1 : 0,
        imageBytes,
        thumbBytes
      );
      return db.prepare('SELECT id FROM galleries WHERE model_id = ? AND folder = ?')
        .get(modelId, galleryName)?.id || null;
    });
  }

  function galleryDbId(modelName, galleryName) {
    return db.prepare(`
      SELECT galleries.id
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE models.folder = ? AND galleries.folder = ?
    `).get(modelName, galleryName)?.id || null;
  }

  function galleryDbRecord(modelName, galleryName) {
    return db.prepare(`
      SELECT galleries.*
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE models.folder = ? AND galleries.folder = ?
    `).get(modelName, galleryName) || null;
  }

  function galleryRecordsForModel(modelName) {
    const rows = db.prepare(`
      SELECT galleries.*
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE models.folder = ?
    `).all(modelName);
    return new Map(rows.map(row => [row.folder, row]));
  }

  function favoriteSetsForUser(userId) {
    if (!userId) return { models: new Set(), galleries: new Set(), images: new Set() };
    return {
      models: new Set(db.prepare('SELECT model_id FROM model_favorites WHERE user_id = ?').all(userId).map(row => row.model_id)),
      galleries: new Set(db.prepare('SELECT gallery_id FROM gallery_favorites WHERE user_id = ?').all(userId).map(row => row.gallery_id)),
      images: new Set(db.prepare('SELECT gallery_id, image_name FROM image_favorites WHERE user_id = ?').all(userId).map(row => `${row.gallery_id}\n${row.image_name}`)),
    };
  }

  function seenDataForUser(userId) {
    if (!userId) return { images: new Set(), galleryCounts: new Map() };
    const rows = db.prepare('SELECT gallery_id, COUNT(*) AS count FROM image_seen WHERE user_id = ? GROUP BY gallery_id').all(userId);
    return {
      images: new Set(),
      galleryCounts: new Map(rows.map(row => [row.gallery_id, Number(row.count || 0)])),
    };
  }

  function gallerySeenSummary(gallery, seenData) {
    const count = Number(gallery.count || 0);
    const seenCount = gallery.dbId ? Math.min(Number(seenData.galleryCounts.get(gallery.dbId) || 0), count) : 0;
    return { seenCount, seen: count > 0 && seenCount >= count };
  }

  function unseenStatsForUser(userId) {
    if (!userId) return null;
    const seenData = seenDataForUser(userId);
    const unseen = { models: 0, galleries: 0, images: 0 };
    for (const model of getState().models || []) {
      let modelSeenCount = 0;
      for (const gallery of model.galleries || []) {
        const summary = gallerySeenSummary(gallery, seenData);
        modelSeenCount += summary.seenCount;
        if (!summary.seen) unseen.galleries += 1;
        unseen.images += Math.max(0, Number(gallery.count || 0) - summary.seenCount);
      }
      if (!(Number(model.count || 0) > 0 && modelSeenCount >= Number(model.count || 0))) {
        unseen.models += 1;
      }
    }
    return unseen;
  }

  function seenImagesForGallery(userId, galleryId) {
    if (!userId || !galleryId) return new Set();
    return new Set(
      db.prepare('SELECT image_name FROM image_seen WHERE user_id = ? AND gallery_id = ?')
        .all(userId, galleryId)
        .map(row => row.image_name)
    );
  }

  function getGalleryById(id) {
    return db.prepare('SELECT id FROM galleries WHERE id = ?').get(Number(id || 0));
  }

  function galleryRecordById(id) {
    return db.prepare(`
      SELECT
        galleries.id,
        galleries.folder AS galleryFolder,
        models.folder AS modelFolder
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE galleries.id = ?
    `).get(Number(id || 0)) || null;
  }

  function seenSummaryForGallery(userId, galleryId, total = null) {
    const count = total == null
      ? db.prepare('SELECT image_count AS count FROM galleries WHERE id = ?').get(galleryId)?.count || 0
      : Number(total || 0);
    const seenCount = db.prepare('SELECT COUNT(*) AS count FROM image_seen WHERE user_id = ? AND gallery_id = ?')
      .get(userId, galleryId)?.count || 0;
    return {
      seen: count > 0 && seenCount >= count,
      seenCount: Math.min(Number(seenCount || 0), Number(count || 0)),
      count: Number(count || 0),
    };
  }

  function cleanupSeenRecordsForGallery(galleryId, imageNames) {
    if (!galleryId) return;
    if (!imageNames.length) {
      db.prepare('DELETE FROM image_seen WHERE gallery_id = ?').run(galleryId);
      return;
    }
    const keep = new Set(imageNames);
    const rows = db.prepare('SELECT user_id, image_name FROM image_seen WHERE gallery_id = ?').all(galleryId);
    const remove = db.prepare('DELETE FROM image_seen WHERE gallery_id = ? AND user_id = ? AND image_name = ?');
    db.transaction(() => {
      for (const row of rows) {
        if (!keep.has(row.image_name)) remove.run(galleryId, row.user_id, row.image_name);
      }
    })();
  }

  return {
    upsertModelRecord,
    upsertGalleryRecord,
    galleryDbId,
    galleryDbRecord,
    galleryRecordsForModel,
    favoriteSetsForUser,
    seenDataForUser,
    unseenStatsForUser,
    seenImagesForGallery,
    gallerySeenSummary,
    getGalleryById,
    galleryRecordById,
    seenSummaryForGallery,
    cleanupSeenRecordsForGallery,
  };
}

module.exports = { createLibraryRepository };
