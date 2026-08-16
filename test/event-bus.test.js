'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerEventBus } = require('../server/event-bus');

function eventFixture(overrides = {}) {
  const writes = [];
  let closeHandler = null;
  const request = {
    on(event, handler) {
      if (event === 'close') closeHandler = handler;
    },
  };
  const response = {
    headers: null,
    ended: false,
    writeHead(status, headers) { this.headers = { status, ...headers }; },
    write(value) { writes.push(value); },
    end() { this.ended = true; },
  };
  const bus = createServerEventBus({
    isWorker: false,
    sendWorkerMessage() {},
    getStateNotice: () => ({ status: 'ready' }),
    getViewStats: () => ({ total: 7 }),
    ...overrides,
  });
  return { bus, request, response, writes, close: () => closeHandler?.() };
}

test('worker broadcasts are forwarded to the parent process', () => {
  const messages = [];
  const bus = createServerEventBus({
    isWorker: true,
    sendWorkerMessage: message => messages.push(message),
    getStateNotice: () => ({}),
    getViewStats: () => ({}),
  });

  bus.broadcast('import', { active: true });

  assert.deepEqual(messages, [{ type: 'event', event: 'import', payload: { active: true } }]);
});

test('event streams receive initial state and broadcasts until disconnected', () => {
  const { bus, request, response, writes, close } = eventFixture();

  bus.handleEvents(request, response);
  bus.broadcast('notice', { message: 'working' });
  close();
  bus.broadcast('notice', { message: 'ignored' });

  assert.equal(response.headers.status, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.match(writes[0], /event: state/);
  assert.match(writes[1], /event: notice/);
  assert.equal(writes.length, 2);
});

test('scanned URL broadcasts are throttled and use the latest payload', () => {
  const timers = [];
  const { bus, request, response, writes } = eventFixture({
    setTimer: callback => { timers.push(callback); return callback; },
    clearTimer() {},
  });
  bus.handleEvents(request, response);

  bus.scheduleScannedUrls({ count: 1 });
  bus.scheduleScannedUrls({ count: 2 });
  assert.equal(timers.length, 1);
  timers.shift()();

  assert.match(writes.at(-1), /event: scanned-urls/);
  assert.match(writes.at(-1), /"count":2/);
});

test('view-stat broadcasts are coalesced and closing ends clients', () => {
  const timers = [];
  const { bus, request, response, writes } = eventFixture({
    setTimer: callback => { timers.push(callback); return callback; },
    clearTimer() {},
  });
  bus.handleEvents(request, response);

  bus.scheduleViewStats();
  bus.scheduleViewStats();
  assert.equal(timers.length, 1);
  timers.shift()();
  bus.close();

  assert.match(writes.at(-2), /event: view-stats/);
  assert.match(writes.at(-2), /"total":7/);
  assert.match(writes.at(-1), /event: close/);
  assert.equal(response.ended, true);
});
