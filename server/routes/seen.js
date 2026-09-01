'use strict';

const fs = require('fs');
const path = require('path');

function handleSeenRoute(ctx, req, res, url) {
  const {
    db,
    withBusyRetry,
    readRequestBody,
    sendJson,
    requireUser,
    nowIso,
    getGalleryById,
    galleryRecordById,
    readImageFiles,
    seenSummaryForGallery,
    mediaRoot,
  } = ctx;

  if (url.pathname === '/api/seen/image' && (req.method === 'POST' || req.method === 'DELETE')) {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const galleryId = Number(payload.galleryId || 0);
        const imageName = String(payload.imageName || '').trim();
        if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
        if (!imageName) throw new Error('Missing image.');
        const result = withBusyRetry(() => {
          if (req.method === 'POST') {
            db.prepare('INSERT OR REPLACE INTO image_seen (user_id, gallery_id, image_name, seen_at) VALUES (?, ?, ?, ?)').run(user.id, galleryId, imageName, nowIso());
            return { ok: true, seen: true, ...seenSummaryForGallery(user.id, galleryId) };
          }
          db.prepare('DELETE FROM image_seen WHERE user_id = ? AND gallery_id = ? AND image_name = ?').run(user.id, galleryId, imageName);
          return { ok: true, seen: false, ...seenSummaryForGallery(user.id, galleryId) };
        });
        sendJson(res, 200, result);
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Seen update failed.' }));
    return true;
  }

  if (url.pathname === '/api/seen/gallery' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const galleryId = Number(payload.galleryId || 0);
        const gallery = galleryRecordById(galleryId);
        if (!gallery) throw new Error('Gallery not found.');
        const galleryPath = path.join(mediaRoot(), gallery.modelFolder, gallery.galleryFolder);
        const imageNames = readImageFiles(galleryPath);
        const markSeen = db.transaction(() => {
          const stmt = db.prepare('INSERT OR REPLACE INTO image_seen (user_id, gallery_id, image_name, seen_at) VALUES (?, ?, ?, ?)');
          const seenAt = nowIso();
          for (const imageName of imageNames) stmt.run(user.id, galleryId, imageName, seenAt);
        });
        markSeen();
        sendJson(res, 200, { ok: true, ...seenSummaryForGallery(user.id, galleryId, imageNames.length) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Mark gallery seen failed.' }));
    return true;
  }

  if (url.pathname === '/api/seen/gallery' && req.method === 'DELETE') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const galleryId = Number(payload.galleryId || 0);
        if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
        db.prepare('DELETE FROM image_seen WHERE user_id = ? AND gallery_id = ?').run(user.id, galleryId);
        sendJson(res, 200, { ok: true, ...seenSummaryForGallery(user.id, galleryId, 0) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Mark gallery unseen failed.' }));
    return true;
  }

  if (url.pathname === '/api/seen/model' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const modelId = String(payload.modelId || '').trim();
        if (!modelId) throw new Error('Missing model.');
        const modelPath = path.join(mediaRoot(), modelId);
        if (!fs.existsSync(modelPath)) throw new Error('Model not found.');
        const galleries = db.prepare(`
          SELECT galleries.id AS galleryId, galleries.folder AS galleryFolder
          FROM galleries
          JOIN models ON models.id = galleries.model_id
          WHERE models.folder = ?
        `).all(modelId);
        const results = [];
        const markSeen = db.transaction(() => {
          const stmt = db.prepare('INSERT OR REPLACE INTO image_seen (user_id, gallery_id, image_name, seen_at) VALUES (?, ?, ?, ?)');
          const seenAt = nowIso();
          for (const gallery of galleries) {
            const galleryPath = path.join(modelPath, gallery.galleryFolder);
            const imageNames = readImageFiles(galleryPath);
            for (const imageName of imageNames) stmt.run(user.id, gallery.galleryId, imageName, seenAt);
            results.push({
              galleryId: gallery.galleryId,
              seenCount: imageNames.length,
              count: imageNames.length,
            });
          }
        });
        markSeen();
        sendJson(res, 200, { ok: true, modelId, galleries: results });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Mark model seen failed.' }));
    return true;
  }

  if (url.pathname === '/api/seen/model' && req.method === 'DELETE') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const modelId = String(payload.modelId || '').trim();
        if (!modelId) throw new Error('Missing model.');
        const galleries = db.prepare(`
          SELECT galleries.id AS galleryId
          FROM galleries
          JOIN models ON models.id = galleries.model_id
          WHERE models.folder = ?
        `).all(modelId);
        if (!galleries.length) throw new Error('Model not found.');
        const clearSeen = db.transaction(() => {
          const stmt = db.prepare('DELETE FROM image_seen WHERE user_id = ? AND gallery_id = ?');
          for (const gallery of galleries) stmt.run(user.id, gallery.galleryId);
        });
        clearSeen();
        sendJson(res, 200, {
          ok: true,
          modelId,
          galleries: galleries.map(gallery => ({ galleryId: gallery.galleryId, seenCount: 0, count: null })),
        });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Mark model unseen failed.' }));
    return true;
  }

  return false;
}

module.exports = {
  handleSeenRoute,
};
