'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-gallery-cache.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('gallery cache deduplicates concurrent loads and can be cleared', async () => {
  const { createGalleryPayloadCache } = await loadModule();
  let requests = 0;
  let release;
  const responseReady = new Promise(resolve => { release = resolve; });
  const cache = createGalleryPayloadCache({
    requestUrl: gallery => `/gallery/${gallery.id}`,
    mergePayload: (_gallery, payload) => ({ ...payload, merged: true }),
    fetchImpl: async () => {
      requests += 1;
      await responseReady;
      return { ok: true, json: async () => ({ dbId: 10, images: [] }) };
    },
  });
  const gallery = { id: 'model/001' };
  const first = cache.fetch(gallery);
  const second = cache.fetch(gallery);
  assert.equal(requests, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal((await first).merged, true);

  cache.clear();
  await cache.fetch(gallery);
  assert.equal(requests, 2);
});

test('gallery cache refetches when gallery content metadata changes', async () => {
  const { createGalleryPayloadCache } = await loadModule();
  let requests = 0;
  const cache = createGalleryPayloadCache({
    requestUrl: gallery => `/gallery/${gallery.id}`,
    mergePayload: (_gallery, payload) => payload,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ request: ++requests, images: [] }),
    }),
  });
  const original = { id: 'model/001', dbId: 10, count: 2, updatedAtMs: 100, cover: '/old.jpg' };
  const replacement = { ...original, updatedAtMs: 200, cover: '/new.jpg' };

  assert.equal((await cache.fetch(original)).request, 1);
  assert.equal((await cache.fetch(original)).request, 1);
  assert.equal((await cache.fetch(replacement)).request, 2);
});

test('gallery cache preserves API error messages', async () => {
  const { createGalleryPayloadCache } = await loadModule();
  const cache = createGalleryPayloadCache({
    requestUrl: () => '/gallery',
    mergePayload: (_gallery, payload) => payload,
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'Specific failure.' }) }),
  });
  await assert.rejects(() => cache.fetch({ id: 'model/001' }), /Specific failure\./);
});

test('gallery cache patches seen and favorite image state', async () => {
  const { createGalleryPayloadCache } = await loadModule();
  const cache = createGalleryPayloadCache({
    requestUrl: () => '/gallery',
    mergePayload: (_gallery, payload) => payload,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        dbId: 10,
        seen: false,
        seenCount: 0,
        images: [
          { name: '001.jpg', seen: false, favorite: false },
          { name: '002.jpg', seen: false, favorite: false },
        ],
      }),
    }),
  });
  const gallery = { id: 'model/001' };
  await cache.fetch(gallery);
  cache.patchSeen(10, 1, false, { imageName: '001.jpg', imageSeen: true });
  cache.patchFavorite(10, '002.jpg', true);
  const payload = await cache.fetch(gallery);
  assert.equal(payload.seenCount, 1);
  assert.equal(payload.images[0].seen, true);
  assert.equal(payload.images[1].seen, false);
  assert.equal(payload.images[1].favorite, true);

  cache.patchSeen(10, 2, true, { allImages: true });
  assert.equal((await cache.fetch(gallery)).images.every(image => image.seen), true);
});
