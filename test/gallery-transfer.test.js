'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGalleryTransfer } = require('../server/gallery-transfer');

function fixture(overrides = {}) {
  let pauses = 0;
  const transfer = createGalleryTransfer({
    mapLimit: async (items, _limit, work) => Promise.all(items.map((item, index) => work(item, index))),
    fetchText: async url => {
      if (url.endsWith('/broken')) throw new Error('detail failed');
      return url.endsWith('/missing') ? { image: '' } : { image: `${url}/large.jpg` };
    },
    extractLargeImageUrl: page => page.image,
    downloadImage: overrides.downloadImage || (async (url, outPath) => {
      if (url.includes('broken')) throw new Error('download failed');
      return `${outPath}.jpg`;
    }),
    sanitizeFileBase: value => value.toLowerCase().replace(/\s+/g, '-'),
    concurrency: 2,
    shouldPause: () => overrides.shouldPause ?? true,
    foregroundPauseMs: 900,
    wait: async ms => {
      assert.equal(ms, 900);
      pauses += 1;
    },
  });
  return { transfer, pauses: () => pauses };
}

test('detail resolution preserves successes and reports partial failures', async () => {
  const context = fixture();
  const result = await context.transfer.resolveImageUrls([
    'https://example.test/one',
    'https://example.test/missing',
    'https://example.test/broken',
  ]);
  assert.deepEqual(result.successes, [{
    ok: true,
    index: 0,
    detailUrl: 'https://example.test/one',
    imageUrl: 'https://example.test/one/large.jpg',
  }]);
  assert.deepEqual(result.failures.map(item => [item.index, item.message]), [
    [1, 'No large image found for https://example.test/missing'],
    [2, 'detail failed'],
  ]);
  assert.equal(context.pauses(), 1);
});

test('foreground pause is available to importer model loops', async () => {
  const context = fixture();
  await context.transfer.pauseForForegroundBrowsing();
  assert.equal(context.pauses(), 1);
});

test('downloads use numbered sanitized paths, retain source order, and report progress', async () => {
  const requested = [];
  const progress = [];
  const context = fixture({
    shouldPause: false,
    downloadImage: async (url, outPath) => {
      requested.push([url, outPath]);
      if (url.includes('broken')) throw new Error('download failed');
      return `${outPath}.jpg`;
    },
  });
  const result = await context.transfer.downloadImages([
    { index: 2, imageUrl: 'https://example.test/two.jpg' },
    { index: 0, imageUrl: 'https://example.test/zero.jpg' },
    { index: 1, imageUrl: 'https://example.test/broken.jpg' },
  ], '/gallery', 'Gallery Title', (done, total) => progress.push([done, total]));

  assert.deepEqual(requested.map(entry => entry[1]), [
    '/gallery/00-gallery-title',
    '/gallery/01-gallery-title',
    '/gallery/02-gallery-title',
  ]);
  assert.deepEqual(result.downloaded.map(item => item.index), [0, 2]);
  assert.deepEqual(result.failures.map(item => [item.index, item.message]), [[1, 'download failed']]);
  assert.deepEqual(progress, [[1, 3], [2, 3]]);
  assert.equal(context.pauses(), 0);
});
