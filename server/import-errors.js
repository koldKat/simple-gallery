'use strict';

function createImportErrorStore({
  db,
  broadcast,
  getImportJob,
  normalizeModelName,
  upsertModelRecord,
  galleryDbId,
  nowIso,
}) {
  function load() {
    const errors = db.prepare(`
      SELECT
        import_errors.id AS id,
        import_errors.created_at AS at,
        models.name AS modelName,
        models.folder AS modelFolder,
        import_errors.model_url AS modelUrl,
        import_errors.folder AS gallery,
        import_errors.title AS title,
        import_errors.gallery_url AS sourceUrl,
        import_errors.message AS message
      FROM import_errors
      LEFT JOIN models ON models.id = import_errors.model_id
      ORDER BY import_errors.id ASC
      LIMIT 500
    `).all();
    return {
      version: 1,
      updatedAt: errors.at(-1)?.at || null,
      errors: errors.map(error => ({
        id: error.id,
        at: error.at,
        mode: '',
        modelName: error.modelName || '',
        modelFolder: error.modelFolder || '',
        modelUrl: error.modelUrl || '',
        gallery: error.gallery || '',
        title: error.title || '',
        sourceUrl: error.sourceUrl || '',
        message: error.message || 'Import error',
      })),
    };
  }

  function notify(payload) {
    broadcast('import-errors', payload);
  }

  function clear() {
    db.prepare('DELETE FROM import_errors').run();
    notify({ version: 1, updatedAt: nowIso(), errors: [] });
  }

  function dismiss(id) {
    db.prepare('DELETE FROM import_errors WHERE id = ?').run(Number(id || 0));
    const payload = load();
    notify(payload);
    return payload;
  }

  function record(details) {
    const importJob = getImportJob();
    const modelFolder = String(details.modelFolder || importJob?.modelFolder || '').trim();
    const modelName = String(
      details.modelName || importJob?.modelName || (modelFolder ? normalizeModelName(modelFolder) : '')
    ).trim();
    const modelUrl = String(details.modelUrl || importJob?.currentModelUrl || importJob?.sourceUrl || '').trim();
    const gallery = String(details.gallery || '').trim();
    const sourceUrl = String(details.sourceUrl || '').trim();
    const title = String(details.title || '').trim();
    const message = String(details.message || 'Import error').trim() || 'Import error';

    const modelId = modelFolder
      ? upsertModelRecord(modelFolder, modelName || normalizeModelName(modelFolder), modelUrl, { touchUpdatedAt: false })
      : null;
    const galleryId = modelId && gallery ? galleryDbId(modelFolder, gallery) : null;
    db.prepare(`
      INSERT INTO import_errors (model_id, gallery_id, model_url, gallery_url, title, folder, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(modelId, galleryId, modelUrl, sourceUrl, title, gallery, message, nowIso());

    notify(load());
  }

  return { load, clear, dismiss, record };
}

module.exports = { createImportErrorStore };
