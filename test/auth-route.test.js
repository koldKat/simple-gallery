'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { handleAuthRoute } = require('../server/routes/auth');
const { createAuthService } = require('../server/auth-service');

function fixture(createSessionOverride) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      preload_model INTEGER NOT NULL DEFAULT 0,
      preload_gallery INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      disabled_at TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);
  const sent = [];
  const auth = createAuthService({
    db,
    sendJson() {},
    sessionMaxAgeMs: 60000,
    now: () => Date.parse('2026-08-29T12:00:00.000Z'),
  });
  return {
    db,
    sent,
    context: {
      db,
      readRequestBody: async () => JSON.stringify({ username: 'new-user', password: 'secret1' }),
      sendJson(_res, status, payload, headers) { sent.push({ status, payload, headers }); },
      publicUser: auth.publicUser,
      currentUser: auth.currentUser,
      hashPassword: auth.hashPassword,
      verifyPassword: auth.verifyPassword,
      nowIso: () => '2026-08-29T12:00:00.000Z',
      createSession: createSessionOverride || auth.createSession,
      sessionCookie: auth.sessionCookie,
      requireUser: auth.requireUser,
      withBusyRetry: work => work(),
      parseCookies: auth.parseCookies,
      hashToken: auth.hashToken,
      clearSessionCookie: auth.clearSessionCookie,
      favoriteCountForUser: auth.favoriteCountForUser,
      unseenStatsForUser: () => ({}),
    },
  };
}

function waitTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('registration records the first login and creates its session atomically', async () => {
  const context = fixture();
  handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/register' });
  await waitTurn();

  const user = context.db.prepare('SELECT created_at, last_login_at FROM users WHERE username = ?').get('new-user');
  assert.equal(user.created_at, user.last_login_at);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.equal(context.sent.at(-1).status, 200);
  context.db.close();
});

test('registration rolls back the user when session creation fails', async () => {
  const context = fixture(() => { throw new Error('session unavailable'); });
  handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/register' });
  await waitTurn();

  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(context.sent.at(-1).status, 400);
  context.db.close();
});
