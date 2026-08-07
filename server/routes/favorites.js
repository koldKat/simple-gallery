'use strict';

function handleFavoritesRoute(ctx, req, res, url) {
  const {
    db,
    readRequestBody,
    sendJson,
    requireUser,
    nowIso,
    favoritesResponse,
    favoriteImagesResponse,
    favoriteCountForUser,
    getGalleryById,
  } = ctx;

  if (url.pathname === '/api/favorites' && req.method === 'GET') {
    sendJson(res, 200, favoritesResponse(req));
    return true;
  }

  if (url.pathname === '/api/favorites/images' && req.method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return true;
    try {
      sendJson(res, 200, favoriteImagesResponse(user.id, {
        modelId: url.searchParams.get('model'),
        offset: url.searchParams.get('offset'),
        limit: url.searchParams.get('limit'),
        random: url.searchParams.get('random') === '1',
      }));
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to load favorite images.' });
    }
    return true;
  }

  if (url.pathname === '/api/favorites/model' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const modelId = String(payload.modelId || '').trim();
        const model = db.prepare('SELECT id FROM models WHERE folder = ?').get(modelId);
        if (!model) throw new Error('Model not found.');
        db.prepare('INSERT OR IGNORE INTO model_favorites (user_id, model_id, created_at) VALUES (?, ?, ?)').run(user.id, model.id, nowIso());
        sendJson(res, 200, { ok: true, favorite: true, favoriteCount: favoriteCountForUser(user.id) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Favorite failed.' }));
    return true;
  }

  if (url.pathname === '/api/favorites/model' && req.method === 'DELETE') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const modelId = String(payload.modelId || '').trim();
        db.prepare(`
          DELETE FROM model_favorites
          WHERE user_id = ?
            AND model_id = (SELECT id FROM models WHERE folder = ?)
        `).run(user.id, modelId);
        sendJson(res, 200, { ok: true, favorite: false, favoriteCount: favoriteCountForUser(user.id) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Unfavorite failed.' }));
    return true;
  }

  if (url.pathname === '/api/favorites/gallery' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const galleryId = Number(payload.galleryId || 0);
        if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
        db.prepare('INSERT OR IGNORE INTO gallery_favorites (user_id, gallery_id, created_at) VALUES (?, ?, ?)').run(user.id, galleryId, nowIso());
        sendJson(res, 200, { ok: true, favorite: true, favoriteCount: favoriteCountForUser(user.id) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Favorite failed.' }));
    return true;
  }

  if (url.pathname === '/api/favorites/gallery' && req.method === 'DELETE') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        db.prepare('DELETE FROM gallery_favorites WHERE user_id = ? AND gallery_id = ?').run(user.id, Number(payload.galleryId || 0));
        sendJson(res, 200, { ok: true, favorite: false, favoriteCount: favoriteCountForUser(user.id) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Unfavorite failed.' }));
    return true;
  }

  if (url.pathname === '/api/favorites/image' && (req.method === 'POST' || req.method === 'DELETE')) {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const galleryId = Number(payload.galleryId || 0);
        const imageName = String(payload.imageName || '').trim();
        if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
        if (!imageName) throw new Error('Missing image.');
        if (req.method === 'POST') {
          db.prepare('INSERT OR IGNORE INTO image_favorites (user_id, gallery_id, image_name, created_at) VALUES (?, ?, ?, ?)').run(user.id, galleryId, imageName, nowIso());
          sendJson(res, 200, { ok: true, favorite: true, favoriteCount: favoriteCountForUser(user.id) });
        } else {
          db.prepare('DELETE FROM image_favorites WHERE user_id = ? AND gallery_id = ? AND image_name = ?').run(user.id, galleryId, imageName);
          sendJson(res, 200, { ok: true, favorite: false, favoriteCount: favoriteCountForUser(user.id) });
        }
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Favorite failed.' }));
    return true;
  }

  return false;
}

module.exports = {
  handleFavoritesRoute,
};
