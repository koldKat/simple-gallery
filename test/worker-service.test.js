'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerService } = require('../server/worker-service');

function waitTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('parent worker requests correlate responses and forward events', async () => {
  const child = new EventEmitter();
  child.connected = true;
  child.sent = [];
  child.send = message => child.sent.push(message);
  child.kill = signal => { child.killedWith = signal; };
  const events = [];
  const service = createWorkerService({
    isWorker: false,
    scriptPath: '/app/server.js',
    onEvent: message => events.push(message),
    processRef: { env: { TEST: '1' } },
    forkProcess: (script, args, options) => {
      assert.equal(script, '/app/server.js');
      assert.deepEqual(args, []);
      assert.equal(options.env.SIMPLE_GALLERY_ROLE, 'worker');
      return child;
    },
  });

  const request = service.request('scan', { full: true });
  assert.deepEqual(child.sent[0], { type: 'command', id: 1, command: 'scan', payload: { full: true } });
  child.emit('message', { type: 'event', event: 'import', payload: { active: true } });
  child.emit('message', { type: 'response', id: 1, ok: true, payload: { done: true } });
  assert.deepEqual(await request, { done: true });
  assert.equal(events.length, 1);

  assert.equal(service.notifyForeground(123), true);
  assert.equal(child.sent[1].event, 'foreground-activity');
  service.stop();
  assert.equal(child.killedWith, 'SIGTERM');
});

test('worker exits and failed responses reject pending requests', async () => {
  const child = new EventEmitter();
  child.connected = true;
  child.send = () => {};
  child.kill = () => {};
  const service = createWorkerService({
    isWorker: false,
    scriptPath: '/app/server.js',
    onEvent: () => {},
    processRef: { env: {} },
    forkProcess: () => child,
  });
  const failed = service.request('bad');
  child.emit('message', { type: 'response', id: 1, ok: false, error: 'Nope' });
  await assert.rejects(failed, /Nope/);

  const exited = service.request('later');
  child.emit('exit', 1);
  await assert.rejects(exited, /Worker exited/);
});

test('worker process dispatches commands and returns structured responses', async () => {
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.sent = [];
  processRef.send = (message, callback) => {
    processRef.sent.push(message);
    callback?.(null);
  };
  let foregroundAt = 0;
  const service = createWorkerService({
    isWorker: true,
    scriptPath: '/app/server.js',
    onEvent: () => {},
    processRef,
  });
  service.startProcess({
    success: async payload => ({ value: payload.value + 1 }),
    failure: async () => { throw new Error('Broken'); },
  }, at => { foregroundAt = at; });

  processRef.emit('message', { type: 'event', event: 'foreground-activity', payload: { at: 55 } });
  processRef.emit('message', { type: 'command', id: 1, command: 'success', payload: { value: 2 } });
  processRef.emit('message', { type: 'command', id: 2, command: 'failure', payload: {} });
  processRef.emit('message', { type: 'command', id: 3, command: 'missing', payload: {} });
  await waitTurn();

  assert.equal(foregroundAt, 55);
  assert.deepEqual(processRef.sent.sort((a, b) => a.id - b.id), [
    { type: 'response', id: 1, ok: true, payload: { value: 3 } },
    { type: 'response', id: 2, ok: false, error: 'Broken' },
    { type: 'response', id: 3, ok: false, error: 'Unknown worker command.' },
  ]);
  service.stop();
});

test('worker stops sending after its parent IPC channel disconnects', () => {
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.sent = [];
  processRef.send = message => processRef.sent.push(message);
  const service = createWorkerService({
    isWorker: true,
    scriptPath: '/app/server.js',
    onEvent: () => {},
    processRef,
  });

  processRef.emit('disconnect');

  assert.equal(service.sendFromWorker({ type: 'event' }), false);
  assert.deepEqual(processRef.sent, []);
});
