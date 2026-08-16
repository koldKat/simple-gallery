'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createDatabaseHousekeeping } = require('../server/db-housekeeping');

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const RETENTION = 60 * 60 * 1000;

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE view_dedupe (last_counted_at TEXT);
    CREATE TABLE sessions (expires_at TEXT);
  `);
  return db;
}

test('cleanup removes only old dedupe rows and expired sessions', () => {
  const db = database();
  const messages = [];
  db.prepare('INSERT INTO view_dedupe VALUES (?)').run(new Date(NOW - RETENTION - 1).toISOString());
  db.prepare('INSERT INTO view_dedupe VALUES (?)').run(new Date(NOW - RETENTION).toISOString());
  db.prepare('INSERT INTO sessions VALUES (?)').run(new Date(NOW - 1).toISOString());
  db.prepare('INSERT INTO sessions VALUES (?)').run(new Date(NOW + 1).toISOString());
  const housekeeping = createDatabaseHousekeeping({
    db,
    retentionMs: RETENTION,
    isWorker: false,
    now: () => NOW,
    log: { log: message => messages.push(message), error() {} },
  });

  assert.deepEqual(housekeeping.run('startup'), { dedupe: 1, sessions: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM view_dedupe').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.match(messages[0], /startup: removed 1 old view dedupe rows, 1 expired sessions/);
  db.close();
});

test('scheduled cleanup reschedules itself and stop cancels the timer', () => {
  const db = database();
  const callbacks = [];
  const cleared = [];
  let nextId = 0;
  const housekeeping = createDatabaseHousekeeping({
    db,
    retentionMs: RETENTION,
    isWorker: false,
    now: () => NOW,
    setTimer(callback, delay) {
      const timer = { id: ++nextId, delay };
      callbacks.push({ timer, callback });
      return timer;
    },
    clearTimer: timer => cleared.push(timer.id),
    log: { log() {}, error() {} },
  });

  housekeeping.schedule();
  assert.equal(callbacks[0].timer.delay, 60 * 60 * 1000);
  callbacks[0].callback();
  assert.equal(callbacks.length, 2);
  housekeeping.stop();
  assert.deepEqual(cleared, [2]);
  db.close();
});

test('workers do not schedule housekeeping timers', () => {
  const db = database();
  let scheduled = false;
  const housekeeping = createDatabaseHousekeeping({
    db,
    retentionMs: RETENTION,
    isWorker: true,
    setTimer() { scheduled = true; },
  });
  housekeeping.schedule();
  assert.equal(scheduled, false);
  db.close();
});

test('scheduled errors are logged and do not stop future scheduling', () => {
  const callbacks = [];
  const errors = [];
  const housekeeping = createDatabaseHousekeeping({
    db: { prepare() { throw new Error('database busy'); } },
    retentionMs: RETENTION,
    isWorker: false,
    now: () => NOW,
    setTimer(callback) {
      callbacks.push(callback);
      return callbacks.length;
    },
    clearTimer() {},
    log: { log() {}, error: message => errors.push(message) },
  });

  housekeeping.schedule();
  callbacks[0]();
  assert.match(errors[0], /Scheduled cleanup failed: database busy/);
  assert.equal(callbacks.length, 2);
});
