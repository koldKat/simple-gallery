'use strict';

function createViewTracker({
  db,
  actorKeyForRequest,
  getGalleryById,
  scheduleStatsBroadcast,
  dedupeMs,
  now = () => Date.now(),
  nowIso = () => new Date().toISOString(),
}) {
  function shouldCount(actorKey, targetType, targetKey) {
    const timestamp = now();
    const timestampIso = new Date(timestamp).toISOString();
    const row = db.prepare(`
      SELECT last_counted_at AS lastCountedAt
      FROM view_dedupe
      WHERE actor_key = ? AND target_type = ? AND target_key = ?
    `).get(actorKey, targetType, targetKey);
    if (row && timestamp - Date.parse(row.lastCountedAt) < dedupeMs) return false;
    db.prepare(`
      INSERT INTO view_dedupe (actor_key, target_type, target_key, last_counted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(actor_key, target_type, target_key) DO UPDATE SET
        last_counted_at = excluded.last_counted_at
    `).run(actorKey, targetType, targetKey, timestampIso);
    return true;
  }

  function incrementModel(modelId) {
    const viewedAt = nowIso();
    db.prepare(`
      INSERT INTO model_view_totals (model_id, view_count, first_viewed_at, last_viewed_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET
        view_count = view_count + 1,
        last_viewed_at = excluded.last_viewed_at
    `).run(modelId, viewedAt, viewedAt);
  }

  function incrementGallery(galleryId) {
    const viewedAt = nowIso();
    db.prepare(`
      INSERT INTO gallery_view_totals (gallery_id, view_count, first_viewed_at, last_viewed_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(gallery_id) DO UPDATE SET
        view_count = view_count + 1,
        last_viewed_at = excluded.last_viewed_at
    `).run(galleryId, viewedAt, viewedAt);
  }

  function incrementImage(galleryId, imageName) {
    const viewedAt = nowIso();
    db.prepare(`
      INSERT INTO image_view_totals (gallery_id, image_name, view_count, first_viewed_at, last_viewed_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(gallery_id, image_name) DO UPDATE SET
        view_count = view_count + 1,
        last_viewed_at = excluded.last_viewed_at
    `).run(galleryId, imageName, viewedAt, viewedAt);
  }

  function record(req, payload) {
    const type = String(payload.type || '').trim();
    const { actorKey, setCookie } = actorKeyForRequest(req);
    let counted = false;

    if (type === 'model') {
      const modelFolder = String(payload.modelId || '').trim();
      const model = db.prepare('SELECT id FROM models WHERE folder = ?').get(modelFolder);
      if (!model) throw new Error('Model not found.');
      counted = shouldCount(actorKey, 'model', `model:${model.id}`);
      if (counted) incrementModel(model.id);
    } else if (type === 'gallery') {
      const galleryId = Number(payload.galleryDbId || payload.galleryId || 0);
      if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
      counted = shouldCount(actorKey, 'gallery', `gallery:${galleryId}`);
      if (counted) incrementGallery(galleryId);
    } else if (type === 'image') {
      const galleryId = Number(payload.galleryDbId || payload.galleryId || 0);
      const imageName = String(payload.imageName || '').trim();
      if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
      if (!imageName) throw new Error('Missing image.');
      counted = shouldCount(actorKey, 'image', `image:${galleryId}:${imageName}`);
      if (counted) incrementImage(galleryId, imageName);
    } else {
      throw new Error('Unsupported view type.');
    }

    if (counted) scheduleStatsBroadcast();
    return { ok: true, counted, setCookie };
  }

  return { record };
}

module.exports = { createViewTracker };
