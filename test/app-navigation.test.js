'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-navigation.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fixture(createAppNavigationController, pathname = '/') {
  const location = { pathname };
  const calls = { decoded: 0, preload: 0, preloadReset: 0, records: [], renders: 0, routes: [] };
  const state = {
    data: {
      scannedAt: 'one',
      models: [{
        id: 'alpha',
        galleries: [
          { id: 'alpha/001', dbId: 11 },
          { id: 'alpha/002', dbId: 12 },
        ],
      }],
    },
    mode: 'home',
    selectedModel: null,
    selectedGallery: null,
    activeImages: [{ name: 'old.jpg' }],
    activeGalleryId: 'alpha/001',
    imagesLoading: true,
  };
  const history = {
    pushState(_state, _title, next) { location.pathname = next; calls.routes.push(['push', next]); },
    replaceState(_state, _title, next) { location.pathname = next; calls.routes.push(['replace', next]); },
  };
  const parsePath = value => {
    const parts = value.split('/').filter(Boolean);
    if (!parts.length) return { recognized: true, mode: 'home' };
    if (parts[0] === 'model' && parts[1] && parts[2] === 'gallery' && parts[3]) {
      return { recognized: true, mode: 'model', modelId: parts[1], galleryName: parts[3] };
    }
    if (parts[0] === 'model' && parts[1]) return { recognized: true, mode: 'model', modelId: parts[1] };
    return { recognized: false, mode: 'home' };
  };
  const pathForState = value => value.selectedGallery
    ? `/model/${value.selectedModel}/gallery/${value.selectedGallery.split('/')[1]}`
    : value.selectedModel ? `/model/${value.selectedModel}` : '/';
  const controller = createAppNavigationController({
    state,
    location,
    history,
    parsePath,
    pathForState,
    releaseDecodedCache: () => { calls.decoded += 1; },
    resetPreloadScope: () => { calls.preloadReset += 1; },
    clearGalleryCache() {},
    applySeenOverrides() {},
    syncPreloadScope() {},
    syncPreloadForCurrentView: () => { calls.preload += 1; },
    advanceSidebarShuffle() {},
    recordView: payload => calls.records.push(payload),
    render: () => { calls.renders += 1; },
  });
  return { calls, controller, location, state };
}

test('deep gallery routes restore selection and clear stale active images', async () => {
  const { createAppNavigationController } = await loadModule();
  const { calls, controller, state } = fixture(createAppNavigationController, '/model/alpha/gallery/002');

  controller.applyRouteFromLocation();

  assert.equal(state.mode, 'model');
  assert.equal(state.selectedGallery, 'alpha/002');
  assert.deepEqual(state.activeImages, []);
  assert.equal(calls.decoded, 1);
});

test('gallery stepping updates history, records the view, and renders once', async () => {
  const { createAppNavigationController } = await loadModule();
  const { calls, controller, state } = fixture(createAppNavigationController);
  controller.openGallery('alpha', 'alpha/001');
  calls.records.length = 0;

  controller.stepGallery(1);

  assert.equal(state.selectedGallery, 'alpha/002');
  assert.deepEqual(calls.routes.at(-1), ['push', '/model/alpha/gallery/002']);
  assert.deepEqual(calls.records, [{ type: 'gallery', galleryDbId: 12 }]);
  assert.equal(calls.renders, 1);
});

test('library replacement drops invalid selections and resets preload scope', async () => {
  const { createAppNavigationController } = await loadModule();
  const { calls, controller, state } = fixture(createAppNavigationController);
  state.mode = 'model';
  state.selectedModel = 'alpha';
  state.selectedGallery = 'alpha/001';

  controller.setData({ scannedAt: 'two', models: [], user: null });

  assert.equal(state.mode, 'home');
  assert.equal(state.selectedModel, null);
  assert.equal(calls.preloadReset, 1);
  assert.equal(calls.renders, 1);
});
