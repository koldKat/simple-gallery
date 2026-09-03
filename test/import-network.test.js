'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createImportNetwork,
  parseRetryAfterMs,
  mapLimit,
} = require('../server/import-network');

function response({ status = 200, headers = {}, text = '', bytes = [], url = '' } = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: key => normalized.get(String(key).toLowerCase()) || null },
    text: async () => text,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

function networkFor(fetchImpl, overrides = {}) {
  return createImportNetwork({
    getSourceProfile: () => ({ referer: 'https://example.test/source' }),
    mkdirp: directory => fs.mkdirSync(directory, { recursive: true }),
    imageExtensions: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']),
    retries: 2,
    timeoutMs: 1000,
    backoffBaseMs: 100,
    backoffMaxMs: 1000,
    fetchImpl,
    random: () => 0,
    ...overrides,
  });
}

test('Retry-After supports seconds and HTTP dates', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  assert.equal(parseRetryAfterMs('2', now), 2000);
  assert.equal(parseRetryAfterMs('Sun, 16 Aug 2026 12:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfterMs('invalid', now), 0);
});

test('fetch retries failed responses and honors capped Retry-After delay', async () => {
  const delays = [];
  let attempts = 0;
  const network = networkFor(async () => {
    attempts += 1;
    return attempts === 1
      ? response({ status: 429, headers: { 'retry-after': '5' } })
      : response({ text: 'loaded' });
  }, { sleep: async delay => { delays.push(delay); } });

  assert.equal(await network.fetchText('https://example.test/page'), 'loaded');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1000]);
});

test('terminal fetch errors report attempts, status, and URL', async () => {
  const network = networkFor(async () => response({ status: 502 }), { sleep: async () => {} });
  await assert.rejects(network.fetchText('https://example.test/broken'), error => {
    assert.match(error.message, /Fetch failed after 3 attempts.*HTTP 502/);
    assert.equal(error.status, 502);
    return true;
  });
});

test('page fetches reject unapproved initial and redirected hosts', async () => {
  const redirected = networkFor(async () => response({
    url: 'https://foreign.example/page',
    text: 'loaded',
  }));
  await assert.rejects(
    redirected.fetchText('https://example.test/page', { allowedHosts: ['example.test'] }),
    /Page fetch redirect uses an unapproved URL/
  );
  await assert.rejects(
    redirected.fetchText('ftp://example.test/page', { allowedHosts: ['example.test'] }),
    /Page fetch uses an unapproved URL/
  );
});

test('mapLimit preserves order while bounding active work', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapLimit([3, 1, 2, 4], 2, async value => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, value));
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(results, [30, 10, 20, 40]);
  assert.equal(maximum, 2);
});

test('image downloads use configured referer, response extension, and output path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requestOptions = null;
  const network = networkFor(async (_url, options) => {
    requestOptions = options;
    return response({ headers: { 'content-type': 'image/png; charset=binary' }, bytes: [1, 2, 3, 4] });
  });

  const output = await network.downloadImage('https://example.test/image/no-extension', path.join(directory, 'nested', 'image'));
  assert.equal(output, path.join(directory, 'nested', 'image.png'));
  assert.deepEqual([...fs.readFileSync(output)], [1, 2, 3, 4]);
  assert.equal(requestOptions.headers.referer, 'https://example.test/source');
  assert.match(requestOptions.headers.accept, /image\/avif/);
});

test('image extension falls back to an allowed URL extension', () => {
  const network = networkFor(async () => response());
  assert.equal(
    network.extensionFromResponse('https://example.test/image/photo.webp?size=full', response()),
    '.webp'
  );
  assert.equal(network.extensionFromResponse('https://example.test/image/file.bin', response()), '.jpg');
});

test('image downloads reject redirects outside provider-approved hosts', async () => {
  const network = networkFor(async () => response({
    url: 'https://unapproved.example/image.jpg',
    headers: { 'content-type': 'image/jpeg' },
  }));
  await assert.rejects(
    network.downloadImage('https://images.example/image.jpg', '/tmp/unused-image', {
      allowedHosts: ['images.example'],
    }),
    /Image download redirect uses an unapproved URL/
  );
});
