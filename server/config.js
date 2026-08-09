'use strict';

const fs = require('fs');
const path = require('path');

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const APP_ROOT = path.join(__dirname, '..');
const VERSION_PATH = path.join(APP_ROOT, 'VERSION');
const PORT = Number(process.env.PORT || 3020);
const ROOT = path.join(APP_ROOT, 'public');
const DEFAULT_MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || path.join(ROOT, 'media'));
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(APP_ROOT, 'gallery.db'));
const DB_BACKUP_DIR = path.resolve(process.env.DB_BACKUP_DIR || path.join(APP_ROOT, 'db-backups'));
const THUMB_DIR = '.thumbs';
const PROCESS_ROLE = process.env.SIMPLE_GALLERY_ROLE === 'worker' ? 'worker' : 'web';
const IS_WORKER = PROCESS_ROLE === 'worker';
const THUMB_SIZE = Number(process.env.THUMB_SIZE || 420);
const THUMB_CONCURRENCY = Number(process.env.THUMB_CONCURRENCY || (IS_WORKER ? 1 : 2));
const IMPORT_CONCURRENCY = Number(process.env.IMPORT_CONCURRENCY || 2);
const MODEL_LIST_DISCOVERY_CONCURRENCY = Number(process.env.MODEL_LIST_DISCOVERY_CONCURRENCY || 4);
const IMPORT_FETCH_RETRIES = Number(process.env.IMPORT_FETCH_RETRIES || 3);
const IMPORT_FETCH_TIMEOUT_MS = Number(process.env.IMPORT_FETCH_TIMEOUT_MS || 30000);
const IMPORT_LOG_LIMIT = Number(process.env.IMPORT_LOG_LIMIT || 120);
const IMPORT_PROGRESS_MIN_MS = Number(process.env.IMPORT_PROGRESS_MIN_MS || 1000);
const IMPORT_FETCH_BACKOFF_BASE_MS = Number(process.env.IMPORT_FETCH_BACKOFF_BASE_MS || 1500);
const IMPORT_FETCH_BACKOFF_MAX_MS = Number(process.env.IMPORT_FETCH_BACKOFF_MAX_MS || 20000);
const AUTO_RESCAN_DEFAULT_TIME = '01:45';
const AUTO_RESCAN_RETRY_MS = 15 * 60 * 1000;
const DB_BACKUP_DEFAULT_TIME = '02:30';
const DB_BACKUP_RETENTION_DAYS = 30;
const DEFAULT_VERSION_LABEL = fs.readFileSync(VERSION_PATH, 'utf8').trim();
if (!DEFAULT_VERSION_LABEL) throw new Error('VERSION must contain an application version.');
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;
const FOREGROUND_ACTIVITY_WINDOW_MS = positiveNumber(process.env.FOREGROUND_ACTIVITY_WINDOW_MS, 6000);
const IMPORT_FOREGROUND_PAUSE_MS = positiveNumber(process.env.IMPORT_FOREGROUND_PAUSE_MS, 900);
const VIEW_DEDUPE_MS = positiveNumber(process.env.VIEW_DEDUPE_MS, 30000);
const VIEW_DEDUPE_RETENTION_MS = Math.max(
  VIEW_DEDUPE_MS * 20,
  positiveNumber(process.env.VIEW_DEDUPE_RETENTION_MS, 60 * 60 * 1000)
);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

module.exports = {
  APP_ROOT,
  VERSION_PATH,
  PORT,
  ROOT,
  DEFAULT_MEDIA_ROOT,
  DB_PATH,
  DB_BACKUP_DIR,
  THUMB_DIR,
  PROCESS_ROLE,
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
  positiveNumber,
};
