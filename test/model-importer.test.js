'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelImporter } = require('../server/model-importer');

function fixture({ known = false, invalid = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-model-importer-'));
  const galleryUrl = 'https://example.test/gallery/one';
  const record = { galleries: known ? { [galleryUrl]: { folder: '001', title: 'Old' } } : {} };
  const importDb = { models: {}, scannedUrls: [] };
  const job = {
    active: true,
    status: 'running',
    currentModelUrl: '',
    modelName: '',
    modelFolder: '',
    current: null,
    totals: {
      modelsChecked: 0, galleries: 0, knownGalleries: 0, newGalleries: 0,
      galleriesProcessed: 0, galleriesImported: 0, galleriesSkipped: 0,
      images: 0, imagesImported: 0, imagesSkipped: 0, errors: 0,
    },
  };
  const updates = [];
  const errors = [];
  let saves = 0;
  let refreshes = 0;
  let remembered = null;
  const importer = createModelImporter({
    getJob: () => job,
    removeLoadedModel() {},
    requireSourceProfile: () => ({ modelPathSegment: 'model', modelExample: '' }),
    validateSourceUrl: () => ({ parsed: { pathname: invalid ? '/wrong/alpha' : '/model/alpha' } }),
    canonicalRemoteUrl: value => new URL(value).origin + new URL(value).pathname,
    updateImport: (message, _patch, options) => updates.push({ message, options }),
    fetchText: async url => url === galleryUrl ? 'gallery-html' : 'model-html',
    extractModelName: () => 'Alpha',
    sanitizeFolderName: () => 'alpha',
    mediaRoot: () => root,
    mkdirp: target => fs.mkdirSync(target, { recursive: true }),
    loadImportDb: () => importDb,
    getImportModelRecord: () => record,
    hydrateImportRecordFromManifests() {},
    extractSourceGalleries: () => [{ sourceUrl: galleryUrl, title: 'One' }],
    saveImportDb: () => { saves += 1; },
    galleryStorageStats: () => ({ missingThumbs: 0 }),
    pauseForForegroundBrowsing: async () => {},
    findExistingGalleryForSource: () => null,
    rememberImportedGallery: (_record, gallery, folder, count) => {
      remembered = { gallery, folder, count };
      record.galleries[galleryUrl] = { folder, title: gallery.title };
    },
    readImageFiles: () => [],
    nextGalleryName: () => '001',
    activeImportGalleryPaths: new Set(),
    markImportPath() {},
    clearImportPath() {},
    extractDetailUrls: () => ['detail-one'],
    resolveGalleryImageUrls: async () => ({
      successes: [{ index: 0, detailUrl: 'detail-one', imageUrl: 'image-one' }],
      failures: [],
    }),
    downloadGalleryImagesPartial: async (items, _galleryPath, _title, onProgress) => {
      onProgress(1, items.length);
      return { downloaded: [{ ...items[0], outPath: 'one.jpg' }], failures: [] };
    },
    recordImportError: value => errors.push(value),
    refreshModelInState: async () => { refreshes += 1; },
    recordRescanAllFinished() {},
    importSnapshot: () => ({ status: job.status, totals: { ...job.totals } }),
    nowIso: () => '2026-08-16T12:00:00.000Z',
  });
  return {
    root, job, record, importer, updates, errors,
    saves: () => saves,
    refreshes: () => refreshes,
    remembered: () => remembered,
    close() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('known galleries are skipped without unnecessary model refreshes', async () => {
  const context = fixture({ known: true });
  const result = await context.importer.importModel('https://example.test/model/alpha');
  assert.equal(result.status, 'running');
  assert.equal(context.job.modelName, 'Alpha');
  assert.equal(context.job.totals.modelsChecked, 1);
  assert.equal(context.job.totals.knownGalleries, 1);
  assert.equal(context.job.totals.galleriesSkipped, 1);
  assert.equal(context.job.totals.galleriesImported, 0);
  assert.equal(context.refreshes(), 0);
  assert.match(context.updates.at(-1).message, /gallery refresh skipped/);
  context.close();
});

test('new galleries download, persist, update totals, and refresh the model', async () => {
  const context = fixture();
  await context.importer.importModel('https://example.test/model/alpha');
  assert.deepEqual(context.remembered(), {
    gallery: { sourceUrl: 'https://example.test/gallery/one', title: 'One' },
    folder: '001',
    count: 1,
  });
  assert.equal(context.job.totals.newGalleries, 1);
  assert.equal(context.job.totals.galleriesImported, 1);
  assert.equal(context.job.totals.images, 1);
  assert.equal(context.job.totals.imagesImported, 1);
  assert.equal(context.refreshes(), 1);
  assert.equal(context.saves() >= 2, true);
  assert.equal(context.errors.length, 0);
  context.close();
});

test('invalid model URLs fail the active job and record the error', async () => {
  const context = fixture({ invalid: true });
  const result = await context.importer.importModel('https://example.test/wrong/alpha');
  assert.equal(result.status, 'error');
  assert.equal(context.job.active, false);
  assert.equal(context.job.finishedAt, '2026-08-16T12:00:00.000Z');
  assert.equal(context.job.totals.errors, 1);
  assert.equal(context.errors.length, 1);
  context.close();
});
