'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceProfileService } = require('../server/source-profile');

function service(profile = {}) {
  return createSourceProfileService({
    getJson(key, fallback) {
      if (key === 'source_profile') return profile;
      if (key === 'seo_profile') return { homeTitle: 'Configured title' };
      return fallback;
    },
  });
}

test('source profiles normalize hosts, path segments, arrays, and defaults', () => {
  const profile = service({
    allowedHosts: ['Example.COM'],
    modelPathSegment: '/models/',
    excludedGalleryPathPrefixes: ['/skip'],
  }).get();

  assert.deepEqual(profile.allowedHosts, ['example.com']);
  assert.equal(profile.modelPathSegment, 'models');
  assert.equal(profile.paginationParameter, 'offset');
  assert.deepEqual(profile.excludedGalleryPathPrefixes, ['/skip']);
});

test('source profiles normalize configured direct gallery providers', () => {
  const profile = service({
    galleryProviders: [{
      id: 'Example Direct',
      allowedHosts: ['Gallery.Example'],
      allowedImageHosts: ['Images.Example'],
      galleryPathPattern: '^/gallery/',
      imageLinkClass: 'full-image',
    }],
  }).get();

  assert.deepEqual(profile.galleryProviders, [{
    id: 'example-direct',
    type: 'direct-images',
    allowedHosts: ['gallery.example'],
    allowedImageHosts: ['images.example'],
    galleryPathPattern: '^/gallery/',
    imageLinkClass: 'full-image',
    imageUrlAttribute: 'href',
    titleSuffixPattern: '',
    referer: '',
  }]);
});

test('host authorization accepts the configured host and its subdomains only', () => {
  const source = service({ allowedHosts: ['example.com'] });

  assert.equal(source.hostAllowed('example.com'), true);
  assert.equal(source.hostAllowed('images.example.com'), true);
  assert.equal(source.hostAllowed('notexample.com'), false);
});

test('gallery verification rejects excluded, detail, malformed, and foreign URLs', () => {
  const source = service({
    allowedHosts: ['example.com'],
    excludedGalleryPathPrefixes: ['/members'],
    galleryDetailSuffixPattern: '-\\d+\\.html',
  });

  assert.equal(source.isVerifiableGalleryUrl('https://example.com/gallery/alpha'), true);
  assert.equal(source.isVerifiableGalleryUrl('https://example.com/members/alpha'), false);
  assert.equal(source.isVerifiableGalleryUrl('https://example.com/gallery/alpha-2.html'), false);
  assert.equal(source.isVerifiableGalleryUrl('https://other.test/gallery/alpha'), false);
  assert.equal(source.isVerifiableGalleryUrl('not a url'), false);
});

test('missing host configuration is rejected and slugs fail safely', () => {
  const source = service();

  assert.throws(() => source.requireProfile(), /Configure a source profile/);
  assert.equal(source.sourceSlug('https://example.com/model/alpha'), 'alpha');
  assert.equal(source.sourceSlug('%'), null);
  assert.deepEqual(source.getSeo(), { homeTitle: 'Configured title' });
});
