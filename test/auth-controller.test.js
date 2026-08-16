'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-auth.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

class FakeElement {
  constructor(tagName = '') {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.textContent = '';
  }
  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') this.children = [];
  }
  get innerHTML() { return this._innerHTML || ''; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name, event = {}) { return this.listeners.get(name)?.(event); }
}

function descendants(root) {
  const result = [];
  const visit = node => {
    if (!(node instanceof FakeElement)) return;
    result.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return result;
}

function fixture(createAuthController, options = {}) {
  const state = {
    mode: options.mode || 'home',
    user: options.user || null,
    userStats: { seen: 1 },
    favorites: { imageCount: 2 },
  };
  const authElement = new FakeElement('root');
  const calls = [];
  const documentObject = {
    createElement: tagName => new FakeElement(tagName),
    createTextNode: text => ({ textContent: text }),
  };
  let preferences = { preloadModel: false, preloadGallery: false };
  const controller = createAuthController({
    state,
    authElement,
    preloadPreferences: () => ({ ...preferences }),
    fetchJson: async (url, request) => {
      calls.push({ type: 'fetch', url, request });
      if (url === '/api/auth/logout') return {};
      return { user: { id: 7, username: 'alex', displayName: 'Alex' } };
    },
    syncUserOnlyUi: () => calls.push({ type: 'sync-user-ui' }),
    renderHeaderStats: () => calls.push({ type: 'header-stats' }),
    renderFavoritesButton: () => calls.push({ type: 'favorites-button' }),
    loadCurrentUserStats: async () => calls.push({ type: 'load-user-stats' }),
    loadState: async () => calls.push({ type: 'load-state' }),
    saveUserSettings: async next => { preferences = next; calls.push({ type: 'save-user-settings', next }); },
    saveAnonymousPreloadSettings: next => { preferences = next; calls.push({ type: 'save-anonymous', next }); },
    showNotice: message => calls.push({ type: 'notice', message }),
    documentObject,
  });
  return { authElement, calls, controller, state };
}

test('login submits credentials and refreshes personalized state in order', async () => {
  const { createAuthController } = await loadModule();
  const context = fixture(createAuthController);
  context.controller.render();
  const nodes = descendants(context.authElement);
  const username = nodes.find(node => node.placeholder === 'Username');
  const password = nodes.find(node => node.placeholder === 'Password');
  const login = nodes.find(node => node.textContent === 'Login');
  username.value = ' alex ';
  password.value = 'secret';
  await login.dispatch('click');

  assert.equal(context.state.user.displayName, 'Alex');
  const request = context.calls.find(call => call.type === 'fetch');
  assert.equal(request.url, '/api/auth/login');
  assert.deepEqual(JSON.parse(request.request.body), { username: 'alex', password: 'secret' });
  assert.deepEqual(context.calls.slice(1).map(call => call.type), [
    'sync-user-ui',
    'favorites-button',
    'load-user-stats',
    'load-state',
  ]);
});

test('anonymous preload changes stay in browser settings', async () => {
  const { createAuthController } = await loadModule();
  const context = fixture(createAuthController);
  context.controller.render();
  const checkboxes = descendants(context.authElement).filter(node => node.type === 'checkbox');
  checkboxes[0].checked = true;
  checkboxes[0].dispatch('change');
  assert.deepEqual(context.calls.at(-1), {
    type: 'save-anonymous',
    next: { preloadModel: true, preloadGallery: false },
  });
});

test('logout clears private state and leaves Favorites mode', async () => {
  const { createAuthController } = await loadModule();
  const context = fixture(createAuthController, {
    mode: 'favorites',
    user: { id: 7, username: 'alex', displayName: 'Alex' },
  });
  context.controller.render();
  const logout = descendants(context.authElement).find(node => node.textContent === 'Logout');
  await logout.dispatch('click');

  assert.equal(context.state.user, null);
  assert.equal(context.state.favorites, null);
  assert.equal(context.state.mode, 'home');
  assert.equal(context.calls[0].url, '/api/auth/logout');
  assert.equal(context.calls.at(-1).type, 'load-state');
});
