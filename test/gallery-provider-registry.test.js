'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGalleryProviderRegistry } = require('../server/gallery-provider-registry');

function registry() {
  return createGalleryProviderRegistry({
    canonicalRemoteUrl(value) {
      const url = new URL(value);
      url.hash = '';
      url.search = '';
      url.pathname = url.pathname.replace(/\/+$/, '');
      return url.toString();
    },
    getProfile: () => ({
      galleryProviders: [{
        id: 'direct',
        type: 'direct-images',
        allowedHosts: ['gallery.example'],
        allowedImageHosts: ['images.example'],
        galleryPathPattern: '^/galleries/[^/]+/?$',
        imageLinkClass: 'full-image',
        imageUrlAttribute: 'href',
        titleSuffixPattern: '\\s+-\\s+Example$',
        referer: 'https://gallery.example/',
      }],
    }),
  });
}

test('direct providers identify gallery URLs and extract allowlisted image links', () => {
  const result = registry().inspect('https://gallery.example/galleries/one/', `
    <title>One &amp; Two - Example</title>
    <a class="thumb full-image" href="https://images.example/full/002.jpg"></a>
    <a class="full-image" href="https://images.example/full/001.jpg"></a>
    <a class="full-image" href="https://foreign.example/bad.jpg"></a>
  `);

  assert.equal(result.providerId, 'direct');
  assert.equal(result.title, 'One & Two');
  assert.deepEqual(result.imageUrls, [
    'https://images.example/full/002.jpg',
    'https://images.example/full/001.jpg',
  ]);
  assert.deepEqual(result.allowedImageHosts, ['images.example']);
});

test('provider IDs, page paths, image hosts, and empty galleries are rejected', () => {
  const service = registry();
  assert.throws(() => service.identify('https://gallery.example/not-a-gallery', 'direct'), /No configured/);
  assert.throws(() => service.identify('ftp://gallery.example/galleries/one', 'direct'), /No configured/);
  assert.throws(() => service.identify('https://gallery.example/galleries/one', 'missing'), /not configured/);
  assert.throws(
    () => service.inspect('https://gallery.example/galleries/one', '<a class="full-image" href="https://foreign.example/a.jpg">'),
    /found no gallery images/
  );
});
