'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createThumbnailService } = require('../server/thumbnail-service');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-thumbs-'));
  const galleryPath = path.join(root, 'alpha', '001');
  fs.mkdirSync(galleryPath, { recursive: true });
  const sourcePath = path.join(galleryPath, 'one.jpg');
  const thumbPath = path.join(galleryPath, '.thumbs', 'one.jpg');
  fs.writeFileSync(sourcePath, 'source-image');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE galleries (id INTEGER PRIMARY KEY, thumb_bytes INTEGER NOT NULL DEFAULT 0); INSERT INTO galleries VALUES (3, 0);');
  const state = {
    models: [{
      id: 'alpha',
      galleries: [{ name: '001', thumbBytes: 0, missingThumbs: 1 }],
      _totals: { imageBytes: 12, thumbBytes: 0, totalBytes: 12, missingThumbs: 1, thumbs: 0 },
    }],
    totals: { imageBytes: 12, thumbBytes: 0, totalBytes: 12, missingThumbs: 1, thumbs: 0 },
  };
  let currentState = state;
  let conversions = 0;
  let broadcasts = 0;
  let rescans = 0;
  const service = createThumbnailService({
    db,
    mediaRoot: () => root,
    mkdirp: target => fs.mkdirSync(target, { recursive: true }),
    fileSize: target => {
      try { return fs.statSync(target).size; } catch { return 0; }
    },
    galleryDbId: (model, gallery) => model === 'alpha' && gallery === '001' ? 3 : null,
    thumbSize: 240,
    concurrency: 1,
    isWorker: false,
    getState: () => currentState,
    setState: value => { currentState = value; },
    runtimeStats: () => ({ rssBytes: 10 }),
    broadcast: () => { broadcasts += 1; },
    stateNotice: () => ({ status: 'ready' }),
    shouldAutoRescan: () => true,
    scanLibrary: () => { rescans += 1; },
    runConvert: (_command, args, _options, callback) => {
      conversions += 1;
      fs.writeFileSync(args.at(-1), 'generated-thumbnail');
      setTimeout(() => callback(null), 2);
    },
    stateBroadcastDelayMs: 2,
    rescanDelayMs: 2,
  });
  return {
    db,
    root,
    sourcePath,
    thumbPath,
    service,
    state: () => currentState,
    conversions: () => conversions,
    broadcasts: () => broadcasts,
    rescans: () => rescans,
    close() {
      service.stop();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('thumbnail queue deduplicates work and updates database and runtime totals', async () => {
  const context = fixture();
  assert.equal(context.service.needsThumb(context.sourcePath, context.thumbPath), true);
  context.service.enqueue(context.sourcePath, context.thumbPath);
  context.service.enqueue(context.sourcePath, context.thumbPath);
  await wait(30);

  const thumbBytes = fs.statSync(context.thumbPath).size;
  assert.equal(context.conversions(), 1);
  assert.equal(context.db.prepare('SELECT thumb_bytes FROM galleries WHERE id = 3').get().thumb_bytes, thumbBytes);
  assert.equal(context.state().models[0].galleries[0].thumbBytes, thumbBytes);
  assert.equal(context.state().models[0].galleries[0].missingThumbs, 0);
  assert.equal(context.state().totals.thumbBytes, thumbBytes);
  assert.equal(context.state().runtime.rssBytes, 10);
  assert.equal(context.broadcasts(), 1);
  assert.equal(context.rescans(), 1);
  assert.equal(context.service.needsThumb(context.sourcePath, context.thumbPath), false);
  context.close();
});

test('an importer-requested skip suppresses exactly the next automatic rescan', async () => {
  const context = fixture();
  context.service.skipNextAutoRescan();
  context.service.enqueue(context.sourcePath, context.thumbPath);
  await wait(30);
  assert.equal(context.rescans(), 0);
  context.close();
});
