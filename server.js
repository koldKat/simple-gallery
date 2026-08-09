#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, fork } = require('child_process');
const geoip = require('geoip-lite');
console.log('[startup] Opening database...');
const db = require('./server/db/connection');
console.log('[startup] Database opened.');
const {
  readRequestBody,
  sendJson,
} = require('./server/http-utils');
const {
  escapeHtml,
  escapeJsonForHtml,
  formatDateLabel,
  formatCount,
  renderStatsBreakdown,
  seoKeywords,
} = require('./server/html-format');
const {
  requestUrl,
  absoluteUrlForRequest,
  modelRoutePath,
  galleryRoutePath,
  modelsDirectoryPath,
} = require('./server/route-paths');
const { handleAuthRoute } = require('./server/routes/auth');
const { handleFavoritesRoute } = require('./server/routes/favorites');
const { handleSeenRoute } = require('./server/routes/seen');
const { handleViewsRoute } = require('./server/routes/views');
const {
  APP_ROOT,
  VERSION_PATH,
  PORT,
  ROOT,
  DEFAULT_MEDIA_ROOT,
  DB_PATH,
  DB_BACKUP_DIR,
  THUMB_DIR,
  IS_WORKER,
  THUMB_SIZE,
  THUMB_CONCURRENCY,
  IMPORT_CONCURRENCY,
  MODEL_LIST_DISCOVERY_CONCURRENCY,
  IMPORT_FETCH_RETRIES,
  IMPORT_FETCH_TIMEOUT_MS,
  IMPORT_LOG_LIMIT,
  IMPORT_PROGRESS_MIN_MS,
  IMPORT_FETCH_BACKOFF_BASE_MS,
  IMPORT_FETCH_BACKOFF_MAX_MS,
  AUTO_RESCAN_DEFAULT_TIME,
  AUTO_RESCAN_RETRY_MS,
  DB_BACKUP_DEFAULT_TIME,
  DB_BACKUP_RETENTION_DAYS,
  DEFAULT_VERSION_LABEL,
  SESSION_MAX_AGE_MS,
  FOREGROUND_ACTIVITY_WINDOW_MS,
  IMPORT_FOREGROUND_PAUSE_MS,
  VIEW_DEDUPE_MS,
  VIEW_DEDUPE_RETENTION_MS,
  IMAGE_EXTS,
  MIME,
} = require('./server/config');

const sseClients = new Set();
const sockets = new Set();
const thumbQueue = [];
const queuedThumbs = new Set();
let activeThumbs = 0;
let thumbRescanTimer = null;
let thumbStateBroadcastTimer = null;
let autoRescanTimer = null;
let nextAutoRescanAt = null;
let dbBackupTimer = null;
let dbBackupInFlight = false;
let dbHousekeepingTimer = null;
let scanInFlight = null;
let importJob = null;
let stopAfterCurrentModelRequested = false;
let pauseRescanAllRequested = false;
let loadedModelList = null;
let loadedModelBroadcastCount = 0;
let lastImportProgressAt = 0;
let lastState = emptyState('starting');
const activeImportGalleryPaths = new Set();
let viewStatsBroadcastTimer = null;
let lastForegroundActivityAt = 0;
let shuttingDown = false;
let shutdownTimer = null;
let skipNextThumbAutoRescan = false;
let lastCpuUsage = process.cpuUsage();
let lastCpuWallNs = process.hrtime.bigint();
let server = null;
let workerChild = null;
let workerRequestId = 0;
const workerPending = new Map();
let workerIpcConnected = !IS_WORKER || Boolean(process.connected);

function appSettingSafe(key, fallback = '') {
  try {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || fallback;
  } catch {
    return fallback;
  }
}

