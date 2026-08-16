'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-preferences.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function classList() {
  const values = new Set();
  return {
    toggle(name, enabled) { enabled ? values.add(name) : values.delete(name); },
    has: name => values.has(name),
  };
}

function fixture(createAppPreferencesController) {
  const stored = new Map();
  const inserted = [];
  const state = { mode: 'model', selectedModel: 'alpha', user: null };
  const elements = {
    modelBrowser: { parentNode: { insertBefore: item => inserted.push(item) } },
    imageGrid: { classList: classList() },
    gridLarge: { classList: classList() },
    gridSmall: { classList: classList() },
  };
  const documentObject = {
    createElement() {
      return { className: '', hidden: false, style: {}, append(child) { this.child = child; } };
    },
  };
  let renders = 0;
  let preloadSyncs = 0;
  const controller = createAppPreferencesController({
    state,
    elements,
    storageKeys: {
      anonPreloadModel: 'model',
      anonPreloadGallery: 'gallery',
      largeThumbs: 'large',
    },
    storage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
    documentObject,
    render: () => { renders += 1; },
    syncPreloadForCurrentView: () => { preloadSyncs += 1; },
  });
  return { controller, elements, inserted, state, stored, counts: () => ({ renders, preloadSyncs }) };
}

test('anonymous preload preferences persist and trigger current-view preload', async () => {
  const { createAppPreferencesController } = await loadModule();
  const { controller, counts, stored } = fixture(createAppPreferencesController);

  controller.saveAnonymousPreloadSettings({ preloadModel: true, preloadGallery: false });

  assert.deepEqual(controller.preloadPreferences(), { preloadModel: true, preloadGallery: false });
  assert.equal(stored.get('model'), '1');
  assert.deepEqual(counts(), { renders: 1, preloadSyncs: 1 });
});

test('authenticated preferences take precedence over anonymous storage', async () => {
  const { createAppPreferencesController } = await loadModule();
  const { controller, state, stored } = fixture(createAppPreferencesController);
  stored.set('model', '1');
  state.user = { preloadModel: false, preloadGallery: true };

  assert.deepEqual(controller.preloadPreferences(), { preloadModel: false, preloadGallery: true });
});

test('preload progress is clamped and shown only in an enabled model scope', async () => {
  const { createAppPreferencesController } = await loadModule();
  const { controller, inserted, stored } = fixture(createAppPreferencesController);
  stored.set('model', '1');

  controller.setPreloadProgress({ total: 4, completed: 2 });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].hidden, false);
  assert.equal(inserted[0].child.style.width, '50.00%');
  controller.setPreloadProgress({ total: 4, completed: 8 });
  assert.equal(inserted[0].child.style.width, '100.00%');
});

test('grid size selection updates classes and storage', async () => {
  const { createAppPreferencesController } = await loadModule();
  const { controller, elements, stored } = fixture(createAppPreferencesController);

  controller.setGridSize(true);

  assert.equal(elements.imageGrid.classList.has('large'), true);
  assert.equal(elements.gridLarge.classList.has('is-active'), true);
  assert.equal(elements.gridSmall.classList.has('is-active'), false);
  assert.equal(stored.get('large'), '1');
});
