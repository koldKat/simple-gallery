#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const geoip = require('geoip-lite');
console.log('[startup] Opening database...');
const db = require('./server/db/connection');
const { initializeSchema } = require('./server/db/schema');
const { createDatabaseMigrations } = require('./server/db/migrations');
console.log('[startup] Database opened.');
const {
  readRequestBody,
  sendHtml,
  sendJson,
  sendText,
} = require('./server/http-utils');
const {
  escapeHtml,
  escapeJsonForHtml,
  formatDateLabel,
  formatCount,
  renderStatsBreakdown,
  seoKeywords,
  renderInstanceTemplate,
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
const { handleAdminRoute } = require('./server/routes/admin');
const { handleSiteRoute } = require('./server/routes/site');
const { createSitemapRenderer } = require('./server/sitemap');
const { createStaticHandler } = require('./server/static-handler');
const { createBackupService } = require('./server/backup');
const { createTrafficService } = require('./server/traffic');
const { createPageRenderer } = require('./server/page-renderer');
const { renderWebAppManifest } = require('./server/web-app-manifest');
const { createAuthService } = require('./server/auth-service');
const { createSettingsStore } = require('./server/settings-store');
const { createViewTracker } = require('./server/view-tracker');
const {
  createMediaLibrary,
  sanitizeFolderName,
  normalizeModelName,
  sanitizeFileBase,
} = require('./server/media-library');
const { createImportNetwork } = require('./server/import-network');
const { createImportErrorStore } = require('./server/import-errors');
const { createAdminReporting } = require('./server/admin-reporting');
const { createDatabaseHousekeeping } = require('./server/db-housekeeping');
const { createSourceUrlRegistry } = require('./server/source-url-registry');
const { createUserLibraryService } = require('./server/user-library');
const { createImportStateStore } = require('./server/import-state-store');
const { createImportLibrary } = require('./server/import-library');
const { createThumbnailService } = require('./server/thumbnail-service');
const { createAutoRescanService } = require('./server/auto-rescan-service');
const { createWorkerService } = require('./server/worker-service');
const { createWorkerCoordinator } = require('./server/worker-coordinator');
const { createSourceProfileService } = require('./server/source-profile');
const { createServerEventBus } = require('./server/event-bus');
const { createGalleryProviderRegistry } = require('./server/gallery-provider-registry');
const { createDirectGalleryImporter } = require('./server/direct-gallery-importer');
const { createSourceModelLoader } = require('./server/source-model-loader');
const { createGalleryTransfer } = require('./server/gallery-transfer');
const { createImportProgress } = require('./server/import-progress');
const { createModelImporter } = require('./server/model-importer');
const { createImportRunner } = require('./server/import-runner');
const { createGalleryVerifier } = require('./server/gallery-verifier');
const { createDatabaseRuntime, withBusyRetry } = require('./server/database-runtime');
const { createLibraryStateService } = require('./server/library-state');
const { createLibraryRepository } = require('./server/library-repository');
const { createLibraryScanner, emptyTotals, addTotals } = require('./server/library-scanner');
const { createRescanCheckpoints } = require('./server/rescan-checkpoints');
const { createImportPathLock } = require('./server/import-path-lock');
const {
  canonicalRemoteUrl,
  canonicalPageUrl,
  createSourceParser,
} = require('./server/source-parser');
const {
  ALL_WEEKDAYS: AUTO_RESCAN_ALL_DAYS,
  normalizeTime,
  parseWeekdays: parseAutoRescanDays,
  nextWeeklyDate,
} = require('./server/schedule');
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
  STATIC_READ_CONCURRENCY,
  STATIC_READ_QUEUE_LIMIT,
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

const sockets = new Set();
let importJob = null;
let stopAfterCurrentModelRequested = false;
let pauseRescanAllRequested = false;
let lastState = emptyState('starting');
const activeImportGalleryPaths = new Set();
const importPathLock = createImportPathLock({ nowIso });
let lastForegroundActivityAt = 0;
let shuttingDown = false;
let shutdownTimer = null;
let server = null;
const backupService = createBackupService({
  db,
  backupDirectory: DB_BACKUP_DIR,
  defaultTime: DB_BACKUP_DEFAULT_TIME,
  retentionDays: DB_BACKUP_RETENTION_DAYS,
  isWorker: IS_WORKER,
});
const dbHousekeeping = createDatabaseHousekeeping({
  db,
  retentionMs: VIEW_DEDUPE_RETENTION_MS,
  isWorker: IS_WORKER,
});
const workerService = createWorkerService({
  isWorker: IS_WORKER,
  scriptPath: __filename,
  onEvent: message => workerCoordinator.handleEvent(message),
});
const {
  sendFromWorker: sendWorkerMessage,
  request: requestWorker,
} = workerService;
const serverEventBus = createServerEventBus({
  isWorker: IS_WORKER,
  sendWorkerMessage,
  getStateNotice: () => stateNotice(),
  getViewStats: () => viewStatsResponse(),
});
const {
  broadcast,
  close: closeServerEvents,
  handleEvents,
  scheduleScannedUrls: scheduleScannedUrlsBroadcast,
  scheduleViewStats: scheduleViewStatsBroadcast,
} = serverEventBus;
const {
  getSafe: appSettingSafe,
  getJson: jsonAppSetting,
  get: appSetting,
  set: setAppSetting,
  setVersion: setVersionLabel,
  normalizeJson: normalizedJsonSetting,
} = createSettingsStore({
  db,
  versionPath: VERSION_PATH,
  nowIso,
  withBusyRetry,
});
const sourceProfileService = createSourceProfileService({ getJson: jsonAppSetting });
const {
  get: sourceProfile,
  getSeo: seoProfile,
  hostAllowed: sourceHostAllowed,
  isVerifiableGalleryUrl,
  requireProfile: requireSourceProfile,
  sourceSlug,
} = sourceProfileService;
const galleryProviderRegistry = createGalleryProviderRegistry({
  getProfile: sourceProfile,
  canonicalRemoteUrl,
});
const autoRescanService = createAutoRescanService({
  getSetting: appSetting,
  normalizeTime,
  parseWeekdays: parseAutoRescanDays,
  nextWeeklyDate,
  allWeekdays: AUTO_RESCAN_ALL_DAYS,
  defaultTime: AUTO_RESCAN_DEFAULT_TIME,
  retryMs: AUTO_RESCAN_RETRY_MS,
  isWorker: IS_WORKER,
  getActivity: () => ({ scanInFlight: libraryScanner.isScanning(), importActive: Boolean(importJob?.active) }),
  requestWorker,
  broadcastState: () => broadcast('state', stateNotice()),
});
const {
  normalizeTime: normalizeAutoRescanTime,
  days: autoRescanDaysSetting,
  schedule: scheduleAutoRescan,
} = autoRescanService;
const trafficService = createTrafficService({
  getSetting: appSettingSafe,
  setSetting: setAppSetting,
  geoLookup: ip => geoip.lookup(ip),
  isWorker: IS_WORKER,
});
const {
  upsertModelRecord,
  upsertGalleryRecord,
  galleryDbId,
  galleryDbRecord,
  galleryRecordsForModel,
  favoriteSetsForUser,
  seenDataForUser,
  unseenStatsForUser,
  seenImagesForGallery,
  gallerySeenSummary,
  getGalleryById,
  galleryRecordById,
  seenSummaryForGallery,
  cleanupSeenRecordsForGallery,
} = createLibraryRepository({
  db,
  nowIso,
  withBusyRetry,
  normalizeModelName,
  canonicalRemoteUrl,
  getState: () => lastState,
});
const {
  hashToken,
  hashPassword,
  verifyPassword,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  currentUser,
  favoriteCountForUser,
  publicUser,
  actorKeyForRequest,
  requireUser,
  createSession,
} = createAuthService({
  db,
  sendJson,
  sessionMaxAgeMs: SESSION_MAX_AGE_MS,
});
const { record: recordView } = createViewTracker({
  db,
  actorKeyForRequest,
  getGalleryById,
  scheduleStatsBroadcast: scheduleViewStatsBroadcast,
  dedupeMs: VIEW_DEDUPE_MS,
  nowIso,
});
const {
  toUrl,
  safeName,
  readDirs,
  readImageFiles,
  mkdirp,
  removeFile,
  cleanupStaleThumbs,
  removeEmptyThumbDir,
  fileSize,
  galleryStorageStats,
  galleryCoverUrl,
} = createMediaLibrary({
  mediaRoot,
  mediaUrlPrefix,
  thumbDirectory: THUMB_DIR,
  imageExtensions: IMAGE_EXTS,
});
const {
  checkpointWal,
  runtimeStats,
  vacuumDatabase,
} = createDatabaseRuntime({
  db,
  dbPath: DB_PATH,
  fileSize,
  trafficSnapshot: () => trafficService.snapshot(),
});
const {
  migrateGallerySourceUrlUniqueness,
  repairRenamedGalleryForeignKeys,
  migrateGalleryStorageColumns,
  migrateGalleryProviderColumn,
  migrateUserPreferenceColumns,
  backfillGalleryStorageColumns,
  repairShiftedRecoveredGalleryRows,
} = createDatabaseMigrations({ db, mediaRoot, galleryStorageStats });
const {
  getImportModelRecord,
  rememberImportedGallery,
  hydrateImportRecordFromManifests,
  nextGalleryName,
  findExistingGalleryForSource,
  repairGallerySequence,
} = createImportLibrary({
  db,
  readDirs,
  readImageFiles,
  mkdirp,
  canonicalRemoteUrl,
  upsertModelRecord,
  upsertGalleryRecord,
  nowIso,
});
const thumbnailService = createThumbnailService({
  db,
  mediaRoot,
  mkdirp,
  fileSize,
  galleryDbId,
  thumbSize: THUMB_SIZE,
  concurrency: THUMB_CONCURRENCY,
  isWorker: IS_WORKER,
  getState: () => lastState,
  setState: state => { lastState = state; },
  runtimeStats,
  broadcast,
  stateNotice,
  shouldAutoRescan: () => !libraryScanner.isScanning() && !importJob?.active,
  scanLibrary: () => libraryScanner.scan(),
});
const { needsThumb, enqueue: enqueueThumb } = thumbnailService;
const {
  dedupeScannedGalleries,
  gallerySummary,
  hydrateFromDatabase: hydrateCachedLibraryState,
  inferGalleryKey,
  latestGallerySummaries,
} = createLibraryStateService({
  db,
  canonicalRemoteUrl,
  galleryCoverUrl,
  mediaUrlPrefix,
  sourceSlug,
  emptyState,
  emptyTotals,
  addTotals,
  appSetting,
  nowIso,
  runtimeStats,
});
const {
  favoriteImagesResponse,
  favoritesResponse,
  galleryImagesResponse,
  galleryImagesResponseForUser,
  userStateForRequest,
  stateForUser,
} = createUserLibraryService({
  db,
  getState: () => lastState,
  mediaRoot,
  thumbDirectory: THUMB_DIR,
  readImageFiles,
  safeName,
  toUrl,
  currentUser,
  galleryDbId,
  favoriteSetsForUser,
  seenImagesForGallery,
  publicUser,
  seenDataForUser,
  gallerySeenSummary,
  unseenStatsForUser,
  runtimeStats,
  appMetadata,
});
const {
  sleep,
  fetchText,
  downloadImage,
  mapLimit,
} = createImportNetwork({
  getSourceProfile: requireSourceProfile,
  mkdirp,
  imageExtensions: IMAGE_EXTS,
  retries: IMPORT_FETCH_RETRIES,
  timeoutMs: IMPORT_FETCH_TIMEOUT_MS,
  backoffBaseMs: IMPORT_FETCH_BACKOFF_BASE_MS,
  backoffMaxMs: IMPORT_FETCH_BACKOFF_MAX_MS,
});
const {
  load: loadImportErrors,
  clear: clearImportErrors,
  dismiss: dismissImportError,
  record: recordImportError,
} = createImportErrorStore({
  db,
  broadcast,
  getImportJob: () => importJob,
  normalizeModelName,
  upsertModelRecord,
  galleryDbId,
  nowIso,
});
const {
  viewStats: viewStatsResponse,
  users: adminUsersResponse,
  modelOptions: adminModelOptionsResponse,
} = createAdminReporting({
  db,
  getRuntimeStats: runtimeStats,
  nowIso,
});
const {
  snapshot: syncScannedUrlsFile,
  ignore: ignoreModelUrl,
  unignore: unignoreModelUrl,
  ignored: ignoredModelUrlsResponse,
  audit: auditSavedModelUrls,
} = createSourceUrlRegistry({
  db,
  canonicalRemoteUrl,
  normalizeModelName,
  sanitizeFolderName,
  readDirs,
  mediaRoot,
  getVisibleModels: () => lastState.models || [],
  nowIso,
});
const getScannedUrlPayload = syncScannedUrlsFile;
const {
  empty: emptyImportDb,
  load: loadImportDb,
  save: saveImportDb,
} = createImportStateStore({
  db,
  upsertModelRecord,
  upsertGalleryRecord,
  normalizeModelName,
  canonicalRemoteUrl,
  nowIso,
  sourceUrlSnapshot: syncScannedUrlsFile,
  scheduleSourceUrlBroadcast: scheduleScannedUrlsBroadcast,
});
const libraryScanner = createLibraryScanner({
  mediaRoot,
  mediaUrlPrefix,
  thumbDirectory: THUMB_DIR,
  readDirs,
  readImageFiles,
  safeName,
  mkdirp,
  cleanupStaleThumbs,
  removeEmptyThumbDir,
  needsThumb,
  enqueueThumb,
  toUrl,
  fileSize,
  galleryDbRecord,
  galleryRecordsForModel,
  upsertModelRecord,
  upsertGalleryRecord,
  cleanupSeenRecordsForGallery,
  normalizeModelName,
  sourceSlug,
  repairGallerySequence,
  loadImportDb,
  saveImportDb,
  activeImportGalleryPaths,
  isImportPathActive: importPathLock.isActive,
  modelHasActiveImportPath: importPathLock.modelHasActive,
  dedupeScannedGalleries,
  gallerySummary,
  latestGallerySummaries,
  emptyState,
  runtimeStats,
  getState: () => lastState,
  setState: state => { lastState = state; },
  broadcastState: () => broadcast('state', stateNotice()),
  isWorker: IS_WORKER,
  sendWorkerMessage,
  sleep,
  nowIso,
});
const {
  scan: scanLibrary,
  refreshModel: refreshModelInState,
} = libraryScanner;
const {
  metadata: lastRescanAllMetadata,
  recordStarted: recordRescanAllStarted,
  recordFinished: recordRescanAllFinished,
  load: loadRescanAllCheckpoint,
  save: saveRescanAllCheckpoint,
  clear: clearRescanAllCheckpoint,
  fallback: fallbackRescanAllCheckpoint,
  resumable: resumableRescanAllCheckpoint,
} = createRescanCheckpoints({
  db,
  getSetting: appSetting,
  setSetting: setAppSetting,
  withBusyRetry,
  getImportJob: () => importJob,
  getSourceUrls: getScannedUrlPayload,
  canonicalRemoteUrl,
  nowIso,
});
const importProgress = createImportProgress({
  getJob: () => importJob,
  isStopRequested: () => stopAfterCurrentModelRequested,
  isPauseRequested: () => pauseRescanAllRequested,
  resumableCheckpoint: resumableRescanAllCheckpoint,
  lastRescanMetadata: lastRescanAllMetadata,
  broadcast,
  progressMinMs: IMPORT_PROGRESS_MIN_MS,
  logLimit: IMPORT_LOG_LIMIT,
  nowIso,
});
const {
  snapshot: importSnapshot,
  update: updateImport,
  append: appendImportLog,
} = importProgress;

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

function isLocalhostRequest(req) {
  const remote = req.socket.remoteAddress || '';
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && localHosts.has(host);
}

const {
  extractModelName,
  extractModelLinks,
  extractPaginationUrls,
  validateSourceUrl,
  buildLetterModelListUrls,
  extractSourceGalleries,
  extractDetailUrls,
  extractLargeImageUrl,
} = createSourceParser({
  getProfile: requireSourceProfile,
  sourceHostAllowed,
  normalizeModelName,
});
const sourceModelLoader = createSourceModelLoader({
  requireSourceProfile,
  validateSourceUrl,
  fetchText,
  extractPaginationUrls,
  extractModelLinks,
  canonicalPageUrl,
  canonicalRemoteUrl,
  loadImportDb,
  readDirs,
  mediaRoot,
  normalizeModelName,
  sanitizeFolderName,
  broadcast,
  nowIso,
});
const {
  load: loadSourceModelList,
  remove: removeLoadedModel,
  broadcast: broadcastLoadedModels,
} = sourceModelLoader;
const galleryTransfer = createGalleryTransfer({
  mapLimit,
  fetchText,
  extractLargeImageUrl,
  downloadImage,
  sanitizeFileBase,
  concurrency: IMPORT_CONCURRENCY,
  shouldPause: () => IS_WORKER
    && importJob?.mode === 'all'
    && Date.now() - Number(lastForegroundActivityAt || 0) < FOREGROUND_ACTIVITY_WINDOW_MS,
  foregroundPauseMs: IMPORT_FOREGROUND_PAUSE_MS,
});
const {
  pauseForForegroundBrowsing,
  resolveImageUrls: resolveGalleryImageUrls,
  downloadImages: downloadGalleryImagesPartial,
} = galleryTransfer;
const { importModel: importSourceModelIntoCurrentJob } = createModelImporter({
  getJob: () => importJob,
  removeLoadedModel,
  requireSourceProfile,
  validateSourceUrl,
  canonicalRemoteUrl,
  updateImport,
  fetchText,
  extractModelName,
  sanitizeFolderName,
  mediaRoot,
  mkdirp,
  loadImportDb,
  getImportModelRecord,
  hydrateImportRecordFromManifests,
  extractSourceGalleries,
  saveImportDb,
  galleryStorageStats,
  pauseForForegroundBrowsing,
  findExistingGalleryForSource,
  rememberImportedGallery,
  readImageFiles,
  nextGalleryName,
  activeImportGalleryPaths,
  markImportPath: importPathLock.mark,
  clearImportPath: importPathLock.clear,
  extractDetailUrls,
  resolveGalleryImageUrls,
  downloadGalleryImagesPartial,
  recordImportError,
  refreshModelInState,
  recordRescanAllFinished,
  importSnapshot,
  nowIso,
});
const importRunner = createImportRunner({
  getJob: () => importJob,
  setJob: job => { importJob = job; },
  getStopRequested: () => stopAfterCurrentModelRequested,
  setStopRequested: value => { stopAfterCurrentModelRequested = Boolean(value); },
  getPauseRequested: () => pauseRescanAllRequested,
  setPauseRequested: value => { pauseRescanAllRequested = Boolean(value); },
  canonicalRemoteUrl,
  resetProgressThrottle: importProgress.resetThrottle,
  clearImportErrors,
  nowIso,
  recordRescanAllStarted,
  saveRescanAllCheckpoint,
  broadcast,
  importSnapshot,
  broadcastLoadedModels,
  pauseForForegroundBrowsing,
  importModel: importSourceModelIntoCurrentJob,
  updateImport,
  skipNextThumbAutoRescan: thumbnailService.skipNextAutoRescan,
  clearRescanAllCheckpoint,
  recordRescanAllFinished,
  getScannedUrlPayload,
  resumableRescanAllCheckpoint,
  getLoadedModelList: sourceModelLoader.get,
});
const {
  importSources: importSourceModels,
  importOne: importSourceModel,
  importLoaded: importLoadedModels,
  importAll: importAllScannedUrls,
  resumeAll: resumeRescanAll,
} = importRunner;
const { verify: verifyKnownGalleries } = createGalleryVerifier({
  db,
  getJob: () => importJob,
  setJob: job => { importJob = job; },
  getStopRequested: () => stopAfterCurrentModelRequested,
  setStopRequested: value => { stopAfterCurrentModelRequested = Boolean(value); },
  resetProgressThrottle: importProgress.resetThrottle,
  clearImportErrors,
  isVerifiableGalleryUrl,
  nowIso,
  updateImport,
  fetchText,
  extractDetailUrls,
  mediaRoot,
  galleryStorageStats,
  activeImportGalleryPaths,
  markImportPath: importPathLock.mark,
  clearImportPath: importPathLock.clear,
  mkdirp,
  resolveGalleryImageUrls,
  downloadGalleryImagesPartial,
  recordImportError,
  refreshModelInState,
  importSnapshot,
  galleryProviderRegistry,
});
const { importGallery: importDirectGallery } = createDirectGalleryImporter({
  db,
  getJob: () => importJob,
  setJob: job => { importJob = job; },
  resetProgressThrottle: importProgress.resetThrottle,
  clearImportErrors,
  galleryProviderRegistry,
  canonicalRemoteUrl,
  fetchText,
  mediaRoot,
  mkdirp,
  loadImportDb,
  saveImportDb,
  getImportModelRecord,
  hydrateImportRecordFromManifests,
  findExistingGalleryForSource,
  nextGalleryName,
  rememberImportedGallery,
  activeImportGalleryPaths,
  markImportPath: importPathLock.mark,
  clearImportPath: importPathLock.clear,
  downloadGalleryImagesPartial,
  galleryStorageStats,
  refreshModelInState,
  recordImportError,
  updateImport,
  importSnapshot,
  nowIso,
});
const workerCoordinator = createWorkerCoordinator({
  workerService,
  sourceModelLoader,
  getImportJob: () => importJob,
  setImportJob: job => { importJob = job; },
  getState: () => lastState,
  setState: state => { lastState = state; },
  setPauseRequested: value => { pauseRescanAllRequested = Boolean(value); },
  setStopRequested: value => { stopAfterCurrentModelRequested = Boolean(value); },
  setForegroundActivity: at => { lastForegroundActivityAt = Math.max(lastForegroundActivityAt, at); },
  broadcast,
  addTotals,
  emptyTotals,
  latestGallerySummaries,
  runtimeStats,
  stateNotice,
  nowIso,
  recordImportError,
  updateImport,
  importSnapshot,
  loadSourceModelList,
  importLoadedModels,
  importSourceModels,
  importSourceModel,
  importAllScannedUrls,
  resumeRescanAll,
  verifyKnownGalleries,
  importDirectGallery,
});

function nowIso() {
  return new Date().toISOString();
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
    autoRescanDays: autoRescanDaysSetting(),
    nextAutoRescanAt: autoRescanService.getNextAt(),
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


console.log('[startup] Initializing database schema...');
initializeSchema({ db, withBusyRetry, defaultVersionLabel: DEFAULT_VERSION_LABEL, nowIso });
console.log('[startup] Loading traffic counters...');
trafficService.load();
console.log('[startup] Running database migrations...');
migrateGallerySourceUrlUniqueness();
migrateUserPreferenceColumns();
migrateGalleryStorageColumns();
migrateGalleryProviderColumn();
repairRenamedGalleryForeignKeys();
repairShiftedRecoveredGalleryRows();
if (!IS_WORKER) {
  console.log('[startup] Checking cached gallery storage metadata...');
  backfillGalleryStorageColumns();
}
console.log('[startup] Database initialization complete.');



function markForegroundActivity(requestedPath = '') {
  if (IS_WORKER) return;
  const normalized = String(requestedPath || '').toLowerCase();
  if (!normalized.startsWith(`${mediaUrlPrefix().toLowerCase()}/`)) return;
  if (!IMAGE_EXTS.has(path.extname(normalized))) return;
  lastForegroundActivityAt = Date.now();
  workerService.notifyForeground(lastForegroundActivityAt);
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

function startWorkerProcess() {
  workerCoordinator.start();
}
const {
  renderHomePage,
  renderModelsPage,
  renderFavoritesPage,
  renderModelPage,
  renderGalleryPage,
  renderNotFoundPage,
} = createPageRenderer({
  appMetadata,
  seoProfile,
  normalizeModelName,
  galleryImagesResponse,
  getState: () => lastState,
});

const {
  renderIndex: renderSitemapIndex,
  renderPages: renderPagesSitemap,
  renderModels: renderModelsSitemap,
  renderGalleries: renderGalleriesSitemap,
} = createSitemapRenderer({
  escapeHtml,
  absoluteUrlForRequest,
  modelRoutePath,
  galleryRoutePath,
  modelsDirectoryPath,
  normalizeModelName,
  getState: () => lastState,
});

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
  thumbnailService.stop();
  autoRescanService.stop();
  workerService.stop();

  if (!IS_WORKER) {
    closeServerEvents();

    for (const socket of sockets) socket.destroy();

    backupService.stop();

    dbHousekeeping.stop();

    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      server.close();
    }

    trafficService.flush();
  }
  try {
    db.close();
  } catch {
    // Ignore DB close errors during shutdown.
  }

  shutdownTimer = setTimeout(() => process.exit(0), 250);
}

const serveStatic = createStaticHandler({
  requestUrl,
  isLocalhostRequest,
  mediaUrlPrefix,
  mediaRoot,
  publicRoot: ROOT,
  thumbDirectory: THUMB_DIR,
  mimeTypes: MIME,
  markForegroundActivity,
  maxConcurrentReads: STATIC_READ_CONCURRENCY,
  maxQueuedReads: STATIC_READ_QUEUE_LIMIT,
});

const adminRouteContext = {
  isLocalhostRequest,
  sendJson,
  readRequestBody,
  importSnapshot,
  appMetadata,
  getState: () => lastState,
  parseAutoRescanDays,
  defaultVersionLabel: DEFAULT_VERSION_LABEL,
  setVersionLabel,
  setAppSetting,
  normalizeAutoRescanTime,
  normalizedJsonSetting,
  scheduleAutoRescan,
  broadcast,
  stateNotice,
  getImportJob: () => importJob,
  requestWorker,
  scanLibrary,
  getScannedUrlPayload,
  auditSavedModelUrls,
  ignoredModelUrlsResponse,
  ignoreModelUrl,
  unignoreModelUrl,
  syncScannedUrlsFile,
  viewStatsResponse,
  adminUsersResponse,
  adminModelOptionsResponse,
  loadImportErrors,
  dismissImportError,
  clearImportErrors,
  vacuumDatabase,
  runtimeStats,
  getLoadedModelList: sourceModelLoader.get,
};
const siteRouteContext = {
  sendJson,
  sendHtml,
  sendText,
  stateForUser,
  userStateForRequest,
  galleryImagesResponseForUser,
  handleEvents,
  absoluteUrlForRequest,
  renderSitemapIndex,
  renderPagesSitemap,
  renderModelsSitemap,
  renderGalleriesSitemap,
  renderHomePage,
  renderModelsPage,
  renderFavoritesPage,
  renderModelPage,
  renderGalleryPage,
  renderNotFoundPage,
  renderWebAppManifest: () => renderWebAppManifest(appMetadata()),
  getState: () => lastState,
};

server = http.createServer((req, res) => {
  const trafficIsLocal = isLocalhostRequest(req);
  trafficService.track(req, res, trafficIsLocal);
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
  if (handleAdminRoute(adminRouteContext, req, res, url)) return;

  if (handleSiteRoute(siteRouteContext, req, res, url)) return;

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
    lastState = hydrateCachedLibraryState();
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
  dbHousekeeping.schedule();
  scheduleAutoRescan('startup');
  backupService.schedule('startup');
  server.listen(PORT, () => {
    console.log(`Simple Gallery running at http://localhost:${PORT}/`);
    setTimeout(() => {
      try {
        dbHousekeeping.run('startup-deferred');
      } catch (error) {
        console.error(`[db-cleanup] Deferred startup cleanup failed: ${error?.message || error}`);
      }
    }, 5000);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
