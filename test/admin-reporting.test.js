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
      display_name TEXT,
      created_at TEXT,
      last_login_at TEXT,
      disabled_at TEXT
    );
    CREATE TABLE sessions (user_id INTEGER, expires_at TEXT);

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
      (1, 'active', 'Active', '2026-01-01T00:00:00.000Z', '2026-08-16T10:00:00.000Z', NULL),
      (2, 'disabled', 'Disabled', '2026-02-01T00:00:00.000Z', '2026-08-16T11:00:00.000Z', '2026-08-16T11:30:00.000Z');
    INSERT INTO sessions VALUES
      (1, '2026-08-17T00:00:00.000Z'),
      (1, '2026-08-15T00:00:00.000Z'),
      (2, '2026-08-17T00:00:00.000Z');
  `);

  assert.deepEqual(context.reporting.users().users, [
    {
      id: 1,
      username: 'active',
      displayName: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-08-16T10:00:00.000Z',
      disabledAt: null,
      activeSessions: 1,
    },
    {
      id: 2,
      username: 'disabled',
      displayName: 'Disabled',
      createdAt: '2026-02-01T00:00:00.000Z',
      lastLoginAt: '2026-08-16T11:00:00.000Z',
      disabledAt: '2026-08-16T11:30:00.000Z',
      activeSessions: 1,
    },
  ]);
  context.db.close();
});
