'use strict';

function createSourceUrlRegistry({
  db,
  canonicalRemoteUrl,
  normalizeModelName,
  sanitizeFolderName,
  readDirs,
  mediaRoot,
  getVisibleModels,
  nowIso,
}) {
  function snapshot() {
    const urls = db.prepare(`
      SELECT model_urls.source_url
      FROM model_urls
      LEFT JOIN ignored_model_urls ON ignored_model_urls.source_url = model_urls.source_url
      WHERE ignored_model_urls.source_url IS NULL
      ORDER BY model_urls.source_url
    `).all().map(row => row.source_url);
    const total = db.prepare('SELECT COUNT(*) AS count FROM model_urls').get()?.count || 0;
    const ignored = db.prepare('SELECT COUNT(*) AS count FROM ignored_model_urls').get()?.count || 0;
    return {
      version: 1,
      updatedAt: nowIso(),
      total,
      ignored,
      active: urls.length,
      urls,
    };
  }

  function ignore(sourceUrl, reason = 'Ignored from URL audit.') {
    const canonical = canonicalRemoteUrl(sourceUrl);
    const normalizedReason = String(reason || '').trim() || 'Ignored from URL audit.';
    db.prepare(`
      INSERT INTO ignored_model_urls (source_url, reason, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        reason = excluded.reason
    `).run(canonical, normalizedReason, nowIso());
    return { sourceUrl: canonical, reason };
  }

  function unignore(sourceUrl) {
    const canonical = canonicalRemoteUrl(sourceUrl);
    db.prepare('DELETE FROM ignored_model_urls WHERE source_url = ?').run(canonical);
    return { sourceUrl: canonical };
  }

  function ignored() {
    const rows = db.prepare(`
      SELECT source_url AS sourceUrl, reason, created_at AS createdAt
      FROM ignored_model_urls
      ORDER BY created_at DESC, source_url
    `).all();
    return {
      ignoredCount: rows.length,
      ignored: rows.map(row => ({
        sourceUrl: row.sourceUrl,
        reason: row.reason || '',
        createdAt: row.createdAt,
      })),
    };
  }

  function modelFolderFromUrl(sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0]?.toLowerCase() !== 'model' || !parts[1]) return '';
      return sanitizeFolderName(normalizeModelName(decodeURIComponent(parts[1])));
    } catch {
      return '';
    }
  }

  function audit() {
    const rows = db.prepare(`
      SELECT
        model_urls.source_url AS sourceUrl,
        models.id AS modelDbId,
        models.name AS modelName,
        models.folder AS modelFolder,
        COUNT(galleries.id) AS dbGalleryCount,
        COALESCE(SUM(galleries.image_count), 0) AS dbImageCount
      FROM model_urls
      LEFT JOIN models ON models.id = model_urls.model_id
      LEFT JOIN galleries ON galleries.model_id = models.id AND galleries.status != 'failed'
      LEFT JOIN ignored_model_urls ON ignored_model_urls.source_url = model_urls.source_url
      WHERE ignored_model_urls.source_url IS NULL
      GROUP BY model_urls.id
      ORDER BY model_urls.source_url
    `).all();
    const visibleModelIds = new Set((getVisibleModels() || []).map(model => model.id));
    const localFolders = new Set(readDirs(mediaRoot()));
    const unmatched = [];

    for (const row of rows) {
      const expectedFolder = row.modelFolder || modelFolderFromUrl(row.sourceUrl);
      const localFolderExists = expectedFolder ? localFolders.has(expectedFolder) : false;
      const visible = expectedFolder ? visibleModelIds.has(expectedFolder) : false;
      const dbGalleryCount = Number(row.dbGalleryCount || 0);
      const dbImageCount = Number(row.dbImageCount || 0);
      let reason = '';

      if (!row.modelDbId) reason = 'URL is saved but has no model database row.';
      else if (!expectedFolder) reason = 'URL does not look like a model URL.';
      else if (!localFolderExists) reason = 'No matching local model folder.';
      else if (!dbGalleryCount || !dbImageCount) reason = 'Model exists but has no imported image galleries.';
      else if (!visible) reason = 'Model has database galleries but is not visible in the current gallery state.';

      if (!reason) continue;
      unmatched.push({
        sourceUrl: row.sourceUrl,
        modelName: row.modelName || normalizeModelName(expectedFolder),
        expectedFolder,
        dbGalleryCount,
        dbImageCount,
        localFolderExists,
        visible,
        reason,
      });
    }

    return {
      savedModelUrls: rows.length,
      visibleModels: visibleModelIds.size,
      unmatchedCount: unmatched.length,
      ignoredCount: db.prepare('SELECT COUNT(*) AS count FROM ignored_model_urls').get()?.count || 0,
      unmatched,
    };
  }

  return { snapshot, ignore, unignore, ignored, audit };
}

module.exports = { createSourceUrlRegistry };
