'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../server/db/schema');

function initialize(db, version = '1.2.3', timestamp = '2026-08-16T12:00:00.000Z') {
  initializeSchema({
    db,
    defaultVersionLabel: version,
    nowIso: () => timestamp,
    withBusyRetry: work => work(),
  });
}

test('schema initialization creates the complete table and index set', () => {
  const db = new Database(':memory:');
  initialize(db);

  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
  assert.deepEqual(tables, [
    'app_settings',
    'galleries',
    'gallery_favorites',
    'gallery_view_totals',
    'ignored_model_urls',
    'image_favorites',
    'image_seen',
    'image_view_totals',
    'import_errors',
    'model_favorites',
    'model_urls',
    'model_view_totals',
    'models',
    'sessions',
    'users',
    'view_dedupe',
  ]);

  const indexes = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
  assert.deepEqual(indexes, [
    'idx_galleries_model',
    'idx_galleries_model_folder',
    'idx_galleries_source_url',
    'idx_gallery_favorites_user',
    'idx_gallery_view_totals_count',
    'idx_image_favorites_user',
    'idx_image_seen_gallery',
    'idx_image_seen_user',
    'idx_image_view_totals_count',
    'idx_model_favorites_user',
    'idx_model_view_totals_count',
    'idx_sessions_expires_at',
    'idx_sessions_user',
    'idx_view_dedupe_last_counted',
  ]);
  db.close();
});

test('schema initialization seeds the default version once and is idempotent', () => {
  const db = new Database(':memory:');
  initialize(db);
  assert.deepEqual(
    db.prepare("SELECT value, updated_at FROM app_settings WHERE key = 'version_label'").get(),
    { value: '1.2.3', updated_at: '2026-08-16T12:00:00.000Z' }
  );

  db.prepare("UPDATE app_settings SET value = '9.8.7', updated_at = 'manual'").run();
  initialize(db, '4.5.6', 'later');
  assert.deepEqual(
    db.prepare("SELECT value, updated_at FROM app_settings WHERE key = 'version_label'").get(),
    { value: '9.8.7', updated_at: 'manual' }
  );
  db.close();
});

test('schema relationships cascade user and model records as designed', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initialize(db);
  db.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, created_at)
    VALUES (1, 'user', 'hash', 'User', 'now')
  `).run();
  db.prepare("INSERT INTO models (id, name, folder, created_at, updated_at) VALUES (2, 'Model', 'model', 'now', 'now')").run();
  db.prepare("INSERT INTO galleries (id, model_id, folder, created_at) VALUES (3, 2, '001', 'now')").run();
  assert.equal(db.prepare('SELECT source_provider FROM galleries WHERE id = 3').get().source_provider, 'primary');
  db.prepare("INSERT INTO image_seen (user_id, gallery_id, image_name, seen_at) VALUES (1, 3, 'one.jpg', 'now')").run();

  db.prepare('DELETE FROM models WHERE id = 2').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM galleries').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_seen').get().count, 0);
  db.close();
});
