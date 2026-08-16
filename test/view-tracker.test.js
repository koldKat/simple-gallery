'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createViewTracker } = require('../server/view-tracker');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, folder TEXT UNIQUE);
    CREATE TABLE galleries (id INTEGER PRIMARY KEY);
    CREATE TABLE view_dedupe (
      actor_key TEXT,
      target_type TEXT,
      target_key TEXT,
      last_counted_at TEXT,
      UNIQUE(actor_key, target_type, target_key)
    );
    CREATE TABLE model_view_totals (
      model_id INTEGER PRIMARY KEY,
      view_count INTEGER,
      first_viewed_at TEXT,
      last_viewed_at TEXT
    );
    CREATE TABLE gallery_view_totals (
      gallery_id INTEGER PRIMARY KEY,
      view_count INTEGER,
      first_viewed_at TEXT,
      last_viewed_at TEXT
    );
    CREATE TABLE image_view_totals (
      gallery_id INTEGER,
      image_name TEXT,
      view_count INTEGER,
      first_viewed_at TEXT,
      last_viewed_at TEXT,
      UNIQUE(gallery_id, image_name)
    );
    INSERT INTO models (id, folder) VALUES (1, 'example-model');
    INSERT INTO galleries (id) VALUES (10);
  `);
  let timestamp = Date.parse('2026-08-16T12:00:00.000Z');
  let broadcasts = 0;
  const tracker = createViewTracker({
    db,
    dedupeMs: 30_000,
    now: () => timestamp,
    nowIso: () => new Date(timestamp).toISOString(),
    actorKeyForRequest: () => ({ actorKey: 'visitor:test', setCookie: 'visitor-cookie' }),
    getGalleryById: id => db.prepare('SELECT id FROM galleries WHERE id = ?').get(id),
    scheduleStatsBroadcast: () => { broadcasts += 1; },
  });
  return {
    db,
    tracker,
    advance(ms) { timestamp += ms; },
    broadcasts: () => broadcasts,
  };
}

test('model views are deduplicated per actor and counted again after the window', () => {
  const { db, tracker, advance, broadcasts } = fixture();
  const first = tracker.record({}, { type: 'model', modelId: 'example-model' });
  const duplicate = tracker.record({}, { type: 'model', modelId: 'example-model' });
  advance(30_000);
  const later = tracker.record({}, { type: 'model', modelId: 'example-model' });

  assert.deepEqual(first, { ok: true, counted: true, setCookie: 'visitor-cookie' });
  assert.equal(duplicate.counted, false);
  assert.equal(later.counted, true);
  assert.equal(db.prepare('SELECT view_count FROM model_view_totals').get().view_count, 2);
  assert.equal(broadcasts(), 2);
  db.close();
});

test('gallery and image counters use independent dedupe targets', () => {
  const { db, tracker, broadcasts } = fixture();
  tracker.record({}, { type: 'gallery', galleryDbId: 10 });
  tracker.record({}, { type: 'image', galleryDbId: 10, imageName: 'one.jpg' });
  tracker.record({}, { type: 'image', galleryDbId: 10, imageName: 'two.jpg' });

  assert.equal(db.prepare('SELECT view_count FROM gallery_view_totals WHERE gallery_id = 10').get().view_count, 1);
  assert.deepEqual(
    db.prepare('SELECT image_name, view_count FROM image_view_totals ORDER BY image_name').all(),
    [{ image_name: 'one.jpg', view_count: 1 }, { image_name: 'two.jpg', view_count: 1 }]
  );
  assert.equal(broadcasts(), 3);
  db.close();
});

test('invalid view targets fail without writing counters', () => {
  const { db, tracker } = fixture();
  assert.throws(() => tracker.record({}, { type: 'model', modelId: 'missing' }), /Model not found/);
  assert.throws(() => tracker.record({}, { type: 'gallery', galleryDbId: 999 }), /Gallery not found/);
  assert.throws(() => tracker.record({}, { type: 'image', galleryDbId: 10 }), /Missing image/);
  assert.throws(() => tracker.record({}, { type: 'other' }), /Unsupported view type/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM view_dedupe').get().count, 0);
  db.close();
});
