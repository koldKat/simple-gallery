'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseRuntime, withBusyRetry } = require('../server/database-runtime');

test('busy retry repeats SQLITE_BUSY and SQLITE_LOCKED failures', () => {
  let attempts = 0;
  const result = withBusyRetry(() => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('busy');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return 'ok';
  }, 3, 1);

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  attempts = 0;
  assert.equal(withBusyRetry(() => {
    attempts += 1;
    if (attempts < 2) {
      const error = new Error('locked');
      error.code = 'SQLITE_LOCKED';
      throw error;
    }
    return 'unlocked';
  }, 2, 1), 'unlocked');
  assert.throws(() => withBusyRetry(() => { throw new Error('broken'); }, 3, 1), /broken/);
});

test('vacuum reports size changes and checkpoints the WAL', () => {
  const logs = [];
  let vacuumed = false;
  const db = {
    exec(sql) {
      assert.equal(sql, 'VACUUM');
      vacuumed = true;
    },
    pragma(sql) {
      assert.equal(sql, 'wal_checkpoint(TRUNCATE)');
      return [{ busy: 0, log: 2, checkpointed: 2 }];
    },
  };
  const runtime = createDatabaseRuntime({
    db,
    dbPath: '/data/gallery.db',
    fileSize(filePath) {
      if (filePath.endsWith('-wal')) return vacuumed ? 0 : 20;
      return vacuumed ? 80 : 100;
    },
    trafficSnapshot: () => ({ trafficInBytes: 4 }),
    log: message => logs.push(message),
  });

  runtime.vacuumDatabase('test');

  assert.equal(vacuumed, true);
  assert.match(logs[1], /100 -> 80 bytes \(-20 bytes\)/);
  assert.match(logs[2], /checkpointed=2/);
  assert.equal(runtime.runtimeStats().dbBytes, 80);
  assert.equal(runtime.runtimeStats().trafficInBytes, 4);
});

test('live runtime CPU sampling is independent from general runtime calls', () => {
  let wallNs = 0n;
  let cpuUsage = { user: 0, system: 0 };
  const processRef = {
    memoryUsage: () => ({ rss: 100, heapUsed: 20, heapTotal: 40 }),
    hrtime: { bigint: () => wallNs },
    cpuUsage: () => ({ ...cpuUsage }),
  };
  const runtime = createDatabaseRuntime({
    db: { pragma() { return []; } },
    dbPath: '/data/gallery.db',
    fileSize: () => 10,
    trafficSnapshot: () => ({}),
    processRef,
    osModule: { cpus: () => [{}, {}, {}, {}] },
  });

  wallNs = 1_000_000_000n;
  cpuUsage = { user: 1_000_000, system: 0 };
  runtime.runtimeStats();
  wallNs = 2_000_000_000n;
  cpuUsage = { user: 1_500_000, system: 0 };
  const live = runtime.liveRuntimeStats();

  assert.equal(live.cpuCores, 0.75);
  assert.equal(live.cpuTotalCores, 4);
});