function jsonAppSetting(key, fallback = {}) {
  try {
    const parsed = JSON.parse(appSettingSafe(key, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function mediaRoot() {
  const configured = String(appSettingSafe('content_root', '')).trim();
  if (!configured) return DEFAULT_MEDIA_ROOT;
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(APP_ROOT, configured);
}

function mediaUrlPrefix() {
  const configured = String(appSettingSafe('media_url_prefix', '/media')).trim();
  const normalized = `/${configured.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/media' : normalized;
}

function sourceProfile() {
  const profile = jsonAppSetting('source_profile', {});
  return {
    allowedHosts: Array.isArray(profile.allowedHosts) ? profile.allowedHosts.map(value => String(value).toLowerCase()) : [],
    referer: String(profile.referer || ''),
    modelPathSegment: String(profile.modelPathSegment || 'item').replace(/^\/+|\/+$/g, ''),
    modelListPath: String(profile.modelListPath || '/items'),
    paginationParameter: String(profile.paginationParameter || 'offset'),
    letterParameter: String(profile.letterParameter || 'letter'),
    letterValues: String(profile.letterValues || 'abcdefghijklmnopqrstuvwxyz'),
    modelListExample: String(profile.modelListExample || ''),
    modelExample: String(profile.modelExample || ''),
    modelTitleSuffixPattern: String(profile.modelTitleSuffixPattern || ''),
    gallerySectionStartLabel: String(profile.gallerySectionStartLabel || ''),
    gallerySectionEndLabel: String(profile.gallerySectionEndLabel || ''),
    galleryLinkClass: String(profile.galleryLinkClass || 'item'),
    galleryTextClass: String(profile.galleryTextClass || 'title'),
    excludedGalleryPathPrefixes: Array.isArray(profile.excludedGalleryPathPrefixes)
      ? profile.excludedGalleryPathPrefixes.map(value => String(value))
      : [],
    galleryDetailSuffixPattern: String(profile.galleryDetailSuffixPattern || '-\\d+\\.html'),
    largeImageLinkLabel: String(profile.largeImageLinkLabel || ''),
    largeImageLinkClass: String(profile.largeImageLinkClass || ''),
  };
}

function seoProfile() {
  return jsonAppSetting('seo_profile', {});
}

function sourceHostAllowed(hostname, profile = sourceProfile()) {
  const host = String(hostname || '').toLowerCase();
  return profile.allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function requireSourceProfile() {
  const profile = sourceProfile();
  if (!profile.allowedHosts.length) throw new Error('Configure a source profile in Admin before importing.');
  return profile;
}

let trafficLocalInBytes = 0;
let trafficLocalOutBytes = 0;
let trafficRemoteInBytes = 0;
let trafficRemoteOutBytes = 0;
let trafficRemoteCountryBytes = new Map();
let trafficDirty = 0;
const TRAFFIC_FLUSH_EVERY = 50;

function emptyState(status = 'idle') {
  return {
    app: {
      name: 'Simple Gallery',
      tagline: '',
      version: '1.0.0',
      versionLabel: DEFAULT_VERSION_LABEL,
      root: '/media',
      thumbSize: THUMB_SIZE,
    },
    status,
    message: 'Waiting for scan.',
    scannedAt: null,
    totals: {
      models: 0,
      galleries: 0,
      images: 0,
      thumbs: 0,
      missingThumbs: 0,
      staleThumbsRemoved: 0,
      imageBytes: 0,
      thumbBytes: 0,
      totalBytes: 0,
    },
    runtime: {
      rssBytes: 0,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      cpuPercent: 0,
      cpuCores: 0,
      cpuTotalCores: os.cpus().length,
      dbBytes: 0,
      trafficInBytes: 0,
      trafficOutBytes: 0,
      trafficLocalInBytes: 0,
      trafficLocalOutBytes: 0,
      trafficRemoteInBytes: 0,
      trafficRemoteOutBytes: 0,
      remoteCountryTraffic: [],
    },
    models: [],
    latest: [],
  };
}

if (IS_WORKER) {
  process.on('disconnect', () => {
    workerIpcConnected = false;
  });
}

function runtimeStats() {
  const usage = process.memoryUsage();
  const nowNs = process.hrtime.bigint();
  const cpuNow = process.cpuUsage();
  const elapsedNs = Number(nowNs - lastCpuWallNs);
  const deltaUser = Number(cpuNow.user - lastCpuUsage.user);
  const deltaSystem = Number(cpuNow.system - lastCpuUsage.system);
  lastCpuWallNs = nowNs;
  lastCpuUsage = cpuNow;
  const elapsedMicros = elapsedNs > 0 ? elapsedNs / 1000 : 0;
  const cpuPercent = elapsedMicros > 0
    ? ((deltaUser + deltaSystem) / elapsedMicros) * 100
    : 0;
  const cpuCores = cpuPercent / 100;
  return {
    rssBytes: Number(usage.rss || 0),
    heapUsedBytes: Number(usage.heapUsed || 0),
    heapTotalBytes: Number(usage.heapTotal || 0),
    cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : 0,
    cpuCores: Number.isFinite(cpuCores) ? Math.max(0, cpuCores) : 0,
    cpuTotalCores: os.cpus().length,
    dbBytes: fileSize(DB_PATH),
    trafficInBytes: Number((trafficLocalInBytes || 0) + (trafficRemoteInBytes || 0)),
    trafficOutBytes: Number((trafficLocalOutBytes || 0) + (trafficRemoteOutBytes || 0)),
    trafficLocalInBytes: Number(trafficLocalInBytes || 0),
    trafficLocalOutBytes: Number(trafficLocalOutBytes || 0),
    trafficRemoteInBytes: Number(trafficRemoteInBytes || 0),
    trafficRemoteOutBytes: Number(trafficRemoteOutBytes || 0),
    remoteCountryTraffic: Array.from(trafficRemoteCountryBytes.entries())
      .map(([country, totals]) => ({
        country,
        inBytes: Number(totals?.inBytes || 0),
        outBytes: Number(totals?.outBytes || 0),
        totalBytes: Number((totals?.inBytes || 0) + (totals?.outBytes || 0)),
      }))
      .sort((a, b) => b.totalBytes - a.totalBytes || a.country.localeCompare(b.country)),
  };
}

function flushTraffic() {
  if (IS_WORKER) return;
  setAppSetting('traffic_in', String(Math.max(0, Number((trafficLocalInBytes || 0) + (trafficRemoteInBytes || 0)))));
  setAppSetting('traffic_out', String(Math.max(0, Number((trafficLocalOutBytes || 0) + (trafficRemoteOutBytes || 0)))));
  setAppSetting('traffic_local_in', String(Math.max(0, Number(trafficLocalInBytes || 0))));
  setAppSetting('traffic_local_out', String(Math.max(0, Number(trafficLocalOutBytes || 0))));
  setAppSetting('traffic_remote_in', String(Math.max(0, Number(trafficRemoteInBytes || 0))));
  setAppSetting('traffic_remote_out', String(Math.max(0, Number(trafficRemoteOutBytes || 0))));
  setAppSetting('traffic_remote_countries', JSON.stringify(Object.fromEntries(trafficRemoteCountryBytes.entries())));
}

function loadTrafficCounters() {
  trafficLocalInBytes = Number(appSettingSafe('traffic_local_in', '0')) || 0;
  trafficLocalOutBytes = Number(appSettingSafe('traffic_local_out', '0')) || 0;
  trafficRemoteInBytes = Number(appSettingSafe('traffic_remote_in', '0')) || 0;
  trafficRemoteOutBytes = Number(appSettingSafe('traffic_remote_out', '0')) || 0;
  try {
    const raw = JSON.parse(appSettingSafe('traffic_remote_countries', '{}'));
    trafficRemoteCountryBytes = new Map(
      Object.entries(raw || {}).map(([country, totals]) => [country, {
        inBytes: Number(totals?.inBytes || 0),
        outBytes: Number(totals?.outBytes || 0),
      }])
    );
  } catch {
    trafficRemoteCountryBytes = new Map();
  }
}

function estimateRequestBytes(req) {
  const method = String(req.method || 'GET');
  const url = String(req.url || '/');
  const version = String(req.httpVersion || '1.1');
  let total = Buffer.byteLength(`${method} ${url} HTTP/${version}\r\n`);
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index] || '');
    const value = String(rawHeaders[index + 1] || '');
    total += Buffer.byteLength(`${name}: ${value}\r\n`);
  }
  total += 2;
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > 0) total += contentLength;
  return total;
}

function clientIpForRequest(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || String(req.socket?.remoteAddress || '').trim();
  if (!raw) return '';
  return raw.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
}

function countryForRemoteRequest(req) {
  const ip = clientIpForRequest(req);
  if (!ip) return 'Unknown';
  const match = geoip.lookup(ip);
  return String(match?.country || 'Unknown').toUpperCase();
}

function toUrl(filePath) {
  const rel = path.relative(mediaRoot(), filePath).split(path.sep).map(encodeURIComponent).join('/');
  return `${mediaUrlPrefix()}/${rel}`;
}

function safeName(name) {
  return name.replace(/\.[^.]+$/, '.jpg');
}

function isImage(fileName) {
  return IMAGE_EXTS.has(path.extname(fileName).toLowerCase());
}

function isLocalhostRequest(req) {
  const remote = req.socket.remoteAddress || '';
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && localHosts.has(host);
}

function sanitizeFolderName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

function normalizeModelName(name) {
  return String(name || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase()) || 'Model';
}

function sanitizeFileBase(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'image';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function resolveRemoteUrl(href, baseUrl) {
  try {
    return new URL(decodeHtml(href), baseUrl).toString();
  } catch {
    return null;
  }
}

function canonicalRemoteUrl(remoteUrl) {
  const url = new URL(remoteUrl);
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function canonicalPageUrl(remoteUrl) {
  const url = new URL(remoteUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return url.toString();
}

function readDirs(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return fs.statSync(path.join(dirPath, entry.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map(entry => entry.name)
      .filter(name => !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function readImageFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && isImage(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleThumbs(thumbRoot, wantedThumbNames) {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(thumbRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(thumbRoot, entry.name);
    if (entry.isDirectory()) continue;
    if (entry.name.includes('.tmp-') || !wantedThumbNames.has(entry.name)) {
      if (removeFile(entryPath)) removed += 1;
    }
  }

  return removed;
}

function removeEmptyThumbDir(thumbRoot) {
  try {
    fs.rmdirSync(thumbRoot);
  } catch {
    // Keep non-empty or unavailable thumb folders in place.
  }
}

function realDirectoryPath(dirPath) {
  try {
    return fs.realpathSync(dirPath);
  } catch {
    return dirPath;
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function galleryStorageStats(galleryPath) {
  const imageNames = readImageFiles(galleryPath);
  const thumbRoot = path.join(galleryPath, THUMB_DIR);
  let imageBytes = 0;
  let thumbBytes = 0;
  let missingThumbs = 0;

  for (const fileName of imageNames) {
    const sourcePath = path.join(galleryPath, fileName);
    const thumbPath = path.join(thumbRoot, safeName(fileName));
    const hasThumb = fs.existsSync(thumbPath);
    imageBytes += fileSize(sourcePath);
    thumbBytes += hasThumb ? fileSize(thumbPath) : 0;
    if (!hasThumb) missingThumbs += 1;
  }

  return {
    imageNames,
    imageBytes,
    thumbBytes,
    missingThumbs,
  };
}

function galleryCoverUrl(modelFolder, galleryFolder, coverName, options = {}) {
  const firstImage = String(coverName || '').trim();
  if (!firstImage) return null;
  const galleryPath = path.join(mediaRoot(), modelFolder, galleryFolder);
  const sourcePath = path.join(galleryPath, firstImage);
  const thumbPath = path.join(galleryPath, THUMB_DIR, safeName(firstImage));
  if (options.cached) {
    return toUrl(Number(options.thumbBytes || 0) > 0 ? thumbPath : sourcePath);
  }
  return fs.existsSync(thumbPath) ? toUrl(thumbPath) : toUrl(sourcePath);
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
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

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS model_urls (
      id INTEGER PRIMARY KEY,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS ignored_model_urls (
      source_url TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS galleries (
      id INTEGER PRIMARY KEY,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      source_url TEXT,
      title TEXT NOT NULL DEFAULT '',
      folder TEXT NOT NULL,
      image_count INTEGER NOT NULL DEFAULT 0,
      cover_name TEXT,
      image_bytes INTEGER NOT NULL DEFAULT 0,
      thumb_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'imported',
      error_message TEXT,
      created_at TEXT NOT NULL,
      imported_at TEXT,
      last_seen_at TEXT,
      UNIQUE(model_id, folder)
    );

    CREATE TABLE IF NOT EXISTS gallery_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, gallery_id)
    );

    CREATE TABLE IF NOT EXISTS image_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      image_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, gallery_id, image_name)
    );

    CREATE TABLE IF NOT EXISTS image_seen (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      image_name TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (user_id, gallery_id, image_name)
    );

    CREATE TABLE IF NOT EXISTS model_view_totals (
      model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
      view_count INTEGER NOT NULL DEFAULT 0,
      first_viewed_at TEXT,
      last_viewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS gallery_view_totals (
      gallery_id INTEGER PRIMARY KEY REFERENCES galleries(id) ON DELETE CASCADE,
      view_count INTEGER NOT NULL DEFAULT 0,
      first_viewed_at TEXT,
      last_viewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS image_view_totals (
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      image_name TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 0,
      first_viewed_at TEXT,
      last_viewed_at TEXT,
      PRIMARY KEY (gallery_id, image_name)
    );

    CREATE TABLE IF NOT EXISTS view_dedupe (
      actor_key TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      last_counted_at TEXT NOT NULL,
      PRIMARY KEY (actor_key, target_type, target_key)
    );

    CREATE TABLE IF NOT EXISTS import_errors (
      id INTEGER PRIMARY KEY,
      model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
      gallery_id INTEGER REFERENCES galleries(id) ON DELETE SET NULL,
      model_url TEXT,
      gallery_url TEXT,
      title TEXT,
      folder TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_galleries_model ON galleries(model_id);
    CREATE INDEX IF NOT EXISTS idx_galleries_source_url ON galleries(source_url);
    CREATE INDEX IF NOT EXISTS idx_galleries_model_folder ON galleries(model_id, folder);
    CREATE INDEX IF NOT EXISTS idx_model_favorites_user ON model_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_favorites_user ON gallery_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_image_favorites_user ON image_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_image_seen_user ON image_seen(user_id);
    CREATE INDEX IF NOT EXISTS idx_image_seen_gallery ON image_seen(gallery_id);
    CREATE INDEX IF NOT EXISTS idx_view_dedupe_last_counted ON view_dedupe(last_counted_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_model_view_totals_count ON model_view_totals(view_count DESC);
    CREATE INDEX IF NOT EXISTS idx_gallery_view_totals_count ON gallery_view_totals(view_count DESC);
    CREATE INDEX IF NOT EXISTS idx_image_view_totals_count ON image_view_totals(view_count DESC);
  `);
  withBusyRetry(() => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('version_label', ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(DEFAULT_VERSION_LABEL, nowIso()));
}

function migrateGallerySourceUrlUniqueness() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'galleries'").get()?.sql || '';
  if (!/\bsource_url\s+TEXT\s+UNIQUE\b/i.test(schema)) return;

  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      ALTER TABLE galleries RENAME TO galleries_old;
      CREATE TABLE galleries (
        id INTEGER PRIMARY KEY,
        model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        source_url TEXT,
        title TEXT NOT NULL DEFAULT '',
        folder TEXT NOT NULL,
        image_count INTEGER NOT NULL DEFAULT 0,
        cover_name TEXT,
        image_bytes INTEGER NOT NULL DEFAULT 0,
        thumb_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'imported',
        error_message TEXT,
        created_at TEXT NOT NULL,
        imported_at TEXT,
        last_seen_at TEXT,
        UNIQUE(model_id, folder)
      );
      INSERT INTO galleries (
        id, model_id, source_url, title, folder, image_count, cover_name, image_bytes, thumb_bytes, status,
        error_message, created_at, imported_at, last_seen_at
      )
      SELECT
        id, model_id, source_url, title, folder, image_count, NULL, 0, 0, status,
        error_message, created_at, imported_at, last_seen_at
      FROM galleries_old;
      DROP TABLE galleries_old;
      CREATE INDEX IF NOT EXISTS idx_galleries_model ON galleries(model_id);
      CREATE INDEX IF NOT EXISTS idx_galleries_source_url ON galleries(source_url);
    `);
  });
  migrate();
  db.pragma('foreign_keys = ON');
}

function repairRenamedGalleryForeignKeys() {
  const brokenTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('gallery_favorites', 'image_favorites', 'image_seen', 'import_errors')
      AND sql LIKE '%galleries_old%'
  `).all().map(row => row.name);

  if (!brokenTables.length) return;

  db.pragma('foreign_keys = OFF');
  const repair = db.transaction(() => {
    if (brokenTables.includes('gallery_favorites')) {
      db.exec(`
        ALTER TABLE gallery_favorites RENAME TO gallery_favorites_old;
        CREATE TABLE gallery_favorites (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, gallery_id)
        );
        INSERT OR IGNORE INTO gallery_favorites (user_id, gallery_id, created_at)
        SELECT user_id, gallery_id, created_at
        FROM gallery_favorites_old
        WHERE EXISTS (SELECT 1 FROM galleries WHERE galleries.id = gallery_favorites_old.gallery_id);
        DROP TABLE gallery_favorites_old;
      `);
    }

    if (brokenTables.includes('image_favorites')) {
      db.exec(`
        ALTER TABLE image_favorites RENAME TO image_favorites_old;
        CREATE TABLE image_favorites (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
          image_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, gallery_id, image_name)
        );
        INSERT OR IGNORE INTO image_favorites (user_id, gallery_id, image_name, created_at)
        SELECT user_id, gallery_id, image_name, created_at
        FROM image_favorites_old
        WHERE EXISTS (SELECT 1 FROM galleries WHERE galleries.id = image_favorites_old.gallery_id);
        DROP TABLE image_favorites_old;
      `);
    }

    if (brokenTables.includes('image_seen')) {
      db.exec(`
        ALTER TABLE image_seen RENAME TO image_seen_old;
        CREATE TABLE image_seen (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
          image_name TEXT NOT NULL,
          seen_at TEXT NOT NULL,
          PRIMARY KEY (user_id, gallery_id, image_name)
        );
        INSERT OR IGNORE INTO image_seen (user_id, gallery_id, image_name, seen_at)
        SELECT user_id, gallery_id, image_name, seen_at
        FROM image_seen_old
        WHERE EXISTS (SELECT 1 FROM galleries WHERE galleries.id = image_seen_old.gallery_id);
        DROP TABLE image_seen_old;
      `);
    }

    if (brokenTables.includes('import_errors')) {
      db.exec(`
        ALTER TABLE import_errors RENAME TO import_errors_old;
        CREATE TABLE import_errors (
          id INTEGER PRIMARY KEY,
          model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
          gallery_id INTEGER REFERENCES galleries(id) ON DELETE SET NULL,
          model_url TEXT,
          gallery_url TEXT,
          title TEXT,
          folder TEXT,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO import_errors (
          id, model_id, gallery_id, model_url, gallery_url, title, folder, message, created_at
        )
        SELECT
          id,
          model_id,
          CASE
            WHEN gallery_id IS NULL THEN NULL
            WHEN EXISTS (SELECT 1 FROM galleries WHERE galleries.id = import_errors_old.gallery_id) THEN gallery_id
            ELSE NULL
          END,
          model_url, gallery_url, title, folder, message, created_at
        FROM import_errors_old;
        DROP TABLE import_errors_old;
      `);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gallery_favorites_user ON gallery_favorites(user_id);
      CREATE INDEX IF NOT EXISTS idx_image_favorites_user ON image_favorites(user_id);
      CREATE INDEX IF NOT EXISTS idx_image_seen_user ON image_seen(user_id);
      CREATE INDEX IF NOT EXISTS idx_image_seen_gallery ON image_seen(gallery_id);
    `);
  });
  repair();
  db.pragma('foreign_keys = ON');
}

function migrateGalleryStorageColumns() {
  const columns = db.prepare(`PRAGMA table_info(galleries)`).all().map(column => column.name);
  if (!columns.includes('cover_name')) {
    db.exec(`ALTER TABLE galleries ADD COLUMN cover_name TEXT;`);
  }
  if (!columns.includes('image_bytes')) {
    db.exec(`ALTER TABLE galleries ADD COLUMN image_bytes INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!columns.includes('thumb_bytes')) {
    db.exec(`ALTER TABLE galleries ADD COLUMN thumb_bytes INTEGER NOT NULL DEFAULT 0;`);
  }
}

function migrateUserPreferenceColumns() {
  const columns = db.prepare(`PRAGMA table_info(users)`).all().map(column => column.name);
  if (!columns.includes('preload_model')) {
    db.exec(`ALTER TABLE users ADD COLUMN preload_model INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!columns.includes('preload_gallery')) {
    db.exec(`ALTER TABLE users ADD COLUMN preload_gallery INTEGER NOT NULL DEFAULT 0;`);
  }
}

function backfillGalleryStorageColumns() {
  const pending = db.prepare(`
    SELECT EXISTS(
      SELECT 1
      FROM galleries
      WHERE status != 'failed'
        AND image_count > 0
        AND (
          cover_name IS NULL OR trim(cover_name) = ''
          OR (image_bytes = 0 AND thumb_bytes = 0)
        )
    ) AS needed
  `).get();
  if (!pending?.needed) return;

  const rows = db.prepare(`
    SELECT
      galleries.id,
      models.folder AS model_folder,
      galleries.folder AS gallery_folder,
      galleries.image_count,
      galleries.cover_name,
      galleries.image_bytes,
      galleries.thumb_bytes
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE galleries.status != 'failed'
      AND galleries.image_count > 0
  `).all();
  if (!rows.length) return;

  const update = db.prepare(`
    UPDATE galleries
    SET cover_name = COALESCE(?, cover_name),
        image_bytes = ?,
        thumb_bytes = ?
    WHERE id = ?
  `);
  const run = db.transaction(() => {
    for (const row of rows) {
      const hasBytes = Number(row.image_bytes || 0) > 0 || Number(row.thumb_bytes || 0) > 0;
      const hasCoverName = Boolean(String(row.cover_name || '').trim());
      if (hasBytes && hasCoverName) continue;
      const galleryPath = path.join(mediaRoot(), row.model_folder, row.gallery_folder);
      const stats = galleryStorageStats(galleryPath);
      const coverName = stats.imageNames[0] || null;
      update.run(
        coverName,
        Number(stats.imageBytes || 0),
        Number(stats.thumbBytes || 0),
        row.id
      );
    }
  });
  run();
}

function repairShiftedRecoveredGalleryRows() {
  const rows = db.prepare(`
    SELECT
      galleries.id,
      galleries.error_message,
      galleries.created_at,
      galleries.image_bytes,
      galleries.thumb_bytes,
      galleries.cover_name,
      models.folder AS model_folder,
      galleries.folder AS gallery_folder
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE galleries.imported_at = 'imported'
      AND galleries.error_message GLOB '[0-9]*'
      AND galleries.created_at GLOB '[0-9]*'
      AND galleries.image_bytes LIKE '%T%Z'
      AND galleries.thumb_bytes LIKE '%T%Z'
      AND galleries.cover_name LIKE '%T%Z'
  `).all();
  if (!rows.length) return;

  const update = db.prepare(`
    UPDATE galleries
    SET cover_name = ?,
        image_bytes = ?,
        thumb_bytes = ?,
        error_message = NULL,
        created_at = ?,
        imported_at = ?
    WHERE id = ?
  `);
  const repair = db.transaction(() => {
    for (const row of rows) {
      const galleryPath = path.join(mediaRoot(), row.model_folder, row.gallery_folder);
      const storage = galleryStorageStats(galleryPath);
      update.run(
        storage.imageNames[0] || null,
        Number(storage.imageBytes || row.error_message || 0),
        Number(storage.thumbBytes || row.created_at || 0),
        row.image_bytes,
        row.thumb_bytes,
        row.id
      );
    }
  });
  repair();
  console.log(`[db-migration] Repaired ${rows.length} shifted recovered gallery rows.`);
}

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withBusyRetry(work, attempts = 12, delayMs = 150) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return work();
    } catch (error) {
      lastError = error;
      if (error?.code !== 'SQLITE_BUSY' || attempt === attempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
  throw lastError;
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
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookie values instead of allowing request input to crash the server.
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

function currentUser(req) {
  if (req && Object.prototype.hasOwnProperty.call(req, '__currentUserLoaded')) {
    return req.__currentUser || null;
  }
  const token = parseCookies(req).sg_session;
  if (!token) {
    if (req) {
      req.__currentUserLoaded = true;
      req.__currentUser = null;
    }
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
    if (req) {
      req.__currentUserLoaded = true;
      req.__currentUser = null;
    }
    return null;
  }
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    try {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    } catch {
      // Expired session remains invalid even if cleanup is blocked briefly.
    }
    if (req) {
      req.__currentUserLoaded = true;
      req.__currentUser = null;
    }
    return null;
  }
  const user = {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    preloadModel: Boolean(row.preloadModel),
    preloadGallery: Boolean(row.preloadGallery),
  };
  if (req) {
    req.__currentUserLoaded = true;
    req.__currentUser = user;
  }
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
  const cookies = parseCookies(req);
  const existing = String(cookies.sg_visitor || '').trim();
  if (/^[a-zA-Z0-9_-]{16,80}$/.test(existing)) return { actorKey: `visitor:${existing}`, setCookie: null };
  const token = crypto.randomBytes(18).toString('base64url');
  return { actorKey: `visitor:${token}`, setCookie: visitorCookie(token) };
}

function appSetting(key, fallback = '') {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || fallback;
}

function setAppSetting(key, value) {
  withBusyRetry(() => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, nowIso()));
}

function writeVersionMirror(value) {
  const tempPath = `${VERSION_PATH}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, `${value}\n`, 'utf8');
    fs.renameSync(tempPath, VERSION_PATH);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

function setVersionLabel(value) {
  const previousFile = fs.readFileSync(VERSION_PATH, 'utf8');
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('version_label', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(value, nowIso());
    writeVersionMirror(value);
  });

  try {
    withBusyRetry(save);
  } catch (error) {
    try { fs.writeFileSync(VERSION_PATH, previousFile, 'utf8'); } catch {}
    throw error;
  }
}

function normalizedJsonSetting(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || '{}'));
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return JSON.stringify(parsed);
}

function normalizeAutoRescanTime(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return AUTO_RESCAN_DEFAULT_TIME;
  const hour = Math.max(0, Math.min(23, Number(match[1] || 0)));
  const minute = Math.max(0, Math.min(59, Number(match[2] || 0)));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function autoRescanEnabledSetting() {
  return appSetting('auto_rescan_enabled', '1') === '1';
}

function autoRescanTimeSetting() {
  return normalizeAutoRescanTime(appSetting('auto_rescan_time', AUTO_RESCAN_DEFAULT_TIME));
}

function nextAutoRescanDate(timeValue, from = new Date()) {
  const normalized = normalizeAutoRescanTime(timeValue);
  const [hourRaw, minuteRaw] = normalized.split(':');
  const hour = Number(hourRaw || 0);
  const minute = Number(minuteRaw || 0);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function scheduleAutoRescan(reason = 'settings') {
  if (autoRescanTimer) {
    clearTimeout(autoRescanTimer);
    autoRescanTimer = null;
  }
  if (IS_WORKER) return;
  if (!autoRescanEnabledSetting()) {
    nextAutoRescanAt = null;
    broadcast('state', stateNotice());
    return;
  }
  const next = nextAutoRescanDate(autoRescanTimeSetting());
  nextAutoRescanAt = next.toISOString();
  const delay = Math.max(1000, next.getTime() - Date.now());
  autoRescanTimer = setTimeout(() => runScheduledAutoRescan('daily'), delay);
  if (reason !== 'startup') {
    broadcast('state', stateNotice());
  }
}

function scheduleAutoRescanRetry() {
  if (autoRescanTimer) {
    clearTimeout(autoRescanTimer);
    autoRescanTimer = null;
  }
  if (IS_WORKER) return;
  const next = new Date(Date.now() + AUTO_RESCAN_RETRY_MS);
  nextAutoRescanAt = next.toISOString();
  autoRescanTimer = setTimeout(() => runScheduledAutoRescan('retry'), AUTO_RESCAN_RETRY_MS);
  broadcast('state', stateNotice());
}

async function runScheduledAutoRescan(trigger = 'daily') {
  autoRescanTimer = null;
  if (IS_WORKER || !autoRescanEnabledSetting()) {
    nextAutoRescanAt = null;
    return;
  }
  if (scanInFlight || importJob?.active) {
    console.warn(`[auto-rescan] ${trigger} run deferred because a scan/import is already active.`);
    scheduleAutoRescanRetry();
    return;
  }
  try {
    console.log(`[auto-rescan] Starting scheduled rescan all at ${new Date().toISOString()}.`);
    await requestWorker('rescan-all-start');
    scheduleAutoRescan('post-run');
  } catch (error) {
    console.error(`[auto-rescan] Scheduled rescan all failed: ${error?.message || error}`);
    scheduleAutoRescan('error');
  }
}

function localDateStamp(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function localTimestampStamp(date = new Date()) {
  return `${localDateStamp(date)}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
}

function nextDailyTimeDate(timeValue, from = new Date()) {
  const normalized = normalizeAutoRescanTime(timeValue || DB_BACKUP_DEFAULT_TIME);
  const [hourRaw, minuteRaw] = normalized.split(':');
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(Number(hourRaw || 0), Number(minuteRaw || 0), 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeStoredZip(zipPath, entryName, content) {
  const name = Buffer.from(entryName, 'utf8');
  const { time, day } = dosDateTime();
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  const centralOffset = local.length + name.length + content.length;
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([local, name, content, central, name, end]));
}

function pruneOldDbBackups() {
  let entries = [];
  try {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (DB_BACKUP_RETENTION_DAYS - 1));
    entries = fs.readdirSync(DB_BACKUP_DIR, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^gallery-db-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/.test(entry.name))
      .map(entry => {
        const match = entry.name.match(/^gallery-db-(\d{4})-(\d{2})-(\d{2})-\d{6}\.zip$/);
        const filePath = path.join(DB_BACKUP_DIR, entry.name);
        let stat = null;
        try { stat = fs.statSync(filePath); } catch {}
        const backupDate = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
        return stat ? { name: entry.name, path: filePath, backupDate } : null;
      })
      .filter(entry => entry?.backupDate && entry.backupDate < cutoff);
  } catch {
    return;
  }

  for (const entry of entries) {
    try {
      fs.unlinkSync(entry.path);
      console.log(`[db-backup] Deleted old backup ${entry.name}.`);
    } catch (error) {
      console.warn(`[db-backup] Failed to delete old backup ${entry.name}: ${error?.message || error}`);
    }
  }
}

function hasDbBackupForToday() {
  const today = localDateStamp();
  try {
    return fs.readdirSync(DB_BACKUP_DIR, { withFileTypes: true })
      .some(entry => entry.isFile() && entry.name.startsWith(`gallery-db-${today}-`) && entry.name.endsWith('.zip'));
  } catch {
    return false;
  }
}

async function createDbBackup(reason = 'scheduled') {
  if (IS_WORKER || dbBackupInFlight) return;
  dbBackupInFlight = true;
  mkdirp(DB_BACKUP_DIR);
  const stamp = localTimestampStamp();
  const tempDbPath = path.join(DB_BACKUP_DIR, `.gallery-db-${stamp}-${process.pid}.tmp`);
  const zipPath = path.join(DB_BACKUP_DIR, `gallery-db-${stamp}.zip`);
  try {
    await db.backup(tempDbPath);
    const content = fs.readFileSync(tempDbPath);
    writeStoredZip(zipPath, `gallery-${stamp}.db`, content);
    console.log(`[db-backup] Created ${path.basename(zipPath)} (${reason}).`);
    pruneOldDbBackups();
  } catch (error) {
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
    console.error(`[db-backup] Backup failed: ${error?.message || error}`);
  } finally {
    try { if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath); } catch {}
    dbBackupInFlight = false;
  }
}

function vacuumDatabase(reason = 'manual') {
  const beforeBytes = fileSize(DB_PATH);
  console.log(`[db-vacuum] Starting database vacuum (${reason}).`);
  db.exec('VACUUM');
  const afterBytes = fileSize(DB_PATH);
  const delta = afterBytes - beforeBytes;
  const deltaText = delta === 0 ? 'no size change' : `${delta > 0 ? '+' : ''}${delta} bytes`;
  console.log(`[db-vacuum] Finished database vacuum (${reason}): ${beforeBytes} -> ${afterBytes} bytes (${deltaText}).`);
  checkpointWal(reason);
}

function checkpointWal(reason = 'manual') {
  const walPath = `${DB_PATH}-wal`;
  const beforeBytes = fileSize(walPath);
  const result = db.pragma('wal_checkpoint(TRUNCATE)')?.[0] || {};
  const afterBytes = fileSize(walPath);
  console.log(
    `[db-wal] Checkpoint ${reason}: ${beforeBytes} -> ${afterBytes} bytes ` +
    `(busy=${result.busy ?? 0}, log=${result.log ?? 0}, checkpointed=${result.checkpointed ?? 0}).`
  );
}

function scheduleDbBackup(reason = 'startup') {
  if (dbBackupTimer) {
    clearTimeout(dbBackupTimer);
    dbBackupTimer = null;
  }
  if (IS_WORKER) return;

  if (reason === 'startup' && !hasDbBackupForToday()) {
    dbBackupTimer = setTimeout(async () => {
      dbBackupTimer = null;
      await createDbBackup('startup');
      scheduleDbBackup('post-run');
    }, 10000);
    return;
  }

  const next = nextDailyTimeDate(DB_BACKUP_DEFAULT_TIME);
  dbBackupTimer = setTimeout(async () => {
    dbBackupTimer = null;
    await createDbBackup('scheduled');
    scheduleDbBackup('post-run');
  }, Math.max(1000, next.getTime() - Date.now()));
}

function appMetadata(options = {}) {
  const lastRescanAll = lastRescanAllMetadata();
  const name = appSetting('app_name', 'Simple Gallery');
  const profile = seoProfile();
  const metadata = {
    ...emptyState().app,
    name,
    tagline: appSetting('app_tagline', ''),
    root: mediaUrlPrefix(),
    versionLabel: appSetting('version_label', DEFAULT_VERSION_LABEL),
    homeTitle: renderInstanceTemplate(profile.homeTitle, { appName: name }, '{appName} - Image Galleries'),
    autoRescanEnabled: appSetting('auto_rescan_enabled', '1') === '1',
    autoRescanTime: appSetting('auto_rescan_time', AUTO_RESCAN_DEFAULT_TIME),
    nextAutoRescanAt,
    ...lastRescanAll,
  };
  if (options.includePrivate) {
    Object.assign(metadata, {
      adminName: appSetting('admin_name', 'Gallery Admin'),
      lastSourceUrl: appSetting('last_source_url', ''),
      allModelsUrl: appSetting('all_models_url', ''),
      contentRoot: appSetting('content_root', ''),
      mediaUrlPrefix: appSetting('media_url_prefix', '/media'),
      sourceProfile: appSetting('source_profile', '{}'),
      seoProfile: appSetting('seo_profile', '{}'),
    });
  }
  return metadata;
}

function lastRescanAllMetadata() {
  const durationMs = Number(appSetting('last_rescan_all_duration_ms', '0'));
  return {
    lastRescanAllStartedAt: appSetting('last_rescan_all_started_at', ''),
    lastRescanAllFinishedAt: appSetting('last_rescan_all_finished_at', ''),
    lastRescanAllStatus: appSetting('last_rescan_all_status', ''),
    lastRescanAllDurationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
  };
}

function recordRescanAllStarted(startedAt) {
  setAppSetting('last_rescan_all_started_at', startedAt || nowIso());
  setAppSetting('last_rescan_all_finished_at', '');
  setAppSetting('last_rescan_all_status', 'running');
  setAppSetting('last_rescan_all_duration_ms', '0');
}

function recordRescanAllFinished(status) {
  if (!importJob || importJob.mode !== 'all') return;
  const startedAt = importJob.startedAt || nowIso();
  const finishedAt = importJob.finishedAt || nowIso();
  const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
  setAppSetting('last_rescan_all_started_at', startedAt);
  setAppSetting('last_rescan_all_finished_at', finishedAt);
  setAppSetting('last_rescan_all_status', status || importJob.status || '');
  setAppSetting('last_rescan_all_duration_ms', String(Number.isFinite(durationMs) ? durationMs : 0));
}

const RESCAN_ALL_CHECKPOINT_KEY = 'rescan_all_checkpoint_v1';

function loadRescanAllCheckpoint() {
  try {
    const value = JSON.parse(appSetting(RESCAN_ALL_CHECKPOINT_KEY, 'null'));
    return value && typeof value === 'object' && value.nextUrl ? value : null;
  } catch {
    return null;
  }
}

function saveRescanAllCheckpoint(checkpoint) {
  setAppSetting(RESCAN_ALL_CHECKPOINT_KEY, JSON.stringify({
    version: 1,
    nextUrl: String(checkpoint.nextUrl || ''),
    nextIndex: Math.max(0, Number(checkpoint.nextIndex || 0)),
    total: Math.max(0, Number(checkpoint.total || 0)),
    totals: checkpoint.totals || null,
    startedAt: checkpoint.startedAt || nowIso(),
    status: checkpoint.status || 'running',
    updatedAt: nowIso(),
  }));
}

function clearRescanAllCheckpoint() {
  withBusyRetry(() => db.prepare('DELETE FROM app_settings WHERE key = ?').run(RESCAN_ALL_CHECKPOINT_KEY));
}

function fallbackRescanAllCheckpoint() {
  const status = appSetting('last_rescan_all_status', '');
  if (status !== 'error' && status !== 'stopped' && status !== 'paused') return null;
  const startedAt = appSetting('last_rescan_all_started_at', '') || nowIso();
  const failed = db.prepare(`
    SELECT model_url AS modelUrl
    FROM import_errors
    WHERE model_url IS NOT NULL AND model_url != ''
    ORDER BY id DESC
    LIMIT 1
  `).get();
  if (failed?.modelUrl) {
    return {
      version: 1,
      nextUrl: failed.modelUrl,
      nextIndex: 0,
      total: 0,
      totals: null,
      startedAt,
      status,
      recovered: true,
    };
  }

  const payload = getScannedUrlPayload();
  const checkedByUrl = new Map(db.prepare(`
    SELECT model_urls.source_url AS sourceUrl, models.last_checked_at AS lastCheckedAt
    FROM model_urls
    JOIN models ON models.id = model_urls.model_id
  `).all().map(row => {
    try {
      return [canonicalRemoteUrl(row.sourceUrl), row.lastCheckedAt || ''];
    } catch {
      return [row.sourceUrl, row.lastCheckedAt || ''];
    }
  }));
  const startedAtMs = Date.parse(startedAt) || 0;
  const nextIndex = payload.urls.findIndex(sourceUrl => {
    let key = sourceUrl;
    try {
      key = canonicalRemoteUrl(sourceUrl);
    } catch {
      // Use the stored URL as-is.
    }
    const checkedAtMs = Date.parse(checkedByUrl.get(key) || '') || 0;
    return checkedAtMs < startedAtMs;
  });
  if (nextIndex < 0) return null;
  return {
    version: 1,
    nextUrl: payload.urls[nextIndex],
    nextIndex,
    total: payload.urls.length,
    totals: {
      models: payload.urls.length,
      modelsChecked: nextIndex,
    },
    startedAt,
    status,
    recovered: true,
  };
}

function resumableRescanAllCheckpoint() {
  const checkpoint = loadRescanAllCheckpoint();
  if (checkpoint) return checkpoint;
  const fallback = fallbackRescanAllCheckpoint();
  if (!fallback) return null;
  saveRescanAllCheckpoint(fallback);
  return loadRescanAllCheckpoint();
}

function upsertModelRecord(modelFolder, modelName, sourceUrl = '', options = {}) {
  return withBusyRetry(() => {
    const touchUpdatedAt = options.touchUpdatedAt !== false;
    const now = nowIso();
    db.prepare(`
      INSERT INTO models (name, folder, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(folder) DO UPDATE SET
        name = excluded.name,
        updated_at = CASE
          WHEN ? THEN excluded.updated_at
          ELSE models.updated_at
        END
    `).run(modelName || normalizeModelName(modelFolder), modelFolder, now, now, touchUpdatedAt ? 1 : 0);
    const model = db.prepare('SELECT id FROM models WHERE folder = ?').get(modelFolder);
    if (sourceUrl) {
      db.prepare(`
        INSERT INTO model_urls (model_id, source_url, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(source_url) DO UPDATE SET model_id = excluded.model_id
      `).run(model.id, canonicalRemoteUrl(sourceUrl), now);
    }
    return model.id;
  });
}

function upsertGalleryRecord(modelFolder, modelName, galleryName, gallery = {}) {
  return withBusyRetry(() => {
    const modelId = upsertModelRecord(
      modelFolder,
      modelName || normalizeModelName(modelFolder),
      '',
      { touchUpdatedAt: gallery.touchModelUpdatedAt !== false }
    );
    const now = nowIso();
    const sourceUrl = gallery.sourceUrl ? canonicalRemoteUrl(gallery.sourceUrl) : null;
    const lastSeenAt = gallery.lastSeenAt || gallery.updatedAt || now;
    const coverName = gallery.coverName == null ? null : String(gallery.coverName || '').trim() || null;
    const imageBytes = gallery.imageBytes == null ? null : Number(gallery.imageBytes || 0);
    const thumbBytes = gallery.thumbBytes == null ? null : Number(gallery.thumbBytes || 0);
    db.prepare(`
      INSERT INTO galleries (
        model_id, source_url, title, folder, image_count, cover_name, image_bytes, thumb_bytes, status, created_at, imported_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 0), COALESCE(?, 0), ?, ?, ?, ?)
      ON CONFLICT(model_id, folder) DO UPDATE SET
        source_url = COALESCE(excluded.source_url, galleries.source_url),
        title = excluded.title,
        image_count = excluded.image_count,
        cover_name = COALESCE(excluded.cover_name, galleries.cover_name),
        image_bytes = COALESCE(?, galleries.image_bytes),
        thumb_bytes = COALESCE(?, galleries.thumb_bytes),
        status = excluded.status,
        imported_at = COALESCE(galleries.imported_at, excluded.imported_at),
        last_seen_at = excluded.last_seen_at
    `).run(
      modelId,
      sourceUrl,
      gallery.title || `Gallery ${galleryName}`,
      galleryName,
      Number(gallery.imageCount || gallery.count || 0),
      coverName,
      imageBytes,
      thumbBytes,
      gallery.status || 'imported',
      now,
      gallery.importedAt || now,
      lastSeenAt,
      imageBytes,
      thumbBytes
    );
    const row = db.prepare('SELECT id FROM galleries WHERE model_id = ? AND folder = ?').get(modelId, galleryName);
    return row?.id || null;
  });
}

function galleryDbId(modelName, galleryName) {
  return db.prepare(`
    SELECT galleries.id
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE models.folder = ? AND galleries.folder = ?
  `).get(modelName, galleryName)?.id || null;
}

function galleryDbRecord(modelName, galleryName) {
  return db.prepare(`
    SELECT galleries.*
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE models.folder = ? AND galleries.folder = ?
  `).get(modelName, galleryName) || null;
}

function galleryRecordsForModel(modelName) {
  const rows = db.prepare(`
    SELECT galleries.*
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE models.folder = ?
  `).all(modelName);
  return new Map(rows.map(row => [row.folder, row]));
}

function sourceSlug(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || null;
  } catch {
    return null;
  }
}

function favoriteSetsForUser(userId) {
  if (!userId) return { models: new Set(), galleries: new Set(), images: new Set() };
  return {
    models: new Set(db.prepare('SELECT model_id FROM model_favorites WHERE user_id = ?').all(userId).map(row => row.model_id)),
    galleries: new Set(db.prepare('SELECT gallery_id FROM gallery_favorites WHERE user_id = ?').all(userId).map(row => row.gallery_id)),
    images: new Set(db.prepare('SELECT gallery_id, image_name FROM image_favorites WHERE user_id = ?').all(userId).map(row => `${row.gallery_id}\n${row.image_name}`)),
  };
}

function seenDataForUser(userId) {
  if (!userId) return { images: new Set(), galleryCounts: new Map() };
  const rows = db.prepare('SELECT gallery_id, COUNT(*) AS count FROM image_seen WHERE user_id = ? GROUP BY gallery_id').all(userId);
  const galleryCounts = new Map();
  for (const row of rows) {
    galleryCounts.set(row.gallery_id, Number(row.count || 0));
  }
  return { images: new Set(), galleryCounts };
}

function unseenStatsForUser(userId) {
  if (!userId) return null;
  const seenData = seenDataForUser(userId);
  const unseen = { models: 0, galleries: 0, images: 0 };
  for (const model of lastState.models || []) {
    let modelSeenCount = 0;
    for (const gallery of model.galleries || []) {
      const summary = gallerySeenSummary(gallery, seenData);
      modelSeenCount += summary.seenCount;
      if (!summary.seen) unseen.galleries += 1;
      unseen.images += Math.max(0, Number(gallery.count || 0) - summary.seenCount);
    }
    if (!(Number(model.count || 0) > 0 && modelSeenCount >= Number(model.count || 0))) {
      unseen.models += 1;
    }
  }
  return unseen;
}

function seenImagesForGallery(userId, galleryId) {
  if (!userId || !galleryId) return new Set();
  return new Set(
    db.prepare('SELECT image_name FROM image_seen WHERE user_id = ? AND gallery_id = ?')
      .all(userId, galleryId)
      .map(row => row.image_name)
  );
}

function gallerySeenSummary(gallery, seenData) {
  const count = Number(gallery.count || 0);
  const seenCount = gallery.dbId ? Math.min(Number(seenData.galleryCounts.get(gallery.dbId) || 0), count) : 0;
  return {
    seenCount,
    seen: count > 0 && seenCount >= count,
  };
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
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, hashToken(token), createdAt, expiresAt, createdAt);
  return { token, expiresAt };
}

function getGalleryById(id) {
  return db.prepare('SELECT id FROM galleries WHERE id = ?').get(Number(id || 0));
}

function galleryRecordById(id) {
  return db.prepare(`
    SELECT
      galleries.id,
      galleries.folder AS galleryFolder,
      models.folder AS modelFolder
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE galleries.id = ?
  `).get(Number(id || 0)) || null;
}

function seenSummaryForGallery(userId, galleryId, total = null) {
  const count = total == null
    ? db.prepare('SELECT image_count AS count FROM galleries WHERE id = ?').get(galleryId)?.count || 0
    : Number(total || 0);
  const seenCount = db.prepare('SELECT COUNT(*) AS count FROM image_seen WHERE user_id = ? AND gallery_id = ?').get(userId, galleryId)?.count || 0;
  return {
    seen: count > 0 && seenCount >= count,
    seenCount: Math.min(Number(seenCount || 0), Number(count || 0)),
    count: Number(count || 0),
  };
}

function cleanupSeenRecordsForGallery(galleryId, imageNames) {
  if (!galleryId) return;
  if (!imageNames.length) {
    db.prepare('DELETE FROM image_seen WHERE gallery_id = ?').run(galleryId);
    return;
  }
  const keep = new Set(imageNames);
  const rows = db.prepare('SELECT user_id, image_name FROM image_seen WHERE gallery_id = ?').all(galleryId);
  const remove = db.prepare('DELETE FROM image_seen WHERE gallery_id = ? AND user_id = ? AND image_name = ?');
  const cleanup = db.transaction(() => {
    for (const row of rows) {
      if (!keep.has(row.image_name)) remove.run(galleryId, row.user_id, row.image_name);
    }
  });
  cleanup();
}

function cleanupDatabaseHousekeeping(reason = 'scheduled') {
  const cutoff = new Date(Date.now() - VIEW_DEDUPE_RETENTION_MS).toISOString();
  const dedupe = db.prepare('DELETE FROM view_dedupe WHERE last_counted_at < ?').run(cutoff).changes;
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()).changes;
  if (dedupe || sessions || reason === 'startup') {
    console.log(`[db-cleanup] ${reason}: removed ${dedupe} old view dedupe rows, ${sessions} expired sessions.`);
  }
}

function scheduleDatabaseHousekeeping() {
  if (IS_WORKER) return;
  if (dbHousekeepingTimer) clearTimeout(dbHousekeepingTimer);
  dbHousekeepingTimer = setTimeout(() => {
    dbHousekeepingTimer = null;
    try {
      cleanupDatabaseHousekeeping('scheduled');
    } catch (error) {
      console.error(`[db-cleanup] Scheduled cleanup failed: ${error?.message || error}`);
    }
    scheduleDatabaseHousekeeping();
  }, 60 * 60 * 1000);
}

function shouldCountView(actorKey, targetType, targetKey) {
  const now = Date.now();
  const nowValue = new Date(now).toISOString();
  const row = db.prepare(`
    SELECT last_counted_at AS lastCountedAt
    FROM view_dedupe
    WHERE actor_key = ? AND target_type = ? AND target_key = ?
  `).get(actorKey, targetType, targetKey);
  if (row && now - Date.parse(row.lastCountedAt) < VIEW_DEDUPE_MS) return false;
  db.prepare(`
    INSERT INTO view_dedupe (actor_key, target_type, target_key, last_counted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(actor_key, target_type, target_key) DO UPDATE SET
      last_counted_at = excluded.last_counted_at
  `).run(actorKey, targetType, targetKey, nowValue);
  return true;
}

function incrementModelView(modelId) {
  const viewedAt = nowIso();
  db.prepare(`
    INSERT INTO model_view_totals (model_id, view_count, first_viewed_at, last_viewed_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(model_id) DO UPDATE SET
      view_count = view_count + 1,
      last_viewed_at = excluded.last_viewed_at
  `).run(modelId, viewedAt, viewedAt);
}

function incrementGalleryView(galleryId) {
  const viewedAt = nowIso();
  db.prepare(`
    INSERT INTO gallery_view_totals (gallery_id, view_count, first_viewed_at, last_viewed_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(gallery_id) DO UPDATE SET
      view_count = view_count + 1,
      last_viewed_at = excluded.last_viewed_at
  `).run(galleryId, viewedAt, viewedAt);
}

function incrementImageView(galleryId, imageName) {
  const viewedAt = nowIso();
  db.prepare(`
    INSERT INTO image_view_totals (gallery_id, image_name, view_count, first_viewed_at, last_viewed_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(gallery_id, image_name) DO UPDATE SET
      view_count = view_count + 1,
      last_viewed_at = excluded.last_viewed_at
  `).run(galleryId, imageName, viewedAt, viewedAt);
}

function recordView(req, payload) {
  const type = String(payload.type || '').trim();
  const { actorKey, setCookie } = actorKeyForRequest(req);
  let counted = false;

  if (type === 'model') {
    const modelFolder = String(payload.modelId || '').trim();
    const model = db.prepare('SELECT id FROM models WHERE folder = ?').get(modelFolder);
    if (!model) throw new Error('Model not found.');
    const targetKey = `model:${model.id}`;
    counted = shouldCountView(actorKey, 'model', targetKey);
    if (counted) incrementModelView(model.id);
  } else if (type === 'gallery') {
    const galleryId = Number(payload.galleryDbId || payload.galleryId || 0);
    if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
    const targetKey = `gallery:${galleryId}`;
    counted = shouldCountView(actorKey, 'gallery', targetKey);
    if (counted) incrementGalleryView(galleryId);
  } else if (type === 'image') {
    const galleryId = Number(payload.galleryDbId || payload.galleryId || 0);
    const imageName = String(payload.imageName || '').trim();
    if (!getGalleryById(galleryId)) throw new Error('Gallery not found.');
    if (!imageName) throw new Error('Missing image.');
    const targetKey = `image:${galleryId}:${imageName}`;
    counted = shouldCountView(actorKey, 'image', targetKey);
    if (counted) incrementImageView(galleryId, imageName);
  } else {
    throw new Error('Unsupported view type.');
  }

  if (counted) scheduleViewStatsBroadcast();
  return { ok: true, counted, setCookie };
}

console.log('[startup] Initializing database schema...');
initDatabase();
console.log('[startup] Loading traffic counters...');
loadTrafficCounters();
console.log('[startup] Running database migrations...');
migrateGallerySourceUrlUniqueness();
migrateUserPreferenceColumns();
migrateGalleryStorageColumns();
repairRenamedGalleryForeignKeys();
repairShiftedRecoveredGalleryRows();
if (!IS_WORKER) {
  console.log('[startup] Checking cached gallery storage metadata...');
  backfillGalleryStorageColumns();
}
console.log('[startup] Database initialization complete.');

function loadImportErrors() {
  const errors = db.prepare(`
    SELECT
      import_errors.id AS id,
      import_errors.created_at AS at,
      models.name AS modelName,
      models.folder AS modelFolder,
      import_errors.model_url AS modelUrl,
      import_errors.folder AS gallery,
      import_errors.title AS title,
      import_errors.gallery_url AS sourceUrl,
      import_errors.message AS message
    FROM import_errors
    LEFT JOIN models ON models.id = import_errors.model_id
    ORDER BY import_errors.id ASC
    LIMIT 500
  `).all();
  return {
    version: 1,
    updatedAt: errors.at(-1)?.at || null,
    errors: errors.map(error => ({
      id: error.id,
      at: error.at,
      mode: '',
      modelName: error.modelName || '',
      modelFolder: error.modelFolder || '',
      modelUrl: error.modelUrl || '',
      gallery: error.gallery || '',
      title: error.title || '',
      sourceUrl: error.sourceUrl || '',
      message: error.message || 'Import error',
    })),
  };
}

function saveImportErrors(payload) {
  broadcast('import-errors', payload);
}

function clearImportErrors() {
  db.prepare('DELETE FROM import_errors').run();
  saveImportErrors({ version: 1, updatedAt: new Date().toISOString(), errors: [] });
}

function dismissImportError(id) {
  db.prepare('DELETE FROM import_errors WHERE id = ?').run(Number(id || 0));
  const payload = loadImportErrors();
  saveImportErrors(payload);
  return payload;
}

function recordImportError(details) {
  const modelFolder = String(details.modelFolder || importJob?.modelFolder || '').trim();
  const modelName = String(details.modelName || importJob?.modelName || (modelFolder ? normalizeModelName(modelFolder) : '')).trim();
  const modelUrl = String(details.modelUrl || importJob?.currentModelUrl || importJob?.sourceUrl || '').trim();
  const gallery = String(details.gallery || '').trim();
  const sourceUrl = String(details.sourceUrl || '').trim();
  const title = String(details.title || '').trim();
  const message = String(details.message || 'Import error').trim() || 'Import error';

  const modelId = modelFolder
    ? upsertModelRecord(modelFolder, modelName || normalizeModelName(modelFolder), modelUrl, { touchUpdatedAt: false })
    : null;
  const galleryId = modelId && gallery
    ? galleryDbId(modelFolder, gallery)
    : null;
  db.prepare(`
    INSERT INTO import_errors (model_id, gallery_id, model_url, gallery_url, title, folder, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    modelId,
    galleryId,
    modelUrl,
    sourceUrl,
    title,
    gallery,
    message,
    nowIso()
  );

  saveImportErrors(loadImportErrors());
}

function emptyImportDb() {
  return { version: 1, scannedUrls: [], models: {} };
}

function loadImportDb() {
  const payload = emptyImportDb();
  const modelRows = db.prepare('SELECT * FROM models ORDER BY folder').all();
  const urlRows = db.prepare(`
    SELECT model_urls.*, models.folder AS model_folder
    FROM model_urls
    JOIN models ON models.id = model_urls.model_id
    WHERE model_urls.source_url NOT IN (SELECT source_url FROM ignored_model_urls)
  `).all();
  const galleryRows = db.prepare(`
    SELECT galleries.*, models.folder AS model_folder, models.name AS model_name
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE galleries.status != 'failed'
    ORDER BY models.folder, galleries.folder
  `).all();

  for (const row of modelRows) {
    payload.models[row.folder] = {
      modelName: row.name,
      modelFolder: row.folder,
      modelUrls: [],
      galleries: {},
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  }

  for (const row of urlRows) {
    if (!payload.scannedUrls.includes(row.source_url)) payload.scannedUrls.push(row.source_url);
    if (payload.models[row.model_folder] && !payload.models[row.model_folder].modelUrls.includes(row.source_url)) {
      payload.models[row.model_folder].modelUrls.push(row.source_url);
    }
  }

  for (const row of galleryRows) {
    const record = payload.models[row.model_folder];
    if (!record) continue;
    const key = row.source_url || `local:${row.folder}`;
    record.galleries[key] = {
      sourceUrl: row.source_url || '',
      title: row.title || '',
      folder: row.folder,
      imageCount: row.image_count || 0,
      firstSeenAt: row.created_at,
      importedAt: row.imported_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  payload.scannedUrls.sort((a, b) => a.localeCompare(b));
  return payload;
}

function saveImportDb(importDb) {
  const run = db.transaction(() => {
    for (const [modelFolder, record] of Object.entries(importDb.models || {})) {
      const modelId = upsertModelRecord(
        modelFolder,
        record.modelName || normalizeModelName(modelFolder),
        record.modelUrls?.[0] || '',
        { touchUpdatedAt: false }
      );
      if (record.lastCheckedAt) {
        db.prepare('UPDATE models SET last_checked_at = ? WHERE id = ?').run(record.lastCheckedAt, modelId);
      }
      for (const modelUrl of record.modelUrls || []) {
        try {
          db.prepare(`
            INSERT INTO model_urls (model_id, source_url, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(source_url) DO UPDATE SET model_id = excluded.model_id
          `).run(modelId, canonicalRemoteUrl(modelUrl), nowIso());
        } catch {
          // Ignore malformed values.
        }
      }

      const desired = new Set();
      for (const gallery of Object.values(record.galleries || {})) {
        if (!gallery.folder) continue;
        const galleryId = upsertGalleryRecord(modelFolder, record.modelName || normalizeModelName(modelFolder), gallery.folder, {
          sourceUrl: gallery.sourceUrl || null,
          title: gallery.title || `Gallery ${gallery.folder}`,
          imageCount: gallery.imageCount || 0,
          importedAt: gallery.importedAt,
          lastSeenAt: gallery.lastSeenAt,
          touchModelUpdatedAt: false,
          status: 'imported',
        });
        if (galleryId) desired.add(galleryId);
      }

      if (desired.size) {
        const existing = db.prepare('SELECT id FROM galleries WHERE model_id = ?').all(modelId);
        const deleteGallery = db.prepare('DELETE FROM galleries WHERE id = ?');
        for (const row of existing) {
          if (!desired.has(row.id)) deleteGallery.run(row.id);
        }
      }
    }
  });
  run();
  const payload = syncScannedUrlsFile();
  scheduleScannedUrlsBroadcast(payload);
}

function syncScannedUrlsFile() {
  const urls = db.prepare(`
    SELECT model_urls.source_url
    FROM model_urls
    LEFT JOIN ignored_model_urls ON ignored_model_urls.source_url = model_urls.source_url
    WHERE ignored_model_urls.source_url IS NULL
    ORDER BY model_urls.source_url
  `).all().map(row => row.source_url);
  const total = db.prepare('SELECT COUNT(*) AS count FROM model_urls').get()?.count || 0;
  const ignored = db.prepare('SELECT COUNT(*) AS count FROM ignored_model_urls').get()?.count || 0;
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    total,
    ignored,
    active: urls.length,
    urls,
  };
  return payload;
}

function ignoreModelUrl(sourceUrl, reason = 'Ignored from URL audit.') {
  const canonical = canonicalRemoteUrl(sourceUrl);
  db.prepare(`
    INSERT INTO ignored_model_urls (source_url, reason, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      reason = excluded.reason
  `).run(canonical, String(reason || '').trim() || 'Ignored from URL audit.', nowIso());
  return { sourceUrl: canonical, reason };
}

function unignoreModelUrl(sourceUrl) {
  const canonical = canonicalRemoteUrl(sourceUrl);
  db.prepare('DELETE FROM ignored_model_urls WHERE source_url = ?').run(canonical);
  return { sourceUrl: canonical };
}

function ignoredModelUrlsResponse() {
  const rows = db.prepare(`
    SELECT source_url AS sourceUrl, reason, created_at AS createdAt
    FROM ignored_model_urls
    ORDER BY created_at DESC, source_url
  `).all();
  return {
    ignoredCount: rows.length,
    ignored: rows.map(row => ({
      sourceUrl: row.sourceUrl,
      reason: row.reason || '',
      createdAt: row.createdAt,
    })),
  };
}

function modelFolderFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0]?.toLowerCase() !== 'model' || !parts[1]) return '';
    return sanitizeFolderName(normalizeModelName(decodeURIComponent(parts[1])));
  } catch {
    return '';
  }
}

function auditSavedModelUrls() {
  const rows = db.prepare(`
    SELECT
      model_urls.source_url AS sourceUrl,
      models.id AS modelDbId,
      models.name AS modelName,
      models.folder AS modelFolder,
      COUNT(galleries.id) AS dbGalleryCount,
      COALESCE(SUM(galleries.image_count), 0) AS dbImageCount
    FROM model_urls
    LEFT JOIN models ON models.id = model_urls.model_id
    LEFT JOIN galleries ON galleries.model_id = models.id AND galleries.status != 'failed'
    LEFT JOIN ignored_model_urls ON ignored_model_urls.source_url = model_urls.source_url
    WHERE ignored_model_urls.source_url IS NULL
    GROUP BY model_urls.id
    ORDER BY model_urls.source_url
  `).all();
  const visibleModelIds = new Set((lastState.models || []).map(model => model.id));
  const localFolders = new Set(readDirs(mediaRoot()));
  const unmatched = [];

  for (const row of rows) {
    const expectedFolder = row.modelFolder || modelFolderFromUrl(row.sourceUrl);
    const localFolderExists = expectedFolder ? localFolders.has(expectedFolder) : false;
    const visible = expectedFolder ? visibleModelIds.has(expectedFolder) : false;
    const dbGalleryCount = Number(row.dbGalleryCount || 0);
    const dbImageCount = Number(row.dbImageCount || 0);
    let reason = '';

    if (!row.modelDbId) reason = 'URL is saved but has no model database row.';
    else if (!expectedFolder) reason = 'URL does not look like a model URL.';
    else if (!localFolderExists) reason = 'No matching local model folder.';
    else if (!dbGalleryCount || !dbImageCount) reason = 'Model exists but has no imported image galleries.';
    else if (!visible) reason = 'Model has database galleries but is not visible in the current gallery state.';

    if (!reason) continue;
    unmatched.push({
      sourceUrl: row.sourceUrl,
      modelName: row.modelName || normalizeModelName(expectedFolder),
      expectedFolder,
      dbGalleryCount,
      dbImageCount,
      localFolderExists,
      visible,
      reason,
    });
  }

  return {
    savedModelUrls: rows.length,
    visibleModels: visibleModelIds.size,
    unmatchedCount: unmatched.length,
    ignoredCount: db.prepare('SELECT COUNT(*) AS count FROM ignored_model_urls').get()?.count || 0,
    unmatched,
  };
}

function viewStatsResponse() {
  const limit = 100;
  const countries = runtimeStats().remoteCountryTraffic || [];
  const totals = {
    modelViews: db.prepare('SELECT COALESCE(SUM(view_count), 0) AS count FROM model_view_totals').get()?.count || 0,
    galleryViews: db.prepare('SELECT COALESCE(SUM(view_count), 0) AS count FROM gallery_view_totals').get()?.count || 0,
    imageViews: db.prepare('SELECT COALESCE(SUM(view_count), 0) AS count FROM image_view_totals').get()?.count || 0,
  };
  const models = db.prepare(`
    SELECT
      models.name,
      models.folder,
      model_view_totals.view_count AS views,
      model_view_totals.last_viewed_at AS lastViewedAt
    FROM model_view_totals
    JOIN models ON models.id = model_view_totals.model_id
    ORDER BY model_view_totals.view_count DESC, model_view_totals.last_viewed_at DESC
    LIMIT ?
  `).all(limit);
  const galleries = db.prepare(`
    SELECT
      models.name AS modelName,
      models.folder AS modelFolder,
      galleries.folder AS gallery,
      galleries.title,
      gallery_view_totals.view_count AS views,
      gallery_view_totals.last_viewed_at AS lastViewedAt
    FROM gallery_view_totals
    JOIN galleries ON galleries.id = gallery_view_totals.gallery_id
    JOIN models ON models.id = galleries.model_id
    ORDER BY gallery_view_totals.view_count DESC, gallery_view_totals.last_viewed_at DESC
    LIMIT ?
  `).all(limit);
  const images = db.prepare(`
    SELECT
      models.name AS modelName,
      models.folder AS modelFolder,
      galleries.folder AS gallery,
      image_view_totals.image_name AS imageName,
      image_view_totals.view_count AS views,
      image_view_totals.last_viewed_at AS lastViewedAt
    FROM image_view_totals
    JOIN galleries ON galleries.id = image_view_totals.gallery_id
    JOIN models ON models.id = galleries.model_id
    ORDER BY image_view_totals.view_count DESC, image_view_totals.last_viewed_at DESC
    LIMIT ?
  `).all(limit);
  return { totals, models, galleries, images, countries };
}

function adminUsersResponse() {
  const rows = db.prepare(`
    SELECT
      users.id,
      users.username,
      users.display_name AS displayName,
      users.created_at AS createdAt,
      users.last_login_at AS lastLoginAt,
      users.disabled_at AS disabledAt,
      COUNT(CASE WHEN sessions.expires_at > ? THEN 1 END) AS activeSessions
    FROM users
    LEFT JOIN sessions ON sessions.user_id = users.id
    GROUP BY users.id
    ORDER BY users.disabled_at IS NOT NULL, users.last_login_at DESC, users.created_at DESC, users.username
  `).all(nowIso());
  return {
    users: rows.map(row => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
      disabledAt: row.disabledAt,
      activeSessions: Number(row.activeSessions || 0),
    })),
  };
}

function getImportModelRecord(db, modelFolder, modelName, sourceUrl) {
  if (!db.models[modelFolder]) {
    db.models[modelFolder] = {
      modelName,
      modelFolder,
      modelUrls: [],
      galleries: {},
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
    };
  }
  const record = db.models[modelFolder];
  record.modelName = modelName;
  record.modelFolder = modelFolder;
  const canonicalModelUrl = canonicalRemoteUrl(sourceUrl);
    if (!db.scannedUrls.includes(canonicalModelUrl)) db.scannedUrls.push(canonicalModelUrl);
  if (!record.modelUrls.includes(canonicalModelUrl)) record.modelUrls.push(canonicalModelUrl);
  if (!record.galleries || typeof record.galleries !== 'object') record.galleries = {};
  upsertModelRecord(modelFolder, modelName, canonicalModelUrl, { touchUpdatedAt: false });
  return record;
}

function rememberImportedGallery(record, gallery, galleryName, imageCount = 0, options = {}) {
  const sourceUrl = canonicalRemoteUrl(gallery.sourceUrl);
  const existing = record.galleries[sourceUrl] || {};
  const preserveTimestamps = Boolean(options.preserveTimestamps);
  const now = new Date().toISOString();
  const firstSeenAt = existing.firstSeenAt || options.firstSeenAt || now;
  const importedAt = preserveTimestamps
    ? (existing.importedAt || options.importedAt || firstSeenAt)
    : (options.importedAt || existing.importedAt || now);
  const lastSeenAt = preserveTimestamps
    ? (existing.lastSeenAt || options.lastSeenAt || importedAt)
    : (options.lastSeenAt || now);
  record.galleries[sourceUrl] = {
    sourceUrl,
    title: gallery.title || existing.title || '',
    folder: galleryName || existing.folder || '',
    imageCount: Number(imageCount || existing.imageCount || 0),
    firstSeenAt,
    importedAt,
    lastSeenAt,
  };
  upsertGalleryRecord(record.modelFolder, record.modelName, galleryName || existing.folder || '', {
    sourceUrl,
    title: gallery.title || existing.title || '',
    imageCount,
    importedAt,
    lastSeenAt,
    touchModelUpdatedAt: !preserveTimestamps,
    status: 'imported',
  });
}

function hydrateImportRecordFromManifests(record, modelPath) {
  const existingFolders = new Set(readDirs(modelPath));
  for (const [sourceUrl, gallery] of Object.entries(record.galleries || {})) {
    const galleryName = String(gallery.folder || '');
    if (!galleryName || !existingFolders.has(galleryName)) {
      delete record.galleries[sourceUrl];
      continue;
    }
  }

  const rows = db.prepare(`
    SELECT galleries.*
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE models.folder = ?
  `).all(record.modelFolder);
  for (const row of rows) {
    if (!row.source_url || !existingFolders.has(row.folder)) continue;
    rememberImportedGallery(record, {
      sourceUrl: row.source_url,
      title: row.title || row.folder,
    }, row.folder, readImageFiles(path.join(modelPath, row.folder)).length, {
      preserveTimestamps: true,
      firstSeenAt: row.created_at,
      importedAt: row.imported_at,
      lastSeenAt: row.last_seen_at,
    });
  }
}

function nextGalleryName(modelPath) {
  const existing = new Set(readDirs(modelPath));
  for (let index = 1; index < 10000; index += 1) {
    const name = String(index).padStart(3, '0');
    if (!existing.has(name)) return name;
  }
  throw new Error('No available gallery folder number.');
}

function findExistingGalleryForSource(modelPath, sourceUrl) {
  const canonicalSourceUrl = canonicalRemoteUrl(sourceUrl);
  const modelFolder = path.basename(modelPath);
  const row = db.prepare(`
    SELECT galleries.folder
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE models.folder = ? AND galleries.source_url = ?
  `).get(modelFolder, canonicalSourceUrl);
  return row?.folder && fs.existsSync(path.join(modelPath, row.folder)) ? row.folder : null;
}

function repairGallerySequence(modelFolder, modelPath, importDb) {
  const numericNames = readDirs(modelPath)
    .filter(name => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
  const galleryNames = numericNames
    .filter(name => readImageFiles(path.join(modelPath, name)).length > 0);
  const staleNames = numericNames.filter(name => !galleryNames.includes(name));
  const moves = [];
  let changed = false;

  for (const galleryName of staleNames) {
    fs.rmSync(path.join(modelPath, galleryName), { recursive: true, force: true });
    changed = true;
  }

  for (let index = 0; index < galleryNames.length; index += 1) {
    const from = galleryNames[index];
    const to = String(index + 1).padStart(3, '0');
    if (from !== to) moves.push({ from, to });
  }

  const record = importDb.models?.[modelFolder];

  if (!moves.length) return changed;

  const tempRoot = path.join(modelPath, `.sequence-repair-${process.pid}-${Date.now()}`);
  mkdirp(tempRoot);

  try {
    for (const galleryName of galleryNames) {
      fs.renameSync(path.join(modelPath, galleryName), path.join(tempRoot, galleryName));
    }
    for (let index = 0; index < galleryNames.length; index += 1) {
      const from = galleryNames[index];
      const to = String(index + 1).padStart(3, '0');
      fs.renameSync(path.join(tempRoot, from), path.join(modelPath, to));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    try {
      for (const galleryName of readDirs(tempRoot)) {
        const target = path.join(modelPath, galleryName);
        if (!fs.existsSync(target)) fs.renameSync(path.join(tempRoot, galleryName), target);
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Keep the original repair error.
    }
    throw error;
  }

  if (record?.galleries) {
    const folderMap = new Map(moves.map(move => [move.from, move.to]));
    for (const gallery of Object.values(record.galleries)) {
      const folder = String(gallery.folder || '').padStart(3, '0');
      if (folderMap.has(folder)) gallery.folder = folderMap.get(folder);
    }
  }

  if (record?.galleries) {
    const currentGalleryNames = readDirs(modelPath)
      .filter(name => /^\d+$/.test(name))
      .filter(name => readImageFiles(path.join(modelPath, name)).length > 0);
    const currentFolders = new Set(currentGalleryNames);

    for (const [sourceUrl, gallery] of Object.entries(record.galleries)) {
      const folder = String(gallery.folder || '').padStart(3, '0');
      if (!currentFolders.has(folder)) {
        delete record.galleries[sourceUrl];
        changed = true;
      }
    }
  }

  return true;
}

function inferGalleryKey(gallery) {
  const manifestUrl = gallery.sourceUrl || '';
  if (manifestUrl) {
    try {
      return `source:${canonicalRemoteUrl(manifestUrl)}`;
    } catch {
      // Fall through to filename inference.
    }
  }
  const names = (gallery.images || [])
    .map(image => image.name.replace(/^\d+\W*/, '').replace(/\.[^.]+$/, ''))
    .filter(Boolean);
  if (!names.length) return `folder:${gallery.id}`;
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return `slug:${Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0]}`;
}

function dedupeScannedGalleries(galleries) {
  const bestByKey = new Map();
  for (const gallery of galleries) {
    const keys = [inferGalleryKey(gallery)];
    if (gallery.sourceSlug) keys.push(`slug:${gallery.sourceSlug}`);

    let duplicateOf = null;
    for (const key of keys) {
      if (bestByKey.has(key)) {
        duplicateOf = bestByKey.get(key);
        break;
      }
    }

    if (!duplicateOf) {
      for (const key of keys) bestByKey.set(key, gallery);
      continue;
    }

    const duplicateScore = Number(Boolean(duplicateOf.sourceUrl)) * 100000 + duplicateOf.count;
    const galleryScore = Number(Boolean(gallery.sourceUrl)) * 100000 + gallery.count;
    if (galleryScore > duplicateScore) {
      for (const key of keys) bestByKey.set(key, gallery);
    }
  }

  return Array.from(new Set(bestByKey.values()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function gallerySummary(gallery) {
  const { images, imageNames, ...summary } = gallery;
  return summary;
}

function latestGallerySummaries(models, limit = 60) {
  const galleries = [];
  for (const model of models || []) {
    for (const gallery of model.galleries || []) {
      galleries.push({
        ...gallery,
        modelId: model.id,
        modelName: model.name,
      });
    }
  }
  return galleries
    .sort((a, b) => {
      const timeDiff = Number(b.addedAtMs || 0) - Number(a.addedAtMs || 0);
      if (timeDiff) return timeDiff;
      const updatedDiff = Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0);
      if (updatedDiff) return updatedDiff;
      return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
    })
    .slice(0, limit);
}

function hydrateStateFromDatabase() {
  const hydrateStartedAt = Date.now();
  const modelRows = db.prepare(`
    SELECT
      models.id,
      models.folder,
      models.name
    FROM models
    WHERE EXISTS (
      SELECT 1
      FROM galleries
      WHERE galleries.model_id = models.id
        AND galleries.status != 'failed'
        AND galleries.image_count > 0
    )
    ORDER BY models.folder
  `).all();
  console.log(`[startup] Cached models query loaded ${modelRows.length} rows in ${Date.now() - hydrateStartedAt}ms.`);

  const galleriesStartedAt = Date.now();
  const galleryRows = db.prepare(`
    SELECT
      models.folder AS modelFolder,
      galleries.id AS dbId,
      galleries.folder AS galleryFolder,
      galleries.source_url AS sourceUrl,
      galleries.image_count AS imageCount,
      galleries.cover_name AS coverName,
      galleries.image_bytes AS imageBytes,
      galleries.thumb_bytes AS thumbBytes,
      galleries.last_seen_at AS lastSeenAt,
      galleries.imported_at AS importedAt,
      galleries.created_at AS createdAt
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    WHERE galleries.status != 'failed'
      AND galleries.image_count > 0
    ORDER BY models.folder, galleries.folder
  `).all();
  console.log(`[startup] Cached galleries query loaded ${galleryRows.length} rows in ${Date.now() - galleriesStartedAt}ms.`);

  const buildStartedAt = Date.now();
  const modelsById = new Map();
  for (const row of modelRows) {
    modelsById.set(row.folder, {
      id: row.folder,
      dbId: row.id,
      name: row.folder,
      count: 0,
      galleryCount: 0,
      cover: null,
      updatedAt: null,
      updatedAtMs: 0,
      _totals: emptyTotals(),
      galleries: [],
    });
  }

  for (const row of galleryRows) {
    const model = modelsById.get(row.modelFolder);
    if (!model) continue;
    const updatedAt = row.importedAt || row.createdAt || null;
    const updatedAtMs = updatedAt ? (Date.parse(updatedAt) || 0) : 0;
    const addedAt = row.importedAt || row.createdAt || updatedAt || null;
    const addedAtMs = addedAt ? (Date.parse(addedAt) || 0) : 0;
    const cover = galleryCoverUrl(row.modelFolder, row.galleryFolder, row.coverName, {
      cached: true,
      thumbBytes: row.thumbBytes,
    });
    const gallery = {
      id: `${row.modelFolder}/${row.galleryFolder}`,
      dbId: row.dbId,
      name: row.galleryFolder,
      path: `${mediaUrlPrefix()}/${encodeURIComponent(row.modelFolder)}/${encodeURIComponent(row.galleryFolder)}`,
      count: Number(row.imageCount || 0),
      cover,
      sourceUrl: row.sourceUrl || null,
      sourceSlug: sourceSlug(row.sourceUrl),
      missingThumbs: 0,
      staleThumbsRemoved: 0,
      imageBytes: Number(row.imageBytes || 0),
      thumbBytes: Number(row.thumbBytes || 0),
      addedAt,
      addedAtMs,
      updatedAt,
      updatedAtMs,
    };
    model.galleries.push(gallery);
    model.count += gallery.count;
    model.galleryCount += 1;
    model._totals.models = 1;
    model._totals.galleries += 1;
    model._totals.images += gallery.count;
    model._totals.thumbs += gallery.count;
    model._totals.missingThumbs += gallery.missingThumbs;
    model._totals.imageBytes += gallery.imageBytes;
    model._totals.thumbBytes += gallery.thumbBytes;
    model._totals.totalBytes = model._totals.imageBytes + model._totals.thumbBytes;
    if (updatedAtMs > model.updatedAtMs) {
      model.updatedAtMs = updatedAtMs;
      model.updatedAt = updatedAt;
      model.cover = gallery.cover;
    }
  }

  const models = Array.from(modelsById.values())
    .filter(model => model.galleryCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  const totals = emptyTotals();
  for (const model of models) {
    addTotals(totals, model._totals, 1);
  }

  lastState = {
    ...emptyState(models.length ? 'ready' : 'idle'),
    message: models.length
      ? `Loaded cached library state for ${totals.galleries} galleries.`
      : 'Waiting for scan.',
    scannedAt: appSetting('last_startup_state_at', nowIso()),
    totals,
    runtime: runtimeStats(),
    models,
    latest: latestGallerySummaries(models),
  };
  console.log(`[startup] Cached library objects built in ${Date.now() - buildStartedAt}ms.`);
}

function hydrateDatabaseFromImportJson() {
  const importDb = loadImportDb();
  const run = db.transaction(() => {
    for (const [modelFolder, record] of Object.entries(importDb.models || {})) {
      const modelId = upsertModelRecord(
        modelFolder,
        record.modelName || normalizeModelName(modelFolder),
        record.modelUrls?.[0] || '',
        { touchUpdatedAt: false }
      );
      for (const modelUrl of record.modelUrls || []) {
        try {
          db.prepare(`
            INSERT INTO model_urls (model_id, source_url, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(source_url) DO UPDATE SET model_id = excluded.model_id
          `).run(modelId, canonicalRemoteUrl(modelUrl), nowIso());
        } catch {
          // Ignore malformed legacy model URLs.
        }
      }
      for (const gallery of Object.values(record.galleries || {})) {
        if (!gallery.folder) continue;
        try {
          upsertGalleryRecord(modelFolder, record.modelName || normalizeModelName(modelFolder), gallery.folder, {
            sourceUrl: gallery.sourceUrl,
            title: gallery.title,
            imageCount: gallery.imageCount,
            importedAt: gallery.importedAt,
            lastSeenAt: gallery.lastSeenAt,
            touchModelUpdatedAt: false,
            status: 'imported',
          });
        } catch {
          // Ignore malformed legacy gallery rows; scan will rehydrate local folders.
        }
      }
    }
  });
  run();
}

function needsThumb(sourcePath, thumbPath) {
  try {
    const sourceStat = fs.statSync(sourcePath);
    const thumbStat = fs.statSync(thumbPath);
    return thumbStat.size === 0 || thumbStat.mtimeMs < sourceStat.mtimeMs;
  } catch {
    return true;
  }
}

function createThumb(sourcePath, thumbPath) {
  return new Promise((resolve) => {
    mkdirp(path.dirname(thumbPath));
    const tmpPath = `${thumbPath}.tmp-${process.pid}`;
    const args = [
      sourcePath,
      '-auto-orient',
      '-thumbnail',
      `${THUMB_SIZE}x${THUMB_SIZE}^`,
      '-gravity',
      'center',
      '-extent',
      `${THUMB_SIZE}x${THUMB_SIZE}`,
      '-strip',
      '-quality',
      '82',
      tmpPath,
    ];

    execFile('convert', args, { timeout: 30000 }, (error) => {
      if (error) {
        fs.rm(tmpPath, { force: true }, () => resolve(false));
        return;
      }
      fs.rename(tmpPath, thumbPath, (renameError) => {
        if (renameError) {
          fs.rm(tmpPath, { force: true }, () => resolve(false));
          return;
        }
        resolve(true);
      });
    });
  });
}

function enqueueThumb(sourcePath, thumbPath) {
  const key = `${sourcePath}\n${thumbPath}`;
  if (queuedThumbs.has(key)) return;
  const previousSize = fileSize(thumbPath);
  queuedThumbs.add(key);
  thumbQueue.push({ key, sourcePath, thumbPath, previousSize });
  processThumbQueue();
}

function galleryPathPartsForFile(filePath) {
  const relative = path.relative(mediaRoot(), filePath);
  if (!relative || relative.startsWith('..')) return null;
  const parts = relative.split(path.sep);
  if (parts.length < 3) return null;
  return {
    modelId: parts[0],
    galleryName: parts[1],
  };
}

function scheduleStateBroadcast() {
  if (thumbStateBroadcastTimer) return;
  thumbStateBroadcastTimer = setTimeout(() => {
    thumbStateBroadcastTimer = null;
    lastState = {
      ...lastState,
      totals: { ...(lastState.totals || {}) },
      runtime: runtimeStats(),
    };
    broadcast('state', stateNotice());
  }, 500);
}

function applyThumbDelta(sourcePath, previousSize, nextSize) {
  const parts = galleryPathPartsForFile(sourcePath);
  if (!parts) return;
  const delta = Number(nextSize || 0) - Number(previousSize || 0);
  const createdNewThumb = Number(previousSize || 0) <= 0 && Number(nextSize || 0) > 0;
  if (!delta && !createdNewThumb) return;

  const galleryId = galleryDbId(parts.modelId, parts.galleryName);
  if (galleryId) {
    db.prepare(`
      UPDATE galleries
      SET thumb_bytes = MAX(0, COALESCE(thumb_bytes, 0) + ?)
      WHERE id = ?
    `).run(delta, galleryId);
  }

  const model = (lastState.models || []).find(item => item.id === parts.modelId);
  const gallery = model?.galleries?.find(item => item.name === parts.galleryName);
  if (gallery) {
    gallery.thumbBytes = Math.max(0, Number(gallery.thumbBytes || 0) + delta);
    if (createdNewThumb) {
      gallery.missingThumbs = Math.max(0, Number(gallery.missingThumbs || 0) - 1);
    }
  }
  if (model?._totals) {
    model._totals.thumbBytes = Math.max(0, Number(model._totals.thumbBytes || 0) + delta);
    if (createdNewThumb) {
      model._totals.missingThumbs = Math.max(0, Number(model._totals.missingThumbs || 0) - 1);
      model._totals.thumbs = Number(model._totals.thumbs || 0) + 1;
    }
    model._totals.totalBytes = Number(model._totals.imageBytes || 0) + Number(model._totals.thumbBytes || 0);
  }

  lastState.totals.thumbBytes = Math.max(0, Number(lastState.totals.thumbBytes || 0) + delta);
  if (createdNewThumb) {
    lastState.totals.missingThumbs = Math.max(0, Number(lastState.totals.missingThumbs || 0) - 1);
    lastState.totals.thumbs = Number(lastState.totals.thumbs || 0) + 1;
  }
  lastState.totals.totalBytes = Number(lastState.totals.imageBytes || 0) + Number(lastState.totals.thumbBytes || 0);
  scheduleStateBroadcast();
}

function processThumbQueue() {
  while (activeThumbs < THUMB_CONCURRENCY && thumbQueue.length) {
    const item = thumbQueue.shift();
    activeThumbs += 1;
    createThumb(item.sourcePath, item.thumbPath)
      .then(created => {
        if (!created) return;
        applyThumbDelta(item.sourcePath, item.previousSize, fileSize(item.thumbPath));
      })
      .finally(() => {
        activeThumbs -= 1;
        queuedThumbs.delete(item.key);
        processThumbQueue();
        if (!activeThumbs && !thumbQueue.length) {
          clearTimeout(thumbRescanTimer);
          thumbRescanTimer = setTimeout(() => {
            if (skipNextThumbAutoRescan) {
              skipNextThumbAutoRescan = false;
              return;
            }
            if (!IS_WORKER && !scanInFlight && !importJob?.active) scanLibrary();
          }, 500);
        }
      });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchErrorMessage(error) {
  const cause = error?.cause;
  const detail = [
    error?.status ? `HTTP ${error.status}` : '',
    cause?.code,
    cause?.name && cause.name !== 'Error' ? cause.name : '',
    cause?.message,
  ].filter(Boolean).join(': ');
  return detail ? `${error.message} (${detail})` : error.message;
}

function parseRetryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const atMs = Date.parse(raw);
  if (!Number.isNaN(atMs)) return Math.max(0, atMs - Date.now());
  return 0;
}

function retryDelayMs(attempt, error) {
  if (error?.status === 429) {
    const headerDelay = parseRetryAfterMs(error.retryAfter);
    if (headerDelay > 0) return Math.min(headerDelay, IMPORT_FETCH_BACKOFF_MAX_MS);
  }
  const baseDelay = Math.min(IMPORT_FETCH_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)), IMPORT_FETCH_BACKOFF_MAX_MS);
  const jitter = Math.floor(Math.random() * 400);
  return baseDelay + jitter;
}

async function fetchWithRetry(remoteUrl, options, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= IMPORT_FETCH_RETRIES + 1; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMPORT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(remoteUrl, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const error = new Error(`${label} failed ${response.status} for ${remoteUrl}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after') || '';
        throw error;
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt > IMPORT_FETCH_RETRIES) break;
      await sleep(retryDelayMs(attempt, error));
    }
  }
  throw new Error(`${label} failed after ${IMPORT_FETCH_RETRIES + 1} attempts for ${remoteUrl}: ${fetchErrorMessage(lastError)}`);
}

async function fetchText(remoteUrl) {
  const response = await fetchWithRetry(remoteUrl, {
    headers: {
      'user-agent': 'SimpleGalleryImporter/1.0',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  }, 'Fetch');
  return response.text();
}

function extensionFromResponse(remoteUrl, response) {
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  if (contentType === 'image/gif') return '.gif';
  const ext = path.extname(new URL(remoteUrl).pathname).toLowerCase();
  return IMAGE_EXTS.has(ext) ? ext : '.jpg';
}

async function downloadImage(remoteUrl, outPathBase) {
  const profile = requireSourceProfile();
  const response = await fetchWithRetry(remoteUrl, {
    headers: {
      'user-agent': 'SimpleGalleryImporter/1.0',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      ...(profile.referer ? { referer: profile.referer } : {}),
    },
    redirect: 'follow',
  }, 'Image download');
  const ext = extensionFromResponse(remoteUrl, response);
  const outPath = `${outPathBase}${ext}`;
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirp(path.dirname(outPath));
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function rescanAllLowPriorityActive() {
  return IS_WORKER
    && importJob?.mode === 'all'
    && Date.now() - Number(lastForegroundActivityAt || 0) < FOREGROUND_ACTIVITY_WINDOW_MS;
}

async function pauseForForegroundBrowsing() {
  if (!rescanAllLowPriorityActive()) return;
  await new Promise(resolve => setTimeout(resolve, IMPORT_FOREGROUND_PAUSE_MS));
}

function extractModelName(modelUrl, html) {
  const profile = requireSourceProfile();
  try {
    const url = new URL(modelUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0]?.toLowerCase() === profile.modelPathSegment.toLowerCase() && parts[1]) {
      return normalizeModelName(decodeURIComponent(parts[1]));
    }
  } catch {
    // Fall through to HTML metadata.
  }

  const schemaName = html.match(/"@type"\s*:\s*"Person"[\s\S]*?"name"\s*:\s*"([^"]+)"/i)?.[1];
  if (schemaName) return normalizeModelName(decodeHtml(schemaName));
  if (profile.modelTitleSuffixPattern) {
    const titlePattern = new RegExp(`<title>\\s*([^<]+?)\\s+${profile.modelTitleSuffixPattern}`, 'i');
    const titleName = html.match(titlePattern)?.[1];
    if (titleName) return normalizeModelName(titleName);
  }
  return normalizeModelName(html.match(/<title>\s*([^<]+?)\s*(?:<|$)/i)?.[1] || 'model');
}

function extractModelLinks(html, baseUrl) {
  const profile = requireSourceProfile();
  const models = [];
  const seen = new Set();
  const segment = escapeRegExp(profile.modelPathSegment);
  const linkRe = new RegExp(`<a\\b([^>]*\\bhref=["'][^"']*/${segment}/[^"']+["'][^>]*)>([\\s\\S]*?)<\\/a>`, 'gi');
  let match;

  while ((match = linkRe.exec(html))) {
    const attrs = match[1];
    const body = match[2];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const sourceUrl = href ? resolveRemoteUrl(href, baseUrl) : null;
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    const nameFromImage = body.match(/<img[^>]*\balt=["']([^"']+)["']/i)?.[1];
    const nameFromUrl = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop();
    seen.add(sourceUrl);
    models.push({
      name: normalizeModelName(decodeHtml(nameFromImage || nameFromUrl)),
      sourceUrl: canonicalRemoteUrl(sourceUrl),
    });
  }

  return models;
}

function extractPaginationUrls(html, baseUrl) {
  const profile = requireSourceProfile();
  const urls = new Set([canonicalPageUrl(baseUrl)]);
  const linkRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = linkRe.exec(html))) {
    const pageUrl = resolveRemoteUrl(match[1], baseUrl);
    if (!pageUrl) continue;
    try {
      const parsed = new URL(pageUrl);
      if (
        sourceHostAllowed(parsed.hostname, profile)
        && parsed.pathname === profile.modelListPath
        && parsed.searchParams.has(profile.paginationParameter)
      ) {
        urls.add(canonicalPageUrl(pageUrl));
      }
    } catch {
      // Ignore malformed pagination links.
    }
  }

  return Array.from(urls).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function knownImportedModelUrls(db = loadImportDb()) {
  const profile = requireSourceProfile();
  const urls = new Set();
  for (const url of db.scannedUrls || []) {
    try {
      const canonical = canonicalRemoteUrl(url);
      const parsed = new URL(canonical);
      if (parsed.pathname.startsWith(`/${profile.modelPathSegment}/`)) urls.add(canonical);
    } catch {
      // Ignore malformed older values.
    }
  }
  for (const record of Object.values(db.models || {})) {
    for (const url of record.modelUrls || []) {
      try {
        urls.add(canonicalRemoteUrl(url));
      } catch {
        // Ignore malformed older values.
      }
    }
  }
  return urls;
}

function knownLocalModelFolders() {
  return new Set(readDirs(mediaRoot()));
}

function isKnownModel(model, knownUrls, knownFolders) {
  const profile = requireSourceProfile();
  if (knownUrls.has(canonicalRemoteUrl(model.sourceUrl))) return true;
  try {
    const parts = new URL(model.sourceUrl).pathname.split('/').filter(Boolean);
    if (parts[0]?.toLowerCase() === profile.modelPathSegment.toLowerCase() && parts[1]) {
      return knownFolders.has(sanitizeFolderName(normalizeModelName(decodeURIComponent(parts[1]))));
    }
  } catch {
    // Fall through to the display name.
  }
  return knownFolders.has(sanitizeFolderName(model.name));
}

function validateSourceUrl(sourceUrl, expectedPath, example = '') {
  const profile = requireSourceProfile();
  const parsed = new URL(sourceUrl);
  if (!sourceHostAllowed(parsed.hostname, profile)) {
    throw new Error('The URL host is not allowed by the configured source profile.');
  }
  if (expectedPath && parsed.pathname !== expectedPath) {
    throw new Error(example ? `Provide a URL such as ${example}.` : `The URL path must be ${expectedPath}.`);
  }
  return { parsed, profile };
}

async function loadSourceModelList(sourceUrl, options = {}) {
  const profile = requireSourceProfile();
  validateSourceUrl(sourceUrl, profile.modelListPath, profile.modelListExample);

  const firstHtml = await fetchText(sourceUrl);
  const pageUrls = [];
  const queuedPageUrls = extractPaginationUrls(firstHtml, sourceUrl);
  const seenPageUrls = new Set();
  const allModels = new Map();

  for (const model of extractModelLinks(firstHtml, sourceUrl)) {
    allModels.set(model.sourceUrl, model);
  }
  if (typeof options.onProgress === 'function') {
    options.onProgress({
      sourceUrl: canonicalPageUrl(sourceUrl),
      pageCount: pageUrls.length,
      pagesSeen: 1,
      modelsFound: allModels.size,
      completed: false,
    });
  }

  while (queuedPageUrls.length) {
    const pageUrl = queuedPageUrls.shift();
    if (seenPageUrls.has(pageUrl)) continue;
    seenPageUrls.add(pageUrl);
    pageUrls.push(pageUrl);
    if (pageUrl === canonicalPageUrl(sourceUrl)) continue;

    const html = await fetchText(pageUrl);
    for (const model of extractModelLinks(html, pageUrl)) {
      allModels.set(model.sourceUrl, model);
    }
    for (const discoveredPageUrl of extractPaginationUrls(html, pageUrl)) {
      if (!seenPageUrls.has(discoveredPageUrl) && !queuedPageUrls.includes(discoveredPageUrl)) {
        queuedPageUrls.push(discoveredPageUrl);
      }
    }
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        sourceUrl: canonicalPageUrl(sourceUrl),
        pageCount: Math.max(pageUrls.length + queuedPageUrls.length, pageUrls.length),
        pagesSeen: pageUrls.length,
        modelsFound: allModels.size,
        completed: false,
      });
    }
  }

  const allModelsSorted = Array.from(allModels.values()).sort((a, b) => a.name.localeCompare(b.name));
  const knownUrls = options.missingOnly ? knownImportedModelUrls() : new Set();
  const knownFolders = options.missingOnly ? knownLocalModelFolders() : new Set();
  const models = options.missingOnly
    ? allModelsSorted.filter(model => !isKnownModel(model, knownUrls, knownFolders))
    : allModelsSorted;

  loadedModelList = {
    sourceUrl: canonicalPageUrl(sourceUrl),
    loadedAt: new Date().toISOString(),
    pageCount: pageUrls.length,
    totalFound: allModelsSorted.length,
    knownCount: allModelsSorted.length - models.length,
    missingOnly: Boolean(options.missingOnly),
    models,
  };
  loadedModelBroadcastCount = 0;
  if (typeof options.onProgress === 'function') {
    options.onProgress({
      sourceUrl: canonicalPageUrl(sourceUrl),
      pageCount: pageUrls.length,
      pagesSeen: pageUrls.length,
      modelsFound: allModelsSorted.length,
      completed: true,
    });
  }
  return loadedModelList;
}

function buildLetterModelListUrls(sourceUrl) {
  const profile = requireSourceProfile();
  const { parsed } = validateSourceUrl(sourceUrl, profile.modelListPath, profile.modelListExample);
  const urls = [];
  for (const letter of profile.letterValues) {
    const next = new URL(parsed.toString());
    next.searchParams.set(profile.letterParameter, letter);
    urls.push(next.toString());
  }
  return urls;
}

function extractSourceGalleries(html, baseUrl) {
  const profile = requireSourceProfile();
  const galleries = [];
  const seen = new Set();
  const startPattern = profile.gallerySectionStartLabel
    ? new RegExp(`<h2\\b[^>]*>\\s*${escapeRegExp(profile.gallerySectionStartLabel)}\\s*<\\/h2>`, 'i')
    : null;
  const endPattern = profile.gallerySectionEndLabel
    ? new RegExp(`<h2\\b[^>]*>\\s*${escapeRegExp(profile.gallerySectionEndLabel)}\\s*<\\/h2>`, 'i')
    : null;
  const sectionStart = startPattern ? html.search(startPattern) : -1;
  const sectionEnd = endPattern ? html.search(endPattern) : -1;
  const sourceHtml = sectionStart >= 0
    ? html.slice(sectionStart, sectionEnd > sectionStart ? sectionEnd : undefined)
    : html;
  const itemRe = new RegExp(`<a\\b([^>]*\\bclass=["'][^"']*\\b${escapeRegExp(profile.galleryLinkClass)}\\b[^"']*["'][^>]*)>([\\s\\S]*?)<\\/a>`, 'gi');
  let match;

  while ((match = itemRe.exec(sourceHtml))) {
    const attrs = match[1];
    const body = match[2];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const sourceUrl = href ? resolveRemoteUrl(href, baseUrl) : null;
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    const pathName = new URL(sourceUrl).pathname;
    if (profile.excludedGalleryPathPrefixes.some(prefix => pathName.startsWith(prefix))) continue;
    if (new RegExp(`${profile.galleryDetailSuffixPattern}$`, 'i').test(pathName)) continue;
    const textClass = escapeRegExp(profile.galleryTextClass);
    const title = decodeHtml(
      body.match(new RegExp(`<span[^>]*class=["'][^"']*\\b${textClass}\\b[^"']*["'][^>]*>\\s*([^<]+?)\\s*<\\/span>`, 'i'))?.[1]
      || body.match(/<img[^>]*\balt=["']([^"']+)["']/i)?.[1]
      || new URL(sourceUrl).pathname.split('/').filter(Boolean).pop()
    );
    seen.add(sourceUrl);
    galleries.push({ sourceUrl, title });
  }

  return galleries;
}

function extractDetailUrls(galleryHtml, galleryUrl) {
  const profile = requireSourceProfile();
  const galleryPath = new URL(galleryUrl).pathname.replace(/\/$/, '');
  const slug = galleryPath.split('/').filter(Boolean).pop();
  const detailRe = new RegExp(`href=["']([^"']*${escapeRegExp(slug)}${profile.galleryDetailSuffixPattern})["']`, 'gi');
  const detailUrls = [];
  const seen = new Set();
  let match;

  while ((match = detailRe.exec(galleryHtml))) {
    const detailUrl = resolveRemoteUrl(match[1], galleryUrl);
    if (!detailUrl || seen.has(detailUrl)) continue;
    seen.add(detailUrl);
    detailUrls.push(detailUrl);
  }

  detailUrls.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return detailUrls;
}

function extractLargeImageUrl(detailHtml, detailUrl) {
  const profile = requireSourceProfile();
  if (profile.largeImageLinkLabel) {
    const labelPattern = new RegExp(`<a\\b[^>]*\\bhref=["']([^"']+)["'][^>]*>\\s*${escapeRegExp(profile.largeImageLinkLabel)}\\s*<\\/a>`, 'i');
    const labeledLink = detailHtml.match(labelPattern)?.[1];
    if (labeledLink) return resolveRemoteUrl(labeledLink, detailUrl);
  }

  if (profile.largeImageLinkClass) {
    const classPattern = new RegExp(`<a\\b[^>]*class=["'][^"']*\\b${escapeRegExp(profile.largeImageLinkClass)}\\b[^"']*["'][^>]*>[\\s\\S]*?<img\\b[^>]*\\bsrc=["']([^"']+)["']`, 'i');
    const classImage = detailHtml.match(classPattern)?.[1];
    if (classImage) return resolveRemoteUrl(classImage, detailUrl);
  }

  const preload = detailHtml.match(/<link\b[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*href=["']([^"']+)["']/i)?.[1];
  if (preload) return resolveRemoteUrl(preload, detailUrl);

  return null;
}

async function resolveGalleryImageUrls(detailUrls) {
  await pauseForForegroundBrowsing();
  const resolved = await mapLimit(detailUrls, IMPORT_CONCURRENCY, async (detailUrl, index) => {
    try {
      const detailHtml = await fetchText(detailUrl);
      const imageUrl = extractLargeImageUrl(detailHtml, detailUrl);
      if (!imageUrl) {
        return {
          ok: false,
          index,
          detailUrl,
          message: `No large image found for ${detailUrl}`,
        };
      }
      return { ok: true, index, detailUrl, imageUrl };
    } catch (error) {
      return {
        ok: false,
        index,
        detailUrl,
        message: error.message || 'Failed to resolve image URL.',
      };
    }
  });

  return {
    successes: resolved.filter(item => item?.ok && item.imageUrl),
    failures: resolved.filter(item => !item?.ok),
  };
}

async function downloadGalleryImagesPartial(items, galleryPath, title, onProgress = null) {
  const downloaded = [];
  const failures = [];

  await pauseForForegroundBrowsing();
  await mapLimit(items, IMPORT_CONCURRENCY, async (item, index) => {
    const fileBase = path.join(galleryPath, String(index).padStart(2, '0'));
    const outPathBase = `${fileBase}-${sanitizeFileBase(title)}`;
    try {
      const outPath = await downloadImage(item.imageUrl, outPathBase);
      downloaded.push({ ...item, outPath });
      if (onProgress) onProgress(downloaded.length, items.length);
    } catch (error) {
      failures.push({
        ...item,
        message: error.message || 'Image download failed.',
      });
    }
  });

  downloaded.sort((a, b) => a.index - b.index);
  failures.sort((a, b) => a.index - b.index);
  return { downloaded, failures };
}

function importSnapshot() {
  if (!importJob) {
    return {
      active: false,
      canResumeRescanAll: Boolean(resumableRescanAllCheckpoint()),
    };
  }
  const lastRescanAll = lastRescanAllMetadata();
  return {
    active: importJob.active,
    status: importJob.status,
    mode: importJob.mode || '',
    message: importJob.message,
    startedAt: importJob.startedAt,
    finishedAt: importJob.finishedAt,
    sourceUrl: importJob.sourceUrl,
    modelName: importJob.modelName,
    modelFolder: importJob.modelFolder,
    currentModelUrl: importJob.currentModelUrl || '',
    totals: importJob.totals,
    current: importJob.current,
    canResumeRescanAll: !importJob.active && Boolean(resumableRescanAllCheckpoint()),
    stopAfterCurrentModel: stopAfterCurrentModelRequested,
    pauseRescanAllRequested,
    lastRescanAll: importJob.mode === 'all' && !importJob.active && lastRescanAll.lastRescanAllDurationMs ? {
      startedAt: lastRescanAll.lastRescanAllStartedAt,
      finishedAt: lastRescanAll.lastRescanAllFinishedAt,
      durationMs: lastRescanAll.lastRescanAllDurationMs,
      status: lastRescanAll.lastRescanAllStatus,
    } : null,
    logs: importJob.logs.slice(-80),
  };
}

function updateImport(message, patch = {}, options = {}) {
  if (!importJob) return;
  Object.assign(importJob, patch);
  importJob.message = message;
  appendImportLog(message, options);

  const now = Date.now();
  if (options.force || now - lastImportProgressAt >= IMPORT_PROGRESS_MIN_MS) {
    lastImportProgressAt = now;
    broadcast('import', importSnapshot());
  }
}

function appendImportLog(message, options = {}) {
  if (!importJob || options.log === false) return;
  if (options.log !== false) {
    importJob.logs.push({ at: new Date().toISOString(), message });
    if (importJob.logs.length > IMPORT_LOG_LIMIT) {
      importJob.logs.splice(0, importJob.logs.length - IMPORT_LOG_LIMIT);
    }
  }

  if (options.broadcast) {
    const now = Date.now();
    if (options.force || now - lastImportProgressAt >= IMPORT_PROGRESS_MIN_MS) {
      lastImportProgressAt = now;
      broadcast('import', importSnapshot());
    }
  }
}

function removeLoadedModel(sourceUrl, modelName = '') {
  if (!loadedModelList?.models?.length) return;
  const canonicalSourceUrl = sourceUrl ? canonicalRemoteUrl(sourceUrl) : '';
  const before = loadedModelList.models.length;
  loadedModelList.models = loadedModelList.models.filter(model => {
    try {
      if (canonicalSourceUrl && canonicalRemoteUrl(model.sourceUrl) === canonicalSourceUrl) return false;
    } catch {
      // Keep malformed loaded entries instead of interrupting the import.
    }
    if (modelName && model.name === modelName) return false;
    return true;
  });
  if (loadedModelList.models.length !== before) {
    loadedModelBroadcastCount += 1;
    if (
      loadedModelBroadcastCount === 1
      || loadedModelBroadcastCount % 10 === 0
      || !loadedModelList.models.length
    ) {
      broadcast('loaded-models', loadedModelList);
    }
  }
}

function broadcastLoadedModels() {
  if (loadedModelList) {
    broadcast('loaded-models', loadedModelList);
  }
}

async function importSourceModel(sourceUrl) {
  return importSourceModels([sourceUrl], 'single');
}

async function importLoadedModels() {
  const urls = (loadedModelList?.models || []).map(model => model.sourceUrl).filter(Boolean);
  if (!urls.length) throw new Error('No loaded models to import.');
  return importSourceModels(urls, 'loaded');
}

async function importSourceModels(sourceUrls, mode = 'single', options = {}) {
  if (importJob?.active) throw new Error('An import is already running.');
  const uniqueSourceUrls = Array.from(new Set(sourceUrls.map(url => canonicalRemoteUrl(url))));
  const startIndex = mode === 'all'
    ? Math.max(0, Math.min(uniqueSourceUrls.length, Number(options.startIndex || 0)))
    : 0;
  const resumedTotals = options.totals && typeof options.totals === 'object' ? options.totals : {};
  stopAfterCurrentModelRequested = false;
  pauseRescanAllRequested = false;
  lastImportProgressAt = 0;
  if (!options.resume) clearImportErrors();

  importJob = {
    active: true,
    status: 'running',
    message: mode === 'all'
      ? (options.resume ? `Resuming rescan all at model ${startIndex + 1}/${uniqueSourceUrls.length}.` : 'Starting rescan all.')
      : 'Starting import.',
    mode,
    sourceUrl: uniqueSourceUrls[0] || '',
    sourceUrls: uniqueSourceUrls,
    modelName: '',
    modelFolder: '',
    currentModelUrl: '',
    startedAt: options.startedAt || new Date().toISOString(),
    finishedAt: null,
    totals: {
      models: uniqueSourceUrls.length,
      modelsChecked: startIndex,
      galleries: Number(resumedTotals.galleries || 0),
      knownGalleries: Number(resumedTotals.knownGalleries || 0),
      newGalleries: Number(resumedTotals.newGalleries || 0),
      galleriesProcessed: Number(resumedTotals.galleriesProcessed || 0),
      galleriesImported: Number(resumedTotals.galleriesImported || 0),
      galleriesSkipped: Number(resumedTotals.galleriesSkipped || 0),
      images: Number(resumedTotals.images || 0),
      imagesImported: Number(resumedTotals.imagesImported || 0),
      imagesSkipped: Number(resumedTotals.imagesSkipped || 0),
      errors: Number(resumedTotals.errors || 0),
    },
    current: null,
    logs: [],
  };
  if (mode === 'all') {
    recordRescanAllStarted(importJob.startedAt);
    if (uniqueSourceUrls[startIndex]) {
      saveRescanAllCheckpoint({
        nextUrl: uniqueSourceUrls[startIndex],
        nextIndex: startIndex,
        total: uniqueSourceUrls.length,
        totals: importJob.totals,
        startedAt: importJob.startedAt,
      });
    }
  }
  broadcast('import', importSnapshot());
  broadcastLoadedModels();

  let lastSnapshot = null;
  for (let modelIndex = startIndex; modelIndex < uniqueSourceUrls.length; modelIndex += 1) {
    const sourceUrl = uniqueSourceUrls[modelIndex];
    await pauseForForegroundBrowsing();
    const totalsBeforeModel = { ...importJob.totals, modelsChecked: modelIndex };
    if (mode === 'all') {
      saveRescanAllCheckpoint({
        nextUrl: sourceUrl,
        nextIndex: modelIndex,
        total: uniqueSourceUrls.length,
        totals: totalsBeforeModel,
        startedAt: importJob.startedAt,
      });
    }
    lastSnapshot = await importSourceModelIntoCurrentJob(sourceUrl);
    if (lastSnapshot.status === 'error') {
      if (mode === 'all') {
        saveRescanAllCheckpoint({
          nextUrl: sourceUrl,
          nextIndex: modelIndex,
          total: uniqueSourceUrls.length,
          totals: { ...totalsBeforeModel, errors: Number(totalsBeforeModel.errors || 0) + 1 },
          startedAt: importJob.startedAt,
          status: 'error',
        });
      }
      break;
    }
    if (mode === 'all' && uniqueSourceUrls[modelIndex + 1]) {
      saveRescanAllCheckpoint({
        nextUrl: uniqueSourceUrls[modelIndex + 1],
        nextIndex: modelIndex + 1,
        total: uniqueSourceUrls.length,
        totals: importJob.totals,
        startedAt: importJob.startedAt,
      });
    }
    if (mode === 'all' && pauseRescanAllRequested && uniqueSourceUrls[modelIndex + 1]) {
      saveRescanAllCheckpoint({
        nextUrl: uniqueSourceUrls[modelIndex + 1],
        nextIndex: modelIndex + 1,
        total: uniqueSourceUrls.length,
        totals: importJob.totals,
        startedAt: importJob.startedAt,
        status: 'paused',
      });
      updateImport('Rescan All paused after the current model.', {}, { force: true });
      break;
    }
    if (pauseRescanAllRequested && !uniqueSourceUrls[modelIndex + 1]) {
      pauseRescanAllRequested = false;
    }
    if (stopAfterCurrentModelRequested) {
      if (mode === 'all' && uniqueSourceUrls[modelIndex + 1]) {
        saveRescanAllCheckpoint({
          nextUrl: uniqueSourceUrls[modelIndex + 1],
          nextIndex: modelIndex + 1,
          total: uniqueSourceUrls.length,
          totals: importJob.totals,
          startedAt: importJob.startedAt,
          status: 'stopped',
        });
      }
      updateImport('Stop after current model requested. Import will stop now.', {}, { force: true });
      break;
    }
  }

  if (importJob.status !== 'error') {
    if (importJob.totals.galleriesImported === 0) {
      updateImport('No new galleries imported; gallery refresh skipped.');
    }
    if (importJob.totals.galleriesImported > 0) {
      skipNextThumbAutoRescan = true;
    }
    importJob.active = false;
    importJob.status = pauseRescanAllRequested
      ? 'paused'
      : (stopAfterCurrentModelRequested ? 'stopped' : 'done');
    importJob.finishedAt = new Date().toISOString();
    const doneMessage = mode === 'all'
      ? 'Rescan all complete.'
      : `Import complete for ${importJob.modelName}.`;
    if (mode === 'all' && !stopAfterCurrentModelRequested && !pauseRescanAllRequested) clearRescanAllCheckpoint();
    if (mode === 'all') recordRescanAllFinished(importJob.status);
    updateImport(
      pauseRescanAllRequested
        ? 'Rescan All paused after the current model.'
        : (stopAfterCurrentModelRequested ? 'Import stopped after current model.' : doneMessage),
      {},
      { force: true }
    );
    stopAfterCurrentModelRequested = false;
    pauseRescanAllRequested = false;
  }
  return importSnapshot();
}

async function importSourceModelIntoCurrentJob(sourceUrl) {
  try {
    importJob.currentModelUrl = canonicalRemoteUrl(sourceUrl);
    removeLoadedModel(importJob.currentModelUrl);
    const profile = requireSourceProfile();
    const { parsed } = validateSourceUrl(sourceUrl, '', profile.modelExample);
    if (!parsed.pathname.toLowerCase().startsWith(`/${profile.modelPathSegment.toLowerCase()}/`)) {
      throw new Error(profile.modelExample
        ? `Provide a URL such as ${profile.modelExample}.`
        : `The URL path must begin with /${profile.modelPathSegment}/.`);
    }

    updateImport(`Fetching model page: ${sourceUrl}`);
    const modelHtml = await fetchText(sourceUrl);
    const modelName = extractModelName(sourceUrl, modelHtml);
    removeLoadedModel(importJob.currentModelUrl, modelName);
    const modelFolder = sanitizeFolderName(modelName);
    const modelPath = path.join(mediaRoot(), modelFolder);
    mkdirp(modelPath);

    const importDb = loadImportDb();
    const modelRecord = getImportModelRecord(importDb, modelFolder, modelName, sourceUrl);
    hydrateImportRecordFromManifests(modelRecord, modelPath);
    let modelImportedGalleries = 0;

    const galleries = extractSourceGalleries(modelHtml, sourceUrl);
    const knownGalleryUrls = new Set(Object.keys(modelRecord.galleries));
    const newGalleries = galleries.filter(gallery => !knownGalleryUrls.has(canonicalRemoteUrl(gallery.sourceUrl)));
    importJob.modelName = modelName;
    importJob.modelFolder = modelFolder;
    importJob.totals.modelsChecked += 1;
    importJob.totals.galleries += galleries.length;
    importJob.totals.knownGalleries += galleries.length - newGalleries.length;
    importJob.totals.newGalleries += newGalleries.length;
    modelRecord.lastCheckedAt = new Date().toISOString();
    saveImportDb(importDb);
    updateImport(`Detected ${galleries.length} galleries for ${modelName}: ${newGalleries.length} new, ${galleries.length - newGalleries.length} already known.`);
    let modelNeedsThumbRefresh = false;

    for (const gallery of galleries) {
      await pauseForForegroundBrowsing();
      const canonicalGalleryUrl = canonicalRemoteUrl(gallery.sourceUrl);
      const knownGallery = modelRecord.galleries[canonicalGalleryUrl];
      if (knownGallery) {
        if (gallery.title) knownGallery.title = gallery.title;
        if (knownGallery.folder) {
          const galleryPath = path.join(modelPath, knownGallery.folder);
          const missingThumbs = galleryStorageStats(galleryPath).missingThumbs;
          if (missingThumbs > 0) {
            modelNeedsThumbRefresh = true;
            updateImport(`Known gallery ${knownGallery.folder} has ${missingThumbs} missing thumbnails; model refresh queued.`, {}, { force: true });
          }
        }
        importJob.totals.galleriesProcessed += 1;
        importJob.totals.galleriesSkipped += 1;
        updateImport(`Skipping known gallery ${knownGallery.folder || ''}: ${gallery.title}`.trim());
        continue;
      }

      const existing = findExistingGalleryForSource(modelPath, gallery.sourceUrl);
      if (existing) {
        rememberImportedGallery(modelRecord, gallery, existing, readImageFiles(path.join(modelPath, existing)).length, {
          preserveTimestamps: true,
        });
        if (galleryStorageStats(path.join(modelPath, existing)).missingThumbs > 0) {
          modelNeedsThumbRefresh = true;
          updateImport(`Existing gallery ${existing} has missing thumbnails; model refresh queued.`, {}, { force: true });
        }
        saveImportDb(importDb);
        importJob.totals.galleriesProcessed += 1;
        importJob.totals.galleriesSkipped += 1;
        updateImport(`Skipping existing gallery ${existing}: ${gallery.title}`);
        continue;
      }

      const galleryName = nextGalleryName(modelPath);
      const galleryPath = path.join(modelPath, galleryName);
      mkdirp(galleryPath);
      activeImportGalleryPaths.add(galleryPath);
      importJob.current = { gallery: galleryName, title: gallery.title, sourceUrl: gallery.sourceUrl, images: 0, imported: 0 };
      updateImport(`Fetching gallery ${galleryName}: ${gallery.title}`);

      try {
        const galleryHtml = await fetchText(gallery.sourceUrl);
        const detailUrls = extractDetailUrls(galleryHtml, gallery.sourceUrl);
        importJob.current.images = detailUrls.length;
        importJob.totals.images += detailUrls.length;
        updateImport(`Found ${detailUrls.length} image pages in gallery ${galleryName}.`);

        const resolved = await resolveGalleryImageUrls(detailUrls);
        for (const failure of resolved.failures) {
          importJob.totals.errors += 1;
          recordImportError({
            gallery: galleryName,
            title: gallery.title,
            sourceUrl: failure.detailUrl || gallery.sourceUrl,
            message: `Image page failed: ${failure.message}`,
          });
        }

        const downloads = await downloadGalleryImagesPartial(
          resolved.successes,
          galleryPath,
          gallery.title,
          (imported, total) => {
            importJob.current.imported = imported;
            importJob.totals.imagesImported += 1;
            updateImport(`Downloaded ${imported}/${total} images for gallery ${galleryName}.`, {}, { log: false });
          }
        );

        for (const failure of downloads.failures) {
          importJob.totals.errors += 1;
          recordImportError({
            gallery: galleryName,
            title: gallery.title,
            sourceUrl: failure.imageUrl || failure.detailUrl || gallery.sourceUrl,
            message: `Image download failed: ${failure.message}`,
          });
        }

        if (!downloads.downloaded.length) {
          throw new Error('No images could be downloaded for this gallery.');
        }

        importJob.totals.imagesSkipped += resolved.failures.length + downloads.failures.length;
        rememberImportedGallery(modelRecord, gallery, galleryName, downloads.downloaded.length);
        saveImportDb(importDb);
        importJob.totals.galleriesProcessed += 1;
        importJob.totals.galleriesImported += 1;
        modelImportedGalleries += 1;
        if (resolved.failures.length || downloads.failures.length) {
          updateImport(`Imported gallery ${galleryName}: ${gallery.title} (${downloads.downloaded.length}/${detailUrls.length} images).`);
        } else {
          updateImport(`Imported gallery ${galleryName}: ${gallery.title}`);
        }
      } catch (error) {
        fs.rmSync(galleryPath, { recursive: true, force: true });
        importJob.totals.galleriesProcessed += 1;
        importJob.totals.errors += 1;
        recordImportError({
          gallery: galleryName,
          title: gallery.title,
          sourceUrl: gallery.sourceUrl,
          message: error.message,
        });
        updateImport(`Failed gallery ${galleryName}: ${error.message}`);
      } finally {
        activeImportGalleryPaths.delete(galleryPath);
      }
    }

    if (modelImportedGalleries > 0) {
      updateImport(`Refreshing ${modelName}.`);
      await refreshModelInState(modelFolder);
    } else if (modelNeedsThumbRefresh) {
      updateImport(`Refreshing ${modelName}; missing thumbnails found in known galleries.`, {}, { force: true });
      await refreshModelInState(modelFolder);
    } else {
      updateImport(`No new galleries for ${modelName}; gallery refresh skipped.`);
    }
    return importSnapshot();
  } catch (error) {
    importJob.active = false;
    importJob.status = 'error';
    importJob.finishedAt = new Date().toISOString();
    importJob.totals.errors += 1;
    recordRescanAllFinished(importJob.status);
    recordImportError({
      sourceUrl,
      message: error.message || 'Import failed.',
    });
    updateImport(error.message || 'Import failed.', {}, { force: true });
    return importSnapshot();
  }
}

function getScannedUrlPayload() {
  return syncScannedUrlsFile();
}

async function importAllScannedUrls() {
  const payload = getScannedUrlPayload();
  if (!payload.urls.length) throw new Error('No scanned URLs recorded yet.');
  return importSourceModels(payload.urls, 'all');
}

async function resumeRescanAll() {
  const checkpoint = resumableRescanAllCheckpoint();
  if (!checkpoint) throw new Error('No failed or stopped Rescan All run is available to resume.');
  const payload = getScannedUrlPayload();
  if (!payload.urls.length) throw new Error('No scanned URLs recorded yet.');

  let startIndex = payload.urls.findIndex(sourceUrl => {
    try {
      return canonicalRemoteUrl(sourceUrl) === canonicalRemoteUrl(checkpoint.nextUrl);
    } catch {
      return sourceUrl === checkpoint.nextUrl;
    }
  });
  if (startIndex < 0 || !payload.urls[startIndex]) {
    throw new Error(`The saved resume model is no longer in the Rescan All URL list: ${checkpoint.nextUrl}`);
  }

  return importSourceModels(payload.urls, 'all', {
    resume: true,
    startIndex,
    totals: checkpoint.totals,
    startedAt: checkpoint.startedAt,
  });
}

function isVerifiableGalleryUrl(sourceUrl) {
  if (!sourceUrl) return false;
  try {
    const profile = requireSourceProfile();
    const parsed = new URL(sourceUrl);
    const pathName = parsed.pathname;
    return sourceHostAllowed(parsed.hostname, profile)
      && !profile.excludedGalleryPathPrefixes.some(prefix => pathName.startsWith(prefix))
      && !new RegExp(`${profile.galleryDetailSuffixPattern}$`, 'i').test(pathName);
  } catch {
    return false;
  }
}

async function verifyKnownGalleries() {
  if (importJob?.active) throw new Error('An import is already running.');
  stopAfterCurrentModelRequested = false;
  lastImportProgressAt = 0;
  clearImportErrors();

  const rows = db.prepare(`
    SELECT
      galleries.id AS gallery_id,
      galleries.folder AS gallery_folder,
      galleries.source_url,
      galleries.title,
      galleries.image_count,
      models.name AS model_name,
      models.folder AS model_folder,
      model_urls.source_url AS model_url
    FROM galleries
    JOIN models ON models.id = galleries.model_id
    LEFT JOIN model_urls ON model_urls.model_id = models.id
    WHERE galleries.source_url IS NOT NULL AND galleries.source_url != ''
    GROUP BY galleries.id
    ORDER BY models.folder, galleries.folder
  `).all().filter(row => isVerifiableGalleryUrl(row.source_url));

  importJob = {
    active: true,
    status: 'running',
    message: 'Verifying known galleries.',
    mode: 'verify',
    sourceUrl: '',
    sourceUrls: [],
    modelName: '',
    modelFolder: '',
    currentModelUrl: '',
    startedAt: nowIso(),
    finishedAt: null,
    totals: {
      models: 0,
      modelsChecked: 0,
      galleries: rows.length,
      knownGalleries: rows.length,
      newGalleries: 0,
      galleriesProcessed: 0,
      galleriesImported: 0,
      galleriesSkipped: 0,
      images: 0,
      imagesImported: 0,
      imagesSkipped: 0,
      errors: 0,
    },
    current: null,
    logs: [],
  };
  updateImport(`Verifying ${rows.length} known galleries.`, {}, { force: true });

  let lastModelFolder = '';
  const repairedModelFolders = new Set();
  for (const row of rows) {
    if (stopAfterCurrentModelRequested && lastModelFolder && row.model_folder !== lastModelFolder) {
      updateImport('Stop after current model requested. Verify will stop now.', {}, { force: true });
      break;
    }

    lastModelFolder = row.model_folder;
    importJob.modelName = row.model_name;
    importJob.modelFolder = row.model_folder;
    importJob.currentModelUrl = row.model_url || '';
    importJob.current = {
      gallery: row.gallery_folder,
      title: row.title,
      sourceUrl: row.source_url,
      images: 0,
      imported: 0,
    };

    try {
      const galleryHtml = await fetchText(row.source_url);
      const detailUrls = extractDetailUrls(galleryHtml, row.source_url);
      const remoteCount = detailUrls.length;
      const galleryPath = path.join(mediaRoot(), row.model_folder, row.gallery_folder);
      const localStats = galleryStorageStats(galleryPath);
      const localCount = localStats.imageNames.length;
      importJob.current.images = remoteCount;
      importJob.current.imported = localCount;
      importJob.totals.images += remoteCount;
      importJob.totals.imagesImported += localCount;

      if (remoteCount !== localCount) {
        updateImport(`Repairing ${row.model_name} / ${row.gallery_folder}: local ${localCount}, remote ${remoteCount}`, {}, { force: true });
        const repaired = await repairKnownGallery(row, detailUrls, galleryPath);
        if (repaired) repairedModelFolders.add(row.model_folder);
      } else if (localStats.missingThumbs > 0) {
        repairedModelFolders.add(row.model_folder);
      }
    } catch (error) {
      importJob.totals.errors += 1;
      recordImportError({
        gallery: row.gallery_folder,
        title: row.title,
        sourceUrl: row.source_url,
        message: `Verify failed: ${error.message}`,
      });
    }

    importJob.totals.galleriesProcessed += 1;
    updateImport(
      `Verified ${importJob.totals.galleriesProcessed}/${importJob.totals.galleries}: ${row.model_name} / ${row.gallery_folder}`,
      {},
      { log: importJob.totals.galleriesProcessed % 25 === 0 }
    );
  }

  for (const modelFolder of repairedModelFolders) {
    try {
      updateImport(`Refreshing repaired model ${modelFolder} and queuing thumbnails.`, {}, { force: true });
      await refreshModelInState(modelFolder);
    } catch (error) {
      importJob.totals.errors += 1;
      recordImportError({
        folder: modelFolder,
        message: `Post-repair refresh failed: ${error.message}`,
      });
      updateImport(`Failed to refresh repaired model ${modelFolder}: ${error.message}`, {}, { force: true });
    }
  }

  importJob.active = false;
  importJob.status = stopAfterCurrentModelRequested ? 'stopped' : 'done';
  importJob.finishedAt = nowIso();
  updateImport(
    stopAfterCurrentModelRequested
      ? `Verify stopped. ${importJob.totals.galleriesImported} galleries repaired, ${importJob.totals.errors} errors.`
      : `Verify complete. ${importJob.totals.galleriesImported} galleries repaired, ${importJob.totals.errors} errors.`,
    {},
    { force: true }
  );
  stopAfterCurrentModelRequested = false;
  return importSnapshot();
}

async function repairKnownGallery(row, detailUrls, galleryPath) {
  activeImportGalleryPaths.add(galleryPath);
  try {
    fs.rmSync(galleryPath, { recursive: true, force: true });
    mkdirp(galleryPath);

    const resolved = await resolveGalleryImageUrls(detailUrls);
    for (const failure of resolved.failures) {
      importJob.totals.errors += 1;
      recordImportError({
        gallery: row.gallery_folder,
        title: row.title,
        sourceUrl: failure.detailUrl || row.source_url,
        message: `Repair image page failed: ${failure.message}`,
      });
    }

    importJob.current.images = detailUrls.length;
    importJob.current.imported = 0;
    const downloads = await downloadGalleryImagesPartial(
      resolved.successes,
      galleryPath,
      row.title,
      (imported, total) => {
        importJob.current.imported = imported;
        updateImport(`Repaired ${imported}/${total} images for ${row.model_name} / ${row.gallery_folder}.`, {}, { log: false });
      }
    );

    for (const failure of downloads.failures) {
      importJob.totals.errors += 1;
      recordImportError({
        gallery: row.gallery_folder,
        title: row.title,
        sourceUrl: failure.imageUrl || failure.detailUrl || row.source_url,
        message: `Repair image download failed: ${failure.message}`,
      });
    }

    if (!downloads.downloaded.length) {
      throw new Error('No images could be repaired for this gallery.');
    }

    db.prepare(`
      UPDATE galleries
      SET image_count = ?, last_seen_at = ?
      WHERE id = ?
    `).run(downloads.downloaded.length, nowIso(), row.gallery_id);
    importJob.totals.galleriesImported += 1;
    updateImport(`Repaired ${row.model_name} / ${row.gallery_folder}: downloaded ${downloads.downloaded.length}/${detailUrls.length} images.`, {}, { force: true });
    return true;
  } catch (error) {
    importJob.totals.errors += 1;
    recordImportError({
      gallery: row.gallery_folder,
      title: row.title,
      sourceUrl: row.source_url,
      message: `Repair failed: ${error.message}`,
    });
    return false;
  } finally {
    activeImportGalleryPaths.delete(galleryPath);
  }
}

async function scanGallery(modelName, galleryName, galleryRecord = galleryDbRecord(modelName, galleryName)) {
  const galleryPath = path.join(mediaRoot(), modelName, galleryName);
  const thumbRoot = path.join(galleryPath, THUMB_DIR);
  const files = readImageFiles(galleryPath);
  let created = 0;
  let missing = 0;
  let staleThumbsRemoved = 0;
  let imageBytes = 0;
  let thumbBytes = 0;
  let newestMtimeMs = 0;
  let cover = null;
  let coverName = null;
  const wantedThumbNames = new Set(files.map(safeName));

  if (files.length) {
    mkdirp(thumbRoot);
    staleThumbsRemoved = cleanupStaleThumbs(thumbRoot, wantedThumbNames);
  } else {
    staleThumbsRemoved = cleanupStaleThumbs(thumbRoot, wantedThumbNames);
    removeEmptyThumbDir(thumbRoot);
  }

  for (const fileName of files) {
    const sourcePath = path.join(galleryPath, fileName);
    const thumbPath = path.join(thumbRoot, safeName(fileName));
    const hasThumb = fs.existsSync(thumbPath);
    if (needsThumb(sourcePath, thumbPath)) {
      enqueueThumb(sourcePath, thumbPath);
    }
    if (!cover) {
      cover = hasThumb ? toUrl(thumbPath) : toUrl(sourcePath);
      coverName = fileName;
    }
    if (!hasThumb) missing += 1;
    imageBytes += fileSize(sourcePath);
    thumbBytes += hasThumb ? fileSize(thumbPath) : 0;
    try {
      newestMtimeMs = Math.max(newestMtimeMs, fs.statSync(sourcePath).mtimeMs);
    } catch {
      // Ignore files that disappeared during scan.
    }
  }

  return {
    id: `${modelName}/${galleryName}`,
    name: galleryName,
    path: `${mediaUrlPrefix()}/${encodeURIComponent(modelName)}/${encodeURIComponent(galleryName)}`,
    count: files.length,
    cover,
    sourceUrl: galleryRecord?.source_url || null,
    sourceSlug: sourceSlug(galleryRecord?.source_url),
    imageNames: files,
    createdThumbs: created,
    missingThumbs: missing,
    staleThumbsRemoved,
    imageBytes,
    thumbBytes,
    coverName,
    addedAt: galleryRecord?.imported_at || galleryRecord?.created_at || (newestMtimeMs ? new Date(newestMtimeMs).toISOString() : null),
    addedAtMs: galleryRecord?.imported_at || galleryRecord?.created_at
      ? (Date.parse(galleryRecord.imported_at || galleryRecord.created_at) || 0)
      : newestMtimeMs,
    updatedAt: newestMtimeMs ? new Date(newestMtimeMs).toISOString() : null,
    updatedAtMs: newestMtimeMs,
  };
}

function emptyTotals() {
  return {
    models: 0,
    galleries: 0,
    images: 0,
    thumbs: 0,
    missingThumbs: 0,
    staleThumbsRemoved: 0,
    imageBytes: 0,
    thumbBytes: 0,
    totalBytes: 0,
  };
}

function addTotals(target, delta, direction = 1) {
  for (const key of Object.keys(emptyTotals())) {
    target[key] = Number(target[key] || 0) + Number(delta[key] || 0) * direction;
  }
  target.totalBytes = Number(target.imageBytes || 0) + Number(target.thumbBytes || 0);
}

async function scanModelState(modelName, importDb = loadImportDb()) {
  const modelPath = path.join(mediaRoot(), modelName);
  const totals = emptyTotals();
  const modelDbId = upsertModelRecord(modelName, normalizeModelName(modelName), '', { touchUpdatedAt: false });
  const hasActiveImportGallery = Array.from(activeImportGalleryPaths)
    .some(galleryPath => galleryPath === modelPath || galleryPath.startsWith(`${modelPath}${path.sep}`));
  const repairedSequence = !hasActiveImportGallery && repairGallerySequence(modelName, modelPath, importDb);
  const galleryNames = readDirs(modelPath);
  const galleryRecords = galleryRecordsForModel(modelName);
  const scannedGalleries = [];

  for (const galleryName of galleryNames) {
    const gallery = await scanGallery(modelName, galleryName, galleryRecords.get(galleryName) || null);
    if (!gallery.count) continue;
    gallery.dbId = upsertGalleryRecord(modelName, normalizeModelName(modelName), galleryName, {
      sourceUrl: gallery.sourceUrl,
      title: gallery.sourceSlug ? normalizeModelName(gallery.sourceSlug) : `Gallery ${galleryName}`,
      imageCount: gallery.count,
      coverName: gallery.coverName,
      imageBytes: gallery.imageBytes,
      thumbBytes: gallery.thumbBytes,
      lastSeenAt: gallery.updatedAt,
      touchModelUpdatedAt: false,
      status: 'imported',
    });
    cleanupSeenRecordsForGallery(gallery.dbId, gallery.imageNames || []);
    scannedGalleries.push(gallery);
  }

  const galleries = dedupeScannedGalleries(scannedGalleries);
  for (const gallery of galleries) {
    totals.galleries += 1;
    totals.images += gallery.count;
    totals.thumbs += gallery.count - gallery.missingThumbs;
    totals.missingThumbs += gallery.missingThumbs;
    totals.staleThumbsRemoved += gallery.staleThumbsRemoved;
    totals.imageBytes += gallery.imageBytes;
    totals.thumbBytes += gallery.thumbBytes;
  }
  totals.totalBytes = totals.imageBytes + totals.thumbBytes;

  if (!galleries.length) return { model: null, totals, repairedSequence };

  const latestGallery = galleries
    .slice()
    .sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0))[0];
  const model = {
    id: modelName,
    dbId: modelDbId,
    name: modelName,
    count: galleries.reduce((sum, gallery) => sum + gallery.count, 0),
    galleryCount: galleries.length,
    cover: latestGallery?.cover || null,
    updatedAt: latestGallery?.updatedAt || null,
    updatedAtMs: latestGallery?.updatedAtMs || 0,
    _totals: { ...totals, models: 1 },
    galleries: galleries.map(gallerySummary),
  };
  totals.models = 1;
  return { model, totals, repairedSequence };
}

async function refreshModelInState(modelName) {
  const importDb = loadImportDb();
  const scanned = await scanModelState(modelName, importDb);
  if (scanned.repairedSequence) saveImportDb(importDb);

  const oldModel = (lastState.models || []).find(model => model.id === modelName);
  const models = (lastState.models || []).filter(model => model.id !== modelName);
  if (oldModel) {
    addTotals(lastState.totals, oldModel._totals || {
      models: 1,
      galleries: oldModel.galleryCount,
      images: oldModel.count,
    }, -1);
  }
  if (scanned.model) {
    models.push(scanned.model);
    addTotals(lastState.totals, scanned.totals, 1);
  }
  models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  lastState = {
    ...lastState,
    status: 'ready',
    message: `Loaded ${lastState.totals.images} images across ${lastState.totals.galleries} galleries.`,
    scannedAt: new Date().toISOString(),
    models,
    latest: latestGallerySummaries(models),
  };
  broadcast('state', stateNotice());
  if (IS_WORKER) {
    sendWorkerMessage({
      type: 'event',
      event: 'model-state',
      payload: {
        modelName,
        model: scanned.model,
        totals: scanned.totals,
        scannedAt: lastState.scannedAt,
        message: lastState.message,
      },
    });
  }
  return lastState;
}

async function scanLibrary() {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    lastState = {
      ...lastState,
      status: 'scanning',
      message: 'Scanning galleries and creating thumbnails.',
      scanProgress: {
        current: 0,
        total: 0,
        model: '',
        totals: emptyTotals(),
      },
    };
    broadcast('state', stateNotice());

    mkdirp(mediaRoot());
    const modelNames = readDirs(mediaRoot());
    const importDb = loadImportDb();
    let repairedSequences = false;
    const models = [];
    const totals = emptyTotals();
    let scannedModels = 0;
    let lastScanProgressAt = 0;

    for (const modelName of modelNames) {
      const scanned = await scanModelState(modelName, importDb);
      scannedModels += 1;
      if (scanned.repairedSequence) repairedSequences = true;
      addTotals(totals, scanned.totals, 1);
      if (scanned.model) models.push(scanned.model);
      const now = Date.now();
      if (now - lastScanProgressAt >= 1000 || scannedModels === modelNames.length) {
        lastScanProgressAt = now;
        lastState = {
          ...lastState,
          status: 'scanning',
          message: `Scanning ${scannedModels}/${modelNames.length} models: ${normalizeModelName(modelName)}`,
          scanProgress: {
            current: scannedModels,
            total: modelNames.length,
            model: modelName,
            totals,
          },
        };
        broadcast('state', stateNotice());
        await sleep(0);
      }
    }

    if (repairedSequences) saveImportDb(importDb);

    totals.totalBytes = totals.imageBytes + totals.thumbBytes;
    lastState = {
      ...emptyState('ready'),
      message: `Loaded ${totals.images} images across ${totals.galleries} galleries.`,
      scannedAt: new Date().toISOString(),
      scanProgress: null,
      totals,
      runtime: runtimeStats(),
      models,
      latest: latestGallerySummaries(models),
    };
    broadcast('state', stateNotice());
    scanInFlight = null;
    return lastState;
  })().catch((error) => {
    scanInFlight = null;
    lastState = {
      ...lastState,
      status: 'error',
      message: error.message || 'Scan failed.',
      scanProgress: null,
      runtime: runtimeStats(),
    };
    broadcast('state', stateNotice());
    return lastState;
  });
  return scanInFlight;
}

function galleryImagesResponse(modelName, galleryName) {
  const id = `${modelName}/${galleryName}`;
  const galleryPath = path.join(mediaRoot(), modelName, galleryName);
  const thumbRoot = path.join(galleryPath, THUMB_DIR);
  const images = readImageFiles(galleryPath).map(fileName => {
    const sourcePath = path.join(galleryPath, fileName);
    const thumbPath = path.join(thumbRoot, safeName(fileName));
    return {
      name: fileName,
      src: toUrl(sourcePath),
      thumb: fs.existsSync(thumbPath) ? toUrl(thumbPath) : toUrl(sourcePath),
    };
  });
  return { id, images };
}

function modelForUser(model, favorites, seenData) {
  if (!model) return null;
  let modelSeenCount = 0;
  const galleries = (model.galleries || []).map(gallery => {
    const seen = gallerySeenSummary(gallery, seenData);
    modelSeenCount += seen.seenCount;
    return {
      ...gallery,
      favorite: Boolean(gallery.dbId && favorites.galleries.has(gallery.dbId)),
      seen: seen.seen,
      seenCount: seen.seenCount,
    };
  });
  return {
    id: model.id,
    name: model.name,
    count: model.count,
    galleryCount: model.galleryCount,
    cover: model.cover,
    updatedAt: model.updatedAt,
    updatedAtMs: model.updatedAtMs,
    favorite: Boolean(model.dbId && favorites.models.has(model.dbId)),
    seen: Number(model.count || 0) > 0 && modelSeenCount >= Number(model.count || 0),
    seenCount: modelSeenCount,
    galleries,
  };
}

function modelSummaryForUser(model, favorites, seenData) {
  const full = modelForUser(model, favorites, seenData);
  if (!full) return null;
  delete full.galleries;
  return full;
}

function stateForUser(req) {
  const user = currentUser(req);
  const favorites = favoriteSetsForUser(user?.id);
  const seenData = seenDataForUser(user?.id);
  const models = (lastState.models || []).map(model => modelForUser(model, favorites, seenData));
  const latest = (lastState.latest || []).map(gallery => ({
    ...gallery,
    favorite: Boolean(gallery.dbId && favorites.galleries.has(gallery.dbId)),
    ...gallerySeenSummary(gallery, seenData),
  }));

  return {
    status: lastState.status,
    message: lastState.message,
    scannedAt: lastState.scannedAt,
    totals: lastState.totals,
    runtime: runtimeStats(),
    app: appMetadata(),
    models,
    latest,
    user: publicUser(user),
  };
}

function galleryImagesResponseForUser(req, modelName, galleryName) {
  const response = galleryImagesResponse(modelName, galleryName);
  const user = currentUser(req);
  const galleryId = galleryDbId(modelName, galleryName);
  const favorites = favoriteSetsForUser(user?.id);
  const seenImages = seenImagesForGallery(user?.id, galleryId);
  response.dbId = galleryId;
  response.user = publicUser(user);
  response.images = response.images.map(image => ({
    ...image,
    favorite: Boolean(galleryId && favorites.images.has(`${galleryId}\n${image.name}`)),
    seen: Boolean(galleryId && seenImages.has(image.name)),
  }));
  return response;
}

function gallerySummaryByDbId(dbId) {
  for (const model of lastState.models || []) {
    for (const gallery of model.galleries || []) {
      const galleryDbIdValue = gallery.dbId || galleryDbId(model.id, gallery.name);
      if (galleryDbIdValue === dbId) {
        return {
          ...gallery,
          dbId,
          modelId: model.id,
          modelName: model.name,
          favorite: true,
        };
      }
    }
  }
  return null;
}

function modelSummaryById(modelId) {
  for (const model of lastState.models || []) {
    if (model.id === modelId) return model;
  }
  return null;
}

function favoritesResponse(req) {
  const user = currentUser(req);
  if (!user) return { user: null, models: [], galleries: [], imageGroups: [], imageCount: 0 };

  const modelRows = db.prepare(`
    SELECT
      model_favorites.created_at AS favoritedAt,
      models.id AS dbId,
      models.folder AS modelId,
      models.name AS modelName
    FROM model_favorites
    JOIN models ON models.id = model_favorites.model_id
    WHERE model_favorites.user_id = ?
    ORDER BY model_favorites.created_at DESC
  `).all(user.id);

  const galleryRows = db.prepare(`
    SELECT
      gallery_favorites.created_at AS favoritedAt,
      galleries.id AS dbId,
      galleries.folder AS galleryName,
      galleries.title AS title,
      galleries.image_count AS count,
      galleries.created_at AS createdAt,
      galleries.imported_at AS importedAt,
      galleries.last_seen_at AS lastSeenAt,
      models.folder AS modelId,
      models.name AS modelName
    FROM gallery_favorites
    JOIN galleries ON galleries.id = gallery_favorites.gallery_id
    JOIN models ON models.id = galleries.model_id
    WHERE gallery_favorites.user_id = ?
    ORDER BY gallery_favorites.created_at DESC
  `).all(user.id);

  // Seen aggregation is expensive for large accounts. The image-groups-only
  // overview does not need it when no models or galleries are favorited.
  const seenData = modelRows.length || galleryRows.length
    ? seenDataForUser(user.id)
    : { images: new Set(), galleryCounts: new Map() };
  const favorites = {
    models: new Set(modelRows.map(row => row.dbId)),
    galleries: new Set(galleryRows.map(row => row.dbId)),
    images: new Set(),
  };

  const models = modelRows.map(row => {
    const live = modelSummaryById(row.modelId);
    const model = live ? modelSummaryForUser(live, favorites, seenData) : {
      id: row.modelId,
      dbId: row.dbId,
      name: row.modelName,
      cover: null,
      count: 0,
      galleryCount: 0,
      updatedAt: null,
      updatedAtMs: 0,
      favorite: true,
      seen: false,
      seenCount: 0,
    };
    return {
      ...model,
      dbId: row.dbId,
      favorite: true,
      favoritedAt: row.favoritedAt,
    };
  });

  const liveGalleries = new Map();
  for (const model of lastState.models || []) {
    for (const gallery of model.galleries || []) {
      if (gallery.dbId) liveGalleries.set(gallery.dbId, { gallery, model });
    }
  }

  const galleries = galleryRows.map(row => {
    const live = liveGalleries.get(row.dbId);
    const gallery = live ? {
      ...live.gallery,
      dbId: row.dbId,
      modelId: live.model.id,
      modelName: live.model.name,
      favorite: true,
    } : {
      id: `${row.modelId}/${row.galleryName}`,
      dbId: row.dbId,
      modelId: row.modelId,
      modelName: row.modelName,
      name: row.galleryName,
      title: row.title,
      count: row.count,
      cover: null,
      updatedAt: row.lastSeenAt || row.importedAt || row.createdAt,
      updatedAtMs: Date.parse(row.lastSeenAt || row.importedAt || row.createdAt) || 0,
      favorite: true,
    };
    return {
      ...gallery,
      ...gallerySeenSummary(gallery, seenData),
    };
  });

  const imageGroups = db.prepare(`
    SELECT
      models.folder AS modelId,
      models.name AS modelName,
      COUNT(*) AS count,
      MAX(image_favorites.created_at) AS latestAt
    FROM image_favorites
    JOIN galleries ON galleries.id = image_favorites.gallery_id
    JOIN models ON models.id = galleries.model_id
    WHERE image_favorites.user_id = ?
    GROUP BY models.id, models.folder, models.name
    ORDER BY models.name COLLATE NOCASE, models.folder
  `).all(user.id);
  const imageCount = imageGroups.reduce((sum, group) => sum + Number(group.count || 0), 0);

  return { user: publicUser(user), models, galleries, imageGroups, imageCount };
}

function favoriteImagesResponse(userId, options = {}) {
  const modelId = String(options.modelId || '').trim();
  const random = options.random === true;
  const limit = Math.min(250, Math.max(1, Number(options.limit) || 120));
  const offset = random ? 0 : Math.max(0, Number(options.offset) || 0);
  if (!random && !modelId) throw new Error('Missing model.');

  const whereModel = random ? '' : 'AND models.folder = ?';
  const params = random ? [userId] : [userId, modelId];
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM image_favorites
    JOIN galleries ON galleries.id = image_favorites.gallery_id
    JOIN models ON models.id = galleries.model_id
    WHERE image_favorites.user_id = ? ${whereModel}
  `).get(...params)?.count || 0);

  const rows = db.prepare(`
    SELECT
      image_favorites.created_at AS favoritedAt,
      image_favorites.image_name AS imageName,
      galleries.id AS dbId,
      galleries.folder AS galleryName,
      models.folder AS modelId,
      models.name AS modelName,
      image_seen.image_name IS NOT NULL AS seen
    FROM image_favorites
    JOIN galleries ON galleries.id = image_favorites.gallery_id
    JOIN models ON models.id = galleries.model_id
    LEFT JOIN image_seen
      ON image_seen.user_id = image_favorites.user_id
      AND image_seen.gallery_id = image_favorites.gallery_id
      AND image_seen.image_name = image_favorites.image_name
    WHERE image_favorites.user_id = ? ${whereModel}
    ORDER BY ${random ? 'RANDOM()' : 'image_favorites.created_at DESC'}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const images = rows.map(row => {
    const imagePath = path.join(mediaRoot(), row.modelId, row.galleryName, row.imageName);
    const thumbPath = path.join(mediaRoot(), row.modelId, row.galleryName, THUMB_DIR, safeName(row.imageName));
    return {
      dbId: row.dbId,
      modelId: row.modelId,
      modelName: row.modelName,
      galleryId: `${row.modelId}/${row.galleryName}`,
      galleryName: row.galleryName,
      name: row.imageName,
      src: toUrl(imagePath),
      thumb: toUrl(thumbPath),
      favorite: true,
      seen: Boolean(row.seen),
      favoritedAt: row.favoritedAt,
    };
  });

  return { images, total, offset, limit, hasMore: !random && offset + images.length < total };
}

function broadcast(event, payload) {
  if (IS_WORKER) {
    sendWorkerMessage({ type: 'event', event, payload });
    return;
  }
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(body);
}

function markForegroundActivity(requestedPath = '') {
  if (IS_WORKER) return;
  const normalized = String(requestedPath || '').toLowerCase();
  if (!normalized.startsWith(`${mediaUrlPrefix().toLowerCase()}/`)) return;
  if (!IMAGE_EXTS.has(path.extname(normalized))) return;
  lastForegroundActivityAt = Date.now();
  if (workerChild?.connected) {
    try {
      workerChild.send({
        type: 'event',
        event: 'foreground-activity',
        payload: { at: lastForegroundActivityAt },
      });
    } catch {
      // Foreground tracking is best-effort.
    }
  }
}

let scannedUrlsBroadcastTimer = null;
let pendingScannedUrlsPayload = null;

function scheduleScannedUrlsBroadcast(payload) {
  pendingScannedUrlsPayload = payload;
  if (scannedUrlsBroadcastTimer) return;
  scannedUrlsBroadcastTimer = setTimeout(() => {
    scannedUrlsBroadcastTimer = null;
    if (!pendingScannedUrlsPayload) return;
    const nextPayload = pendingScannedUrlsPayload;
    pendingScannedUrlsPayload = null;
    broadcast('scanned-urls', nextPayload);
  }, 1000);
}

function sendWorkerMessage(message) {
  if (!IS_WORKER || typeof process.send !== 'function' || !process.connected || !workerIpcConnected) return false;
  try {
    process.send(message, (error) => {
      if (!error) return;
      if (error.code === 'EPIPE' || error.code === 'ERR_IPC_CHANNEL_CLOSED') {
        workerIpcConnected = false;
        return;
      }
      console.error(error);
    });
    return true;
  } catch (error) {
    if (error.code === 'EPIPE' || error.code === 'ERR_IPC_CHANNEL_CLOSED') {
      workerIpcConnected = false;
      return false;
    }
    throw error;
  }
}

function scheduleViewStatsBroadcast() {
  if (viewStatsBroadcastTimer) return;
  viewStatsBroadcastTimer = setTimeout(() => {
    viewStatsBroadcastTimer = null;
    broadcast('view-stats', viewStatsResponse());
  }, 1000);
}

function stateNotice() {
  return {
    status: lastState.status,
    message: lastState.message,
    scannedAt: lastState.scannedAt,
    scanProgress: lastState.scanProgress || null,
    totals: { ...(lastState.totals || {}) },
    runtime: runtimeStats(),
    app: appMetadata(),
  };
}

function mergeModelStateFromWorker(payload) {
  const oldModel = (lastState.models || []).find(model => model.id === payload.modelName);
  const models = (lastState.models || []).filter(model => model.id !== payload.modelName);
  if (oldModel) {
    addTotals(lastState.totals, oldModel._totals || {
      models: 1,
      galleries: oldModel.galleryCount,
      images: oldModel.count,
      thumbs: Number(oldModel.count || 0) - Number(oldModel.missingThumbs || 0),
      missingThumbs: Number(oldModel.missingThumbs || 0),
      imageBytes: Number(oldModel.imageBytes || 0),
      thumbBytes: Number(oldModel.thumbBytes || 0),
      totalBytes: Number(oldModel.imageBytes || 0) + Number(oldModel.thumbBytes || 0),
    }, -1);
  }
  if (payload.model) {
    models.push(payload.model);
    addTotals(lastState.totals, payload.totals || emptyTotals(), 1);
  }
  models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  lastState = {
    ...lastState,
    status: 'ready',
    message: `Loaded ${lastState.totals.images} images across ${lastState.totals.galleries} galleries.`,
    scannedAt: payload.scannedAt || nowIso(),
    models,
    latest: latestGallerySummaries(models),
    runtime: runtimeStats(),
    scanProgress: null,
  };
  broadcast('state', stateNotice());
}

function handleWorkerEvent(message) {
  if (!message || typeof message !== 'object') return;
  const { event, payload } = message;
  if (event === 'import') {
    importJob = payload || null;
    broadcast('import', payload);
    return;
  }
  if (event === 'loaded-models') {
    loadedModelList = payload || null;
    broadcast('loaded-models', payload);
    return;
  }
  if (event === 'import-errors' || event === 'scanned-urls') {
    broadcast(event, payload);
    return;
  }
  if (event === 'model-state') {
    mergeModelStateFromWorker(payload);
    return;
  }
}

function handleWorkerMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'response') {
    const pending = workerPending.get(message.id);
    if (!pending) return;
    workerPending.delete(message.id);
    if (message.ok) pending.resolve(message.payload);
    else pending.reject(new Error(message.error || 'Worker command failed.'));
    return;
  }
  if (message.type === 'event') {
    handleWorkerEvent(message);
  }
}

function ensureWorker() {
  if (IS_WORKER) return null;
  if (workerChild && workerChild.connected) return workerChild;
  workerChild = fork(__filename, [], {
    env: {
      ...process.env,
      SIMPLE_GALLERY_ROLE: 'worker',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  workerChild.on('message', handleWorkerMessage);
  workerChild.on('exit', () => {
    workerChild = null;
    for (const pending of workerPending.values()) pending.reject(new Error('Worker exited.'));
    workerPending.clear();
  });
  return workerChild;
}

function requestWorker(command, payload = {}) {
  const child = ensureWorker();
  if (!child) return Promise.reject(new Error('Worker unavailable.'));
  const id = ++workerRequestId;
  return new Promise((resolve, reject) => {
    workerPending.set(id, { resolve, reject });
    child.send({ type: 'command', id, command, payload });
  });
}

function startImportInBackground(runner) {
  runner().catch((error) => {
    const message = error?.message || 'Background import failed.';
    if (importJob?.active) {
      importJob.active = false;
      importJob.status = 'error';
      importJob.finishedAt = new Date().toISOString();
      importJob.totals.errors += 1;
      recordImportError({ sourceUrl: importJob.currentModelUrl || importJob.sourceUrl || '', message });
      updateImport(message, {}, { force: true });
      return;
    }
    console.error(message);
  });
  return importSnapshot();
}

const workerCommandHandlers = {
  'load-model-list': async ({ url }) => loadSourceModelList(url),
  'load-missing-models': async ({ url }) => loadSourceModelList(url, { missingOnly: true }),
  'import-start': async (payload) => startImportInBackground(async () => {
    const urls = Array.isArray(payload.urls) ? payload.urls.map(url => String(url).trim()).filter(Boolean) : [];
    if (payload.loaded) return importLoadedModels();
    if (urls.length) return importSourceModels(urls, 'loaded');
    if (!payload.url) throw new Error('Missing URL.');
    return importSourceModel(String(payload.url).trim());
  }),
  'rescan-all-start': async () => startImportInBackground(async () => importAllScannedUrls()),
  'rescan-all-resume': async () => startImportInBackground(async () => resumeRescanAll()),
  'rescan-all-pause': async () => {
    if (!importJob?.active || importJob.mode !== 'all') throw new Error('No Rescan All run is active.');
    pauseRescanAllRequested = true;
    updateImport('Pause requested; Rescan All will pause after the current model.', {}, { force: true });
    return importSnapshot();
  },
  'verify-known-start': async () => startImportInBackground(async () => verifyKnownGalleries()),
  'stop-after-current-model': async () => {
    if (!importJob?.active) throw new Error('No active import.');
    stopAfterCurrentModelRequested = true;
    updateImport('Stop after current model requested.', {}, { force: true });
    return importSnapshot();
  },
};

function startWorkerProcess() {
  process.on('message', async (message) => {
    if (!message) return;
    if (message.type === 'event' && message.event === 'foreground-activity') {
      lastForegroundActivityAt = Math.max(lastForegroundActivityAt, Number(message.payload?.at || Date.now()));
      return;
    }
    if (message.type !== 'command') return;
    const handler = workerCommandHandlers[message.command];
    if (!handler) {
      sendWorkerMessage({ type: 'response', id: message.id, ok: false, error: 'Unknown worker command.' });
      return;
    }
    try {
      const payload = await handler(message.payload || {});
      sendWorkerMessage({ type: 'response', id: message.id, ok: true, payload });
    } catch (error) {
      sendWorkerMessage({ type: 'response', id: message.id, ok: false, error: error.message || 'Worker command failed.' });
    }
  });
}

function topSidebarModels(limit = 50) {
  return (lastState.models || []).slice(0, limit);
}

function renderSidebarLinks(selectedModelId = '') {
  const models = topSidebarModels();
  return `${models.map(model => `
    <a class="model-card${model.id === selectedModelId ? ' is-active' : ''}" href="${modelRoutePath(model.id)}">
      <img src="${escapeHtml(model.cover || '')}" alt="${escapeHtml(normalizeModelName(model.name))}">
      <div>
        <div class="card-title">${escapeHtml(normalizeModelName(model.name))}</div>
        <div class="card-sub">${formatCount(model.galleryCount)} galleries · ${formatCount(model.count)} images</div>
        <div class="card-sub">Updated ${escapeHtml(formatDateLabel(model.updatedAt))}</div>
      </div>
    </a>
  `).join('')}`;
}

function renderLatestGalleryCards(galleries) {
  return (galleries || []).map(gallery => `
    <a class="gallery-card latest-gallery-card" href="${galleryRoutePath(gallery.modelId, gallery.name)}">
      <img src="${escapeHtml(gallery.cover || '')}" alt="${escapeHtml(`${normalizeModelName(gallery.modelName)} gallery ${gallery.name}`)}">
      <div>
        <div class="card-title">${escapeHtml(`${normalizeModelName(gallery.modelName)} / ${gallery.name}`)}</div>
        <div class="card-sub">${formatCount(gallery.count)} images · ${escapeHtml(formatDateLabel(gallery.addedAt || gallery.updatedAt))}</div>
      </div>
    </a>
  `).join('');
}

function renderModelGalleryCards(model) {
  return (model?.galleries || []).map(gallery => `
    <a class="gallery-card latest-gallery-card" href="${galleryRoutePath(model.id, gallery.name)}">
      <img src="${escapeHtml(gallery.cover || '')}" alt="${escapeHtml(`${normalizeModelName(model.name)} gallery ${gallery.name}`)}">
      <div>
        <div class="card-title">Gallery ${escapeHtml(gallery.name)}</div>
        <div class="card-sub">${formatCount(gallery.count)} images · ${escapeHtml(formatDateLabel(gallery.updatedAt))}</div>
      </div>
    </a>
  `).join('');
}

function modelsDirectoryData(req) {
  const allModels = lastState.models || [];
  const url = requestUrl(req);
  const selectedLetter = String(url.searchParams.get('letter') || '')
    .trim()
    .toUpperCase();
  const letter = /^[A-Z]$/.test(selectedLetter) ? selectedLetter : '';
  const pageParam = url.searchParams.get('page') || '1';
  const page = Math.max(1, Number(pageParam || 1) || 1);
  const filtered = letter
    ? allModels.filter(model => normalizeModelName(model.name).toUpperCase().startsWith(letter))
    : allModels;
  const perPage = 60;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * perPage;
  return {
    letter,
    page: safePage,
    perPage,
    totalPages,
    totalModels: filtered.length,
    models: filtered.slice(startIndex, startIndex + perPage),
  };
}

function renderLetterBar(selectedLetter = '') {
  const letters = ['All', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
  return `
    <div class="letter-bar">
      ${letters.map(letter => {
        const isAll = letter === 'All';
        const href = modelsDirectoryPath(isAll ? '' : letter, 1);
        const active = (isAll && !selectedLetter) || (!isAll && selectedLetter === letter);
        return `<a class="link-btn${active ? ' is-active' : ''}" href="${href}">${letter}</a>`;
      }).join('')}
    </div>
  `;
}

function renderPagerRow(letter, page, totalPages) {
  if (totalPages <= 1) return '';
  const windowStart = Math.max(1, page - 2);
  const windowEnd = Math.min(totalPages, page + 2);
  const pageLinks = [];
  for (let current = windowStart; current <= windowEnd; current += 1) {
    pageLinks.push(`<a class="link-btn${current === page ? ' is-active' : ''}" href="${modelsDirectoryPath(letter, current)}">${current}</a>`);
  }
  return `
    <div class="pager-row">
      ${page > 1 ? `<a class="link-btn" href="${modelsDirectoryPath(letter, page - 1)}">Previous</a>` : '<button type="button" disabled>Previous</button>'}
      ${windowStart > 1 ? `<a class="link-btn" href="${modelsDirectoryPath(letter, 1)}">1</a><span>…</span>` : ''}
      ${pageLinks.join('')}
      ${windowEnd < totalPages ? `<span>…</span><a class="link-btn" href="${modelsDirectoryPath(letter, totalPages)}">${totalPages}</a>` : ''}
      ${page < totalPages ? `<a class="link-btn" href="${modelsDirectoryPath(letter, page + 1)}">Next</a>` : '<button type="button" disabled>Next</button>'}
    </div>
  `;
}

function renderModelsDirectory(req) {
  const data = modelsDirectoryData(req);
  return `
    ${renderLetterBar(data.letter)}
    <div class="browser-model-grid">
      ${data.models.map(model => `
        <a class="browser-model-card" href="${modelRoutePath(model.id)}">
          <img src="${escapeHtml(model.cover || '')}" alt="${escapeHtml(normalizeModelName(model.name))}">
          <div>
            <div class="card-title">${escapeHtml(normalizeModelName(model.name))}</div>
            <div class="card-sub">${formatCount(model.galleryCount)} galleries · ${formatCount(model.count)} images</div>
            <div class="card-sub">Updated ${escapeHtml(formatDateLabel(model.updatedAt))}</div>
          </div>
        </a>
      `).join('')}
    </div>
    ${renderPagerRow(data.letter, data.page, data.totalPages)}
  `;
}

function renderGalleryImagesGrid(model, gallery) {
  const payload = galleryImagesResponse(model.id, gallery.name);
  return (payload.images || []).map(image => `
    <button type="button" class="image-tile" aria-label="${escapeHtml(`Open ${normalizeModelName(model.name)} gallery ${gallery.name} image ${image.name}`)}">
      <img loading="lazy" src="${escapeHtml(image.thumb)}" alt="${escapeHtml(`${normalizeModelName(model.name)} ${gallery.name} ${image.name}`)}">
    </button>
  `).join('');
}

function renderSelectedGalleryBarHtml(model, gallery) {
  const index = (model.galleries || []).findIndex(item => item.name === gallery.name);
  const prev = index > 0 ? model.galleries[index - 1] : null;
  const next = index >= 0 && index < model.galleries.length - 1 ? model.galleries[index + 1] : null;
  return `
    <div class="selected-gallery-cover">
      <img src="${escapeHtml(gallery.cover || '')}" alt="${escapeHtml(`${normalizeModelName(model.name)} gallery ${gallery.name}`)}">
    </div>
    <div class="selected-gallery-main">
      <div class="selected-gallery-title">Gallery ${escapeHtml(gallery.name)}</div>
      <div class="card-sub">${formatCount(gallery.count)} images</div>
      <div class="card-sub">${escapeHtml(formatDateLabel(gallery.updatedAt))}</div>
    </div>
    <div class="selected-gallery-actions">
      ${prev ? `<a class="link-btn" href="${galleryRoutePath(model.id, prev.name)}">Previous</a>` : '<button type="button" disabled>Previous</button>'}
      ${next ? `<a class="link-btn" href="${galleryRoutePath(model.id, next.name)}">Next</a>` : '<button type="button" disabled>Next</button>'}
      <a class="link-btn" href="${modelRoutePath(model.id)}">All galleries</a>
    </div>
  `;
}

function renderInstanceTemplate(value, variables = {}, fallback = '') {
  const template = String(value || fallback || '');
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key) => (
    Object.hasOwn(variables, key) ? String(variables[key]) : match
  ));
}

function instanceKeywords(profile, key, variables = {}, extras = []) {
  const configured = Array.isArray(profile[key]) ? profile[key] : [];
  return [...extras, ...configured.map(value => renderInstanceTemplate(value, variables))];
}

function renderSeoDocument(req, options = {}) {
  const canonical = absoluteUrlForRequest(req, options.canonicalPath || '/');
  const image = options.image ? absoluteUrlForRequest(req, options.image) : '';
  const app = appMetadata();
  const user = currentUser(req);
  const stats = lastState.totals || {};
  const metaRobots = options.metaRobots || 'index,follow';
  const jsonLd = Array.isArray(options.jsonLd) ? options.jsonLd.filter(Boolean) : [];
  const headLinks = Array.isArray(options.headLinks) ? options.headLinks.filter(Boolean) : [];
  const description = options.description || app.name;
  const keywords = seoKeywords(
    ['gallery', 'models', 'galleries', 'photos', 'pictures', 'images'],
    options.keywords || []
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title || app.name)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="keywords" content="${escapeHtml(keywords)}">
  <meta name="robots" content="${escapeHtml(metaRobots)}">
  <meta name="bingbot" content="index,follow,max-snippet:-1,max-image-preview:large">
  <meta name="googlebot" content="index,follow,max-snippet:-1,max-image-preview:large">
  <meta name="application-name" content="${escapeHtml(app.name)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(app.name)}">
  <meta property="og:title" content="${escapeHtml(options.title || app.name)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${escapeHtml(options.title || app.name)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  ${image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : ''}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/css/style.css?v=33">
  ${headLinks.join('\n  ')}
  ${jsonLd.map(entry => `<script type="application/ld+json">${escapeJsonForHtml(entry)}</script>`).join('\n  ')}
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div>
        <h1><a class="app-title-link" href="/"><span id="app-name">${escapeHtml(app.name)}</span> <span class="app-version-stack"><span id="app-tagline" class="app-tagline">${escapeHtml(app.tagline)}</span><span id="app-version-label" class="app-version-label">${escapeHtml(app.versionLabel)}</span></span></a></h1>
      </div>
      <div class="topbar-actions">
        <div class="auth-box" id="auth-box"></div>
        <div class="stats-stack">
          <div class="stats-row">
            <span class="stats-label">Totals</span>
            <div class="stats-card">
              <span id="stats" class="stats-breakdown">${renderStatsBreakdown(stats)}</span>
            </div>
          </div>
          <div class="stats-row" id="user-stats-row" hidden>
            <span class="stats-label">Unseen</span>
            <div class="stats-card">
              <span id="user-stats" class="user-stats stats-breakdown"></span>
            </div>
          </div>
        </div>
      </div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <div class="sidebar-head">
          <div class="sidebar-title-row">
            <h2>Models</h2>
            <label class="sidebar-toggle" for="hide-seen-models" hidden>
              <input id="hide-seen-models" type="checkbox">
              <span>Hide seen</span>
            </label>
          </div>
          <div id="model-count" class="sidebar-count">${formatCount(stats.models)} shown (${formatCount(stats.models)} total)</div>
          <input id="search" type="search" placeholder="Filter">
        </div>
        <div id="model-list" class="model-list">${options.sidebarHtml || ''}</div>
      </aside>

      <section class="content">
        <div class="content-head">
          <div>
            <p class="eyebrow" id="gallery-kicker">${escapeHtml(options.kicker || 'Latest')}</p>
            <h2 id="gallery-title">${escapeHtml(options.heading || 'Galleries')}</h2>
          </div>
          <div class="view-actions">
            <a id="home-btn" class="link-btn" href="/" data-tooltip="Latest galleries" aria-label="Latest galleries"${options.mode === 'home' ? ' hidden' : ''}>Home</a>
            <button id="favorites-btn" type="button" data-tooltip="View favorites" aria-label="View favorites" hidden>Favorites</button>
            <a id="browse-models-btn" class="link-btn" href="/models" data-tooltip="Browse all models" aria-label="Browse all models"${options.mode === 'models' ? ' hidden' : ''}>Browse Models</a>
            <button id="model-favorite-btn" type="button" data-tooltip="Favorite model" aria-label="Favorite model" hidden>☆</button>
            <button id="model-seen-btn" type="button" data-tooltip="Mark all galleries in this model seen" aria-label="Mark all galleries in this model seen" hidden>Mark model seen</button>
            <button id="grid-small" type="button" data-tooltip="Small thumbnails" aria-label="Small thumbnails"${options.hasGallery ? '' : ' hidden'}>Small</button>
            <button id="grid-large" type="button" data-tooltip="Large thumbnails" aria-label="Large thumbnails"${options.hasGallery ? '' : ' hidden'}>Large</button>
          </div>
        </div>
        <div id="model-browser" class="model-browser"${options.mode === 'models' ? '' : ' hidden'}>${options.modelBrowserHtml || ''}</div>
        <div id="favorites-view" class="favorites-view" hidden></div>
        <div id="selected-gallery-bar" class="selected-gallery-bar"${options.selectedGalleryBarHtml ? '' : ' hidden'}>${options.selectedGalleryBarHtml || ''}</div>
        <div id="gallery-list" class="gallery-list${options.latest ? ' latest-gallery-list' : ''}"${options.galleryListHtml != null ? '' : ' hidden'}>${options.galleryListHtml || ''}</div>
        <div id="image-grid" class="image-grid"${options.imageGridHtml != null ? '' : ' hidden'}>${options.imageGridHtml || ''}</div>
      </section>
    </main>
  </div>

  <div id="lightbox" class="lightbox" hidden>
    <button id="close-lightbox" class="icon-btn" type="button" data-tooltip="Close" aria-label="Close">×</button>
    <button id="lightbox-download" class="icon-btn lightbox-download" type="button" data-tooltip="Download image" aria-label="Download image">↓</button>
    <button id="lightbox-seen" class="icon-btn lightbox-seen" type="button" data-tooltip="Mark seen" aria-label="Mark seen">✓</button>
    <button id="lightbox-favorite" class="icon-btn lightbox-favorite" type="button" data-tooltip="Favorite image" aria-label="Favorite image">☆</button>
    <button id="prev-image" class="nav-btn prev" type="button" data-tooltip="Previous" aria-label="Previous">‹</button>
    <div class="lightbox-media">
      <img id="lightbox-img" alt="">
      <div id="lightbox-loading" class="lightbox-loading" hidden>
        <div class="lightbox-loading-bar"></div>
        <div id="lightbox-loading-text" class="lightbox-loading-text">Loading...</div>
      </div>
    </div>
    <button id="next-image" class="nav-btn next" type="button" data-tooltip="Next" aria-label="Next">›</button>
    <div id="lightbox-caption" class="caption"></div>
  </div>
  <script src="/js/app.js?v=96"></script>
</body>
</html>`;
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function renderHomePage(req) {
  const app = appMetadata();
  const profile = seoProfile();
  const variables = {
    appName: app.name,
    models: formatCount(lastState.totals.models),
    galleries: formatCount(lastState.totals.galleries),
    images: formatCount(lastState.totals.images),
  };
  const description = renderInstanceTemplate(
    profile.homeDescription,
    variables,
    '{appName} contains {models} models, {galleries} galleries, and {images} images.'
  );
  return renderSeoDocument(req, {
    title: renderInstanceTemplate(profile.homeTitle, variables, '{appName} - Image Galleries'),
    description,
    canonicalPath: '/',
    image: lastState.latest?.[0]?.cover || '',
    kicker: 'Latest',
    heading: 'Galleries',
    sidebarHtml: renderSidebarLinks(),
    galleryListHtml: renderLatestGalleryCards(lastState.latest || []),
    latest: true,
    mode: 'home',
    keywords: instanceKeywords(profile, 'homeKeywords', variables, [app.name, 'latest galleries']),
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: app.name,
      description,
      url: absoluteUrlForRequest(req, '/'),
    }],
  });
}

function renderModelsPage(req) {
  const app = appMetadata();
  const profile = seoProfile();
  const directory = modelsDirectoryData(req);
  const canonicalPath = modelsDirectoryPath(directory.letter, directory.page);
  const heading = directory.letter ? `Models: ${directory.letter}` : 'All Models';
  const variables = {
    appName: app.name,
    letter: directory.letter || '',
    models: directory.letter ? directory.totalModels : (lastState.models || []).length,
    page: directory.page,
    pages: directory.totalPages,
  };
  const description = renderInstanceTemplate(
    directory.letter ? profile.modelsLetterDescription : profile.modelsDescription,
    variables,
    directory.letter
      ? 'Browse models under {letter} in {appName}. {models} models listed on page {page} of {pages}.'
      : 'Browse models in {appName}. {models} models listed on page {page} of {pages}.'
  );
  const headLinks = [];
  if (directory.page > 1) {
    headLinks.push(`<link rel="prev" href="${escapeHtml(absoluteUrlForRequest(req, modelsDirectoryPath(directory.letter, directory.page - 1)))}">`);
  }
  if (directory.page < directory.totalPages) {
    headLinks.push(`<link rel="next" href="${escapeHtml(absoluteUrlForRequest(req, modelsDirectoryPath(directory.letter, directory.page + 1)))}">`);
  }
  return renderSeoDocument(req, {
    title: `${heading} | ${app.name}`,
    description,
    canonicalPath,
    image: lastState.models?.[0]?.cover || '',
    kicker: 'Models',
    heading,
    sidebarHtml: renderSidebarLinks(),
    modelBrowserHtml: renderModelsDirectory(req),
    mode: 'models',
    headLinks,
    keywords: instanceKeywords(profile, 'modelsKeywords', variables, [heading, 'model directory']),
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${heading} | ${app.name}`,
      description,
      url: absoluteUrlForRequest(req, canonicalPath),
    }],
  });
}

function renderFavoritesPage(req) {
  const app = appMetadata();
  const profile = seoProfile();
  const variables = { appName: app.name };
  const description = renderInstanceTemplate(
    profile.favoritesDescription,
    variables,
    'Saved favorite models, galleries, and images in {appName}.'
  );
  return renderSeoDocument(req, {
    title: `Favorites | ${app.name}`,
    description,
    canonicalPath: '/favorites',
    kicker: 'Favorites',
    heading: 'Saved Galleries and Images',
    sidebarHtml: renderSidebarLinks(),
    mode: 'favorites',
    keywords: instanceKeywords(profile, 'favoritesKeywords', variables, ['favorites', app.name]),
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `Favorites | ${app.name}`,
      description,
      url: absoluteUrlForRequest(req, '/favorites'),
    }],
  });
}

function renderModelPage(req, model) {
  const app = appMetadata();
  const profile = seoProfile();
  const modelUrl = absoluteUrlForRequest(req, modelRoutePath(model.id));
  const modelName = normalizeModelName(model.name);
  const variables = {
    appName: app.name,
    modelName,
    galleries: model.galleryCount,
    images: model.count,
  };
  const description = renderInstanceTemplate(
    profile.modelDescription,
    variables,
    '{modelName} has {galleries} galleries and {images} images on {appName}.'
  );
  return renderSeoDocument(req, {
    title: `${modelName} | ${app.name}`,
    description,
    canonicalPath: modelRoutePath(model.id),
    image: model.cover || '',
    kicker: modelName,
    heading: 'Galleries',
    sidebarHtml: renderSidebarLinks(model.id),
    galleryListHtml: renderModelGalleryCards(model),
    mode: 'model',
    keywords: instanceKeywords(profile, 'modelKeywords', variables, [modelName]),
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${modelName} galleries`,
      description,
      url: modelUrl,
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: (model.galleries || []).map((gallery, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          url: absoluteUrlForRequest(req, galleryRoutePath(model.id, gallery.name)),
          name: `Gallery ${gallery.name}`,
        })),
      },
    }],
  });
}

function renderGalleryPage(req, model, gallery) {
  const app = appMetadata();
  const profile = seoProfile();
  const galleryUrl = absoluteUrlForRequest(req, galleryRoutePath(model.id, gallery.name));
  const payload = galleryImagesResponse(model.id, gallery.name);
  const modelName = normalizeModelName(model.name);
  const variables = {
    appName: app.name,
    modelName,
    galleryName: gallery.name,
    images: gallery.count,
  };
  const description = renderInstanceTemplate(
    profile.galleryDescription,
    variables,
    'Gallery {galleryName} for {modelName} contains {images} images on {appName}.'
  );
  return renderSeoDocument(req, {
    title: `${modelName} / Gallery ${gallery.name} | ${app.name}`,
    description,
    canonicalPath: galleryRoutePath(model.id, gallery.name),
    image: gallery.cover || '',
    kicker: modelName,
    heading: `Gallery ${gallery.name}`,
    sidebarHtml: renderSidebarLinks(model.id),
    selectedGalleryBarHtml: renderSelectedGalleryBarHtml(model, gallery),
    imageGridHtml: renderGalleryImagesGrid(model, gallery),
    hasGallery: true,
    mode: 'model',
    keywords: instanceKeywords(profile, 'galleryKeywords', variables, [modelName, `gallery ${gallery.name}`]),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'ImageGallery',
        name: `${modelName} / Gallery ${gallery.name}`,
        description,
        url: galleryUrl,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: app.name,
            item: absoluteUrlForRequest(req, '/'),
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: modelName,
            item: absoluteUrlForRequest(req, modelRoutePath(model.id)),
          },
          {
            '@type': 'ListItem',
            position: 3,
            name: `Gallery ${gallery.name}`,
            item: galleryUrl,
          },
        ],
      },
      ...payload.images.slice(0, 20).map(image => ({
        '@context': 'https://schema.org',
        '@type': 'ImageObject',
        contentUrl: absoluteUrlForRequest(req, image.src),
        thumbnailUrl: absoluteUrlForRequest(req, image.thumb),
        name: image.name,
      })),
    ],
  });
}

function renderNotFoundPage(req) {
  return renderSeoDocument(req, {
    title: `Not Found | ${appMetadata().name}`,
    description: 'The requested page could not be found.',
    canonicalPath: req.url,
    metaRobots: 'noindex,follow',
    kicker: 'Missing',
    heading: 'Not Found',
    sidebarHtml: renderSidebarLinks(),
    galleryListHtml: '<div class="empty">Page not found.</div>',
    mode: 'home',
  });
}

function sitemapUrlsetXml(entries) {
  const lastmodXml = value => {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `<lastmod>${escapeHtml(date.toISOString())}</lastmod>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(url => `<url><loc>${escapeHtml(url.loc)}</loc>${lastmodXml(url.lastmod)}</url>`).join('\n')}
</urlset>`;
}

function renderSitemapIndex(req) {
  const maps = [
    { loc: absoluteUrlForRequest(req, '/sitemap-pages.xml'), lastmod: lastState.scannedAt || null },
    { loc: absoluteUrlForRequest(req, '/sitemap-models.xml'), lastmod: lastState.scannedAt || null },
    { loc: absoluteUrlForRequest(req, '/sitemap-galleries.xml'), lastmod: lastState.scannedAt || null },
  ];
  const lastmodXml = value => {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `<lastmod>${escapeHtml(date.toISOString())}</lastmod>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${maps.map(map => `<sitemap><loc>${escapeHtml(map.loc)}</loc>${lastmodXml(map.lastmod)}</sitemap>`).join('\n')}
</sitemapindex>`;
}

function renderPagesSitemap(req) {
  const directoryPages = [];
  const allModels = lastState.models || [];
  const pageCountAll = Math.max(1, Math.ceil(allModels.length / 60));
  for (let page = 1; page <= pageCountAll; page += 1) {
    directoryPages.push({ loc: absoluteUrlForRequest(req, modelsDirectoryPath('', page)), lastmod: lastState.scannedAt || null });
  }
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const count = allModels.filter(model => normalizeModelName(model.name).toUpperCase().startsWith(letter)).length;
    const totalPages = Math.max(1, Math.ceil(count / 60));
    if (!count) continue;
    for (let page = 1; page <= totalPages; page += 1) {
      directoryPages.push({ loc: absoluteUrlForRequest(req, modelsDirectoryPath(letter, page)), lastmod: lastState.scannedAt || null });
    }
  }
  return sitemapUrlsetXml([
    { loc: absoluteUrlForRequest(req, '/'), lastmod: lastState.scannedAt || null },
    ...directoryPages,
  ]);
}

function renderModelsSitemap(req) {
  return sitemapUrlsetXml(
    (lastState.models || []).map(model => ({
      loc: absoluteUrlForRequest(req, modelRoutePath(model.id)),
      lastmod: model.updatedAt || lastState.scannedAt || null,
    }))
  );
}

function renderGalleriesSitemap(req) {
  return sitemapUrlsetXml(
    (lastState.models || []).flatMap(model => (model.galleries || []).map(gallery => ({
      loc: absoluteUrlForRequest(req, galleryRoutePath(model.id, gallery.name)),
      lastmod: gallery.updatedAt || model.updatedAt || lastState.scannedAt || null,
    })))
  );
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(`event: state\ndata: ${JSON.stringify(stateNotice())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function shutdown(signal = 'SIGINT') {
  if (shuttingDown) {
    process.exit(0);
  }
  shuttingDown = true;
  if (!IS_WORKER) {
    console.log(`\n${signal} received. Stopping Simple Gallery...`);
  }

  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

  if (!IS_WORKER) {
    for (const res of sseClients) {
      try {
        res.write('event: close\ndata: {"message":"Server shutting down."}\n\n');
        res.end();
      } catch {
        // Ignore stale event clients during shutdown.
      }
    }
    sseClients.clear();

    for (const socket of sockets) socket.destroy();

    if (workerChild) {
      try {
        workerChild.kill('SIGTERM');
      } catch {
        // Ignore worker shutdown failures.
      }
    }

    if (dbBackupTimer) {
      clearTimeout(dbBackupTimer);
      dbBackupTimer = null;
    }

    if (dbHousekeepingTimer) {
      clearTimeout(dbHousekeepingTimer);
      dbHousekeepingTimer = null;
    }

    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      server.close();
    }

    flushTraffic();
  }
  try {
    db.close();
  } catch {
    // Ignore DB close errors during shutdown.
  }

  shutdownTimer = setTimeout(() => process.exit(0), 250);
}

function serveStatic(req, res) {
  const url = requestUrl(req);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Malformed URL');
    return;
  }
  const requested = decodedPath === '/' ? '/index.html' : decodedPath;

  if ((requested === '/admin.html' || requested === '/js/admin.js') && !isLocalhostRequest(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Admin is only available from localhost.');
    return;
  }

  const mediaPrefix = mediaUrlPrefix();
  const isMediaRequest = requested.startsWith(`${mediaPrefix}/`);
  const basePath = path.resolve(isMediaRequest ? mediaRoot() : ROOT);
  const relativeRequest = isMediaRequest ? requested.slice(mediaPrefix.length) : requested;
  const filePath = path.resolve(basePath, `.${relativeRequest}`);

  if (filePath !== basePath && !filePath.startsWith(`${basePath}${path.sep}`)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    markForegroundActivity(requested);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': requested.includes(`/${THUMB_DIR}/`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

server = http.createServer((req, res) => {
  const trafficIsLocal = isLocalhostRequest(req);
  const trafficCountry = trafficIsLocal ? null : countryForRemoteRequest(req);
  const trafficRequestIn = estimateRequestBytes(req);
  const trafficStartOut = Number(req.socket?.bytesWritten || 0);
  res.on('finish', () => {
    const requestIn = Math.max(0, trafficRequestIn);
    const responseOut = Math.max(0, Number(req.socket?.bytesWritten || 0) - trafficStartOut);
    if (trafficIsLocal) {
      trafficLocalInBytes += requestIn;
      trafficLocalOutBytes += responseOut;
    } else {
      trafficRemoteInBytes += requestIn;
      trafficRemoteOutBytes += responseOut;
      const current = trafficRemoteCountryBytes.get(trafficCountry || 'Unknown') || { inBytes: 0, outBytes: 0 };
      current.inBytes += requestIn;
      current.outBytes += responseOut;
      trafficRemoteCountryBytes.set(trafficCountry || 'Unknown', current);
    }
    if (++trafficDirty >= TRAFFIC_FLUSH_EVERY) {
      trafficDirty = 0;
      flushTraffic();
    }
  });
  const url = requestUrl(req);

  if (handleAuthRoute({
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
  }, req, res, url)) {
    return;
  }

  if (handleFavoritesRoute({
    db,
    readRequestBody,
    sendJson,
    requireUser,
    nowIso,
    favoritesResponse,
    favoriteImagesResponse,
    favoriteCountForUser,
    getGalleryById,
  }, req, res, url)) {
    return;
  }

  if (handleSeenRoute({
    db,
    readRequestBody,
    sendJson,
    requireUser,
    nowIso,
    getGalleryById,
    galleryRecordById,
    readImageFiles,
    seenSummaryForGallery,
    mediaRoot,
  }, req, res, url)) {
    return;
  }

  if (handleViewsRoute({
    readRequestBody,
    sendJson,
    recordView,
  }, req, res, url)) {
    return;
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    if (!isLocalhostRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Admin is only available from localhost.');
      return;
    }
    req.url = '/admin.html';
    serveStatic(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/admin/')) {
    if (!isLocalhostRequest(req)) {
      sendJson(res, 403, { error: 'Admin API is only available from localhost.' });
      return;
    }
    if (url.pathname === '/api/admin/import-status') {
      sendJson(res, 200, importSnapshot());
      return;
    }
    if (url.pathname === '/api/admin/state') {
      const payload = stateForUser(req);
      payload.app = appMetadata({ includePrivate: true });
      sendJson(res, 200, payload);
      return;
    }
    if (url.pathname === '/api/admin/app-settings' && req.method === 'POST') {
      readRequestBody(req)
        .then(body => {
          const payload = JSON.parse(body || '{}');
          if (Object.hasOwn(payload, 'versionLabel')) {
            const versionLabel = String(payload.versionLabel || '').trim().slice(0, 40) || DEFAULT_VERSION_LABEL;
            setVersionLabel(versionLabel);
          }
          if (Object.hasOwn(payload, 'lastSourceUrl')) {
            setAppSetting('last_source_url', String(payload.lastSourceUrl || '').trim().slice(0, 1000));
          }
          if (Object.hasOwn(payload, 'allModelsUrl')) {
            setAppSetting('all_models_url', String(payload.allModelsUrl || '').trim().slice(0, 1000));
          }
          if (Object.hasOwn(payload, 'autoRescanEnabled')) {
            setAppSetting('auto_rescan_enabled', payload.autoRescanEnabled ? '1' : '0');
          }
          if (Object.hasOwn(payload, 'autoRescanTime')) {
            setAppSetting('auto_rescan_time', normalizeAutoRescanTime(payload.autoRescanTime));
          }
          if (Object.hasOwn(payload, 'appName')) {
            setAppSetting('app_name', String(payload.appName || '').trim().slice(0, 120) || 'Simple Gallery');
          }
          if (Object.hasOwn(payload, 'appTagline')) {
            setAppSetting('app_tagline', String(payload.appTagline || '').trim().slice(0, 160));
          }
          if (Object.hasOwn(payload, 'adminName')) {
            setAppSetting('admin_name', String(payload.adminName || '').trim().slice(0, 120) || 'Gallery Admin');
          }
          if (Object.hasOwn(payload, 'contentRoot')) {
            setAppSetting('content_root', String(payload.contentRoot || '').trim().slice(0, 1000));
          }
          if (Object.hasOwn(payload, 'mediaUrlPrefix')) {
            const prefix = `/${String(payload.mediaUrlPrefix || '').trim().replace(/^\/+|\/+$/g, '')}`;
            setAppSetting('media_url_prefix', prefix === '/' ? '/media' : prefix.slice(0, 200));
          }
          if (Object.hasOwn(payload, 'sourceProfile')) {
            setAppSetting('source_profile', normalizedJsonSetting(payload.sourceProfile, 'Source profile'));
          }
          if (Object.hasOwn(payload, 'seoProfile')) {
            setAppSetting('seo_profile', normalizedJsonSetting(payload.seoProfile, 'SEO profile'));
          }
          scheduleAutoRescan();
          broadcast('state', stateNotice());
          sendJson(res, 200, { app: appMetadata({ includePrivate: true }) });
        })
        .catch(error => sendJson(res, 400, { error: error.message || 'Save settings failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/stop-after-current-model' && req.method === 'POST') {
      if (!importJob?.active) {
        sendJson(res, 409, { error: 'No active import.' });
        return;
      }
      requestWorker('stop-after-current-model')
        .then(snapshot => sendJson(res, 200, snapshot))
        .catch(error => sendJson(res, 409, { error: error.message || 'Stop request failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/refresh-gallery' && req.method === 'POST') {
      scanLibrary()
        .then(state => sendJson(res, 200, state))
        .catch(error => sendJson(res, 500, { error: error.message || 'Refresh failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/scanned-urls') {
      sendJson(res, 200, getScannedUrlPayload());
      return;
    }
    if (url.pathname === '/api/admin/url-audit') {
      sendJson(res, 200, auditSavedModelUrls());
      return;
    }
    if (url.pathname === '/api/admin/ignored-model-urls') {
      sendJson(res, 200, ignoredModelUrlsResponse());
      return;
    }
    if (url.pathname === '/api/admin/ignore-model-url' && req.method === 'POST') {
      readRequestBody(req)
        .then(body => {
          const payload = JSON.parse(body || '{}');
          const sourceUrl = String(payload.sourceUrl || '').trim();
          if (!sourceUrl) throw new Error('Missing URL.');
          ignoreModelUrl(sourceUrl, payload.reason || 'Ignored from URL audit.');
          const scanned = syncScannedUrlsFile();
          broadcast('scanned-urls', scanned);
          sendJson(res, 200, { ok: true, audit: auditSavedModelUrls(), ignored: ignoredModelUrlsResponse(), scanned });
        })
        .catch(error => sendJson(res, 400, { error: error.message || 'Ignore URL failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/unignore-model-url' && req.method === 'POST') {
      readRequestBody(req)
        .then(body => {
          const payload = JSON.parse(body || '{}');
          const sourceUrl = String(payload.sourceUrl || '').trim();
          if (!sourceUrl) throw new Error('Missing URL.');
          unignoreModelUrl(sourceUrl);
          const scanned = syncScannedUrlsFile();
          broadcast('scanned-urls', scanned);
          sendJson(res, 200, {
            ok: true,
            audit: auditSavedModelUrls(),
            ignored: ignoredModelUrlsResponse(),
            scanned,
          });
        })
        .catch(error => sendJson(res, 400, { error: error.message || 'Unignore URL failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/view-stats') {
      sendJson(res, 200, viewStatsResponse());
      return;
    }
    if (url.pathname === '/api/admin/users') {
      sendJson(res, 200, adminUsersResponse());
      return;
    }
    if (url.pathname === '/api/admin/import-errors') {
      sendJson(res, 200, loadImportErrors());
      return;
    }
    if (url.pathname === '/api/admin/import-errors/dismiss' && req.method === 'POST') {
      readRequestBody(req)
        .then(body => {
          const payload = JSON.parse(body || '{}');
          const id = Number(payload.id || 0);
          if (!id) throw new Error('Missing error id.');
          sendJson(res, 200, dismissImportError(id));
        })
        .catch(error => sendJson(res, 400, { error: error.message || 'Dismiss import error failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/import-errors/clear' && req.method === 'POST') {
      clearImportErrors();
      sendJson(res, 200, loadImportErrors());
      return;
    }
    if (url.pathname === '/api/admin/vacuum-db' && req.method === 'POST') {
      if (importJob?.active) {
        sendJson(res, 409, { error: 'Cannot vacuum while an import is running.' });
        return;
      }
      try {
        vacuumDatabase('manual');
        sendJson(res, 200, { ok: true, runtime: runtimeStats() });
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'Vacuum failed.' });
      }
      return;
    }
    if (url.pathname === '/api/admin/loaded-models') {
      sendJson(res, 200, loadedModelList || { sourceUrl: '', pageCount: 0, models: [] });
      return;
    }
    if (url.pathname === '/api/admin/load-model-list' && req.method === 'POST') {
      readRequestBody(req)
        .then(body => {
          const payload = JSON.parse(body || '{}');
          const sourceUrl = String(payload.url || '').trim();
          if (!sourceUrl) throw new Error('Missing URL.');
          return requestWorker('load-model-list', { url: sourceUrl });
        })
        .then(result => sendJson(res, 200, result))
        .catch(error => sendJson(res, 400, { error: error.message || 'Load failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/load-missing-models' && req.method === 'POST') {
      readRequestBody(req)
        .then(body => {
          const payload = JSON.parse(body || '{}');
          const sourceUrl = String(payload.url || '').trim();
          if (!sourceUrl) throw new Error('Missing URL.');
          return requestWorker('load-missing-models', { url: sourceUrl });
        })
        .then(result => sendJson(res, 200, result))
        .catch(error => sendJson(res, 400, { error: error.message || 'Find missing models failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/import' && req.method === 'POST') {
      readRequestBody(req)
        .then(body => {
          const payload = JSON.parse(body || '{}');
          const urls = Array.isArray(payload.urls) ? payload.urls.map(url => String(url).trim()).filter(Boolean) : [];
          const loaded = Boolean(payload.loaded);
          const sourceUrl = String(payload.url || '').trim();
          return requestWorker('import-start', {
            loaded,
            urls,
            url: sourceUrl,
          });
        })
        .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
        .catch(error => sendJson(res, 400, { error: error.message || 'Import failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/rescan-all' && req.method === 'POST') {
      requestWorker('rescan-all-start')
        .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
        .catch(error => sendJson(res, 400, { error: error.message || 'Rescan all failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/rescan-all/resume' && req.method === 'POST') {
      requestWorker('rescan-all-resume')
        .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
        .catch(error => sendJson(res, 400, { error: error.message || 'Resume Rescan All failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/rescan-all/pause' && req.method === 'POST') {
      requestWorker('rescan-all-pause')
        .then(snapshot => sendJson(res, 200, snapshot))
        .catch(error => sendJson(res, 409, { error: error.message || 'Pause Rescan All failed.' }));
      return;
    }
    if (url.pathname === '/api/admin/verify-known' && req.method === 'POST') {
      requestWorker('verify-known-start')
        .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
        .catch(error => sendJson(res, 400, { error: error.message || 'Verify known failed.' }));
      return;
    }
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  if (url.pathname === '/api/state') {
    sendJson(res, 200, stateForUser(req));
    return;
  }
  if (url.pathname === '/api/gallery') {
    const modelName = String(url.searchParams.get('model') || '');
    const galleryName = String(url.searchParams.get('gallery') || '');
    sendJson(res, 200, galleryImagesResponseForUser(req, modelName, galleryName));
    return;
  }
  if (url.pathname === '/api/rescan' && req.method === 'POST') {
    scanLibrary().then(state => sendJson(res, 200, state));
    return;
  }
  if (url.pathname === '/api/events') {
    handleEvents(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/robots.txt') {
      sendText(
        res,
        200,
        `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\n\nSitemap: ${absoluteUrlForRequest(req, '/sitemap.xml')}\n`
      );
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      sendText(res, 200, renderSitemapIndex(req), 'application/xml; charset=utf-8');
      return;
    }
    if (url.pathname === '/sitemap-pages.xml') {
      sendText(res, 200, renderPagesSitemap(req), 'application/xml; charset=utf-8');
      return;
    }
    if (url.pathname === '/sitemap-models.xml') {
      sendText(res, 200, renderModelsSitemap(req), 'application/xml; charset=utf-8');
      return;
    }
    if (url.pathname === '/sitemap-galleries.xml') {
      sendText(res, 200, renderGalleriesSitemap(req), 'application/xml; charset=utf-8');
      return;
    }
    if (url.pathname === '/') {
      sendHtml(res, 200, renderHomePage(req));
      return;
    }
    if (url.pathname === '/models') {
      sendHtml(res, 200, renderModelsPage(req));
      return;
    }
    if (url.pathname === '/favorites') {
      sendHtml(res, 200, renderFavoritesPage(req));
      return;
    }

    const routeParts = url.pathname.split('/').filter(Boolean).map(part => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

    if (routeParts[0] === 'model' && routeParts[1] && routeParts.length === 2) {
      const model = (lastState.models || []).find(item => item.id === routeParts[1]);
      sendHtml(res, model ? 200 : 404, model ? renderModelPage(req, model) : renderNotFoundPage(req));
      return;
    }

    if (routeParts[0] === 'model' && routeParts[1] && routeParts[2] === 'gallery' && routeParts[3] && routeParts.length === 4) {
      const model = (lastState.models || []).find(item => item.id === routeParts[1]);
      const gallery = model?.galleries?.find(item => item.name === routeParts[3]);
      sendHtml(res, model && gallery ? 200 : 404, model && gallery ? renderGalleryPage(req, model, gallery) : renderNotFoundPage(req));
      return;
    }
  }

  serveStatic(req, res);
});

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

server.on('error', (error) => {
  console.error(`[startup] Server listen failed: ${error?.message || error}`);
  setImmediate(() => process.exit(1));
});

if (IS_WORKER) {
  startWorkerProcess();
} else {
  try {
    console.log('[startup] Loading cached library state from database...');
    const hydrateStartedAt = Date.now();
    hydrateStateFromDatabase();
    console.log(`[startup] Cached DB state loaded in ${Date.now() - hydrateStartedAt}ms.`);
  } catch (error) {
    console.error(`[startup] Cached DB state load failed: ${error?.message || error}`);
    lastState = {
      ...lastState,
      status: 'error',
      message: error.message || 'Cached DB state load failed.',
      runtime: runtimeStats(),
    };
  }
  scheduleDatabaseHousekeeping();
  scheduleAutoRescan('startup');
  scheduleDbBackup('startup');
  server.listen(PORT, () => {
    console.log(`Simple Gallery running at http://localhost:${PORT}/`);
    setTimeout(() => {
      try {
        cleanupDatabaseHousekeeping('startup-deferred');
      } catch (error) {
        console.error(`[db-cleanup] Deferred startup cleanup failed: ${error?.message || error}`);
      }
    }, 5000);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
