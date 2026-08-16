'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createImportErrorStore } = require('../server/import-errors');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY,
      name TEXT,
      folder TEXT UNIQUE
    );
    CREATE TABLE import_errors (
      id INTEGER PRIMARY KEY,
      model_id INTEGER,
      gallery_id INTEGER,
      model_url TEXT,
      gallery_url TEXT,
      title TEXT,
      folder TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  let importJob = null;
  const events = [];
  const upserts = [];
  const store = createImportErrorStore({
    db,
    getImportJob: () => importJob,
    normalizeModelName: value => String(value || '').replaceAll('-', ' ').replace(/\b\w/g, char => char.toUpperCase()),
    upsertModelRecord(folder, name, sourceUrl, options) {
      upserts.push({ folder, name, sourceUrl, options });
      const existing = db.prepare('SELECT id FROM models WHERE folder = ?').get(folder);
      if (existing) {
        db.prepare('UPDATE models SET name = ? WHERE id = ?').run(name, existing.id);
        return existing.id;
      }
      const id = Number(db.prepare('SELECT MAX(id) AS id FROM models').get().id || 0) + 1;
      db.prepare('INSERT INTO models (id, name, folder) VALUES (?, ?, ?)').run(id, name, folder);
      return id;
    },
    galleryDbId: (_folder, gallery) => gallery === '007' ? 7 : null,
    nowIso: () => '2026-08-16T12:00:00.000Z',
    broadcast: (event, payload) => events.push({ event, payload }),
  });
  return {
    db,
    store,
    events,
    upserts,
    setImportJob(value) { importJob = value; },
  };
}

test('record uses live import-job fallbacks and broadcasts the resulting list', () => {
  const context = fixture();
  context.setImportJob({
    modelFolder: 'jane-doe',
    modelName: 'Jane Doe',
    currentModelUrl: 'https://example.test/model/jane',
  });
  context.store.record({
    gallery: '007',
    sourceUrl: 'https://example.test/gallery/7',
    title: 'Gallery Seven',
    message: 'Download failed',
  });

  assert.deepEqual(context.upserts, [{
    folder: 'jane-doe',
    name: 'Jane Doe',
    sourceUrl: 'https://example.test/model/jane',
    options: { touchUpdatedAt: false },
  }]);
  const payload = context.store.load();
  assert.equal(payload.updatedAt, '2026-08-16T12:00:00.000Z');
  assert.deepEqual(payload.errors[0], {
    id: 1,
    at: '2026-08-16T12:00:00.000Z',
    mode: '',
    modelName: 'Jane Doe',
    modelFolder: 'jane-doe',
    modelUrl: 'https://example.test/model/jane',
    gallery: '007',
    title: 'Gallery Seven',
    sourceUrl: 'https://example.test/gallery/7',
    message: 'Download failed',
  });
  assert.equal(context.events.at(-1).event, 'import-errors');
  assert.deepEqual(context.events.at(-1).payload, payload);
  context.db.close();
});

test('record reads the current job on every call instead of caching it', () => {
  const context = fixture();
  context.setImportJob({ modelFolder: 'first', modelName: 'First' });
  context.store.record({ message: 'First error' });
  context.setImportJob({ modelFolder: 'second', modelName: 'Second' });
  context.store.record({ message: 'Second error' });

  assert.deepEqual(context.upserts.map(item => item.folder), ['first', 'second']);
  assert.deepEqual(context.store.load().errors.map(error => error.modelFolder), ['first', 'second']);
  context.db.close();
});

test('dismiss and clear return or publish updated payloads', () => {
  const context = fixture();
  context.store.record({ message: 'Standalone error' });
  const id = context.store.load().errors[0].id;
  assert.deepEqual(context.store.dismiss(id).errors, []);

  context.store.record({ message: 'Another error' });
  context.store.clear();
  assert.deepEqual(context.store.load().errors, []);
  assert.deepEqual(context.events.at(-1), {
    event: 'import-errors',
    payload: { version: 1, updatedAt: '2026-08-16T12:00:00.000Z', errors: [] },
  });
  context.db.close();
});
