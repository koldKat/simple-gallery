'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDirectGalleryImporter } = require('../server/direct-gallery-importer');

function fixture({ knownFolder = '', modelRows = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-direct-import-'));
  const model = { id: 1, name: 'Alpha', folder: 'alpha' };
  let job = null;
  let remembered = null;
  let saved = 0;
  let refreshed = 0;
  const downloadedItems = [];
  const errors = [];
  const importer = createDirectGalleryImporter({
    db: {
      prepare(sql) {
        if (/WHERE folder = \?/.test(sql)) return { get: value => value === 'alpha' ? model : undefined };
        return { all: () => modelRows === null ? [model] : modelRows };
      },
    },
    getJob: () => job,
    setJob: value => { job = value; },
    resetProgressThrottle() {},
    clearImportErrors() {},
    galleryProviderRegistry: {
      identify: () => ({ id: 'direct', type: 'direct-images' }),
      extract: () => ({
        providerId: 'direct',
        title: 'Imported title',
        imageUrls: ['https://images.example.test/one.jpg', 'https://images.example.test/two.jpg'],
        referer: 'https://source.example.test/',
        allowedImageHosts: ['images.example.test'],
      }),
    },
    canonicalRemoteUrl: value => new URL(value).toString(),
    fetchText: async () => '<html></html>',
    mediaRoot: () => root,
    mkdirp: target => fs.mkdirSync(target, { recursive: true }),
    loadImportDb: () => ({ models: {}, scannedUrls: [] }),
    saveImportDb: () => { saved += 1; },
    getImportModelRecord: () => ({ galleries: [] }),
    hydrateImportRecordFromManifests() {},
    findExistingGalleryForSource: () => knownFolder,
    nextGalleryName: () => '001',
    rememberImportedGallery: (_record, gallery, folder, imageCount, storage) => {
      remembered = { gallery, folder, imageCount, storage };
    },
    activeImportGalleryPaths: new Set(),
    markImportPath() {},
    clearImportPath() {},
    downloadGalleryImagesPartial: async (items, galleryPath, _title, onProgress) => {
      downloadedItems.push(...items);
      onProgress(items.length, items.length);
      return {
        downloaded: items.map((item, index) => ({ ...item, outPath: path.join(galleryPath, `${index}.jpg`) })),
        failures: [],
      };
    },
    galleryStorageStats: () => ({ imageNames: ['00.jpg', '01.jpg'], imageBytes: 20, thumbBytes: 5 }),
    refreshModelInState: async () => { refreshed += 1; },
    recordImportError: error => errors.push(error),
    updateImport() {},
    importSnapshot: () => ({ status: job.status, mode: job.mode, totals: { ...job.totals } }),
    nowIso: () => '2026-08-17T12:00:00.000Z',
  });
  return {
    root,
    importer,
    job: () => job,
    remembered: () => remembered,
    saved: () => saved,
    refreshed: () => refreshed,
    downloadedItems,
    errors,
    close() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('imports a configured direct-image gallery into an existing model', async () => {
  const context = fixture();
  const result = await context.importer.importGallery({
    model: 'alpha',
    url: 'https://source.example.test/galleries/one',
    providerId: 'direct',
  });

  assert.equal(result.status, 'done');
  assert.equal(result.mode, 'direct-gallery');
  assert.equal(result.totals.imagesImported, 2);
  assert.equal(context.remembered().gallery.sourceProvider, 'direct');
  assert.equal(context.remembered().storage.sourceProvider, 'direct');
  assert.deepEqual(context.downloadedItems[0].allowedHosts, ['images.example.test']);
  assert.equal(context.downloadedItems[0].referer, 'https://source.example.test/');
  assert.equal(context.saved(), 1);
  assert.equal(context.refreshed(), 1);
  assert.deepEqual(context.errors, []);
  context.close();
});

test('known source URLs refresh their model without writing import state', async () => {
  const context = fixture({ knownFolder: '007' });
  const result = await context.importer.importGallery({
    model: 'alpha',
    url: 'https://source.example.test/galleries/one',
  });

  assert.equal(result.status, 'done');
  assert.equal(result.totals.galleriesSkipped, 1);
  assert.equal(context.saved(), 0);
  assert.equal(context.refreshed(), 1);
  context.close();
});

test('requires an unambiguous existing model and exposes the failure in job state', async () => {
  const context = fixture({ modelRows: [] });
  assert.throws(() => context.importer.findModel('missing'), /was not found/);
  const result = await context.importer.importGallery({
    model: 'missing',
    url: 'https://source.example.test/galleries/one',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.totals.errors, 1);
  assert.match(context.errors[0].message, /was not found/);
  context.close();
});
