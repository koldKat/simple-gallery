'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAuthService } = require('../server/auth-service');

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      preload_model INTEGER DEFAULT 0,
      preload_gallery INTEGER DEFAULT 0,
      disabled_at TEXT
    );
    CREATE TABLE sessions (
      user_id INTEGER,
      token_hash TEXT,
      created_at TEXT,
      expires_at TEXT,
      last_seen_at TEXT
    );
    CREATE TABLE model_favorites (user_id INTEGER);
    CREATE TABLE gallery_favorites (user_id INTEGER);
    CREATE TABLE image_favorites (user_id INTEGER);
  `);
  const responses = [];
  const service = createAuthService({
    db,
    sessionMaxAgeMs: TWO_WEEKS,
    now: () => NOW,
    sendJson(_res, status, payload) {
      responses.push({ status, payload });
    },
  });
  return { db, service, responses };
}

function addUser(db) {
  db.prepare(`
    INSERT INTO users (id, username, display_name, preload_model, preload_gallery)
    VALUES (1, 'alex', 'Alex', 1, 0)
  `).run();
}

function addSession(db, service, token, expiresAt) {
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES (1, ?, ?, ?, ?)
  `).run(service.hashToken(token), new Date(NOW).toISOString(), expiresAt, new Date(NOW).toISOString());
}

test('password hashes verify without accepting malformed values', () => {
  const { service, db } = fixture();
  const stored = service.hashPassword('correct horse', 'fixed-salt');
  assert.equal(service.verifyPassword('correct horse', stored), true);
  assert.equal(service.verifyPassword('wrong', stored), false);
  assert.equal(service.verifyPassword('correct horse', 'not-a-hash'), false);
  db.close();
});

test('current user is resolved once and cached on the request', () => {
  const { service, db } = fixture();
  addUser(db);
  addSession(db, service, 'session-token', new Date(NOW + TWO_WEEKS).toISOString());
  const req = { headers: { cookie: 'sg_session=session-token' } };

  assert.deepEqual(service.currentUser(req), {
    id: 1,
    username: 'alex',
    displayName: 'Alex',
    preloadModel: true,
    preloadGallery: false,
  });
  db.prepare('DELETE FROM sessions').run();
  assert.equal(service.currentUser(req).username, 'alex');
  db.close();
});

test('expired sessions are rejected and removed', () => {
  const { service, db } = fixture();
  addUser(db);
  addSession(db, service, 'expired-token', new Date(NOW - 1).toISOString());

  assert.equal(service.currentUser({ headers: { cookie: 'sg_session=expired-token' } }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  db.close();
});

test('public users include the aggregate favorite count', () => {
  const { service, db } = fixture();
  addUser(db);
  db.prepare('INSERT INTO model_favorites (user_id) VALUES (1), (1)').run();
  db.prepare('INSERT INTO gallery_favorites (user_id) VALUES (1)').run();
  db.prepare('INSERT INTO image_favorites (user_id) VALUES (1), (1), (1)').run();

  const user = service.publicUser({ id: 1, username: 'alex', displayName: 'Alex' });
  assert.equal(user.favoriteCount, 6);
  db.close();
});

test('authorization and visitor cookies preserve request behavior', () => {
  const { service, db, responses } = fixture();
  const req = { headers: { cookie: 'bad=%E0%A4%A; sg_visitor=abcdefghijklmnop' } };

  assert.equal(service.requireUser(req, {}), null);
  assert.deepEqual(responses, [{ status: 401, payload: { error: 'Login required.' } }]);
  assert.deepEqual(service.actorKeyForRequest(req), {
    actorKey: 'visitor:abcdefghijklmnop',
    setCookie: null,
  });
  db.close();
});

test('created sessions expire after the configured interval', () => {
  const { service, db } = fixture();
  addUser(db);
  const session = service.createSession(1);
  const stored = db.prepare('SELECT * FROM sessions').get();

  assert.equal(session.expiresAt, new Date(NOW + TWO_WEEKS).toISOString());
  assert.equal(stored.token_hash, service.hashToken(session.token));
  assert.equal(stored.created_at, new Date(NOW).toISOString());
  db.close();
});
