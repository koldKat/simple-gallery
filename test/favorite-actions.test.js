'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-favorite-actions.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fixture(createFavoriteActionsController, overrides = {}) {
  const image = { dbId: 7, name: 'one.jpg', favorite: false };
  const gallery = { dbId: 7, favorite: false };
  const model = { id: 'alpha', favorite: false, galleries: [gallery] };
  const state = {
    user: { id: 1 },
    mode: 'model',
    data: { models: [model] },
    favorites: { galleries: [{ dbId: 7, favorite: false }] },
    activeImages: [image],
  };
  const calls = { api: [], cache: [], count: [], images: 0, lightbox: 0, render: 0 };
  const controller = createFavoriteActionsController({
    state,
    setTooltip() {},
    fetchJson: async (url, options) => {
      calls.api.push([url, options]);
      return { favorite: true, favoriteCount: 5 };
    },
    galleryCache: { patchFavorite: (...args) => calls.cache.push(args) },
    getFavoritesController: () => ({ patchImageFavorite() {} }),
    updateFavoriteCount: (...args) => calls.count.push(args),
    loadFavorites: async () => {},
    render: () => { calls.render += 1; },
    renderImageTiles: () => { calls.images += 1; },
    renderLightboxMeta: () => { calls.lightbox += 1; },
    ...overrides,
  });
  return { calls, controller, gallery, image, model, state };
}

test('image favorite mutations propagate to active and cached state', async () => {
  const { createFavoriteActionsController } = await loadModule();
  const { calls, controller, image } = fixture(createFavoriteActionsController);

  await controller.toggleImage(image);

  assert.equal(image.favorite, true);
  assert.equal(calls.api[0][0], '/api/favorites/image');
  assert.equal(calls.api[0][1].method, 'POST');
  assert.deepEqual(calls.cache, [[7, 'one.jpg', true]]);
  assert.deepEqual(calls.count, [[{ favorite: true, favoriteCount: 5 }, true]]);
  assert.equal(calls.images, 1);
  assert.equal(calls.lightbox, 1);
});

test('gallery favorite mutations update every in-memory representation', async () => {
  const { createFavoriteActionsController } = await loadModule();
  const { calls, controller, gallery, state } = fixture(createFavoriteActionsController);

  await controller.toggleGallery(gallery);

  assert.equal(gallery.favorite, true);
  assert.equal(state.favorites.galleries[0].favorite, true);
  assert.equal(calls.api[0][0], '/api/favorites/gallery');
  assert.equal(calls.render, 1);
});
