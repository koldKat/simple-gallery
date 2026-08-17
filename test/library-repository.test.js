'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../server/db/schema');
const { createLibraryRepository } = require('../server/library-repository');

function fixture() {
  const db = new Database(':memory:');
  initializeSchema({
    db,
    defaultVersionLabel: '1.0.0',
    nowIso: () => 'seed-time',
    withBusyRetry: work => work(),
  });
  db.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, created_at)
    VALUES (1, 'alex', 'hash', 'Alex', 'seed-time')
  `).run();
  let now = '2026-08-16T10:00:00.000Z';
  let state = { models: [] };
  const repository = createLibraryRepository({
    db,
    nowIso: () => now,
    withBusyRetry: work => work(),
    normalizeModelName: folder => folder.replace(/-/g, ' ').replace(/\b\w/g, value => value.toUpperCase()),
    canonicalRemoteUrl: value => String(value).replace(/\/$/, '').toLowerCase(),
    getState: () => state,
  });
  return {
    db,
    repository,
    setNow(value) { now = value; },
    setState(value) { state = value; },
  };
}

test('model and gallery upserts preserve update semantics and storage metadata', () => {
  const context = fixture();
  const modelId = context.repository.upsertModelRecord('alpha-model', '', 'HTTPS://SOURCE.TEST/ALPHA/');
  assert.equal(context.db.prepare('SELECT name FROM models WHERE id = ?').get(modelId).name, 'Alpha Model');
  assert.equal(context.db.prepare('SELECT source_url FROM model_urls').get().source_url, 'https://source.test/alpha');

  const galleryId = context.repository.upsertGalleryRecord('alpha-model', 'Alpha', '001', {
    title: 'First',
    sourceUrl: 'HTTPS://SOURCE.TEST/GALLERY/001/',
    sourceProvider: 'direct',
    imageCount: 3,
    coverName: 'cover.jpg',
    imageBytes: 100,
    thumbBytes: 20,
    touchModelUpdatedAt: false,
  });
  context.setNow('2026-08-17T10:00:00.000Z');
  context.repository.upsertGalleryRecord('alpha-model', 'Alpha Updated', '001', {
    title: 'Updated',
    sourceUrl: 'https://source.test/gallery/001',
    count: 4,
    touchModelUpdatedAt: false,
  });

  const model = context.db.prepare('SELECT name, updated_at FROM models WHERE id = ?').get(modelId);
  const gallery = context.repository.galleryDbRecord('alpha-model', '001');
  assert.deepEqual(model, { name: 'Alpha Updated', updated_at: '2026-08-16T10:00:00.000Z' });
  assert.equal(gallery.id, galleryId);
  assert.equal(gallery.source_url, 'https://source.test/gallery/001');
  assert.equal(gallery.source_provider, 'direct');
  assert.equal(gallery.image_count, 4);
  assert.equal(gallery.cover_name, 'cover.jpg');
  assert.equal(gallery.image_bytes, 100);
  assert.equal(gallery.thumb_bytes, 20);
  assert.equal(context.repository.galleryDbId('alpha-model', '001'), galleryId);
  assert.equal(context.repository.galleryRecordsForModel('alpha-model').get('001').id, galleryId);
  context.db.close();
});

test('favorite and seen queries return stable sets and summaries', () => {
  const context = fixture();
  const modelId = context.repository.upsertModelRecord('alpha', 'Alpha');
  const galleryId = context.repository.upsertGalleryRecord('alpha', 'Alpha', '001', { count: 3 });
  context.db.exec(`
    INSERT INTO model_favorites (user_id, model_id, created_at) VALUES (1, ${modelId}, 'now');
    INSERT INTO gallery_favorites (user_id, gallery_id, created_at) VALUES (1, ${galleryId}, 'now');
    INSERT INTO image_favorites (user_id, gallery_id, image_name, created_at) VALUES (1, ${galleryId}, 'one.jpg', 'now');
    INSERT INTO image_seen (user_id, gallery_id, image_name, seen_at) VALUES
      (1, ${galleryId}, 'one.jpg', 'now'),
      (1, ${galleryId}, 'two.jpg', 'now');
  `);

  const favorites = context.repository.favoriteSetsForUser(1);
  assert.equal(favorites.models.has(modelId), true);
  assert.equal(favorites.galleries.has(galleryId), true);
  assert.equal(favorites.images.has(`${galleryId}\none.jpg`), true);
  assert.deepEqual([...context.repository.seenImagesForGallery(1, galleryId)].sort(), ['one.jpg', 'two.jpg']);
  assert.deepEqual(context.repository.seenSummaryForGallery(1, galleryId), {
    seen: false,
    seenCount: 2,
    count: 3,
  });
  assert.deepEqual(context.repository.galleryRecordById(galleryId), {
    id: galleryId,
    galleryFolder: '001',
    modelFolder: 'alpha',
  });
  assert.equal(context.repository.getGalleryById(galleryId).id, galleryId);
  context.db.close();
});

test('unseen totals use the current library state and stale seen rows are removed', () => {
  const context = fixture();
  const galleryId = context.repository.upsertGalleryRecord('alpha', 'Alpha', '001', { count: 3 });
  context.db.exec(`
    INSERT INTO image_seen (user_id, gallery_id, image_name, seen_at) VALUES
      (1, ${galleryId}, 'one.jpg', 'now'),
      (1, ${galleryId}, 'stale.jpg', 'now');
  `);
  context.setState({
    models: [{ count: 3, galleries: [{ dbId: galleryId, count: 3 }] }],
  });
  assert.deepEqual(context.repository.unseenStatsForUser(1), { models: 1, galleries: 1, images: 1 });

  context.repository.cleanupSeenRecordsForGallery(galleryId, ['one.jpg', 'two.jpg', 'three.jpg']);
  assert.deepEqual([...context.repository.seenImagesForGallery(1, galleryId)], ['one.jpg']);
  context.repository.cleanupSeenRecordsForGallery(galleryId, []);
  assert.equal(context.repository.seenImagesForGallery(1, galleryId).size, 0);
  context.db.close();
});
