'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleAdminRoute } = require('../server/routes/admin');

function recorder() {
  const calls = [];
  return {
    calls,
    sendJson(_res, status, payload) {
      calls.push({ status, payload });
    },
  };
}

function waitTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('admin route ignores non-admin paths', () => {
  assert.equal(handleAdminRoute({}, {}, {}, { pathname: '/api/state' }), false);
});

test('admin route rejects remote requests before dispatch', () => {
  const output = recorder();
  const handled = handleAdminRoute({
    isLocalhostRequest: () => false,
    sendJson: output.sendJson,
  }, {}, {}, { pathname: '/api/admin/state' });

  assert.equal(handled, true);
  assert.deepEqual(output.calls, [{ status: 403, payload: { error: 'Admin API is only available from localhost.' } }]);
});

test('admin user deletion remains localhost-only', () => {
  const output = recorder();
  handleAdminRoute({
    isLocalhostRequest: () => false,
    sendJson: output.sendJson,
  }, { method: 'POST' }, {}, { pathname: '/api/admin/users/delete' });
  assert.deepEqual(output.calls, [{ status: 403, payload: { error: 'Admin API is only available from localhost.' } }]);
});

test('admin state is returned without the full library payload', () => {
  const output = recorder();
  const handled = handleAdminRoute({
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
    getState: () => ({
      status: 'ready',
      message: 'Loaded',
      scannedAt: 'now',
      totals: { models: 1, galleries: 2, images: 3 },
    }),
    runtimeStats: () => ({ rssBytes: 123 }),
    appMetadata: () => ({ versionLabel: 'v1', lastSourceUrl: 'https://example.test/model/A' }),
  }, {}, {}, { pathname: '/api/admin/state' });

  assert.equal(handled, true);
  assert.deepEqual(output.calls, [{
    status: 200,
    payload: {
      status: 'ready',
      message: 'Loaded',
      scannedAt: 'now',
      totals: { models: 1, galleries: 2, images: 3 },
      runtime: { rssBytes: 123 },
      app: { versionLabel: 'v1', lastSourceUrl: 'https://example.test/model/A' },
    },
  }]);
});

test('admin summary and live endpoints return their dedicated payloads', () => {
  const output = recorder();
  const context = {
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
    adminSummaryStats: () => ({ library: { models: 2 } }),
    liveRuntimeStats: () => ({ appAgeSeconds: 10 }),
  };
  handleAdminRoute(context, { method: 'GET' }, {}, { pathname: '/api/admin/stats' });
  handleAdminRoute(context, { method: 'GET' }, {}, { pathname: '/api/admin/live' });
  assert.deepEqual(output.calls, [
    { status: 200, payload: { library: { models: 2 } } },
    { status: 200, payload: { appAgeSeconds: 10 } },
  ]);
});

test('admin account lock and session revoke endpoints dispatch their actions', async () => {
  const output = recorder();
  const calls = [];
  const context = {
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
    readRequestBody: async () => JSON.stringify({ id: 7, locked: true }),
    revokeAdminUserSessions(id) { calls.push(['revoke', id]); return { cleared: 2 }; },
    setAdminUserLocked(id, locked) { calls.push(['lock', id, locked]); return { users: [] }; },
  };
  handleAdminRoute(context, { method: 'POST' }, {}, { pathname: '/api/admin/users/revoke-sessions' });
  await waitTurn();
  handleAdminRoute(context, { method: 'POST' }, {}, { pathname: '/api/admin/users/lock' });
  await waitTurn();
  assert.deepEqual(calls, [['revoke', 7], ['lock', 7, true]]);
  assert.deepEqual(output.calls, [
    { status: 200, payload: { cleared: 2 } },
    { status: 200, payload: { users: [] } },
  ]);
});

test('admin route reads live loaded-model state through its getter', () => {
  const output = recorder();
  let loaded = null;
  const ctx = {
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
    getLoadedModelList: () => loaded,
  };
  handleAdminRoute(ctx, {}, {}, { pathname: '/api/admin/loaded-models' });
  assert.deepEqual(output.calls.at(-1).payload, { sourceUrl: '', pageCount: 0, models: [] });

  loaded = { sourceUrl: 'configured', pageCount: 2, models: [{ name: 'Example' }] };
  handleAdminRoute(ctx, {}, {}, { pathname: '/api/admin/loaded-models' });
  assert.equal(output.calls.at(-1).payload, loaded);
});

test('admin route exposes model autocomplete choices', () => {
  const output = recorder();
  handleAdminRoute({
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
    adminModelOptionsResponse: () => ({ models: [{ name: 'Alpha', folder: 'alpha' }] }),
  }, { method: 'GET' }, {}, { pathname: '/api/admin/model-options' });
  assert.deepEqual(output.calls, [{
    status: 200,
    payload: { models: [{ name: 'Alpha', folder: 'alpha' }] },
  }]);
});

test('admin route preserves active-import vacuum guard', () => {
  const output = recorder();
  let vacuumed = false;
  handleAdminRoute({
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
    getImportJob: () => ({ active: true }),
    vacuumDatabase: () => { vacuumed = true; },
  }, { method: 'POST' }, {}, { pathname: '/api/admin/vacuum-db' });

  assert.equal(vacuumed, false);
  assert.equal(output.calls.at(-1).status, 409);
});

test('admin route dispatches direct gallery imports with normalized fields', async () => {
  const output = recorder();
  let command = null;
  let payload = null;
  const handled = handleAdminRoute({
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
    readRequestBody: async () => JSON.stringify({
      model: '  alpha  ',
      url: '  https://gallery.example/galleries/one  ',
      providerId: '  direct  ',
    }),
    requestWorker: async (nextCommand, nextPayload) => {
      command = nextCommand;
      payload = nextPayload;
      return { status: 'running' };
    },
  }, { method: 'POST' }, {}, { pathname: '/api/admin/import-gallery' });

  assert.equal(handled, true);
  await waitTurn();
  assert.equal(command, 'direct-gallery-import');
  assert.deepEqual(payload, {
    model: 'alpha',
    url: 'https://gallery.example/galleries/one',
    providerId: 'direct',
  });
  assert.deepEqual(output.calls, [{ status: 200, payload: { status: 'running' } }]);
});

test('unknown admin routes return the original JSON 404', () => {
  const output = recorder();
  handleAdminRoute({
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
  }, { method: 'GET' }, {}, { pathname: '/api/admin/unknown' });
  assert.deepEqual(output.calls, [{ status: 404, payload: { error: 'Not found.' } }]);
});
