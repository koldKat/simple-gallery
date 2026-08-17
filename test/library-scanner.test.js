'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLibraryScanner, emptyTotals, addTotals } = require('../server/library-scanner');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-scanner-'));
  const galleryPath = path.join(root, 'alpha', '001');
  const thumbPath = path.join(galleryPath, '.thumbs');
  fs.mkdirSync(thumbPath, { recursive: true });
  fs.writeFileSync(path.join(galleryPath, 'one.jpg'), 'source');
  fs.writeFileSync(path.join(thumbPath, 'one.jpg'), 'thumb');
  let state = {
    status: 'idle',
    totals: emptyTotals(),
    models: [],
    latest: [],
  };
  let broadcasts = 0;
  let modelUpserts = 0;
  let galleryUpserts = 0;
  let lastGalleryUpsert = null;
  const readDirs = target => {
    try {
      return fs.readdirSync(target, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== '.thumbs').map(entry => entry.name);
    } catch {
      return [];
    }
  };
  const scanner = createLibraryScanner({
    mediaRoot: () => root,
    mediaUrlPrefix: () => '/media',
    thumbDirectory: '.thumbs',
    readDirs,
    readImageFiles: target => {
      try { return fs.readdirSync(target).filter(name => /\.jpg$/i.test(name)); } catch { return []; }
    },
    safeName: value => value,
    mkdirp: target => fs.mkdirSync(target, { recursive: true }),
    cleanupStaleThumbs: () => 0,
    removeEmptyThumbDir: () => {},
    needsThumb: () => false,
    enqueueThumb: () => assert.fail('existing thumbnail must not be queued'),
    toUrl: target => `file:${target}`,
    fileSize: target => fs.statSync(target).size,
    galleryDbRecord: () => ({
      source_url: 'https://example.test/gallery/one',
      title: 'Stored title',
      imported_at: '2026-08-15T10:00:00.000Z',
    }),
    galleryRecordsForModel: () => new Map([['001', {
      source_url: 'https://example.test/gallery/one',
      title: 'Stored title',
      imported_at: '2026-08-15T10:00:00.000Z',
    }]]),
    upsertModelRecord: () => { modelUpserts += 1; return 2; },
    upsertGalleryRecord: (_model, _name, _gallery, values) => {
      galleryUpserts += 1;
      lastGalleryUpsert = values;
      return 3;
    },
    cleanupSeenRecordsForGallery: () => {},
    normalizeModelName: value => value[0].toUpperCase() + value.slice(1),
    sourceSlug: () => 'one',
    repairGallerySequence: () => false,
    loadImportDb: () => ({ models: {} }),
    saveImportDb: () => assert.fail('unchanged sequences must not be saved'),
    activeImportGalleryPaths: new Set(),
    dedupeScannedGalleries: galleries => galleries,
    gallerySummary: gallery => ({ ...gallery }),
    latestGallerySummaries: models => models.flatMap(model => model.galleries),
    emptyState: status => ({ status, totals: emptyTotals(), models: [], latest: [] }),
    runtimeStats: () => ({ rssBytes: 50 }),
    getState: () => state,
    setState: value => { state = value; },
    broadcastState: () => { broadcasts += 1; },
    isWorker: false,
    sendWorkerMessage: () => {},
    sleep: async () => {},
    nowIso: () => '2026-08-16T12:00:00.000Z',
  });
  return {
    root,
    scanner,
    state: () => state,
    broadcasts: () => broadcasts,
    modelUpserts: () => modelUpserts,
    galleryUpserts: () => galleryUpserts,
    lastGalleryUpsert: () => lastGalleryUpsert,
    close() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('total helpers add and subtract all storage counters', () => {
  const totals = emptyTotals();
  addTotals(totals, { models: 1, galleries: 2, images: 3, imageBytes: 40, thumbBytes: 5 });
  assert.deepEqual(totals, {
    models: 1, galleries: 2, images: 3, thumbs: 0, missingThumbs: 0,
    staleThumbsRemoved: 0, imageBytes: 40, thumbBytes: 5, totalBytes: 45,
  });
  addTotals(totals, { galleries: 1, images: 1, imageBytes: 10, thumbBytes: 2 }, -1);
  assert.equal(totals.galleries, 1);
  assert.equal(totals.images, 2);
  assert.equal(totals.totalBytes, 33);
});

test('gallery and model scans preserve source metadata and storage totals', async () => {
  const context = fixture();
  const gallery = await context.scanner.scanGallery('alpha', '001');
  assert.equal(gallery.count, 1);
  assert.equal(gallery.imageBytes, 6);
  assert.equal(gallery.thumbBytes, 5);
  assert.equal(gallery.missingThumbs, 0);
  assert.equal(gallery.cover.endsWith('/.thumbs/one.jpg'), true);
  assert.equal(gallery.addedAt, '2026-08-15T10:00:00.000Z');
  assert.equal(gallery.title, 'Stored title');

  const scanned = await context.scanner.scanModelState('alpha');
  assert.equal(scanned.model.dbId, 2);
  assert.equal(scanned.model.count, 1);
  assert.equal(scanned.model.galleryCount, 1);
  assert.equal(scanned.model.galleries[0].dbId, 3);
  assert.equal(scanned.totals.totalBytes, 11);
  assert.equal(context.lastGalleryUpsert().title, 'Stored title');
  context.close();
});

test('full scans coalesce concurrent requests and replace cached state', async () => {
  const context = fixture();
  const first = context.scanner.scan();
  const second = context.scanner.scan();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, secondResult);
  assert.equal(context.modelUpserts(), 1);
  assert.equal(context.galleryUpserts(), 1);
  assert.equal(context.state().status, 'ready');
  assert.equal(context.state().totals.images, 1);
  assert.equal(context.state().totals.totalBytes, 11);
  assert.equal(context.state().runtime.rssBytes, 50);
  assert.equal(context.state().scannedAt, '2026-08-16T12:00:00.000Z');
  assert.equal(context.scanner.isScanning(), false);
  assert.equal(context.broadcasts() >= 2, true);
  context.close();
});
