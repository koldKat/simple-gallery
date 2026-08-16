'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSitemapRenderer, sitemapUrlsetXml } = require('../server/sitemap');

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function rendererFor(getState) {
  return createSitemapRenderer({
    escapeHtml,
    absoluteUrlForRequest: (_req, path) => `https://example.test${path}`,
    modelRoutePath: id => `/model/${id}`,
    galleryRoutePath: (id, gallery) => `/model/${id}/gallery/${gallery}`,
    modelsDirectoryPath: (letter, page) => `/models?letter=${letter}&page=${page}`,
    normalizeModelName: name => String(name || ''),
    getState,
  });
}

test('URL sets escape locations and omit invalid dates', () => {
  const xml = sitemapUrlsetXml([
    { loc: 'https://example.test/?a=1&b=2', lastmod: 'not-a-date' },
    { loc: 'https://example.test/valid', lastmod: '2026-08-16T10:20:30.000Z' },
  ], escapeHtml);

  assert.match(xml, /a=1&amp;b=2/);
  assert.doesNotMatch(xml, /not-a-date/);
  assert.match(xml, /2026-08-16T10:20:30\.000Z/);
});

test('renderer reads current state for every request', () => {
  let state = { scannedAt: null, models: [] };
  const renderer = rendererFor(() => state);
  assert.doesNotMatch(renderer.renderModels({}), /\/model\/new-model/);

  state = {
    scannedAt: '2026-08-16T00:00:00.000Z',
    models: [{
      id: 'new-model',
      name: 'New Model',
      updatedAt: null,
      galleries: [{ name: '001', updatedAt: null }],
    }],
  };
  assert.match(renderer.renderModels({}), /\/model\/new-model/);
  assert.match(renderer.renderGalleries({}), /\/model\/new-model\/gallery\/001/);
});

test('pages sitemap includes every all-model and populated-letter page', () => {
  const models = Array.from({ length: 61 }, (_, index) => ({
    id: `a-${index}`,
    name: `A ${index}`,
    galleries: [],
  }));
  const xml = rendererFor(() => ({ scannedAt: null, models })).renderPages({});

  assert.match(xml, /letter=&amp;page=1/);
  assert.match(xml, /letter=&amp;page=2/);
  assert.match(xml, /letter=A&amp;page=1/);
  assert.match(xml, /letter=A&amp;page=2/);
  assert.doesNotMatch(xml, /letter=B/);
});
