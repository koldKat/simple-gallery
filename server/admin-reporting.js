'use strict';

function createAdminReporting({ db, getRuntimeStats, nowIso, withBusyRetry = callback => callback(), viewLimit = 100 }) {
  const protectedUsernames = new Set(['koldkat']);

  function isProtectedUser(row) {
    return protectedUsernames.has(String(row?.username || '').toLowerCase());
  }
  function viewStats() {
    const countries = getRuntimeStats().remoteCountryTraffic || [];
    const totals = {
      modelViews: db.prepare('SELECT COALESCE(SUM(view_count), 0) AS count FROM model_view_totals').get()?.count || 0,
      galleryViews: db.prepare('SELECT COALESCE(SUM(view_count), 0) AS count FROM gallery_view_totals').get()?.count || 0,
      imageViews: db.prepare('SELECT COALESCE(SUM(view_count), 0) AS count FROM image_view_totals').get()?.count || 0,
    };
    const models = db.prepare(`
      SELECT
        models.name,
        models.folder,
        model_view_totals.view_count AS views,
        model_view_totals.last_viewed_at AS lastViewedAt
      FROM model_view_totals
      JOIN models ON models.id = model_view_totals.model_id
      ORDER BY model_view_totals.view_count DESC, model_view_totals.last_viewed_at DESC
      LIMIT ?
    `).all(viewLimit);
    const galleries = db.prepare(`
      SELECT
        models.name AS modelName,
        models.folder AS modelFolder,
        galleries.folder AS gallery,
        galleries.title,
        gallery_view_totals.view_count AS views,
        gallery_view_totals.last_viewed_at AS lastViewedAt
      FROM gallery_view_totals
      JOIN galleries ON galleries.id = gallery_view_totals.gallery_id
      JOIN models ON models.id = galleries.model_id
      ORDER BY gallery_view_totals.view_count DESC, gallery_view_totals.last_viewed_at DESC
      LIMIT ?
    `).all(viewLimit);
    const images = db.prepare(`
      SELECT
        models.name AS modelName,
        models.folder AS modelFolder,
        galleries.folder AS gallery,
        image_view_totals.image_name AS imageName,
        image_view_totals.view_count AS views,
        image_view_totals.last_viewed_at AS lastViewedAt
      FROM image_view_totals
      JOIN galleries ON galleries.id = image_view_totals.gallery_id
      JOIN models ON models.id = galleries.model_id
      ORDER BY image_view_totals.view_count DESC, image_view_totals.last_viewed_at DESC
      LIMIT ?
    `).all(viewLimit);
    return { totals, models, galleries, images, countries };
  }

  function users() {
    const rows = db.prepare(`
      SELECT
        users.id,
        users.username,
        users.display_name AS displayName,
        users.created_at AS createdAt,
        users.last_login_at AS lastLoginAt,
        users.disabled_at AS disabledAt,
        COUNT(CASE WHEN sessions.expires_at > ? THEN 1 END) AS activeSessions
      FROM users
      LEFT JOIN sessions ON sessions.user_id = users.id
      GROUP BY users.id
      ORDER BY users.disabled_at IS NOT NULL, users.last_login_at DESC, users.created_at DESC, users.username
    `).all(nowIso());
    return {
      users: rows.map(row => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        createdAt: row.createdAt,
        lastLoginAt: row.lastLoginAt,
        disabledAt: row.disabledAt,
        activeSessions: Number(row.activeSessions || 0),
        protected: isProtectedUser(row),
      })),
    };
  }

  function deleteUser(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user.');
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (!user) throw new Error('User not found.');
    if (isProtectedUser(user)) throw new Error('The koldKat account is protected and cannot be deleted.');
    withBusyRetry(() => db.prepare('DELETE FROM users WHERE id = ?').run(id));
    return users();
  }

  function modelOptions() {
    return {
      models: db.prepare(`
        SELECT name, folder
        FROM models
        ORDER BY name COLLATE NOCASE, folder COLLATE NOCASE
      `).all(),
    };
  }

  return { viewStats, users, deleteUser, modelOptions };
}

module.exports = { createAdminReporting };
