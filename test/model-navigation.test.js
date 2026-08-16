'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-model-navigation.js'), 'utf8');
  assert.doesNotMatch(source, /modelements/i);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fixture(createModelNavigationController, options = {}) {
  const sidebar = {
    style: { height: '100px' },
    getBoundingClientRect: () => ({ top: 20 }),
  };
  const modelList = {
    innerHTML: 'old',
    previousElementSibling: { offsetHeight: 40 },
    scrollHeight: 0,
    closest: () => sidebar,
    querySelector: () => null,
    append() {},
  };
  const state = {
    mode: options.mode || 'home',
    selectedModel: null,
    hideSeenModels: false,
    modelBrowserLetter: options.letter || 'all',
    modelBrowserPage: 0,
    data: {
      models: options.models || [
        { id: 'zoe', name: 'zoe', galleries: [], galleryCount: 0, count: 0 },
        { id: 'anna', name: 'anna', galleries: [], galleryCount: 0, count: 0 },
      ],
    },
  };
  const elements = {
    search: { value: '' },
    modelList,
    modelCount: { textContent: '' },
    modelBrowser: { hidden: true, innerHTML: '', append() {} },
    galleryKicker: { textContent: '' },
    galleryTitle: { textContent: '' },
  };
  const windowObject = {
    innerHeight: 800,
    innerWidth: 1200,
    matchMedia: () => ({ matches: Boolean(options.mobile) }),
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0', gap: '9' }),
    requestAnimationFrame: callback => { callback(); return 1; },
  };
  const controller = createModelNavigationController({
    state,
    elements,
    searchText: value => String(value || '').toLowerCase(),
    shuffledModels: models => models.slice().reverse(),
    formatCount: value => String(value),
    formatDate: value => String(value || ''),
    titleCase: value => String(value || '').replace(/\b\w/g, char => char.toUpperCase()),
    bindCardImageLoading() {},
    openModel() {},
    render() {},
    windowObject,
    documentObject: {},
  });
  return { controller, elements, sidebar, state };
}

test('model browser sorting and letter filtering do not mutate source order', async () => {
  const { createModelNavigationController } = await loadModule();
  const context = fixture(createModelNavigationController, { letter: 'A' });
  assert.deepEqual(context.controller.modelsForBrowser().map(model => model.id), ['anna']);
  assert.deepEqual(context.state.data.models.map(model => model.id), ['zoe', 'anna']);
});

test('sidebar cover uses the numerically last gallery', async () => {
  const { createModelNavigationController } = await loadModule();
  const context = fixture(createModelNavigationController);
  assert.equal(context.controller.previewCover({
    cover: '/fallback.jpg',
    galleries: [
      { name: '2', cover: '/two.jpg' },
      { name: '10', cover: '/ten.jpg' },
      { name: '9', cover: '/nine.jpg' },
    ],
  }), '/ten.jpg');
});

test('mobile sidebar renders no random model cards and releases fixed height', async () => {
  const { createModelNavigationController } = await loadModule();
  const context = fixture(createModelNavigationController, { mobile: true });
  context.controller.renderSidebar();
  assert.equal(context.elements.modelCount.textContent, '0 shown (2 total)');
  assert.equal(context.elements.modelList.innerHTML, '');
  assert.equal(context.sidebar.style.height, '');
});
