'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStaticHandler } = require('../server/static-handler');

function responseRecorder() {
  const response = new EventEmitter();
  response.status = null;
  response.headers = null;
  response.headersSent = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.body = '';
  response.writeHead = function writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  };
  response.end = function end(body = '') {
    this.body = String(body);
    this.writableEnded = true;
  };
  response.destroy = function destroy() {
    this.destroyed = true;
    this.emit('close');
  };
  return response;
}

function handler(isLocalhostRequest = () => false, overrides = {}) {
  return createStaticHandler({
    requestUrl: req => new URL(req.url, 'http://example.test'),
    isLocalhostRequest,
    mediaUrlPrefix: () => '/media',
    mediaRoot: () => '/tmp/simple-gallery-media',
    publicRoot: '/tmp/simple-gallery-public',
    thumbDirectory: 'thumbs',
    mimeTypes: {},
    markForegroundActivity() {},
    logError() {},
    ...overrides,
  });
}

test('static handler rejects malformed URL encoding without throwing', () => {
  const res = responseRecorder();
  handler()({ url: '/%E0%A4%A' }, res);
  assert.equal(res.status, 400);
  assert.equal(res.body, 'Malformed URL');
});

test('static handler keeps admin assets local', () => {
  const res = responseRecorder();
  handler()({ url: '/admin.html' }, res);
  assert.equal(res.status, 403);
  assert.equal(res.body, 'Admin is only available from localhost.');
});

test('static handler blocks decoded path traversal', () => {
  const res = responseRecorder();
  handler(() => true)({ url: '/..%2Fsecret' }, res);
  assert.equal(res.status, 403);
  assert.equal(res.body, 'Forbidden');
});

test('static handler returns 503 when a file stream hits descriptor capacity', async () => {
  const fileSystem = {
    stat(filePath, callback) {
      queueMicrotask(() => callback(null, { isFile: () => true, size: 12, mtimeMs: 1 }));
    },
    createReadStream() {
      const stream = new EventEmitter();
      stream.destroyed = false;
      stream.destroy = () => {
        if (stream.destroyed) return;
        stream.destroyed = true;
        stream.emit('close');
      };
      stream.pipe = () => {};
      queueMicrotask(() => {
        const error = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
        stream.emit('error', error);
        stream.destroy();
      });
      return stream;
    },
  };
  const res = responseRecorder();

  handler(() => false, { fileSystem })({ url: '/asset.jpg', headers: {} }, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.status, 503);
  assert.equal(res.headers['retry-after'], '1');
  assert.equal(res.body, 'Server is busy. Please retry.');
});

test('static handler rejects excess queued reads without opening more files', async () => {
  const statCallbacks = [];
  const fileSystem = {
    stat(filePath, callback) {
      statCallbacks.push(callback);
    },
    createReadStream() {
      throw new Error('stream should not open');
    },
  };
  const serve = handler(() => false, {
    fileSystem,
    maxConcurrentReads: 1,
    maxQueuedReads: 1,
  });
  const first = responseRecorder();
  const second = responseRecorder();
  const rejected = responseRecorder();

  serve({ url: '/first.jpg', headers: {} }, first);
  serve({ url: '/second.jpg', headers: {} }, second);
  serve({ url: '/third.jpg', headers: {} }, rejected);

  assert.equal(statCallbacks.length, 1);
  assert.equal(rejected.status, 503);
  statCallbacks.shift()(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statCallbacks.length, 1);
  statCallbacks.shift()(Object.assign(new Error('missing'), { code: 'ENOENT' }));
});

test('static handler removes disconnected requests from the read queue', async () => {
  const statCallbacks = [];
  const fileSystem = {
    stat(filePath, callback) {
      statCallbacks.push(callback);
    },
    createReadStream() {
      throw new Error('stream should not open');
    },
  };
  const serve = handler(() => false, {
    fileSystem,
    maxConcurrentReads: 1,
    maxQueuedReads: 1,
  });
  const active = responseRecorder();
  const disconnected = responseRecorder();
  const replacement = responseRecorder();

  serve({ url: '/active.jpg', headers: {} }, active);
  serve({ url: '/disconnected.jpg', headers: {} }, disconnected);
  disconnected.destroy();
  serve({ url: '/replacement.jpg', headers: {} }, replacement);

  assert.equal(replacement.status, null);
  statCallbacks.shift()(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statCallbacks.length, 1);
  statCallbacks.shift()(Object.assign(new Error('missing'), { code: 'ENOENT' }));
});
