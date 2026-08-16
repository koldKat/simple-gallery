'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalRemoteUrl,
  canonicalPageUrl,
  createSourceParser,
} = require('../server/source-parser');

const profile = {
  allowedHosts: ['example.test'],
  modelPathSegment: 'person',
  modelListPath: '/people',
  paginationParameter: 'offset',
  letterParameter: 'letter',
  letterValues: 'ab',
  modelListExample: 'https://example.test/people',
  modelTitleSuffixPattern: '\\| Example$',
  gallerySectionStartLabel: 'Photo sets',
  gallerySectionEndLabel: 'Videos',
  galleryLinkClass: 'gallery-item',
  galleryTextClass: 'gallery-title',
  excludedGalleryPathPrefixes: ['/video/'],
  galleryDetailSuffixPattern: '-\\d+\\.html',
  largeImageLinkLabel: 'Original image',
  largeImageLinkClass: 'full-size',
};

const normalizeModelName = value => String(value || '')
  .trim()
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\b\w/g, character => character.toUpperCase()) || 'Model';

const parser = createSourceParser({
  getProfile: () => profile,
  sourceHostAllowed(hostname, currentProfile) {
    const host = String(hostname || '').toLowerCase();
    return currentProfile.allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
  },
  normalizeModelName,
});

test('canonical source URLs normalize host, query, hash, and trailing slash', () => {
  assert.equal(
    canonicalRemoteUrl('https://EXAMPLE.test/person/jane/?ref=home#top'),
    'https://example.test/person/jane'
  );
  assert.equal(
    canonicalPageUrl('https://EXAMPLE.test/people/?z=2&a=1#top'),
    'https://example.test/people?a=1&z=2'
  );
});

test('model extraction uses configured paths and canonical links', () => {
  assert.equal(parser.extractModelName('https://example.test/person/jane-doe', ''), 'Jane Doe');
  assert.equal(
    parser.extractModelName('not a URL', '<script>{"@type":"Person","name":"Jane &amp; Doe"}</script>'),
    'Jane & Doe'
  );
  const models = parser.extractModelLinks(`
    <a href="/person/jane-doe?from=list"><img alt="jane_doe"></a>
    <a href="/person/john-smith"><span>John</span></a>
  `, 'https://example.test/people');
  assert.deepEqual(models, [
    { name: 'Jane Doe', sourceUrl: 'https://example.test/person/jane-doe' },
    { name: 'John Smith', sourceUrl: 'https://example.test/person/john-smith' },
  ]);
});

test('pagination remains on the configured host and list path', () => {
  const urls = parser.extractPaginationUrls(`
    <a href="/people?offset=40&letter=a">2</a>
    <a href="/other?offset=80">wrong path</a>
    <a href="https://other.test/people?offset=80">wrong host</a>
  `, 'https://example.test/people?letter=a');
  assert.deepEqual(urls, [
    'https://example.test/people?letter=a',
    'https://example.test/people?letter=a&offset=40',
  ]);
});

test('configured gallery section excludes detail and ignored links', () => {
  const galleries = parser.extractSourceGalleries(`
    <a class="gallery-item" href="/gallery/outside"><span class="gallery-title">Outside</span></a>
    <h2>Photo sets</h2>
    <a class="card gallery-item" href="/gallery/set-one"><span class="gallery-title">Set &amp; One</span></a>
    <a class="gallery-item" href="/gallery/set-one-1.html"><span class="gallery-title">Detail</span></a>
    <a class="gallery-item" href="/video/clip"><span class="gallery-title">Video</span></a>
    <h2>Videos</h2>
    <a class="gallery-item" href="/gallery/outside-two"><span class="gallery-title">Outside</span></a>
  `, 'https://example.test/person/jane');
  assert.deepEqual(galleries, [{ sourceUrl: 'https://example.test/gallery/set-one', title: 'Set & One' }]);
});

test('detail and large-image extraction preserve numeric order and fallback priority', () => {
  assert.deepEqual(parser.extractDetailUrls(`
    <a href="/gallery/set-one-10.html">10</a>
    <a href="/gallery/set-one-2.html">2</a>
    <a href="/gallery/other-1.html">other</a>
  `, 'https://example.test/gallery/set-one'), [
    'https://example.test/gallery/set-one-2.html',
    'https://example.test/gallery/set-one-10.html',
  ]);
  assert.equal(
    parser.extractLargeImageUrl('<a href="/images/original.jpg">Original image</a>', 'https://example.test/gallery/set-one-1.html'),
    'https://example.test/images/original.jpg'
  );
  assert.equal(
    parser.extractLargeImageUrl('<a class="full-size"><img src="/images/class.jpg"></a>', 'https://example.test/gallery/set-one-1.html'),
    'https://example.test/images/class.jpg'
  );
  assert.equal(
    parser.extractLargeImageUrl('<link rel="preload" as="image" href="/images/preload.jpg">', 'https://example.test/gallery/set-one-1.html'),
    'https://example.test/images/preload.jpg'
  );
});

test('source validation and letter URLs honor the runtime profile', () => {
  assert.throws(
    () => parser.validateSourceUrl('https://other.test/people', '/people'),
    /host is not allowed/
  );
  assert.throws(
    () => parser.validateSourceUrl('https://example.test/wrong', '/people', profile.modelListExample),
    /Provide a URL such as/
  );
  assert.deepEqual(parser.buildLetterModelListUrls('https://example.test/people'), [
    'https://example.test/people?letter=a',
    'https://example.test/people?letter=b',
  ]);
});
