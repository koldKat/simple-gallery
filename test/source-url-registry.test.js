'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { canonicalRemoteUrl } = require('../server/source-parser');
const { createSourceUrlRegistry } = require('../server/source-url-registry');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, folder TEXT);
    CREATE TABLE model_urls (id INTEGER PRIMARY KEY, model_id INTEGER, source_url TEXT UNIQUE);
    CREATE TABLE ignored_model_urls (source_url TEXT PRIMARY KEY, reason TEXT, created_at TEXT);
    CREATE TABLE galleries (
      id INTEGER PRIMARY KEY,
      model_id INTEGER,
      image_count INTEGER,
      status TEXT
    );
  `);
  let visibleModels = [];
  let localFolders = [];
  let timestamp = '2026-08-16T12:00:00.000Z';
  const registry = createSourceUrlRegistry({
    db,
    canonicalRemoteUrl,
    normalizeModelName: value => String(value || '').replaceAll('-', ' ').replace(/\b\w/g, char => char.toUpperCase()),
    sanitizeFolderName: value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    readDirs: () => localFolders,
    mediaRoot: () => '/unused/media',
    getVisibleModels: () => visibleModels,
    nowIso: () => timestamp,
  });
  return {
    db,
    registry,
    setVisible(value) { visibleModels = value; },
    setLocal(value) { localFolders = value; },
    setTimestamp(value) { timestamp = value; },
  };
}

test('snapshots count and sort active and ignored source URLs', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO models VALUES (1, 'One', 'one');
    INSERT INTO model_urls VALUES
      (1, 1, 'https://example.test/model/zeta'),
      (2, 1, 'https://example.test/model/alpha');
    INSERT INTO ignored_model_urls VALUES
      ('https://example.test/model/zeta', 'duplicate', '2026-08-16T11:00:00.000Z');
  `);

  assert.deepEqual(context.registry.snapshot(), {
    version: 1,
    updatedAt: '2026-08-16T12:00:00.000Z',
    total: 2,
    ignored: 1,
    active: 1,
    urls: ['https://example.test/model/alpha'],
  });
  context.db.close();
});

test('ignore and unignore canonicalize URLs and preserve ignored metadata', () => {
  const context = fixture();
  context.registry.ignore('https://EXAMPLE.test/model/jane/?from=list#top', ' duplicate ');
  assert.deepEqual(context.registry.ignored(), {
    ignoredCount: 1,
    ignored: [{
      sourceUrl: 'https://example.test/model/jane',
      reason: 'duplicate',
      createdAt: '2026-08-16T12:00:00.000Z',
    }],
  });

  context.registry.unignore('https://example.test/model/jane/?again=1');
  assert.deepEqual(context.registry.ignored(), { ignoredCount: 0, ignored: [] });
  context.db.close();
});

test('audit classifies unmatched URLs and reads visible state live', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO models VALUES
      (1, 'Healthy', 'healthy'),
      (2, 'Missing Local', 'missing-local'),
      (3, 'No Galleries', 'no-galleries'),
      (4, 'Not Visible', 'not-visible');
    INSERT INTO model_urls VALUES
      (1, 1, 'https://example.test/model/healthy'),
      (2, 2, 'https://example.test/model/missing-local'),
      (3, 3, 'https://example.test/model/no-galleries'),
      (4, 4, 'https://example.test/model/not-visible'),
      (5, NULL, 'https://example.test/model/orphan');
    INSERT INTO galleries VALUES
      (1, 1, 10, 'imported'),
      (2, 2, 10, 'imported'),
      (3, 4, 10, 'imported');
  `);
  context.setLocal(['healthy', 'no-galleries', 'not-visible']);
  context.setVisible([{ id: 'healthy' }]);

  let audit = context.registry.audit();
  assert.equal(audit.savedModelUrls, 5);
  assert.equal(audit.unmatchedCount, 4);
  assert.deepEqual(audit.unmatched.map(item => item.reason), [
    'No matching local model folder.',
    'Model exists but has no imported image galleries.',
    'Model has database galleries but is not visible in the current gallery state.',
    'URL is saved but has no model database row.',
  ]);

  context.setVisible([{ id: 'healthy' }, { id: 'not-visible' }]);
  audit = context.registry.audit();
  assert.equal(audit.visibleModels, 2);
  assert.equal(audit.unmatchedCount, 3);
  context.db.close();
});

test('ignored URLs are excluded from the audit', () => {
  const context = fixture();
  context.db.exec(`
    INSERT INTO model_urls VALUES (1, NULL, 'https://example.test/model/orphan');
    INSERT INTO ignored_model_urls VALUES
      ('https://example.test/model/orphan', 'known missing', '2026-08-16T12:00:00.000Z');
  `);
  assert.deepEqual(context.registry.audit(), {
    savedModelUrls: 0,
    visibleModels: 0,
    unmatchedCount: 0,
    ignoredCount: 1,
    unmatched: [],
  });
  context.db.close();
});
