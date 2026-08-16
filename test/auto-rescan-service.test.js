'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoRescanService } = require('../server/auto-rescan-service');

function fixture() {
  const settings = new Map([
    ['auto_rescan_enabled', '1'],
    ['auto_rescan_time', '01:45'],
    ['auto_rescan_days', '1,3,5'],
  ]);
  const timers = [];
  const cleared = [];
  const logs = [];
  let broadcasts = 0;
  let requests = 0;
  let activity = { scanInFlight: false, importActive: false };
  let current = new Date('2026-08-16T10:00:00.000Z');
  const service = createAutoRescanService({
    getSetting: (key, fallback) => settings.get(key) ?? fallback,
    normalizeTime: (value, fallback) => /^\d{2}:\d{2}$/.test(value) ? value : fallback,
    parseWeekdays: value => String(value).split(',').map(Number).filter(day => day >= 0 && day <= 6),
    nextWeeklyDate: (_time, _days, from) => new Date(from.getTime() + 60_000),
    allWeekdays: [0, 1, 2, 3, 4, 5, 6],
    defaultTime: '01:45',
    retryMs: 30_000,
    isWorker: false,
    getActivity: () => activity,
    requestWorker: async command => {
      assert.equal(command, 'rescan-all-start');
      requests += 1;
    },
    broadcastState: () => { broadcasts += 1; },
    now: () => new Date(current),
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => cleared.push(timer),
    logger: {
      log: message => logs.push(['log', message]),
      warn: message => logs.push(['warn', message]),
      error: message => logs.push(['error', message]),
    },
  });
  return {
    service,
    settings,
    timers,
    cleared,
    logs,
    broadcasts: () => broadcasts,
    requests: () => requests,
    setActivity(value) { activity = value; },
    setNow(value) { current = new Date(value); },
  };
}

test('schedule reads configured time and weekdays without broadcasting at startup', () => {
  const context = fixture();
  context.service.schedule('startup');
  assert.equal(context.service.normalizeTime('bad'), '01:45');
  assert.deepEqual(context.service.days(), [1, 3, 5]);
  assert.equal(context.service.getNextAt(), '2026-08-16T10:01:00.000Z');
  assert.equal(context.timers[0].delay, 60_000);
  assert.equal(context.broadcasts(), 0);

  context.service.stop();
  assert.equal(context.cleared.length, 1);
  assert.equal(context.service.getNextAt(), null);
});

test('disabled schedules clear the next run and notify clients', () => {
  const context = fixture();
  context.settings.set('auto_rescan_enabled', '0');
  context.service.schedule();
  assert.equal(context.service.getNextAt(), null);
  assert.equal(context.timers.length, 0);
  assert.equal(context.broadcasts(), 1);
});

test('busy scheduled runs defer by the retry interval', async () => {
  const context = fixture();
  context.setActivity({ scanInFlight: true, importActive: false });
  await context.service.run('daily');
  assert.equal(context.requests(), 0);
  assert.equal(context.service.getNextAt(), '2026-08-16T10:00:30.000Z');
  assert.equal(context.timers[0].delay, 30_000);
  assert.equal(context.logs[0][0], 'warn');
  assert.equal(context.broadcasts(), 1);
});

test('successful scheduled runs dispatch to the worker and schedule the next run', async () => {
  const context = fixture();
  context.setNow('2026-08-17T12:00:00.000Z');
  await context.service.run('daily');
  assert.equal(context.requests(), 1);
  assert.equal(context.service.getNextAt(), '2026-08-17T12:01:00.000Z');
  assert.equal(context.timers[0].delay, 60_000);
  assert.equal(context.logs[0][0], 'log');
  assert.equal(context.broadcasts(), 1);
});
