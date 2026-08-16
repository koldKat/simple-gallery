'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../server/db/schema');
const { createUserLibraryService } = require('../server/user-library');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-user-library-'));
  const db = new Database(':memory:');
  initializeSchema({
    db,
    defaultVersionLabel: '1.0.0',
    nowIso: () => 'now',
    withBusyRetry: work => work(),
  });
  db.exec(`
    INSERT INTO users (id, username, password_hash, display_name, created_at)
    VALUES (1, 'alex', 'hash', 'Alex', 'now');
    INSERT INTO models (id, name, folder, created_at, updated_at)
    VALUES (2, 'Alpha', 'alpha', 'now', 'now');
    INSERT INTO galleries
      (id, model_id, folder, image_count, status, created_at, imported_at)
    VALUES (3, 2, '001', 2, 'imported', '2026-01-01', '2026-01-02');
  `);
  const gallery = {
    id: 'alpha/001', dbId: 3, name: '001', count: 2, cover: '/cover.jpg',
    updatedAt: '2026-01-02', updatedAtMs: 2,
  };
  const model = {
    id: 'alpha', dbId: 2, name: 'alpha', count: 2, galleryCount: 1,
    cover: '/cover.jpg', updatedAt: '2026-01-02', updatedAtMs: 2, galleries: [gallery],
  };
  const state = {
    status: 'ready', message: 'Ready', scannedAt: 'now', totals: { images: 2 },
    models: [model], latest: [{ ...gallery, modelId: 'alpha', modelName: 'alpha' }],
  };
  const user = { id: 1, username: 'alex', display_name: 'Alex' };
  const service = createUserLibraryService({
    db,
    getState: () => state,
    mediaRoot: () => directory,
    thumbDirectory: '.thumbs',
    readImageFiles: galleryPath => fs.readdirSync(galleryPath).filter(name => /\.jpg$/i.test(name)).sort(),
    safeName: value => value,
    toUrl: value => `file:${value}`,
    currentUser: () => user,
    galleryDbId: (modelName, galleryName) => modelName === 'alpha' && galleryName === '001' ? 3 : null,
    favoriteSetsForUser: userId => ({
      models: new Set(userId ? [2] : []),
      galleries: new Set(userId ? [3] : []),
      images: new Set(userId ? ['3\none.jpg'] : []),
    }),
    seenImagesForGallery: () => new Set(['two.jpg']),
    publicUser: value => value ? { id: value.id, username: value.username } : null,
    seenDataForUser: () => ({ images: new Set(['3\ntwo.jpg']), galleryCounts: new Map([[3, 1]]) }),
    gallerySeenSummary: (item, seenData) => {
      const seenCount = Number(seenData.galleryCounts.get(item.dbId) || 0);
      return { seenCount, seen: Number(item.count || 0) > 0 && seenCount >= Number(item.count || 0) };
    },
    runtimeStats: () => ({ rssBytes: 10 }),
    appMetadata: () => ({ name: 'Test Gallery' }),
  });
  return {
    db,
    directory,
    gallery,
    model,
    service,
    state,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('gallery image responses use generated thumbs and source fallback', () => {
  const context = fixture();
  const galleryPath = path.join(context.directory, 'alpha', '001');
  fs.mkdirSync(path.join(galleryPath, '.thumbs'), { recursive: true });
  fs.writeFileSync(path.join(galleryPath, 'one.jpg'), 'one');
  fs.writeFileSync(path.join(galleryPath, 'two.jpg'), 'two');
  fs.writeFileSync(path.join(galleryPath, '.thumbs', 'one.jpg'), 'thumb');

  const response = context.service.galleryImagesResponseForUser({}, 'alpha', '001');
  assert.equal(response.dbId, 3);
  assert.equal(response.images[0].thumb, `file:${path.join(galleryPath, '.thumbs', 'one.jpg')}`);
  assert.equal(response.images[1].thumb, response.images[1].src);
  assert.deepEqual(response.images.map(image => [image.name, image.favorite, image.seen]), [
    ['one.jpg', true, false],
    ['two.jpg', false, true],
  ]);
  context.close();
});

test('public state projects favorites and seen counts without mutating cached state', () => {
  const context = fixture();
  const response = context.service.stateForUser({});
  assert.equal(response.models[0].favorite, true);
  assert.equal(response.models[0].seenCount, 1);
  assert.equal(response.models[0].galleries[0].favorite, true);
  assert.equal(response.latest[0].seenCount, 1);
  assert.deepEqual(response.runtime, { rssBytes: 10 });
  assert.deepEqual(response.app, { name: 'Test Gallery' });
  assert.equal(context.state.models[0].favorite, undefined);
  context.close();
});

test('favorites overview and paginated images preserve database metadata', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO model_favorites (user_id, model_id, created_at) VALUES (1, 2, 'model-favorite');
    INSERT INTO gallery_favorites (user_id, gallery_id, created_at) VALUES (1, 3, 'gallery-favorite');
    INSERT INTO image_favorites (user_id, gallery_id, image_name, created_at) VALUES
      (1, 3, 'one.jpg', 'image-one'),
      (1, 3, 'two.jpg', 'image-two');
    INSERT INTO image_seen (user_id, gallery_id, image_name, seen_at)
    VALUES (1, 3, 'two.jpg', 'seen');
  `);

  const overview = context.service.favoritesResponse({});
  assert.equal(overview.models[0].id, 'alpha');
  assert.equal(overview.galleries[0].id, 'alpha/001');
  assert.deepEqual(overview.imageGroups.map(group => [group.modelId, group.count]), [['alpha', 2]]);
  assert.equal(overview.imageCount, 2);

  const page = context.service.favoriteImagesResponse(1, { modelId: 'alpha', limit: 1, offset: 0 });
  assert.equal(page.images.length, 1);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.images[0].seen, true);
  assert.match(page.images[0].src, /alpha\/001\/two\.jpg$/);
  context.close();
});

test('favorite image pagination requires a model outside random mode', () => {
  const context = fixture();
  assert.throws(() => context.service.favoriteImagesResponse(1), /Missing model/);
  context.close();
});
