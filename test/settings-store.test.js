'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createSettingsStore } = require('../server/settings-store');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-settings-'));
  const versionPath = path.join(directory, 'VERSION');
  fs.writeFileSync(versionPath, '1.0.0\n');
  const db = new Database(':memory:');
  const store = createSettingsStore({
    db,
    versionPath,
    nowIso: () => '2026-08-16T12:00:00.000Z',
    withBusyRetry: work => work(),
  });
  return {
    db,
    store,
    versionPath,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `);
}

test('safe settings reads tolerate a database without initialized schema', () => {
  const testFixture = fixture();
  assert.equal(testFixture.store.getSafe('missing', 'fallback'), 'fallback');
  assert.deepEqual(testFixture.store.getJson('missing', { ready: false }), { ready: false });
  testFixture.close();
});

test('settings can be inserted, updated, and parsed as objects', () => {
  const testFixture = fixture();
  createSchema(testFixture.db);
  testFixture.store.set('profile', '{"enabled":true}');
  assert.equal(testFixture.store.get('profile'), '{"enabled":true}');
  assert.deepEqual(testFixture.store.getJson('profile'), { enabled: true });

  testFixture.store.set('profile', '{"enabled":false}');
  assert.deepEqual(testFixture.store.getJson('profile'), { enabled: false });
  assert.equal(
    testFixture.db.prepare('SELECT updated_at FROM app_settings WHERE key = ?').get('profile').updated_at,
    '2026-08-16T12:00:00.000Z'
  );
  testFixture.close();
});

test('JSON normalization accepts only object values', () => {
  const testFixture = fixture();
  assert.equal(testFixture.store.normalizeJson(' { "a": 1 } ', 'Profile'), '{"a":1}');
  assert.throws(() => testFixture.store.normalizeJson('[1]', 'Profile'), /must be a JSON object/);
  assert.throws(() => testFixture.store.normalizeJson('{', 'Profile'), /must be valid JSON/);
  testFixture.close();
});

test('saving a version updates the database and VERSION mirror together', () => {
  const testFixture = fixture();
  createSchema(testFixture.db);
  testFixture.store.setVersion('2.3.4');

  assert.equal(testFixture.store.get('version_label'), '2.3.4');
  assert.equal(fs.readFileSync(testFixture.versionPath, 'utf8'), '2.3.4\n');
  assert.equal(
    testFixture.db.prepare('SELECT updated_at FROM app_settings WHERE key = ?').get('version_label').updated_at,
    '2026-08-16T12:00:00.000Z'
  );
  testFixture.close();
});
