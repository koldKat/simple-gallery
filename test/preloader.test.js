'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-preloader.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fakeImageFactory({ autoLoad = true } = {}) {
  const images = [];
  class FakeImage {
    constructor() {
      this._src = '';
      this.complete = false;
      this.naturalWidth = 0;
      images.push(this);
    }
    set src(value) {
      this._src = value;
      if (!value || !autoLoad) return;
      queueMicrotask(() => {
        this.complete = true;
        this.naturalWidth = 100;
        this.onload?.();
      });
    }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  }
  return { images, createImage: () => new FakeImage() };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve));
}

test('preloader warms gallery cover, thumbnails, and source images with progress', async () => {
  const { createImagePreloader } = await loadModule();
  const factory = fakeImageFactory();
  const state = { mode: 'model', selectedModel: 'model', selectedGallery: 'model/001', activeImages: [], lightboxIndex: 0 };
  const progress = [];
  const gallery = { id: 'model/001', cover: '/cover.jpg' };
  const preloader = createImagePreloader({
    getState: () => state,
    getPreferences: () => ({ preloadModel: false, preloadGallery: true }),
    getCurrentModel: () => null,
    getCurrentGallery: () => gallery,
    fetchGalleryPayload: async () => ({ images: [{ thumb: '/thumb.jpg', src: '/image.jpg' }] }),
    clearGalleryCache() {},
    onProgress: value => progress.push(value),
    createImage: factory.createImage,
    isImage: () => true,
  });
  preloader.syncForCurrentView();
  await settle();
  assert.deepEqual(progress.at(-1), { total: 3, completed: 3 });
  assert.deepEqual(factory.images.map(image => image.src).sort(), ['/cover.jpg', '/image.jpg', '/thumb.jpg']);
});

test('changing preload scope aborts and releases old in-flight images', async () => {
  const { createImagePreloader } = await loadModule();
  const factory = fakeImageFactory({ autoLoad: false });
  const state = { mode: 'model', selectedModel: 'model', selectedGallery: 'model/001', activeImages: [], lightboxIndex: 0 };
  const preloader = createImagePreloader({
    getState: () => state,
    getPreferences: () => ({ preloadModel: false, preloadGallery: true }),
    getCurrentModel: () => null,
    getCurrentGallery: () => ({ id: state.selectedGallery, cover: '/old-cover.jpg' }),
    fetchGalleryPayload: async () => ({ images: [] }),
    clearGalleryCache() {},
    onProgress() {},
    createImage: factory.createImage,
    isImage: () => true,
  });
  preloader.syncForCurrentView();
  await settle();
  const oldImage = factory.images[0];
  assert.equal(oldImage.src, '/old-cover.jpg');
  state.selectedGallery = 'model/002';
  preloader.syncScope();
  assert.equal(oldImage.src, '');
  assert.equal(oldImage.onload, null);
});

test('lightbox decode window evicts images outside the configured window', async () => {
  const { createImagePreloader } = await loadModule();
  const factory = fakeImageFactory();
  const state = {
    mode: 'model',
    selectedModel: 'model',
    selectedGallery: 'model/001',
    activeImages: [{ src: '/one.jpg' }, { src: '/two.jpg' }],
    lightboxIndex: 0,
  };
  const preloader = createImagePreloader({
    getState: () => state,
    getPreferences: () => ({ preloadModel: false, preloadGallery: true }),
    getCurrentModel: () => null,
    getCurrentGallery: () => null,
    fetchGalleryPayload: async () => ({ images: [] }),
    clearGalleryCache() {},
    onProgress() {},
    createImage: factory.createImage,
    isImage: () => true,
    decodeAhead: 0,
    decodeBehind: 0,
  });
  preloader.warmDecodedWindow(0);
  await settle();
  const first = factory.images[0];
  assert.equal(first.src, '/one.jpg');
  preloader.warmDecodedWindow(1);
  await settle();
  assert.equal(first.src, '');
  assert.equal(factory.images.at(-1).src, '/two.jpg');
});

test('lightbox can register an image decoded by the visible image element', async () => {
  const { createImagePreloader } = await loadModule();
  const factory = fakeImageFactory({ autoLoad: false });
  const preloader = createImagePreloader({
    getState: () => ({ activeImages: [], lightboxIndex: 0 }),
    getPreferences: () => ({ preloadModel: false, preloadGallery: false }),
    getCurrentModel: () => null,
    getCurrentGallery: () => null,
    fetchGalleryPayload: async () => ({ images: [] }),
    clearGalleryCache() {},
    onProgress() {},
    createImage: factory.createImage,
    isImage: () => true,
  });
  const decoded = factory.createImage();
  decoded.src = '/visible.jpg';
  preloader.rememberDecodedImage('/visible.jpg', decoded);
  preloader.releaseLightboxDecodedCache();
  assert.equal(decoded.src, '');
});
