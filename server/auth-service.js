'use strict';

const crypto = require('crypto');

const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES_PER_WINDOW = 8;
const AUTH_FAILURE_PRUNE_INTERVAL_MS = 60 * 1000;
const AUTH_FAILURE_MAX_TRACKED_IPS = 10_000;

function createAuthService({
  db,
  sendJson,
  sessionMaxAgeMs,
  now = () => Date.now(),
  authFailureWindowMs = AUTH_FAILURE_WINDOW_MS,
  authFailureMaxTrackedIps = AUTH_FAILURE_MAX_TRACKED_IPS,
}) {
  const authFailuresByIp = new Map();
  let nextAuthFailurePruneAt = 0;

  function clientIp(req) {
    return String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '')
      .split(',')[0]
      .trim();
  }

  function recentAuthFailures(ip) {
    const key = String(ip || 'unknown');
    const cutoff = now() - authFailureWindowMs;
    const recent = (authFailuresByIp.get(key) || []).filter(at => at > cutoff);
    if (recent.length) authFailuresByIp.set(key, recent);
    else authFailuresByIp.delete(key);
    return recent;
  }

  function pruneAuthFailures(timestamp = now()) {
    if (timestamp < nextAuthFailurePruneAt) return;
    const cutoff = timestamp - authFailureWindowMs;
    for (const [key, attempts] of authFailuresByIp) {
      const recent = attempts.filter(at => at > cutoff);
      if (recent.length) authFailuresByIp.set(key, recent);
      else authFailuresByIp.delete(key);
    }
    nextAuthFailurePruneAt = timestamp + AUTH_FAILURE_PRUNE_INTERVAL_MS;
  }

  function isAuthRateLimited(ip) {
    return recentAuthFailures(ip).length >= AUTH_MAX_FAILURES_PER_WINDOW;
  }

  function recordAuthFailure(ip) {
    const key = String(ip || 'unknown');
    const timestamp = now();
    pruneAuthFailures(timestamp);
    const recent = recentAuthFailures(key);
    if (!authFailuresByIp.has(key)) {
      while (authFailuresByIp.size >= authFailureMaxTrackedIps) {
        const oldestKey = authFailuresByIp.keys().next().value;
        if (oldestKey === undefined) break;
        authFailuresByIp.delete(oldestKey);
      }
    }
    recent.push(timestamp);
    authFailuresByIp.set(key, recent);
  }

  function clearAuthFailures(ip) {
    authFailuresByIp.delete(String(ip || 'unknown'));
  }
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
        users.avatar_path AS avatarUrl,
        users.preload_model AS preloadModel,
        users.preload_gallery AS preloadGallery,
        sessions.expires_at AS expiresAt
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND users.disabled_at IS NULL
        AND users.admin_locked = 0
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
    if (!user) return null;
    const publicProfile = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      preloadModel: Boolean(user.preloadModel),
      preloadGallery: Boolean(user.preloadGallery),
      favoriteCount: favoriteCountForUser(user.id),
    };
    if (user.avatarUrl) publicProfile.avatarUrl = user.avatarUrl;
    return publicProfile;
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
    clientIp,
    isAuthRateLimited,
    recordAuthFailure,
    clearAuthFailures,
  };
}

module.exports = { createAuthService };
