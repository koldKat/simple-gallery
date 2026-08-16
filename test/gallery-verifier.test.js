'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGalleryVerifier } = require('../server/gallery-verifier');

function fixture({ remoteCount = 2, localCount = 2, missingThumbs = 0 } = {}) {
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
  };
  let job = null;
  let stopRequested = false;
  let databaseUpdate = null;
  let refreshes = 0;
  const updates = [];
  const errors = [];
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
    fetchText: async () => 'gallery-html',
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
      items.forEach((_item, index) => onProgress(index + 1, items.length));
      return {
        downloaded: items.map((item, index) => ({ ...item, outPath: path.join(galleryPath, `${index}.jpg`) })),
        failures: [],
      };
    },
    recordImportError: value => errors.push(value),
    refreshModelInState: async () => { refreshes += 1; },
    importSnapshot: () => ({ status: job.status, totals: { ...job.totals } }),
  });
  return {
    root, verifier, updates, errors, activePaths,
    job: () => job,
    databaseUpdate: () => databaseUpdate,
    refreshes: () => refreshes,
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
