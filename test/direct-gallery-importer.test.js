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
    normalizeModelName: value => String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
    sanitizeFolderName: value => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
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

test('creates a direct-import-only model when no existing model matches', async () => {
  const context = fixture({ modelRows: [] });
  assert.deepEqual(context.importer.findModel('New Model_Name'), {
    id: null,
    name: 'New Model Name',
    folder: 'new-model-name',
    isNew: true,
  });
  const result = await context.importer.importGallery({
    model: 'New Model_Name',
    url: 'https://source.example.test/galleries/one',
  });
  assert.equal(result.status, 'done');
  assert.equal(context.job().modelName, 'New Model Name');
  assert.equal(context.job().modelFolder, 'new-model-name');
  assert.equal(context.refreshed(), 1);
  assert.deepEqual(context.errors, []);
  context.close();
});

test('rejects ambiguous existing model matches', async () => {
  const context = fixture({ modelRows: [{ id: 1, name: 'Alpha', folder: 'alpha' }, { id: 2, name: 'Alpha Two', folder: 'alpha-two' }] });
  assert.throws(() => context.importer.findModel('Alpha Name'), /More than one model matches/);
  context.close();
});
