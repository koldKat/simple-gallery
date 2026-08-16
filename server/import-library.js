'use strict';

const fs = require('fs');
const path = require('path');

function createImportLibrary({
  db,
  readDirs,
  readImageFiles,
  mkdirp,
  canonicalRemoteUrl,
  upsertModelRecord,
  upsertGalleryRecord,
  nowIso,
}) {
  function getImportModelRecord(importDb, modelFolder, modelName, sourceUrl) {
    if (!importDb.models[modelFolder]) {
      importDb.models[modelFolder] = {
        modelName,
        modelFolder,
        modelUrls: [],
        galleries: {},
        createdAt: nowIso(),
        lastCheckedAt: null,
      };
    }
    const record = importDb.models[modelFolder];
    record.modelName = modelName;
    record.modelFolder = modelFolder;
    const canonicalModelUrl = canonicalRemoteUrl(sourceUrl);
    if (!importDb.scannedUrls.includes(canonicalModelUrl)) importDb.scannedUrls.push(canonicalModelUrl);
    if (!record.modelUrls.includes(canonicalModelUrl)) record.modelUrls.push(canonicalModelUrl);
    if (!record.galleries || typeof record.galleries !== 'object') record.galleries = {};
    upsertModelRecord(modelFolder, modelName, canonicalModelUrl, { touchUpdatedAt: false });
    return record;
  }

  function rememberImportedGallery(record, gallery, galleryName, imageCount = 0, options = {}) {
    const sourceUrl = canonicalRemoteUrl(gallery.sourceUrl);
    const existing = record.galleries[sourceUrl] || {};
    const preserveTimestamps = Boolean(options.preserveTimestamps);
    const now = nowIso();
    const firstSeenAt = existing.firstSeenAt || options.firstSeenAt || now;
    const importedAt = preserveTimestamps
      ? (existing.importedAt || options.importedAt || firstSeenAt)
      : (options.importedAt || existing.importedAt || now);
    const lastSeenAt = preserveTimestamps
      ? (existing.lastSeenAt || options.lastSeenAt || importedAt)
      : (options.lastSeenAt || now);
    record.galleries[sourceUrl] = {
      sourceUrl,
      title: gallery.title || existing.title || '',
      folder: galleryName || existing.folder || '',
      imageCount: Number(imageCount || existing.imageCount || 0),
      firstSeenAt,
      importedAt,
      lastSeenAt,
    };
    upsertGalleryRecord(record.modelFolder, record.modelName, galleryName || existing.folder || '', {
      sourceUrl,
      title: gallery.title || existing.title || '',
      imageCount,
      importedAt,
      lastSeenAt,
      touchModelUpdatedAt: !preserveTimestamps,
      status: 'imported',
    });
  }

  function hydrateImportRecordFromManifests(record, modelPath) {
    const existingFolders = new Set(readDirs(modelPath));
    for (const [sourceUrl, gallery] of Object.entries(record.galleries || {})) {
      const galleryName = String(gallery.folder || '');
      if (!galleryName || !existingFolders.has(galleryName)) delete record.galleries[sourceUrl];
    }

    const rows = db.prepare(`
      SELECT galleries.*
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE models.folder = ?
    `).all(record.modelFolder);
    for (const row of rows) {
      if (!row.source_url || !existingFolders.has(row.folder)) continue;
      rememberImportedGallery(record, {
        sourceUrl: row.source_url,
        title: row.title || row.folder,
      }, row.folder, readImageFiles(path.join(modelPath, row.folder)).length, {
        preserveTimestamps: true,
        firstSeenAt: row.created_at,
        importedAt: row.imported_at,
        lastSeenAt: row.last_seen_at,
      });
    }
  }

  function nextGalleryName(modelPath) {
    const existing = new Set(readDirs(modelPath));
    for (let index = 1; index < 10000; index += 1) {
      const name = String(index).padStart(3, '0');
      if (!existing.has(name)) return name;
    }
    throw new Error('No available gallery folder number.');
  }

  function findExistingGalleryForSource(modelPath, sourceUrl) {
    const canonicalSourceUrl = canonicalRemoteUrl(sourceUrl);
    const modelFolder = path.basename(modelPath);
    const row = db.prepare(`
      SELECT galleries.folder
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE models.folder = ? AND galleries.source_url = ?
    `).get(modelFolder, canonicalSourceUrl);
    return row?.folder && fs.existsSync(path.join(modelPath, row.folder)) ? row.folder : null;
  }

  function repairGallerySequence(modelFolder, modelPath, importDb) {
    const numericNames = readDirs(modelPath)
      .filter(name => /^\d+$/.test(name))
      .sort((a, b) => Number(a) - Number(b));
    const galleryNames = numericNames
      .filter(name => readImageFiles(path.join(modelPath, name)).length > 0);
    const staleNames = numericNames.filter(name => !galleryNames.includes(name));
    const moves = [];
    let changed = false;

    for (const galleryName of staleNames) {
      fs.rmSync(path.join(modelPath, galleryName), { recursive: true, force: true });
      changed = true;
    }

    for (let index = 0; index < galleryNames.length; index += 1) {
      const from = galleryNames[index];
      const to = String(index + 1).padStart(3, '0');
      if (from !== to) moves.push({ from, to });
    }

    const record = importDb.models?.[modelFolder];
    if (!moves.length) return changed;

    const tempRoot = path.join(modelPath, `.sequence-repair-${process.pid}-${Date.now()}`);
    mkdirp(tempRoot);

    try {
      for (const galleryName of galleryNames) {
        fs.renameSync(path.join(modelPath, galleryName), path.join(tempRoot, galleryName));
      }
      for (let index = 0; index < galleryNames.length; index += 1) {
        const from = galleryNames[index];
        const to = String(index + 1).padStart(3, '0');
        fs.renameSync(path.join(tempRoot, from), path.join(modelPath, to));
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      try {
        for (const galleryName of readDirs(tempRoot)) {
          const target = path.join(modelPath, galleryName);
          if (!fs.existsSync(target)) fs.renameSync(path.join(tempRoot, galleryName), target);
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Keep the original repair error.
      }
      throw error;
    }

    if (record?.galleries) {
      const folderMap = new Map(moves.map(move => [move.from, move.to]));
      for (const gallery of Object.values(record.galleries)) {
        const folder = String(gallery.folder || '').padStart(3, '0');
        if (folderMap.has(folder)) gallery.folder = folderMap.get(folder);
      }

      const currentFolders = new Set(
        readDirs(modelPath)
          .filter(name => /^\d+$/.test(name))
          .filter(name => readImageFiles(path.join(modelPath, name)).length > 0)
      );
      for (const [sourceUrl, gallery] of Object.entries(record.galleries)) {
        const folder = String(gallery.folder || '').padStart(3, '0');
        if (!currentFolders.has(folder)) {
          delete record.galleries[sourceUrl];
          changed = true;
        }
      }
    }

    return true;
  }

  return {
    getImportModelRecord,
    rememberImportedGallery,
    hydrateImportRecordFromManifests,
    nextGalleryName,
    findExistingGalleryForSource,
    repairGallerySequence,
  };
}

module.exports = { createImportLibrary };
