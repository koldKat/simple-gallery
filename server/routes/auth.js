'use strict';

function handleAuthRoute(ctx, req, res, url) {
  const {
    db,
    readRequestBody,
    readRequestBuffer,
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
    clientIp,
    isAuthRateLimited,
    recordAuthFailure,
    clearAuthFailures,
    avatarService,
  } = ctx;

  const ACCOUNT_FAILURE_LIMIT = 5;
  const ACCOUNT_LOCK_MS = 15 * 60 * 1000;
  const AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

  function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return null;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid email address or leave it blank.');
    }
    return email;
  }

  function accountLockedError(message) {
    return Object.assign(new Error(message), { status: 423, code: 'ACCOUNT_LOCKED' });
  }

  function isDatabaseBusy(error) {
    return ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code);
  }

  function profileForUser(user) {
    const row = db.prepare('SELECT email, display_name AS displayName, avatar_path AS avatarUrl FROM users WHERE id = ?').get(user.id);
    if (!row) throw new Error('User not found.');
    const profile = { ...user, displayName: row.displayName, avatarUrl: row.avatarUrl || null };
    return { user: publicUser(profile), email: row.email || '' };
  }

  function cacheProfile(req, user, profile) {
    if (!req) return;
    req.__currentUserLoaded = true;
    req.__currentUser = {
      ...user,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl || null,
    };
  }

  function profileError(res, error, fallback) {
    if (isDatabaseBusy(error)) {
      sendJson(res, 503, { error: 'Database is busy. Try again shortly.' });
      return;
    }
    sendJson(res, error.status || 400, { error: error.message || fallback });
  }

  if (url.pathname === '/api/auth/me') {
    sendJson(res, 200, { user: publicUser(currentUser(req)) });
    return true;
  }

  if (url.pathname === '/api/auth/stats') {
    const user = currentUser(req);
    sendJson(res, 200, { stats: unseenStatsForUser(user?.id) });
    return true;
  }

  if (url.pathname === '/api/auth/profile' && req.method === 'GET') {
    const user = requireUser(req, res);
    if (!user) return true;
    try {
      sendJson(res, 200, profileForUser(user));
    } catch (error) {
      profileError(res, error, 'Profile load failed.');
    }
    return true;
  }

  if (url.pathname === '/api/auth/profile' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const displayName = String(payload.displayName || '').trim().slice(0, 80);
        if (!displayName) throw new Error('Display name is required.');
        const email = normalizeEmail(payload.email);
        const currentPassword = String(payload.currentPassword || '');
        const newPassword = String(payload.newPassword || '');
        const confirmPassword = String(payload.confirmPassword || '');
        const changingPassword = Boolean(currentPassword || newPassword || confirmPassword);
        const account = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
        if (!account) throw new Error('User not found.');
        if (changingPassword) {
          if (!currentPassword || !verifyPassword(currentPassword, account.password_hash)) throw new Error('Current password is incorrect.');
          if (newPassword.length < 6) throw new Error('New password must be at least 6 characters.');
          if (newPassword !== confirmPassword) throw new Error('New passwords do not match.');
        }
        try {
          withBusyRetry(() => db.prepare(`
            UPDATE users
            SET display_name = ?, email = ?, password_hash = COALESCE(?, password_hash)
            WHERE id = ?
          `).run(displayName, email, changingPassword ? hashPassword(newPassword) : null, user.id));
        } catch (error) {
          if (/UNIQUE constraint failed: users\.email|idx_users_email_unique/i.test(String(error?.message || ''))) {
            throw new Error('Email is already in use.');
          }
          throw error;
        }
        const profile = profileForUser(user);
        cacheProfile(req, user, profile.user);
        sendJson(res, 200, profile);
      })
      .catch(error => profileError(res, error, 'Profile save failed.'));
    return true;
  }

  if (url.pathname === '/api/auth/profile/avatar' && req.method === 'POST') {
    const user = requireUser(req, res);
    if (!user) return true;
    readRequestBuffer(req, AVATAR_SOURCE_MAX_BYTES)
      .then(async source => {
        const previous = db.prepare('SELECT avatar_path AS avatarUrl FROM users WHERE id = ?').get(user.id)?.avatarUrl || null;
        const avatarUrl = await avatarService.saveAvatar(user.id, source);
        try {
          withBusyRetry(() => db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(avatarUrl, user.id));
        } catch (error) {
          avatarService.removeAvatar(avatarUrl);
          throw error;
        }
        avatarService.removeAvatar(previous);
        const profile = profileForUser(user);
        cacheProfile(req, user, profile.user);
        sendJson(res, 200, profile);
      })
      .catch(error => profileError(res, error, 'Avatar upload failed.'));
    return true;
  }

  if (url.pathname === '/api/auth/profile/avatar' && req.method === 'DELETE') {
    const user = requireUser(req, res);
    if (!user) return true;
    try {
      const previous = db.prepare('SELECT avatar_path AS avatarUrl FROM users WHERE id = ?').get(user.id)?.avatarUrl || null;
      withBusyRetry(() => db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(user.id));
      avatarService.removeAvatar(previous);
      const profile = profileForUser(user);
      cacheProfile(req, user, profile.user);
      sendJson(res, 200, profile);
    } catch (error) {
      profileError(res, error, 'Avatar removal failed.');
    }
    return true;
  }

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    const ip = clientIp(req);
    if (isAuthRateLimited(ip)) {
      sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
      return true;
    }
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const username = String(payload.username || '').trim();
        const password = String(payload.password || '');
        const confirmPassword = String(payload.confirmPassword || '');
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error('Username must be 3-40 letters, numbers, dots, dashes, or underscores.');
        if (password.length < 6) throw new Error('Password must be at least 6 characters.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        const email = normalizeEmail(payload.email);
        const displayName = String(payload.displayName || username).trim().slice(0, 80) || username;
        const registeredAt = nowIso();
        const passwordHash = hashPassword(password);
        const registerAccount = db.transaction(() => {
          const result = db.prepare(`
            INSERT INTO users (username, email, password_hash, display_name, created_at, last_login_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(username, email, passwordHash, displayName, registeredAt, registeredAt);
          return { result, session: createSession(result.lastInsertRowid) };
        });
        const { result, session } = withBusyRetry(registerAccount);
        clearAuthFailures(ip);
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
        if (isDatabaseBusy(error)) {
          sendJson(res, 503, { error: 'Database is busy. Try again shortly.' });
          return;
        }
        recordAuthFailure(ip);
        if (/UNIQUE constraint failed: users\.(username|email)|idx_users_email_unique/i.test(String(error?.message || ''))) {
          sendJson(res, 409, { error: 'Username or email is already taken.' });
          return;
        }
        sendJson(res, 400, { error: error.message || 'Register failed.' });
      });
    return true;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (isAuthRateLimited(ip)) {
      sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
      return true;
    }
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const username = String(payload.username || '').trim();
        const password = String(payload.password || '');
        const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL').get(username);
        if (user?.admin_locked) throw accountLockedError('This account has been locked by an administrator.');
        const now = Date.now();
        if (user?.locked_until && new Date(user.locked_until).getTime() > now) {
          throw accountLockedError('This account is temporarily locked after too many failed sign-in attempts. Try again later.');
        }
        if (!user || !verifyPassword(password, user.password_hash)) {
          if (user) {
            const failures = Number(user.failed_login_count || 0) + 1;
            const lockedUntil = failures >= ACCOUNT_FAILURE_LIMIT ? new Date(now + ACCOUNT_LOCK_MS).toISOString() : null;
            withBusyRetry(() => db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(failures, lockedUntil, user.id));
            if (lockedUntil) throw accountLockedError('This account is temporarily locked after too many failed sign-in attempts. Try again later.');
          }
          throw Object.assign(new Error('Invalid username or password.'), { code: 'INVALID_CREDENTIALS' });
        }
        const session = withBusyRetry(() => db.transaction(() => {
          if (user.failed_login_count || user.locked_until) {
            db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
          }
          db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
          return createSession(user.id);
        })());
        clearAuthFailures(ip);
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
      .catch(error => {
        if (isDatabaseBusy(error)) {
          sendJson(res, 503, { error: 'Database is busy. Try again shortly.' });
          return;
        }
        if (error.code === 'INVALID_CREDENTIALS' || error.code === 'ACCOUNT_LOCKED') recordAuthFailure(ip);
        sendJson(res, error.status || 401, { error: error.message || 'Login failed.' });
      });
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
