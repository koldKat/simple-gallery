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
      email TEXT UNIQUE,
      avatar_path TEXT,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      preload_model INTEGER NOT NULL DEFAULT 0,
      preload_gallery INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      disabled_at TEXT,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      admin_locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE model_favorites (user_id INTEGER);
    CREATE TABLE gallery_favorites (user_id INTEGER);
    CREATE TABLE image_favorites (user_id INTEGER);
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
      readRequestBody: async () => JSON.stringify({ username: 'new-user', password: 'secret1', confirmPassword: 'secret1', email: 'new@example.test' }),
      readRequestBuffer: async () => Buffer.alloc(0),
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
      clientIp: auth.clientIp,
      isAuthRateLimited: auth.isAuthRateLimited,
      recordAuthFailure: auth.recordAuthFailure,
      clearAuthFailures: auth.clearAuthFailures,
      avatarService: { saveAvatar: async () => '/uploads/avatars/test.jpg', removeAvatar() {} },
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

  const user = context.db.prepare('SELECT created_at, last_login_at, email FROM users WHERE username = ?').get('new-user');
  assert.equal(user.created_at, user.last_login_at);
  assert.equal(user.email, 'new@example.test');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.equal(context.sent.at(-1).status, 200);
  context.db.close();
});

test('registration requires matching passwords and login locks after five failures', async () => {
  const context = fixture();
  context.context.readRequestBody = async () => JSON.stringify({ username: 'new-user', password: 'secret1', confirmPassword: 'different' });
  handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/register' });
  await waitTurn();
  assert.equal(context.sent.at(-1).status, 400);
  assert.match(context.sent.at(-1).payload.error, /do not match/);

  const hash = context.context.hashPassword('secret1');
  context.db.prepare(`INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run('locked-user', hash, 'Locked User', '2026-08-29T12:00:00.000Z');
  context.context.readRequestBody = async () => JSON.stringify({ username: 'locked-user', password: 'wrong' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/login' });
    await waitTurn();
  }
  assert.equal(context.sent.at(-1).status, 423);
  assert.ok(context.db.prepare('SELECT locked_until FROM users WHERE username = ?').get('locked-user').locked_until);
  context.db.close();
});

test('a successful login clears an expired temporary lock from the database', async () => {
  const context = fixture();
  const hash = context.context.hashPassword('secret1');
  context.db.prepare(`
    INSERT INTO users (username, password_hash, display_name, created_at, failed_login_count, locked_until)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('returning-user', hash, 'Returning User', '2026-08-29T10:00:00.000Z', 5, '2026-08-29T11:59:59.000Z');
  context.context.readRequestBody = async () => JSON.stringify({ username: 'returning-user', password: 'secret1' });
  handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/login' });
  await waitTurn();

  const user = context.db.prepare('SELECT failed_login_count, locked_until FROM users WHERE username = ?').get('returning-user');
  assert.equal(context.sent.at(-1).status, 200);
  assert.equal(user.failed_login_count, 0);
  assert.equal(user.locked_until, null);
  context.db.close();
});

test('temporary account-lock responses count toward the IP attempt limit', async () => {
  const context = fixture();
  const hash = context.context.hashPassword('secret1');
  context.db.prepare(`INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run('locked-user', hash, 'Locked User', '2026-08-29T12:00:00.000Z');
  context.context.readRequestBody = async () => JSON.stringify({ username: 'locked-user', password: 'wrong' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/login' });
    await waitTurn();
  }
  context.context.readRequestBody = async () => JSON.stringify({ username: 'bad', password: 'secret1', confirmPassword: 'different' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/register' });
    await waitTurn();
  }
  handleAuthRoute(context.context, { method: 'POST' }, {}, { pathname: '/api/auth/register' });
  await waitTurn();
  assert.equal(context.sent.at(-1).status, 429);
  context.db.close();
});

test('profile endpoint returns the authenticated user email and avatar privately', async () => {
  const context = fixture();
  const hash = context.context.hashPassword('secret1');
  context.db.prepare(`
    INSERT INTO users (id, username, email, avatar_path, password_hash, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(7, 'profile-user', 'profile@example.test', '/uploads/avatars/7.jpg', hash, 'Profile User', '2026-08-29T12:00:00.000Z');
  const session = context.context.createSession(7);
  handleAuthRoute(context.context, { method: 'GET', headers: { cookie: `sg_session=${session.token}` } }, {}, { pathname: '/api/auth/profile' });

  assert.deepEqual(context.sent.at(-1).payload, {
    user: {
      id: 7,
      username: 'profile-user',
      displayName: 'Profile User',
      preloadModel: false,
      preloadGallery: false,
      favoriteCount: 0,
      avatarUrl: '/uploads/avatars/7.jpg',
    },
    email: 'profile@example.test',
  });
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
