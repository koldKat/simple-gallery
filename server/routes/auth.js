'use strict';

function handleAuthRoute(ctx, req, res, url) {
  const {
    db,
    readRequestBody,
    sendJson,
    publicUser,
    currentUser,
    hashPassword,
    verifyPassword,
    nowIso,
    createSession,
    sessionCookie,
    requireUser,
    withBusyRetry,
    parseCookies,
    hashToken,
    clearSessionCookie,
    favoriteCountForUser,
    unseenStatsForUser,
  } = ctx;

  if (url.pathname === '/api/auth/me') {
    sendJson(res, 200, { user: publicUser(currentUser(req)) });
    return true;
  }

  if (url.pathname === '/api/auth/stats') {
    const user = currentUser(req);
    sendJson(res, 200, { stats: unseenStatsForUser(user?.id) });
    return true;
  }

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const username = String(payload.username || '').trim();
        const password = String(payload.password || '');
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error('Username must be 3-40 letters, numbers, dots, dashes, or underscores.');
        if (password.length < 6) throw new Error('Password must be at least 6 characters.');
        const displayName = String(payload.displayName || username).trim().slice(0, 80) || username;
        const registeredAt = nowIso();
        const passwordHash = hashPassword(password);
        const registerAccount = db.transaction(() => {
          const result = db.prepare(`
            INSERT INTO users (username, password_hash, display_name, created_at, last_login_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(username, passwordHash, displayName, registeredAt, registeredAt);
          return { result, session: createSession(result.lastInsertRowid) };
        });
        const { result, session } = withBusyRetry(registerAccount);
        sendJson(res, 200, {
          user: {
            id: result.lastInsertRowid,
            username,
            displayName,
            preloadModel: false,
            preloadGallery: false,
            favoriteCount: 0,
          },
        }, { 'set-cookie': sessionCookie(session.token, session.expiresAt) });
      })
      .catch(error => {
        if (/UNIQUE constraint failed: users\.username/i.test(String(error?.message || ''))) {
          sendJson(res, 409, { error: 'Username is already taken.' });
          return;
        }
        sendJson(res, 400, { error: error.message || 'Register failed.' });
      });
    return true;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const username = String(payload.username || '').trim();
        const password = String(payload.password || '');
        const user = db.prepare('SELECT * FROM users WHERE username = ? AND disabled_at IS NULL').get(username);
        if (!user || !verifyPassword(password, user.password_hash)) throw new Error('Invalid username or password.');
        db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
        const session = createSession(user.id);
        sendJson(res, 200, {
          user: {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            preloadModel: Boolean(user.preload_model),
            preloadGallery: Boolean(user.preload_gallery),
            favoriteCount: favoriteCountForUser(user.id),
          },
        }, { 'set-cookie': sessionCookie(session.token, session.expiresAt) });
      })
      .catch(error => sendJson(res, 401, { error: error.message || 'Login failed.' }));
    return true;
  }

  if (url.pathname === '/api/auth/settings' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const preloadModel = payload.preloadModel ? 1 : 0;
        const preloadGallery = payload.preloadGallery ? 1 : 0;
        withBusyRetry(() => db.prepare(`
          UPDATE users
          SET preload_model = ?, preload_gallery = ?
          WHERE id = ?
        `).run(preloadModel, preloadGallery, user.id));
        if (req) {
          req.__currentUserLoaded = true;
          req.__currentUser = {
            ...user,
            preloadModel: Boolean(preloadModel),
            preloadGallery: Boolean(preloadGallery),
          };
        }
        sendJson(res, 200, { user: publicUser(req.__currentUser) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Save profile settings failed.' }));
    return true;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req).sg_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    sendJson(res, 200, { user: null }, { 'set-cookie': clearSessionCookie() });
    return true;
  }

  return false;
}

module.exports = {
  handleAuthRoute,
};
