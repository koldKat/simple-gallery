'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { canonicalRemoteUrl } = require('../server/source-parser');
const { CHECKPOINT_KEY, createRescanCheckpoints } = require('../server/rescan-checkpoints');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE import_errors (id INTEGER PRIMARY KEY, model_url TEXT);
    CREATE TABLE models (id INTEGER PRIMARY KEY, last_checked_at TEXT);
    CREATE TABLE model_urls (id INTEGER PRIMARY KEY, model_id INTEGER, source_url TEXT);
  `);
  let importJob = null;
  let sourceUrls = [];
  let timestamp = '2026-08-16T12:00:00.000Z';
  const getSetting = (key, fallback = '') => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || fallback;
  const setSetting = (key, value) => db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
  const checkpoints = createRescanCheckpoints({
    db,
    getSetting,
    setSetting,
    withBusyRetry: work => work(),
    getImportJob: () => importJob,
    getSourceUrls: () => ({ urls: sourceUrls }),
    canonicalRemoteUrl,
    nowIso: () => timestamp,
  });
  return {
    db,
    checkpoints,
    getSetting,
    setSetting,
    setImportJob(value) { importJob = value; },
    setSourceUrls(value) { sourceUrls = value; },
    setTimestamp(value) { timestamp = value; },
  };
}

test('run metadata records starts and calculates completed duration', () => {
  const context = fixture();
  context.checkpoints.recordStarted('2026-08-16T10:00:00.000Z');
  assert.deepEqual(context.checkpoints.metadata(), {
    lastRescanAllStartedAt: '2026-08-16T10:00:00.000Z',
    lastRescanAllFinishedAt: '',
    lastRescanAllStatus: 'running',
    lastRescanAllDurationMs: 0,
  });

  context.setImportJob({
    mode: 'all',
    status: 'done',
    startedAt: '2026-08-16T10:00:00.000Z',
    finishedAt: '2026-08-16T10:02:03.000Z',
  });
  context.checkpoints.recordFinished();
  assert.equal(context.checkpoints.metadata().lastRescanAllDurationMs, 123000);
  assert.equal(context.checkpoints.metadata().lastRescanAllStatus, 'done');
  context.db.close();
});

test('checkpoint save normalizes values and clear removes persisted state', () => {
  const context = fixture();
  context.checkpoints.save({
    nextUrl: 'https://example.test/model/two',
    nextIndex: -4,
    total: '3',
    totals: { modelsChecked: 1 },
    status: 'paused',
  });
  assert.deepEqual(context.checkpoints.load(), {
    version: 1,
    nextUrl: 'https://example.test/model/two',
    nextIndex: 0,
    total: 3,
    totals: { modelsChecked: 1 },
    startedAt: '2026-08-16T12:00:00.000Z',
    status: 'paused',
    updatedAt: '2026-08-16T12:00:00.000Z',
  });
  context.checkpoints.clear();
  assert.equal(context.checkpoints.load(), null);

  context.setSetting(CHECKPOINT_KEY, '{broken');
  assert.equal(context.checkpoints.load(), null);
  context.db.close();
});

test('fallback prefers the latest failed model URL', () => {
  const context = fixture();
  context.setSetting('last_rescan_all_status', 'error');
  context.setSetting('last_rescan_all_started_at', '2026-08-16T10:00:00.000Z');
  context.db.exec(`
    INSERT INTO import_errors VALUES (1, 'https://example.test/model/first');
    INSERT INTO import_errors VALUES (2, 'https://example.test/model/failed');
  `);

  assert.deepEqual(context.checkpoints.fallback(), {
    version: 1,
    nextUrl: 'https://example.test/model/failed',
    nextIndex: 0,
    total: 0,
    totals: null,
    startedAt: '2026-08-16T10:00:00.000Z',
    status: 'error',
    recovered: true,
  });
  context.db.close();
});

test('fallback finds the first URL not checked during the failed run', () => {
  const context = fixture();
  context.setSetting('last_rescan_all_status', 'paused');
  context.setSetting('last_rescan_all_started_at', '2026-08-16T10:00:00.000Z');
  context.db.exec(`
    INSERT INTO models VALUES
      (1, '2026-08-16T10:01:00.000Z'),
      (2, '2026-08-16T09:59:00.000Z');
    INSERT INTO model_urls VALUES
      (1, 1, 'https://example.test/model/one'),
      (2, 2, 'https://example.test/model/two');
  `);
  context.setSourceUrls([
    'https://example.test/model/one',
    'https://example.test/model/two',
    'https://example.test/model/three',
  ]);

  const fallback = context.checkpoints.fallback();
  assert.equal(fallback.nextUrl, 'https://example.test/model/two');
  assert.equal(fallback.nextIndex, 1);
  assert.deepEqual(fallback.totals, { models: 3, modelsChecked: 1 });

  context.setSourceUrls(['https://example.test/model/three']);
  assert.equal(context.checkpoints.fallback().nextUrl, 'https://example.test/model/three');
  context.db.close();
});

test('resumable persists recovered fallback and ignores non-resumable statuses', () => {
  const context = fixture();
  context.setSetting('last_rescan_all_status', 'done');
  assert.equal(context.checkpoints.resumable(), null);

  context.setSetting('last_rescan_all_status', 'stopped');
  context.db.prepare('INSERT INTO import_errors (model_url) VALUES (?)').run('https://example.test/model/resume');
  const recovered = context.checkpoints.resumable();
  assert.equal(recovered.nextUrl, 'https://example.test/model/resume');
  assert.deepEqual(context.checkpoints.load(), recovered);
  context.db.close();
});
