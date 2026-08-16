'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../server/db/schema');
const { createLibraryStateService } = require('../server/library-state');

function emptyTotals() {
  return {
    models: 0, galleries: 0, images: 0, thumbs: 0, missingThumbs: 0,
    staleThumbsRemoved: 0, imageBytes: 0, thumbBytes: 0, totalBytes: 0,
  };
}

function addTotals(target, delta, direction = 1) {
  for (const key of Object.keys(emptyTotals())) {
    target[key] = Number(target[key] || 0) + Number(delta[key] || 0) * direction;
  }
  return target;
}

function fixture() {
  const db = new Database(':memory:');
  initializeSchema({
    db,
    defaultVersionLabel: '1.0.0',
    nowIso: () => '2026-08-16T00:00:00.000Z',
    withBusyRetry: work => work(),
  });
  const coverCalls = [];
  let clockValue = 100;
  const logs = [];
  const service = createLibraryStateService({
    db,
    canonicalRemoteUrl: value => new URL(value).href.replace(/\/$/, ''),
    galleryCoverUrl: (...args) => {
      coverCalls.push(args);
      return `/covers/${args[0]}/${args[1]}/${args[2]}`;
    },
    mediaUrlPrefix: () => '/media',
    sourceSlug: value => value ? new URL(value).pathname.split('/').filter(Boolean).at(-1) : '',
    emptyState: status => ({ status, app: {}, totals: emptyTotals(), models: [], latest: [] }),
    emptyTotals,
    addTotals,
    appSetting: (_key, fallback) => fallback,
    nowIso: () => '2026-08-16T12:00:00.000Z',
    runtimeStats: () => ({ rssBytes: 123 }),
    clock: () => { clockValue += 1; return clockValue; },
    log: message => logs.push(message),
  });
  return { coverCalls, db, logs, service };
}

test('database hydration builds totals, latest galleries, and cached covers', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO models (id, name, folder, created_at, updated_at) VALUES
      (1, 'Alpha Display', 'alpha', 'created', 'updated'),
      (2, 'Beta Display', 'beta', 'created', 'updated');
    INSERT INTO galleries
      (id, model_id, source_url, folder, image_count, cover_name, image_bytes, thumb_bytes, status, created_at, imported_at)
    VALUES
      (10, 1, 'https://example.test/gallery/one', '001', 4, 'one.jpg', 100, 20, 'imported', '2026-01-01', '2026-01-02'),
      (11, 1, 'https://example.test/gallery/two', '002', 3, 'two.jpg', 200, 30, 'imported', '2026-02-01', '2026-02-02'),
      (12, 2, NULL, '001', 5, 'beta.jpg', 300, 40, 'imported', '2026-03-01', '2026-03-02');
  `);

  const state = context.service.hydrateFromDatabase();
  assert.equal(state.status, 'ready');
  assert.equal(state.message, 'Loaded cached library state for 3 galleries.');
  assert.deepEqual(
    { models: state.totals.models, galleries: state.totals.galleries, images: state.totals.images, imageBytes: state.totals.imageBytes, thumbBytes: state.totals.thumbBytes },
    { models: 2, galleries: 3, images: 12, imageBytes: 600, thumbBytes: 90 }
  );
  assert.deepEqual(state.models.map(model => [model.id, model.count, model.cover]), [
    ['alpha', 7, '/covers/alpha/002/two.jpg'],
    ['beta', 5, '/covers/beta/001/beta.jpg'],
  ]);
  assert.deepEqual(state.latest.map(gallery => gallery.id), ['beta/001', 'alpha/002', 'alpha/001']);
  assert.deepEqual(context.coverCalls[0], ['alpha', '001', 'one.jpg', { cached: true, thumbBytes: 20 }]);
  assert.equal(state.runtime.rssBytes, 123);
  assert.equal(context.logs.length, 3);
  context.db.close();
});

test('empty hydration returns idle state without fabricated models', () => {
  const context = fixture();
  const state = context.service.hydrateFromDatabase();
  assert.equal(state.status, 'idle');
  assert.equal(state.message, 'Waiting for scan.');
  assert.deepEqual(state.models, []);
  context.db.close();
});

test('gallery deduplication keeps the stronger duplicate candidate', () => {
  const context = fixture();
  const galleries = context.service.dedupeScannedGalleries([
    { id: '001', name: '001', sourceUrl: 'https://example.test/gallery/same', sourceSlug: 'same', count: 3, images: [] },
    { id: '002', name: '002', sourceUrl: 'https://example.test/gallery/same/', sourceSlug: 'same', count: 8, images: [] },
    { id: '010', name: '010', sourceUrl: null, sourceSlug: 'other', count: 2, images: [{ name: '1-other.jpg' }] },
  ]);
  assert.deepEqual(galleries.map(gallery => gallery.id), ['002', '010']);
  context.db.close();
});
