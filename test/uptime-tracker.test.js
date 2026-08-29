'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createUptimeTracker } = require('../server/uptime-tracker');

function fixture({ nowSeconds, settings = {} } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (created_at TEXT);
    CREATE TABLE galleries (created_at TEXT);
    CREATE TABLE users (created_at TEXT);
    CREATE TABLE app_settings (updated_at TEXT);
  `);
  let clock = nowSeconds;
  const values = new Map(Object.entries(settings));
  const tracker = createUptimeTracker({
    db,
    getSetting: (key, fallback) => values.get(key) || fallback,
    setSetting: (key, value) => values.set(key, String(value)),
    now: () => clock * 1000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
  });
  return {
    db,
    tracker,
    settings: values,
    setNow(value) { clock = value; },
  };
}

test('app age uses the earliest timestamp-bearing database entry', () => {
  const context = fixture({ nowSeconds: 300 });
  context.db.exec(`
    INSERT INTO models VALUES ('1970-01-01T00:02:00.000Z');
    INSERT INTO galleries VALUES ('1970-01-01T00:01:40.000Z');
    INSERT INTO users VALUES ('1970-01-01T00:02:30.000Z');
    INSERT INTO app_settings VALUES ('1970-01-01T00:00:50.000Z');
  `);
  assert.equal(context.tracker.stats().appAgeSeconds, 250);
  context.db.close();
});

test('a restart gap longer than fifteen seconds records only the excess as downtime', () => {
  const context = fixture({
    nowSeconds: 130,
    settings: {
      server_stopped_at: '100',
      server_last_heartbeat: '100',
      server_total_downtime_s: '20',
      server_session_start_at: '70',
    },
  });
  context.tracker.initialize();
  assert.equal(context.settings.get('server_total_downtime_s'), '35');
  assert.equal(context.settings.get('server_session_start_at'), '115');
  context.setNow(145);
  assert.equal(context.tracker.stats().sessionUptimeSeconds, 30);
  context.db.close();
});

test('a restart gap within fifteen seconds remains continuous uptime', () => {
  const context = fixture({
    nowSeconds: 112,
    settings: {
      server_stopped_at: '100',
      server_last_heartbeat: '100',
      server_total_downtime_s: '20',
      server_session_start_at: '70',
    },
  });
  context.tracker.initialize();
  assert.equal(context.settings.get('server_total_downtime_s'), '20');
  assert.equal(context.settings.get('server_session_start_at'), '70');
  context.db.close();
});

test('a clean stop and restart preserves the current uptime session within the grace window', () => {
  const context = fixture({ nowSeconds: 100 });
  context.tracker.start();
  context.setNow(150);
  context.tracker.stop();
  context.setNow(160);
  const restarted = createUptimeTracker({
    db: context.db,
    getSetting: (key, fallback) => context.settings.get(key) || fallback,
    setSetting: (key, value) => context.settings.set(key, String(value)),
    now: () => 160000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
  });
  restarted.initialize();
  assert.equal(context.settings.get('server_total_downtime_s') || '0', '0');
  assert.equal(context.settings.get('server_session_start_at'), '100');
  context.db.close();
});

test('heartbeat failures are contained and reported instead of escaping the timer', () => {
  const messages = [];
  const db = new Database(':memory:');
  const tracker = createUptimeTracker({
    db,
    getSetting: () => '0',
    setSetting: () => { throw new Error('database is locked'); },
    log: message => messages.push(message),
  });
  assert.equal(tracker.updateHeartbeat(), false);
  assert.match(messages[0], /Heartbeat write failed: database is locked/);
  db.close();
});

test('initialization write failures are contained so startup can continue', () => {
  const messages = [];
  const db = new Database(':memory:');
  const tracker = createUptimeTracker({
    db,
    getSetting: () => '0',
    setSetting: () => { throw new Error('database is locked'); },
    log: message => messages.push(message),
  });
  assert.equal(tracker.initialize(), false);
  assert.match(messages[0], /Initialization write failed: database is locked/);
  db.close();
});
