'use strict';

const fs = require('fs');
const path = require('path');

function createUserLibraryService(options) {
  const {
    db,
    getState,
    mediaRoot,
    thumbDirectory,
    readImageFiles,
    safeName,
    toUrl,
    currentUser,
    galleryDbId,
    favoriteSetsForUser,
    seenImagesForGallery,
    publicUser,
    seenDataForUser,
    gallerySeenSummary,
    runtimeStats,
    appMetadata,
  } = options;

  function galleryImagesResponse(modelName, galleryName) {
    const id = `${modelName}/${galleryName}`;
    const galleryPath = path.join(mediaRoot(), modelName, galleryName);
    const thumbRoot = path.join(galleryPath, thumbDirectory);
    const images = readImageFiles(galleryPath).map(fileName => {
      const sourcePath = path.join(galleryPath, fileName);
      const thumbPath = path.join(thumbRoot, safeName(fileName));
      return {
        name: fileName,
        src: toUrl(sourcePath),
        thumb: fs.existsSync(thumbPath) ? toUrl(thumbPath) : toUrl(sourcePath),
      };
    });
    return { id, images };
  }

  function modelForUser(model, favorites, seenData) {
    if (!model) return null;
    let modelSeenCount = 0;
    const galleries = (model.galleries || []).map(gallery => {
      const seen = gallerySeenSummary(gallery, seenData);
      modelSeenCount += seen.seenCount;
      return {
        ...gallery,
        favorite: Boolean(gallery.dbId && favorites.galleries.has(gallery.dbId)),
        seen: seen.seen,
        seenCount: seen.seenCount,
      };
    });
    return {
      id: model.id,
      name: model.name,
      count: model.count,
      galleryCount: model.galleryCount,
      cover: model.cover,
      updatedAt: model.updatedAt,
      updatedAtMs: model.updatedAtMs,
      favorite: Boolean(model.dbId && favorites.models.has(model.dbId)),
      seen: Number(model.count || 0) > 0 && modelSeenCount >= Number(model.count || 0),
      seenCount: modelSeenCount,
      galleries,
    };
  }

  function modelSummaryForUser(model, favorites, seenData) {
    const full = modelForUser(model, favorites, seenData);
    if (!full) return null;
    delete full.galleries;
    return full;
  }

  function stateForUser(req) {
    const user = currentUser(req);
    const favorites = favoriteSetsForUser(user?.id);
    const seenData = seenDataForUser(user?.id);
    const models = (getState().models || []).map(model => modelForUser(model, favorites, seenData));
    const latest = (getState().latest || []).map(gallery => ({
      ...gallery,
      favorite: Boolean(gallery.dbId && favorites.galleries.has(gallery.dbId)),
      ...gallerySeenSummary(gallery, seenData),
    }));

    return {
      status: getState().status,
      message: getState().message,
      scannedAt: getState().scannedAt,
      totals: getState().totals,
      runtime: runtimeStats(),
      app: appMetadata(),
      models,
      latest,
      user: publicUser(user),
    };
  }

  function galleryImagesResponseForUser(req, modelName, galleryName) {
    const response = galleryImagesResponse(modelName, galleryName);
    const user = currentUser(req);
    const galleryId = galleryDbId(modelName, galleryName);
    const favorites = favoriteSetsForUser(user?.id);
    const seenImages = seenImagesForGallery(user?.id, galleryId);
    response.dbId = galleryId;
    response.user = publicUser(user);
    response.images = response.images.map(image => ({
      ...image,
      favorite: Boolean(galleryId && favorites.images.has(`${galleryId}\n${image.name}`)),
      seen: Boolean(galleryId && seenImages.has(image.name)),
    }));
    return response;
  }

  function gallerySummaryByDbId(dbId) {
    for (const model of getState().models || []) {
      for (const gallery of model.galleries || []) {
        const galleryDbIdValue = gallery.dbId || galleryDbId(model.id, gallery.name);
        if (galleryDbIdValue === dbId) {
          return {
            ...gallery,
            dbId,
            modelId: model.id,
            modelName: model.name,
            favorite: true,
          };
        }
      }
    }
    return null;
  }

  function modelSummaryById(modelId) {
    for (const model of getState().models || []) {
      if (model.id === modelId) return model;
    }
    return null;
  }

  function favoritesResponse(req) {
    const user = currentUser(req);
    if (!user) return { user: null, models: [], galleries: [], imageGroups: [], imageCount: 0 };

    const modelRows = db.prepare(`
      SELECT
        model_favorites.created_at AS favoritedAt,
        models.id AS dbId,
        models.folder AS modelId,
        models.name AS modelName
      FROM model_favorites
      JOIN models ON models.id = model_favorites.model_id
      WHERE model_favorites.user_id = ?
      ORDER BY model_favorites.created_at DESC
    `).all(user.id);

    const galleryRows = db.prepare(`
      SELECT
        gallery_favorites.created_at AS favoritedAt,
        galleries.id AS dbId,
        galleries.folder AS galleryName,
        galleries.title AS title,
        galleries.image_count AS count,
        galleries.created_at AS createdAt,
        galleries.imported_at AS importedAt,
        galleries.last_seen_at AS lastSeenAt,
        models.folder AS modelId,
        models.name AS modelName
      FROM gallery_favorites
      JOIN galleries ON galleries.id = gallery_favorites.gallery_id
      JOIN models ON models.id = galleries.model_id
      WHERE gallery_favorites.user_id = ?
      ORDER BY gallery_favorites.created_at DESC
    `).all(user.id);

    // Seen aggregation is expensive for large accounts. The image-groups-only
    // overview does not need it when no models or galleries are favorited.
    const seenData = modelRows.length || galleryRows.length
      ? seenDataForUser(user.id)
      : { images: new Set(), galleryCounts: new Map() };
    const favorites = {
      models: new Set(modelRows.map(row => row.dbId)),
      galleries: new Set(galleryRows.map(row => row.dbId)),
      images: new Set(),
    };

    const models = modelRows.map(row => {
      const live = modelSummaryById(row.modelId);
      const model = live ? modelSummaryForUser(live, favorites, seenData) : {
        id: row.modelId,
        dbId: row.dbId,
        name: row.modelName,
        cover: null,
        count: 0,
        galleryCount: 0,
        updatedAt: null,
        updatedAtMs: 0,
        favorite: true,
        seen: false,
        seenCount: 0,
      };
      return {
        ...model,
        dbId: row.dbId,
        favorite: true,
        favoritedAt: row.favoritedAt,
      };
    });

    const liveGalleries = new Map();
    for (const model of getState().models || []) {
      for (const gallery of model.galleries || []) {
        if (gallery.dbId) liveGalleries.set(gallery.dbId, { gallery, model });
      }
    }

    const galleries = galleryRows.map(row => {
      const live = liveGalleries.get(row.dbId);
      const gallery = live ? {
        ...live.gallery,
        dbId: row.dbId,
        modelId: live.model.id,
        modelName: live.model.name,
        favorite: true,
      } : {
        id: `${row.modelId}/${row.galleryName}`,
        dbId: row.dbId,
        modelId: row.modelId,
        modelName: row.modelName,
        name: row.galleryName,
        title: row.title,
        count: row.count,
        cover: null,
        updatedAt: row.lastSeenAt || row.importedAt || row.createdAt,
        updatedAtMs: Date.parse(row.lastSeenAt || row.importedAt || row.createdAt) || 0,
        favorite: true,
      };
      return {
        ...gallery,
        ...gallerySeenSummary(gallery, seenData),
      };
    });

    const imageGroups = db.prepare(`
      SELECT
        models.folder AS modelId,
        models.name AS modelName,
        COUNT(*) AS count,
        MAX(image_favorites.created_at) AS latestAt
      FROM image_favorites
      JOIN galleries ON galleries.id = image_favorites.gallery_id
      JOIN models ON models.id = galleries.model_id
      WHERE image_favorites.user_id = ?
      GROUP BY models.id, models.folder, models.name
      ORDER BY models.name COLLATE NOCASE, models.folder
    `).all(user.id);
    const imageCount = imageGroups.reduce((sum, group) => sum + Number(group.count || 0), 0);

    return { user: publicUser(user), models, galleries, imageGroups, imageCount };
  }

  function favoriteImagesResponse(userId, options = {}) {
    const modelId = String(options.modelId || '').trim();
    const random = options.random === true;
    const limit = Math.min(250, Math.max(1, Number(options.limit) || 120));
    const offset = random ? 0 : Math.max(0, Number(options.offset) || 0);
    if (!random && !modelId) throw new Error('Missing model.');

    const whereModel = random ? '' : 'AND models.folder = ?';
    const params = random ? [userId] : [userId, modelId];
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM image_favorites
      JOIN galleries ON galleries.id = image_favorites.gallery_id
      JOIN models ON models.id = galleries.model_id
      WHERE image_favorites.user_id = ? ${whereModel}
    `).get(...params)?.count || 0);

    const rows = db.prepare(`
      SELECT
        image_favorites.created_at AS favoritedAt,
        image_favorites.image_name AS imageName,
        galleries.id AS dbId,
        galleries.folder AS galleryName,
        models.folder AS modelId,
        models.name AS modelName,
        image_seen.image_name IS NOT NULL AS seen
      FROM image_favorites
      JOIN galleries ON galleries.id = image_favorites.gallery_id
      JOIN models ON models.id = galleries.model_id
      LEFT JOIN image_seen
        ON image_seen.user_id = image_favorites.user_id
        AND image_seen.gallery_id = image_favorites.gallery_id
        AND image_seen.image_name = image_favorites.image_name
      WHERE image_favorites.user_id = ? ${whereModel}
      ORDER BY ${random ? 'RANDOM()' : 'image_favorites.created_at DESC'}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const images = rows.map(row => {
      const imagePath = path.join(mediaRoot(), row.modelId, row.galleryName, row.imageName);
      const thumbPath = path.join(mediaRoot(), row.modelId, row.galleryName, thumbDirectory, safeName(row.imageName));
      return {
        dbId: row.dbId,
        modelId: row.modelId,
        modelName: row.modelName,
        galleryId: `${row.modelId}/${row.galleryName}`,
        galleryName: row.galleryName,
        name: row.imageName,
        src: toUrl(imagePath),
        thumb: toUrl(thumbPath),
        favorite: true,
        seen: Boolean(row.seen),
        favoritedAt: row.favoritedAt,
      };
    });

    return { images, total, offset, limit, hasMore: !random && offset + images.length < total };
  }

  return {
    favoriteImagesResponse,
    favoritesResponse,
    galleryImagesResponse,
    galleryImagesResponseForUser,
    stateForUser,
  };
}

module.exports = { createUserLibraryService };
