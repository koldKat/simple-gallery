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

test('unknown admin routes return the original JSON 404', () => {
  const output = recorder();
  handleAdminRoute({
    isLocalhostRequest: () => true,
    sendJson: output.sendJson,
  }, { method: 'GET' }, {}, { pathname: '/api/admin/unknown' });
  assert.deepEqual(output.calls, [{ status: 404, payload: { error: 'Not found.' } }]);
});
