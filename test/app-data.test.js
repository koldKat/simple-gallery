'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-data.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function response(payload, ok = true) {
  return { ok, json: async () => payload };
}

function fixture(createAppDataService, fetchImpl) {
  const state = { user: null, userStats: null, data: { latest: [{ id: 'one' }] } };
  const calls = { favorites: 0, headers: 0, renders: 0, state: [] };
  const service = createAppDataService({
    state,
    fetchImpl,
    getGalleryCache: () => ({ fetch: async gallery => ({ id: gallery.id }) }),
    setData: data => calls.state.push(data),
    render: () => { calls.renders += 1; },
    renderAuth() {},
    syncUserOnlyUi() {},
    renderHeaderStats: () => { calls.headers += 1; },
    renderFavoritesButton: () => { calls.favorites += 1; },
    syncPreloadForCurrentView() {},
    showNotice() {},
  });
  return { calls, service, state };
}

test('JSON requests merge required and caller-provided headers', async () => {
  const { createAppDataService } = await loadModule();
  let request = null;
  const { service } = fixture(createAppDataService, async (_url, options) => {
    request = options;
    return response({ ok: true });
  });

  await service.fetchJson('/api/test', { headers: { 'x-test': 'yes' } });

  assert.deepEqual(request.headers, { 'content-type': 'application/json', 'x-test': 'yes' });
});

test('gallery helpers preserve database ids and URL-encode path segments', async () => {
  const { createAppDataService } = await loadModule();
  const { service } = fixture(createAppDataService, async () => response({}));

  assert.equal(service.galleryRequestUrl({ id: 'alpha model/001' }), '/api/gallery?model=alpha%20model&gallery=001');
  assert.deepEqual(service.galleryImagesFromPayload({ dbId: 7, images: [{ name: 'one.jpg' }] }), [
    { dbId: 7, name: 'one.jpg' },
  ]);
});

test('late user-stat responses cannot overwrite a different signed-in user', async () => {
  const { createAppDataService } = await loadModule();
  let resolveStats;
  const statsResponse = new Promise(resolve => { resolveStats = resolve; });
  const { calls, service, state } = fixture(createAppDataService, async url => {
    if (url === '/api/auth/stats') return statsResponse;
    return response({});
  });
  state.user = { id: 1 };
  const loading = service.loadCurrentUserStats();
  state.user = { id: 2 };
  resolveStats(response({ stats: { images: 99 } }));

  await loading;

  assert.equal(state.userStats, null);
  assert.equal(calls.headers, 0);
});

test('repeated scan notifications coalesce state loads without concurrent or stale responses', async () => {
  const { createAppDataService } = await loadModule();
  const pending = [];
  const { calls, service } = fixture(createAppDataService, url => {
    assert.equal(url, '/api/state');
    return new Promise(resolve => pending.push(resolve));
  });

  const first = service.loadState();
  const second = service.loadState();
  const third = service.loadState();
  assert.equal(pending.length, 1);

  pending[0](response({ scannedAt: 'first' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1](response({ scannedAt: 'latest' }));
  await Promise.all([first, second, third]);

  assert.deepEqual(calls.state.map(item => item.scannedAt), ['first', 'latest']);
});
