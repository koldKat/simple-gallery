'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-favorites.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('favorites source contains no mechanically corrupted model identifiers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-favorites.js'), 'utf8');
  assert.doesNotMatch(source, /modelements/i);
});

function fixture(createFavoritesController, overrides = {}) {
  const state = {
    mode: 'favorites',
    user: { id: 1, favoriteCount: 3 },
    favorites: null,
    favoritesLoading: false,
    favoritesError: null,
  };
  const elements = {
    favoritesView: { hidden: false, innerHTML: '', append() {} },
    galleryKicker: { textContent: '' },
    galleryTitle: { textContent: '' },
  };
  let renderCount = 0;
  const controller = createFavoritesController({
    state,
    elements,
    formatCount: value => String(value),
    formatDate: value => String(value),
    titleCase: value => String(value),
    fetchJson: overrides.fetchJson || (async () => ({ models: [], galleries: [], imageGroups: [], imageCount: 0 })),
    bindCardImageLoading() {},
    favoriteButton() {},
    toggleImageFavorite: async () => {},
    toggleGalleryFavorite: async () => {},
    toggleModelFavorite: async () => {},
    openLightbox() {},
    openGallery() {},
    openModel() {},
    render: () => { renderCount += 1; },
    showNotice() {},
    syncGalleryBackdrop() {},
    documentObject: {},
  });
  return { controller, elements, get renderCount() { return renderCount; }, state };
}

test('favorites loading deduplicates concurrent overview requests', async () => {
  const { createFavoritesController } = await loadModule();
  let resolveRequest;
  let requestCount = 0;
  const context = fixture(createFavoritesController, {
    fetchJson: async () => {
      requestCount += 1;
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });

  const first = context.controller.load();
  const second = context.controller.load();
  assert.equal(requestCount, 1);
  assert.equal(context.state.favoritesLoading, true);
  resolveRequest({ user: { id: 1, favoriteCount: 4 }, models: [], galleries: [], imageGroups: [], imageCount: 0 });
  await Promise.all([first, second]);

  assert.equal(context.state.favoritesLoading, false);
  assert.equal(context.state.user.favoriteCount, 4);
  assert.equal(context.renderCount, 1);
});

test('favorites load failures clear the in-flight guard and allow retry', async () => {
  const { createFavoritesController } = await loadModule();
  let requestCount = 0;
  const context = fixture(createFavoritesController, {
    fetchJson: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new Error('temporary failure');
      return { models: [], galleries: [], imageGroups: [], imageCount: 0 };
    },
  });

  await assert.rejects(context.controller.load(), /temporary failure/);
  assert.equal(context.state.favoritesError, 'temporary failure');
  await context.controller.load();
  assert.equal(requestCount, 2);
  assert.equal(context.state.favoritesError, null);
});

test('favorites render keeps logged-out users out of the private view', async () => {
  const { createFavoritesController } = await loadModule();
  const context = fixture(createFavoritesController);
  context.state.user = null;
  context.controller.render();
  assert.equal(context.elements.galleryKicker.textContent, 'Favorites');
  assert.match(context.elements.favoritesView.innerHTML, /Login to view favorites/);
});
