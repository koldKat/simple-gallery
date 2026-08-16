'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseRuntime, withBusyRetry } = require('../server/database-runtime');

test('busy retry repeats only SQLITE_BUSY failures', () => {
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
