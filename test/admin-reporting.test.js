'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAdminReporting } = require('../server/admin-reporting');

function fixture(viewLimit = 100) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, folder TEXT);
    CREATE TABLE galleries (id INTEGER PRIMARY KEY, model_id INTEGER, folder TEXT, title TEXT);
    CREATE TABLE model_view_totals (model_id INTEGER, view_count INTEGER, last_viewed_at TEXT);
    CREATE TABLE gallery_view_totals (gallery_id INTEGER, view_count INTEGER, last_viewed_at TEXT);
    CREATE TABLE image_view_totals (gallery_id INTEGER, image_name TEXT, view_count INTEGER, last_viewed_at TEXT);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      email TEXT,
      display_name TEXT,
      created_at TEXT,
      last_login_at TEXT,
      disabled_at TEXT,
      failed_login_count INTEGER DEFAULT 0,
      locked_until TEXT,
      admin_locked INTEGER DEFAULT 0
    );
    CREATE TABLE sessions (user_id INTEGER, expires_at TEXT);
    CREATE TABLE model_favorites (user_id INTEGER);
    CREATE TABLE gallery_favorites (user_id INTEGER);
    CREATE TABLE image_favorites (user_id INTEGER);

    INSERT INTO models VALUES (1, 'One', 'one'), (2, 'Two', 'two');
    INSERT INTO galleries VALUES (10, 1, '001', 'First'), (20, 2, '002', 'Second');
    INSERT INTO model_view_totals VALUES
      (1, 3, '2026-08-15T10:00:00.000Z'),
      (2, 8, '2026-08-16T10:00:00.000Z');
    INSERT INTO gallery_view_totals VALUES
      (10, 7, '2026-08-16T09:00:00.000Z'),
      (20, 2, '2026-08-15T09:00:00.000Z');
    INSERT INTO image_view_totals VALUES
      (10, 'one.jpg', 4, '2026-08-16T08:00:00.000Z'),
      (20, 'two.jpg', 9, '2026-08-16T11:00:00.000Z');
  `);
  let countries = [];
  const reporting = createAdminReporting({
    db,
    viewLimit,
    nowIso: () => '2026-08-16T12:00:00.000Z',
    getRuntimeStats: () => ({ remoteCountryTraffic: countries }),
  });
  return {
    db,
    reporting,
    setCountries(value) { countries = value; },
  };
}

test('view reporting returns totals, ranked rows, and live country traffic', () => {
  const context = fixture(1);
  context.setCountries([{ country: 'Bulgaria', inBytes: 10, outBytes: 20 }]);
  let payload = context.reporting.viewStats();

  assert.deepEqual(payload.totals, { modelViews: 11, galleryViews: 9, imageViews: 13 });
  assert.deepEqual(payload.models.map(row => row.folder), ['two']);
  assert.deepEqual(payload.galleries.map(row => row.gallery), ['001']);
  assert.deepEqual(payload.images.map(row => row.imageName), ['two.jpg']);
  assert.equal(payload.countries[0].country, 'Bulgaria');

  context.setCountries([{ country: 'Germany', inBytes: 30, outBytes: 40 }]);
  payload = context.reporting.viewStats();
  assert.equal(payload.countries[0].country, 'Germany');
  context.db.close();
});

test('user reporting counts only unexpired sessions and preserves ordering', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO users VALUES
      (1, 'active', 'active@example.test', 'Active', '2026-01-01T00:00:00.000Z', '2026-08-16T10:00:00.000Z', NULL, 0, NULL, 0),
      (2, 'disabled', '', 'Disabled', '2026-02-01T00:00:00.000Z', '2026-08-16T11:00:00.000Z', '2026-08-16T11:30:00.000Z', 0, NULL, 0);
    INSERT INTO model_favorites VALUES (1);
    INSERT INTO image_favorites VALUES (1), (1);
    INSERT INTO sessions VALUES
      (1, '2026-08-17T00:00:00.000Z'),
      (1, '2026-08-15T00:00:00.000Z'),
      (2, '2026-08-17T00:00:00.000Z');
  `);

  assert.deepEqual(context.reporting.users().users, [
    {
      id: 1,
      username: 'active',
      email: 'active@example.test',
      displayName: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-08-16T10:00:00.000Z',
      disabledAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      adminLocked: false,
      activeSessions: 1,
      favorites: 3,
      protected: false,
    },
    {
      id: 2,
      username: 'disabled',
      email: '',
      displayName: 'Disabled',
      createdAt: '2026-02-01T00:00:00.000Z',
      lastLoginAt: '2026-08-16T11:00:00.000Z',
      disabledAt: '2026-08-16T11:30:00.000Z',
      failedLoginCount: 0,
      lockedUntil: null,
      adminLocked: false,
      activeSessions: 1,
      favorites: 0,
      protected: false,
    },
  ]);
  context.db.close();
});

