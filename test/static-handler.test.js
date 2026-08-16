'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStaticHandler } = require('../server/static-handler');

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

function handler(isLocalhostRequest = () => false) {
  return createStaticHandler({
    requestUrl: req => new URL(req.url, 'http://example.test'),
    isLocalhostRequest,
    mediaUrlPrefix: () => '/media',
    mediaRoot: () => '/tmp/simple-gallery-media',
    publicRoot: '/tmp/simple-gallery-public',
    thumbDirectory: 'thumbs',
    mimeTypes: {},
    markForegroundActivity() {},
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
