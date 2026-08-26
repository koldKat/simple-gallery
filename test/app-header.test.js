'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-header.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function element() {
  return {
    classList: { add() {}, toggle() {} },
    style: {},
    textContent: '',
    innerHTML: '',
    replaceChildren(...children) { this.children = children; },
  };
}

function fixture(createAppHeaderController) {
  const model = {
    id: 'alpha',
    name: 'alpha-model',
    seen: false,
    favorite: false,
    galleries: [{ id: 'alpha/001', name: '001', count: 3, seenCount: 1, seen: false }],
  };
  const state = {
    mode: 'model',
    selectedModel: 'alpha',
    selectedGallery: 'alpha/001',
    user: { id: 4, favoriteCount: 12 },
    userStats: { models: 1, galleries: 1, images: 2 },
    data: {
      app: { name: 'Gallery', homeTitle: 'Gallery Home', tagline: 'Tag', versionLabel: 'v1' },
      totals: { models: 1, galleries: 1, images: 3 },
      models: [model],
    },
  };
  const documentObject = {
    title: '',
    createTextNode: text => ({ textContent: text }),
    createElement: () => element(),
  };
  const elements = {
    appName: element(),
    appTagline: element(),
    versionLabel: element(),
    stats: element(),
    userStats: element(),
    userStatsRow: element(),
    favoritesButton: element(),
    modelFavoriteButton: element(),
    modelSeenButton: element(),
  };
  const controller = createAppHeaderController({
    state,
    elements,
    documentObject,
    currentModel: () => model,
    currentGallery: () => model.galleries[0],
    syncActiveGallerySeenState() {},
    setTooltip() {},
    formatCount: value => String(value),
    titleCase: value => String(value).replace('-', ' '),
  });
  return { controller, documentObject, elements, state };
}

test('header metadata follows the selected gallery route', async () => {
  const { createAppHeaderController } = await loadModule();
  const { controller, documentObject, elements } = fixture(createAppHeaderController);

  controller.renderMetadata();

  assert.equal(documentObject.title, 'alpha model / Gallery 001 | Gallery');
  assert.equal(elements.appName.textContent, 'Gallery');
  assert.equal(elements.versionLabel.textContent, 'v1');
});

test('header stats render the supplied unseen totals for the authenticated user', async () => {
  const { createAppHeaderController } = await loadModule();
  const { controller, elements, state } = fixture(createAppHeaderController);

  controller.renderStats();
  controller.renderFavoritesButton();

  assert.deepEqual(state.userStats, { models: 1, galleries: 1, images: 2 });
  assert.match(elements.userStats.innerHTML, />2<\/span><span class="stat-word">images/);
  assert.equal(elements.favoritesButton.children[1].textContent, '(12)');
  assert.equal(elements.favoritesButton.hidden, false);
});

test('server favorite counts replace local estimates', async () => {
  const { createAppHeaderController } = await loadModule();
  const { controller, state } = fixture(createAppHeaderController);

  controller.updateFavoriteCount({ favoriteCount: 20 }, true);

  assert.equal(state.user.favoriteCount, 20);
});
