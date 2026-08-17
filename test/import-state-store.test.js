'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { canonicalRemoteUrl } = require('../server/source-parser');
const { createImportStateStore } = require('../server/import-state-store');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY,
      name TEXT,
      folder TEXT UNIQUE,
      created_at TEXT,
      updated_at TEXT,
      last_checked_at TEXT
    );
    CREATE TABLE model_urls (
      id INTEGER PRIMARY KEY,
      model_id INTEGER,
      source_url TEXT UNIQUE,
      created_at TEXT
    );
    CREATE TABLE ignored_model_urls (source_url TEXT PRIMARY KEY);
    CREATE TABLE galleries (
      id INTEGER PRIMARY KEY,
      model_id INTEGER,
      source_url TEXT,
      source_provider TEXT NOT NULL DEFAULT 'primary',
      title TEXT,
      folder TEXT,
      image_count INTEGER,
      status TEXT,
      created_at TEXT,
      imported_at TEXT,
      last_seen_at TEXT,
      UNIQUE(model_id, folder)
    );
  `);
  const broadcasts = [];
  const now = '2026-08-16T12:00:00.000Z';
  const upsertModelRecord = (folder, name) => {
    const existing = db.prepare('SELECT id FROM models WHERE folder = ?').get(folder);
    if (existing) {
      db.prepare('UPDATE models SET name = ? WHERE id = ?').run(name, existing.id);
      return existing.id;
    }
    const result = db.prepare(`
      INSERT INTO models (name, folder, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(name, folder, now, now);
    return Number(result.lastInsertRowid);
  };
  const upsertGalleryRecord = (modelFolder, _modelName, galleryFolder, values) => {
    const model = db.prepare('SELECT id FROM models WHERE folder = ?').get(modelFolder);
    const existing = db.prepare('SELECT id FROM galleries WHERE model_id = ? AND folder = ?').get(model.id, galleryFolder);
    if (existing) {
      db.prepare(`
        UPDATE galleries SET source_url = ?, source_provider = ?, title = ?, image_count = ?, status = ?, imported_at = ?, last_seen_at = ?
        WHERE id = ?
      `).run(values.sourceUrl, values.sourceProvider, values.title, values.imageCount, values.status, values.importedAt, values.lastSeenAt, existing.id);
      return existing.id;
    }
    const result = db.prepare(`
      INSERT INTO galleries
        (model_id, source_url, source_provider, title, folder, image_count, status, created_at, imported_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(model.id, values.sourceUrl, values.sourceProvider, values.title, galleryFolder, values.imageCount, values.status, now, values.importedAt, values.lastSeenAt);
    return Number(result.lastInsertRowid);
  };
  const store = createImportStateStore({
    db,
    upsertModelRecord,
    upsertGalleryRecord,
    normalizeModelName: value => String(value || '').replaceAll('-', ' ').replace(/\b\w/g, char => char.toUpperCase()),
    canonicalRemoteUrl,
    nowIso: () => now,
    sourceUrlSnapshot: () => ({ urls: ['snapshot'] }),
    scheduleSourceUrlBroadcast: payload => broadcasts.push(payload),
  });
  return { db, store, broadcasts, now };
}

test('load builds normalized state and excludes ignored URLs and failed galleries', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO models VALUES
      (1, 'Alpha', 'alpha', '2026-01-01', '2026-01-02', '2026-01-03');
    INSERT INTO model_urls VALUES
      (1, 1, 'https://example.test/model/alpha-b', '2026-01-01'),
      (2, 1, 'https://example.test/model/alpha-a', '2026-01-01');
    INSERT INTO ignored_model_urls VALUES ('https://example.test/model/alpha-b');
    INSERT INTO galleries VALUES
      (1, 1, 'https://example.test/gallery/one', 'direct', 'One', '001', 4, 'imported', 'created', 'imported', 'seen'),
      (2, 1, NULL, 'primary', 'Local', '002', 2, 'imported', 'local-created', NULL, NULL),
      (3, 1, 'https://example.test/gallery/failed', 'primary', 'Failed', '003', 0, 'failed', 'failed-created', NULL, NULL);
  `);

  const state = context.store.load();
  assert.deepEqual(state.scannedUrls, ['https://example.test/model/alpha-a']);
  assert.deepEqual(state.models.alpha.modelUrls, ['https://example.test/model/alpha-a']);
  assert.deepEqual(Object.keys(state.models.alpha.galleries), [
    'https://example.test/gallery/one',
    'local:002',
  ]);
  assert.equal(state.models.alpha.galleries['local:002'].firstSeenAt, 'local-created');
  assert.equal(state.models.alpha.galleries['https://example.test/gallery/one'].sourceProvider, 'direct');
  assert.equal(state.models.alpha.lastCheckedAt, '2026-01-03');
  context.db.close();
});

test('save canonicalizes URLs, updates timestamps, and removes stale galleries', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO models VALUES (1, 'Alpha', 'alpha', 'old', 'old', NULL);
    INSERT INTO galleries VALUES
      (50, 1, 'https://example.test/gallery/keep', 'direct', 'Old', '001', 1, 'imported', 'old', NULL, NULL),
      (51, 1, 'https://example.test/gallery/stale', 'primary', 'Stale', '002', 1, 'imported', 'old', NULL, NULL);
  `);
  context.store.save({
    models: {
      alpha: {
        modelName: 'Alpha',
        modelUrls: ['https://EXAMPLE.test/model/alpha/?from=list', 'not a url'],
        lastCheckedAt: '2026-08-16T11:00:00.000Z',
        galleries: {
          keep: {
            folder: '001',
            sourceUrl: 'https://example.test/gallery/keep',
            sourceProvider: 'direct',
            title: 'Updated',
            imageCount: 8,
            importedAt: 'imported',
            lastSeenAt: 'seen',
          },
        },
      },
    },
  });

  assert.deepEqual(context.db.prepare('SELECT source_url FROM model_urls').all(), [
    { source_url: 'https://example.test/model/alpha' },
  ]);
  assert.equal(context.db.prepare('SELECT last_checked_at FROM models WHERE id = 1').get().last_checked_at, '2026-08-16T11:00:00.000Z');
  assert.deepEqual(context.db.prepare('SELECT id, source_provider, title, image_count FROM galleries').all(), [
    { id: 50, source_provider: 'direct', title: 'Updated', image_count: 8 },
  ]);
  assert.deepEqual(context.broadcasts, [{ urls: ['snapshot'] }]);
  context.db.close();
});

test('save keeps existing gallery rows when incoming desired galleries are empty', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO models VALUES (1, 'Alpha', 'alpha', 'old', 'old', NULL);
    INSERT INTO galleries VALUES
      (50, 1, NULL, 'primary', 'Existing', '001', 1, 'imported', 'old', NULL, NULL);
  `);
  context.store.save({ models: { alpha: { modelName: 'Alpha', modelUrls: [], galleries: {} } } });
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM galleries').get().count, 1);
  context.db.close();
});
