'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../server/db/schema');
const { createDatabaseMigrations } = require('../server/db/migrations');

function service(db, options = {}) {
  return createDatabaseMigrations({
    db,
    mediaRoot: () => '/media',
    galleryStorageStats: options.galleryStorageStats || (() => ({ imageNames: [], imageBytes: 0, thumbBytes: 0 })),
    log: options.log || (() => {}),
  });
}

function currentSchema(db) {
  initializeSchema({
    db,
    defaultVersionLabel: '1.0.0',
    nowIso: () => 'now',
    withBusyRetry: work => work(),
  });
}

test('gallery source migration removes the obsolete global uniqueness constraint', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY);
    CREATE TABLE galleries (
      id INTEGER PRIMARY KEY,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      source_url TEXT UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      folder TEXT NOT NULL,
      image_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'imported',
      error_message TEXT,
      created_at TEXT NOT NULL,
      imported_at TEXT,
      last_seen_at TEXT,
      UNIQUE(model_id, folder)
    );
    INSERT INTO models VALUES (1), (2);
    INSERT INTO galleries
      (id, model_id, source_url, title, folder, image_count, status, created_at)
    VALUES (10, 1, 'https://example.test/gallery', 'One', '001', 4, 'imported', 'now');
  `);

  service(db).migrateGallerySourceUrlUniqueness();
  db.prepare(`
    INSERT INTO galleries (model_id, source_url, folder, created_at)
    VALUES (2, 'https://example.test/gallery', '001', 'now')
  `).run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM galleries').get().count, 2);
  assert.deepEqual(
    db.prepare('SELECT cover_name, image_bytes, thumb_bytes FROM galleries WHERE id = 10').get(),
    { cover_name: null, image_bytes: 0, thumb_bytes: 0 }
  );
  db.close();
});

test('column migrations upgrade old user and gallery tables idempotently', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE galleries (id INTEGER PRIMARY KEY);
  `);
  const migrations = service(db);
  migrations.migrateUserPreferenceColumns();
  migrations.migrateGalleryStorageColumns();
  migrations.migrateUserPreferenceColumns();
  migrations.migrateGalleryStorageColumns();

  assert.deepEqual(
    db.prepare('PRAGMA table_info(users)').all().map(column => column.name),
    ['id', 'preload_model', 'preload_gallery']
  );
  assert.deepEqual(
    db.prepare('PRAGMA table_info(galleries)').all().map(column => column.name),
    ['id', 'cover_name', 'image_bytes', 'thumb_bytes']
  );
  db.close();
});

test('storage backfill updates only incomplete imported gallery metadata', () => {
  const db = new Database(':memory:');
  currentSchema(db);
  db.prepare("INSERT INTO models (id, name, folder, created_at, updated_at) VALUES (1, 'One', 'one', 'now', 'now')").run();
  db.prepare(`
    INSERT INTO galleries (id, model_id, folder, image_count, status, created_at)
    VALUES (2, 1, '001', 3, 'imported', 'now')
  `).run();
  const paths = [];
  service(db, {
    galleryStorageStats: galleryPath => {
      paths.push(galleryPath);
      return { imageNames: ['cover.jpg'], imageBytes: 123, thumbBytes: 45 };
    },
  }).backfillGalleryStorageColumns();

  assert.deepEqual(paths, ['/media/one/001']);
  assert.deepEqual(
    db.prepare('SELECT cover_name, image_bytes, thumb_bytes FROM galleries WHERE id = 2').get(),
    { cover_name: 'cover.jpg', image_bytes: 123, thumb_bytes: 45 }
  );
  db.close();
});

test('renamed-gallery foreign key repair preserves valid child rows', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE galleries (id INTEGER PRIMARY KEY);
    CREATE TABLE gallery_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER NOT NULL REFERENCES galleries_old(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, gallery_id)
    );
    CREATE TABLE image_favorites (user_id INTEGER, gallery_id INTEGER);
    CREATE TABLE image_seen (user_id INTEGER, gallery_id INTEGER);
    INSERT INTO users VALUES (1);
    INSERT INTO galleries VALUES (2);
    INSERT INTO gallery_favorites VALUES (1, 2, 'now');
  `);

  service(db).repairRenamedGalleryForeignKeys();
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gallery_favorites'").get().sql;
  assert.doesNotMatch(schema, /galleries_old/);
  assert.deepEqual(db.prepare('SELECT * FROM gallery_favorites').all(), [
    { user_id: 1, gallery_id: 2, created_at: 'now' },
  ]);
  db.close();
});
