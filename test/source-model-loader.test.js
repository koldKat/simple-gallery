'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceModelLoader } = require('../server/source-model-loader');

function canonical(value) {
  const url = new URL(value);
  return `${url.origin.toLowerCase()}${url.pathname.replace(/\/$/, '') || '/'}`;
}

function fixture(overrides = {}) {
  const pages = new Map([
    ['https://example.test/models', {
      pages: ['https://example.test/models', 'https://example.test/models?page=2'],
      models: [
        { name: 'Zulu', sourceUrl: 'https://example.test/model/zulu' },
        { name: 'Known', sourceUrl: 'https://example.test/model/known' },
      ],
    }],
    ['https://example.test/models?page=2', {
      pages: ['https://example.test/models?page=2'],
      models: [
        { name: 'Alpha', sourceUrl: 'https://example.test/model/alpha' },
        { name: 'Zulu Updated', sourceUrl: 'https://example.test/model/zulu' },
      ],
    }],
  ]);
  const broadcasts = [];
  const loader = createSourceModelLoader({
    requireSourceProfile: () => ({ modelPathSegment: 'model', modelListPath: '/models', modelListExample: '' }),
    validateSourceUrl: () => {},
    fetchText: async url => pages.get(url),
    extractPaginationUrls: page => page.pages,
    extractModelLinks: page => page.models,
    canonicalPageUrl: value => value,
    canonicalRemoteUrl: canonical,
    loadImportDb: () => overrides.importDb || {
      scannedUrls: ['https://example.test/model/known?from=list'],
      models: {},
    },
    readDirs: () => overrides.localFolders || [],
    mediaRoot: () => '/media',
    normalizeModelName: value => value,
    sanitizeFolderName: value => String(value).toLowerCase().replace(/\s+/g, '-'),
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    nowIso: () => '2026-08-16T12:00:00.000Z',
  });
  return { loader, broadcasts };
}

test('model-list loading traverses pagination, deduplicates URLs, and reports completion', async () => {
  const context = fixture();
  const progress = [];
  const result = await context.loader.load('https://example.test/models', {
    onProgress: value => progress.push(value),
  });

  assert.equal(result.pageCount, 2);
  assert.equal(result.totalFound, 3);
  assert.deepEqual(result.models.map(model => model.name), ['Alpha', 'Known', 'Zulu Updated']);
  assert.equal(result.loadedAt, '2026-08-16T12:00:00.000Z');
  assert.equal(progress.at(-1).completed, true);
  assert.equal(progress.at(-1).modelsFound, 3);
});

test('missing-only loading excludes canonical URLs and matching local folders', async () => {
  const context = fixture({ localFolders: ['alpha'] });
  const result = await context.loader.load('https://example.test/models', { missingOnly: true });
  assert.deepEqual(result.models.map(model => model.name), ['Zulu Updated']);
  assert.equal(result.knownCount, 2);
  assert.equal(result.missingOnly, true);
});

test('loaded-list removals mutate state and broadcast the first and final changes', () => {
  const context = fixture();
  context.loader.set({
    models: [
      { name: 'Alpha', sourceUrl: 'https://example.test/model/alpha' },
      { name: 'Zulu', sourceUrl: 'https://example.test/model/zulu' },
    ],
  });
  context.loader.remove('https://example.test/model/alpha?from=list');
  assert.deepEqual(context.loader.get().models.map(model => model.name), ['Zulu']);
  assert.equal(context.broadcasts.length, 1);
  context.loader.remove('', 'Zulu');
  assert.equal(context.loader.get().models.length, 0);
  assert.equal(context.broadcasts.length, 2);
  assert.equal(context.broadcasts[1].event, 'loaded-models');
});
