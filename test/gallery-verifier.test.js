'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGalleryVerifier } = require('../server/gallery-verifier');

function fixture({ remoteCount = 2, localCount = 2, missingThumbs = 0, provider = 'primary', failedDownloads = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-verifier-'));
  const row = {
    gallery_id: 3,
    gallery_folder: '001',
    source_url: 'https://example.test/gallery/one',
    title: 'One',
    image_count: localCount,
    model_name: 'Alpha',
    model_folder: 'alpha',
    model_url: 'https://example.test/model/alpha',
    source_provider: provider,
  };
  let job = null;
  let stopRequested = false;
  let databaseUpdate = null;
  let refreshes = 0;
  const updates = [];
  const errors = [];
  const downloadedItems = [];
  let fetches = 0;
  const activePaths = new Set();
  const db = {
    prepare(sql) {
      if (/^\s*SELECT/.test(sql)) return { all: () => [row] };
      return { run: (...values) => { databaseUpdate = values; } };
    },
  };
  const verifier = createGalleryVerifier({
    db,
    getJob: () => job,
    setJob: value => { job = value; },
    getStopRequested: () => stopRequested,
    setStopRequested: value => { stopRequested = value; },
    resetProgressThrottle() {},
    clearImportErrors() {},
    isVerifiableGalleryUrl: () => true,
    nowIso: () => '2026-08-16T12:00:00.000Z',
    updateImport: message => updates.push(message),
    fetchText: async () => { fetches += 1; return 'gallery-html'; },
    extractDetailUrls: () => Array.from({ length: remoteCount }, (_, index) => `detail-${index}`),
    mediaRoot: () => root,
    galleryStorageStats: () => ({
      imageNames: Array.from({ length: localCount }, (_, index) => `${index}.jpg`),
      missingThumbs,
    }),
    activeImportGalleryPaths: activePaths,
    mkdirp: target => fs.mkdirSync(target, { recursive: true }),
    resolveGalleryImageUrls: async detailUrls => ({
      successes: detailUrls.map((detailUrl, index) => ({ index, detailUrl, imageUrl: `image-${index}` })),
      failures: [],
    }),
    downloadGalleryImagesPartial: async (items, galleryPath, _title, onProgress) => {
      downloadedItems.push(...items);
      const downloadedSource = items.slice(0, Math.max(0, items.length - failedDownloads));
      downloadedSource.forEach((_item, index) => onProgress(index + 1, items.length));
      return {
        downloaded: downloadedSource.map((item, index) => ({ ...item, outPath: path.join(galleryPath, `${index}.jpg`) })),
        failures: items.slice(downloadedSource.length).map(item => ({ ...item, message: 'download failed' })),
      };
    },
    recordImportError: value => errors.push(value),
    refreshModelInState: async () => { refreshes += 1; },
    importSnapshot: () => ({ status: job.status, totals: { ...job.totals } }),
    galleryProviderRegistry: {
      identify: (_url, providerId) => {
        if (providerId === 'unknown') throw new Error('Not configured');
        return { id: providerId, type: 'direct-images' };
      },
      extract: selected => ({
        providerId: selected.id,
        imageUrls: Array.from({ length: remoteCount }, (_, index) => `https://images.example.test/${index}.jpg`),
        referer: 'https://source.example.test/',
        allowedImageHosts: ['images.example.test'],
      }),
    },
  });
  return {
    root, verifier, updates, errors, activePaths, downloadedItems,
    job: () => job,
    databaseUpdate: () => databaseUpdate,
    refreshes: () => refreshes,
    fetches: () => fetches,
    close() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('matching galleries complete verification without repair or refresh', async () => {
  const context = fixture();
  const result = await context.verifier.verify();
  assert.equal(result.status, 'done');
  assert.equal(context.job().totals.galleriesProcessed, 1);
  assert.equal(context.job().totals.galleriesImported, 0);
  assert.equal(context.databaseUpdate(), null);
  assert.equal(context.refreshes(), 0);
  assert.equal(context.errors.length, 0);
  context.close();
});

test('configured direct-image providers are verified and repaired with provider download metadata', async () => {
  const context = fixture({ provider: 'direct', remoteCount: 3, localCount: 1 });
  const result = await context.verifier.verify();
  assert.equal(result.status, 'done');
  assert.equal(context.job().totals.galleriesImported, 1);
  assert.equal(context.downloadedItems.length, 3);
  assert.equal(context.downloadedItems[0].referer, 'https://source.example.test/');
  assert.deepEqual(context.downloadedItems[0].allowedHosts, ['images.example.test']);
  context.close();
});

test('unknown providers are skipped rather than fetched or invalidated', async () => {
  const context = fixture({ provider: 'unknown' });
  const result = await context.verifier.verify();
  assert.equal(result.status, 'done');
  assert.equal(context.job().totals.galleriesSkipped, 1);
  assert.equal(context.fetches(), 0);
  assert.equal(context.databaseUpdate(), null);
  assert.deepEqual(context.errors, []);
  context.close();
});

test('missing thumbnails queue a model refresh without redownloading images', async () => {
  const context = fixture({ missingThumbs: 1 });
  await context.verifier.verify();
  assert.equal(context.databaseUpdate(), null);
  assert.equal(context.refreshes(), 1);
  assert.match(context.updates.find(message => /Refreshing repaired model/.test(message)), /alpha/);
  context.close();
});

test('count mismatches repair files, update database counts, and clear active paths', async () => {
  const context = fixture({ remoteCount: 3, localCount: 1 });
  const result = await context.verifier.verify();
  assert.equal(result.status, 'done');
  assert.deepEqual(context.databaseUpdate(), [3, '2026-08-16T12:00:00.000Z', 3]);
  assert.equal(context.job().totals.galleriesImported, 1);
  assert.equal(context.refreshes(), 1);
  assert.equal(context.activePaths.size, 0);
  assert.equal(context.errors.length, 0);
  context.close();
});

test('incomplete repairs retain the existing gallery and leave its database count unchanged', async () => {
  const context = fixture({ remoteCount: 3, localCount: 1, failedDownloads: 1 });
  const galleryPath = path.join(context.root, 'alpha', '001');
  fs.mkdirSync(galleryPath, { recursive: true });
  fs.writeFileSync(path.join(galleryPath, 'existing.jpg'), 'existing');

  const result = await context.verifier.verify();
  assert.equal(result.status, 'done');
  assert.equal(fs.readFileSync(path.join(galleryPath, 'existing.jpg'), 'utf8'), 'existing');
  assert.equal(context.databaseUpdate(), null);
  assert.equal(context.job().totals.galleriesImported, 0);
  assert.equal(context.activePaths.size, 0);
  assert.match(context.errors.at(-1).message, /existing files were retained/);
  context.close();
});
