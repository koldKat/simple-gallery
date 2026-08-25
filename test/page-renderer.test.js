'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageRenderer } = require('../server/page-renderer');

function stateWith(models = [], latest = []) {
  return {
    totals: {
      models: models.length,
      galleries: models.reduce((sum, model) => sum + model.galleries.length, 0),
      images: models.reduce((sum, model) => sum + model.count, 0),
    },
    models,
    latest,
  };
}

function rendererFor(getState) {
  return createPageRenderer({
    getState,
    normalizeModelName: name => String(name || '').replaceAll('-', ' '),
    galleryImagesResponse: () => ({
      images: [{ name: 'one.jpg', src: '/media/one.jpg', thumb: '/media/thumbs/one.jpg' }],
    }),
    appMetadata: () => ({
      name: 'Test & Gallery',
      tagline: 'A test instance',
      versionLabel: '1.2.3',
    }),
    seoProfile: () => ({}),
  });
}

function request(url = '/') {
  return { url, headers: { host: 'example.test', 'x-forwarded-proto': 'https' } };
}

function model(id = 'new-model') {
  return {
    id,
    name: 'New <Model>',
    cover: '/media/cover.jpg',
    count: 1,
    galleryCount: 1,
    updatedAt: '2026-08-16T00:00:00.000Z',
    galleries: [{
      name: '001',
      cover: '/media/gallery.jpg',
      count: 1,
      updatedAt: '2026-08-16T00:00:00.000Z',
    }],
  };
}

test('page renderer reads current library state for every render', () => {
  let state = stateWith();
  const renderer = rendererFor(() => state);
  assert.doesNotMatch(renderer.renderHomePage(request()), /new-model/);

  const addedModel = model();
  state = stateWith([addedModel], [{
    modelId: addedModel.id,
    modelName: addedModel.name,
    name: '001',
    cover: '/media/gallery.jpg',
    count: 1,
  }]);

  const html = renderer.renderHomePage(request());
  assert.match(html, /\/model\/new-model/);
  assert.match(html, /1 model/);
});

test('models page honors letter and page query parameters', () => {
  const models = Array.from({ length: 61 }, (_, index) => ({
    ...model(`alpha-${index}`),
    name: `Alpha ${index}`,
  }));
  const renderer = rendererFor(() => stateWith(models));
  const html = renderer.renderModelsPage(request('/models?letter=A&page=2'));

  assert.match(html, /Models: A/);
  assert.match(html, /browser-model-card" href="\/model\/alpha-60/);
  assert.doesNotMatch(html, /browser-model-card" href="\/model\/alpha-0"/);
  assert.match(html, /rel="prev"/);
});

test('SEO metadata is escaped and gallery pages include image data', () => {
  const selectedModel = model();
  const renderer = rendererFor(() => stateWith([selectedModel]));
  const html = renderer.renderGalleryPage(request('/model/new-model/gallery/001'), selectedModel, selectedModel.galleries[0]);

  assert.match(html, /<title>New &lt;Model&gt; \/ Gallery 001 \| Test &amp; Gallery<\/title>/);
  assert.match(html, /https:\/\/example\.test\/media\/one\.jpg/);
  assert.match(html, /"@type":"ImageObject"/);
  assert.match(html, /<script type="module" src="\/js\/app\.js"><\/script>/);
});
