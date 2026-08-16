'use strict';

const crypto = require('crypto');

function createAuthService({ db, sendJson, sessionMaxAgeMs, now = () => Date.now() }) {
  function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
  }

  function verifyPassword(password, stored) {
    const [scheme, salt, hash] = String(stored || '').split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = hashPassword(password, salt).split(':')[2];
    const candidateBuffer = Buffer.from(candidate, 'hex');
    const storedBuffer = Buffer.from(hash, 'hex');
    if (candidateBuffer.length !== storedBuffer.length) return false;
    return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
  }

  function parseCookies(req) {
    const cookies = {};
    for (const part of String(req?.headers?.cookie || '').split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const name = part.slice(0, index).trim();
      try {
        cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        // Ignore malformed request cookies rather than failing the request.
      }
    }
    return cookies;
  }

  function sessionCookie(token, expiresAt) {
    return `sg_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
  }

  function visitorCookie(token) {
    return `sg_visitor=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
  }

  function clearSessionCookie() {
    return 'sg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  }

  function cacheCurrentUser(req, user) {
    if (!req) return;
    req.__currentUserLoaded = true;
    req.__currentUser = user;
  }

  function currentUser(req) {
    if (req && Object.hasOwn(req, '__currentUserLoaded')) return req.__currentUser || null;
    const token = parseCookies(req).sg_session;
    if (!token) {
      cacheCurrentUser(req, null);
      return null;
    }

    const tokenHash = hashToken(token);
    const row = db.prepare(`
      SELECT
        users.id,
        users.username,
        users.display_name AS displayName,
        users.preload_model AS preloadModel,
        users.preload_gallery AS preloadGallery,
        sessions.expires_at AS expiresAt
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND users.disabled_at IS NULL
    `).get(tokenHash);
    if (!row) {
      cacheCurrentUser(req, null);
      return null;
    }
    if (new Date(row.expiresAt).getTime() <= now()) {
      try {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      } catch {
        // An expired session remains invalid even when cleanup is briefly blocked.
      }
      cacheCurrentUser(req, null);
      return null;
    }

    const user = {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      preloadModel: Boolean(row.preloadModel),
      preloadGallery: Boolean(row.preloadGallery),
    };
    cacheCurrentUser(req, user);
    return user;
  }

  function favoriteCountForUser(userId) {
    if (!userId) return 0;
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM model_favorites WHERE user_id = ?) +
        (SELECT COUNT(*) FROM gallery_favorites WHERE user_id = ?) +
        (SELECT COUNT(*) FROM image_favorites WHERE user_id = ?) AS count
    `).get(userId, userId, userId);
    return Number(row?.count || 0);
  }

  function publicUser(user) {
    return user ? {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      preloadModel: Boolean(user.preloadModel),
      preloadGallery: Boolean(user.preloadGallery),
      favoriteCount: favoriteCountForUser(user.id),
    } : null;
  }

  function actorKeyForRequest(req) {
    const user = currentUser(req);
    if (user) return { actorKey: `user:${user.id}`, setCookie: null };
    const existing = String(parseCookies(req).sg_visitor || '').trim();
    if (/^[a-zA-Z0-9_-]{16,80}$/.test(existing)) {
      return { actorKey: `visitor:${existing}`, setCookie: null };
    }
    const token = crypto.randomBytes(18).toString('base64url');
    return { actorKey: `visitor:${token}`, setCookie: visitorCookie(token) };
  }

  function requireUser(req, res) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, 401, { error: 'Login required.' });
      return null;
    }
    return user;
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + sessionMaxAgeMs).toISOString();
    db.prepare(`
      INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, hashToken(token), createdAt, expiresAt, createdAt);
    return { token, expiresAt };
  }

  return {
    hashToken,
    hashPassword,
    verifyPassword,
    parseCookies,
    sessionCookie,
    visitorCookie,
    clearSessionCookie,
    currentUser,
    favoriteCountForUser,
    publicUser,
    actorKeyForRequest,
    requireUser,
    createSession,
  };
}

module.exports = { createAuthService };
