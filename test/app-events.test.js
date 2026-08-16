'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-events.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fixture(createAppEventController, overrides = {}) {
  const state = {
    mode: 'model',
    selectedGallery: null,
    activeImages: [],
    favorites: null,
    favoritesError: null,
  };
  const model = { id: 'alpha', galleries: [{ id: 'alpha/001' }] };
  const calls = { close: [], galleries: [], lightbox: [], renders: 0, steps: [] };
  const noop = () => {};
  const controller = createAppEventController({
    state,
    elements: {},
    documentObject: { addEventListener() {} },
    windowObject: { addEventListener() {}, EventSource: null },
    storageKeys: {},
    lightboxController: { handleKeydown: () => false, isOpen: () => false, bind: noop },
    renderModels: noop,
    writeStoredFlag: noop,
    setMajorMode: noop,
    syncRoute: noop,
    render: () => { calls.renders += 1; },
    currentModel: () => model,
    toggleModelFavorite: async () => {},
    setModelSeen: async () => {},
    showNotice: noop,
    setGridSize: noop,
    openLightbox: index => calls.lightbox.push(index),
    openGallery: (...args) => calls.galleries.push(args),
    stepGallery: delta => calls.steps.push(delta),
    closeLightbox: options => calls.close.push(options),
    applyRouteFromLocation: noop,
    advanceSidebarShuffle: noop,
    syncPreloadForCurrentView: noop,
    scheduleSidebarLayoutSync: noop,
    loadState: async () => {},
    initTooltips: noop,
    readStoredFlag: () => false,
    syncUserOnlyUi: noop,
    fitSidebarToRenderedCards: noop,
    loadCurrentUser: async () => {},
    loadCurrentUserStats: async () => {},
    ...overrides,
  });
  return { calls, controller, model, state };
}

test('space opens the first gallery from a model overview', async () => {
  const { createAppEventController } = await loadModule();
  const { calls, controller } = fixture(createAppEventController);
  let prevented = false;

  controller.handleDocumentKeydown({ key: ' ', preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.deepEqual(calls.galleries, [['alpha', 'alpha/001']]);
  assert.equal(calls.renders, 1);
});

test('space opens the first image when a gallery is selected', async () => {
  const { createAppEventController } = await loadModule();
  const { calls, controller, state } = fixture(createAppEventController);
  state.selectedGallery = 'alpha/001';
  state.activeImages = [{ name: 'one.jpg' }];

  controller.handleDocumentKeydown({ key: ' ', preventDefault() {} });

  assert.deepEqual(calls.lightbox, [0]);
  assert.deepEqual(calls.galleries, []);
});

test('browser back closes an open lightbox before changing the route', async () => {
  const { createAppEventController } = await loadModule();
  let routeChanges = 0;
  const { calls, controller } = fixture(createAppEventController, {
    lightboxController: { handleKeydown: () => false, isOpen: () => true, bind() {} },
    applyRouteFromLocation: () => { routeChanges += 1; },
  });

  controller.handlePopState();

  assert.deepEqual(calls.close, [{ fromHistory: true }]);
  assert.equal(routeChanges, 0);
});