test('user deletion protects koldKat and removes other users', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO users (id, username, display_name, created_at) VALUES
      (1, 'koldKat', 'koldKat', '2026-01-01T00:00:00.000Z'),
      (2, 'temporary', 'Temporary', '2026-01-02T00:00:00.000Z');
  `);

  assert.throws(() => context.reporting.deleteUser(1), /protected/);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = 1').get().count, 1);
  context.reporting.deleteUser(2);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = 2').get().count, 0);
  context.db.close();
});

test('admin can lock accounts and revoke their sessions, except koldKat', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO users (id, username, display_name, created_at) VALUES
      (1, 'koldKat', 'koldKat', 'now'), (2, 'member', 'Member', 'now');
    INSERT INTO sessions VALUES (2, '2026-08-17T00:00:00.000Z');
  `);
  assert.equal(context.reporting.revokeUserSessions(2).cleared, 1);
  context.reporting.setUserLocked(2, true);
  assert.equal(context.db.prepare('SELECT admin_locked FROM users WHERE id = 2').get().admin_locked, 1);
  assert.throws(() => context.reporting.setUserLocked(1, true), /protected/);
  context.db.close();
});

test('summary reporting returns complete library, account, storage, and view totals', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY);
    CREATE TABLE galleries (id INTEGER PRIMARY KEY, image_count INTEGER, image_bytes INTEGER, thumb_bytes INTEGER);
    CREATE TABLE model_urls (id INTEGER PRIMARY KEY);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, expires_at TEXT);
    CREATE TABLE model_favorites (id INTEGER PRIMARY KEY);
    CREATE TABLE gallery_favorites (id INTEGER PRIMARY KEY);
    CREATE TABLE image_favorites (id INTEGER PRIMARY KEY);
    CREATE TABLE image_seen (id INTEGER PRIMARY KEY);
    CREATE TABLE import_errors (id INTEGER PRIMARY KEY);
    CREATE TABLE model_view_totals (view_count INTEGER);
    CREATE TABLE gallery_view_totals (view_count INTEGER);
    CREATE TABLE image_view_totals (view_count INTEGER);
    INSERT INTO models VALUES (1), (2);
    INSERT INTO galleries VALUES (1, 4, 100, 20), (2, 6, 200, 30);
    INSERT INTO model_urls VALUES (1), (2), (3);
    INSERT INTO users VALUES (1);
    INSERT INTO sessions VALUES (1, '2026-08-17T00:00:00.000Z'), (2, '2026-08-15T00:00:00.000Z');
    INSERT INTO model_favorites VALUES (1);
    INSERT INTO gallery_favorites VALUES (1), (2);
    INSERT INTO image_favorites VALUES (1), (2), (3);
    INSERT INTO image_seen VALUES (1), (2), (3), (4);
    INSERT INTO import_errors VALUES (1);
    INSERT INTO model_view_totals VALUES (5);
    INSERT INTO gallery_view_totals VALUES (7);
    INSERT INTO image_view_totals VALUES (11);
  `);
  const reporting = createAdminReporting({
    db,
    getRuntimeStats: () => ({}),
    nowIso: () => '2026-08-16T12:00:00.000Z',
  });
  const summary = reporting.summaryStats();
  assert.deepEqual(summary.library, { models: 2, galleries: 2, images: 10, sourceUrls: 3 });
  assert.deepEqual(summary.accounts, { users: 1, activeSessions: 1, favorites: 6, seenImages: 4 });
  assert.equal(summary.storage.imageBytes, 300);
  assert.equal(summary.storage.thumbBytes, 50);
  assert.equal(summary.storage.importErrors, 1);
  assert.deepEqual(summary.views, { models: 5, galleries: 7, images: 11 });
  db.close();
});

test('model options expose existing names and folders in stable order', () => {
  const context = fixture();
  assert.deepEqual(context.reporting.modelOptions(), {
    models: [
      { name: 'One', folder: 'one' },
      { name: 'Two', folder: 'two' },
    ],
  });
  context.db.close();
});
