'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeRouteParts, handleSiteRoute } = require('../server/routes/site');

function fixture() {
  const calls = [];
  const state = {
    models: [{ id: 'alpha model', galleries: [{ name: '001' }] }],
  };
  const context = {
    sendJson: (_res, status, payload) => calls.push(['json', status, payload]),
    sendHtml: (_res, status, body) => calls.push(['html', status, body]),
    sendText: (_res, status, body, type) => calls.push(['text', status, body, type]),
    stateForUser: () => ({ status: 'ready' }),
    galleryImagesResponseForUser: (_req, model, gallery) => ({ model, gallery }),
    handleEvents: () => calls.push(['events']),
    absoluteUrlForRequest: (_req, route) => `https://example.test${route}`,
    renderSitemapIndex: () => '<index/>',
    renderPagesSitemap: () => '<pages/>',
    renderModelsSitemap: () => '<models/>',
    renderGalleriesSitemap: () => '<galleries/>',
    renderHomePage: () => 'home',
    renderModelsPage: () => 'models',
    renderFavoritesPage: () => 'favorites',
    renderModelPage: (_req, model) => `model:${model.id}`,
    renderGalleryPage: (_req, model, gallery) => `gallery:${model.id}:${gallery.name}`,
    renderNotFoundPage: () => 'missing',
    renderWebAppManifest: () => '{"display":"standalone"}',
    getState: () => state,
  };
  return { calls, context };
}

test('gallery API query parameters are delegated to the user library response', () => {
  const { calls, context } = fixture();
  const url = new URL('https://example.test/api/gallery?model=alpha&gallery=002');
  const handled = handleSiteRoute(context, { method: 'GET' }, {}, url);

  assert.equal(handled, true);
  assert.deepEqual(calls, [['json', 200, { model: 'alpha', gallery: '002' }]]);
});

test('encoded model and gallery routes resolve server-rendered entities', () => {
  const { calls, context } = fixture();
  const url = new URL('https://example.test/model/alpha%20model/gallery/001');
  const handled = handleSiteRoute(context, { method: 'GET' }, {}, url);

  assert.equal(handled, true);
  assert.deepEqual(calls, [['html', 200, 'gallery:alpha model:001']]);
});

test('unknown routes fall through to static handling', () => {
  const { calls, context } = fixture();
  const handled = handleSiteRoute(context, { method: 'GET' }, {}, new URL('https://example.test/asset.css'));

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(decodeRouteParts('/model/bad%EA/gallery/001'), ['model', 'bad%EA', 'gallery', '001']);
});

test('web app manifest is served with the installable manifest content type', () => {
  const { calls, context } = fixture();
  const handled = handleSiteRoute(context, { method: 'GET' }, {}, new URL('https://example.test/manifest.webmanifest'));

  assert.equal(handled, true);
  assert.deepEqual(calls, [[
    'text',
    200,
    '{"display":"standalone"}',
    'application/manifest+json; charset=utf-8',
  ]]);
});

test('public routes cannot trigger a library rescan', () => {
  const { calls, context } = fixture();
  const handled = handleSiteRoute(context, { method: 'POST' }, {}, new URL('https://example.test/api/rescan'));

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
});
