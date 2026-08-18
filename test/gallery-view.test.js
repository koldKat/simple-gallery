'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-gallery-view.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fixture(createGalleryViewController, overrides = {}) {
  const gallery = { id: 'model/001', dbId: 5, name: '001', count: 2 };
  const state = {
    mode: 'model',
    selectedModel: 'model',
    selectedGallery: gallery.id,
    galleryListExpanded: false,
    activeGalleryId: gallery.id,
    activeImages: [],
    imagesLoading: true,
    user: null,
  };
  const elements = {
    selectedGalleryBar: { innerHTML: '', hidden: false, append() {} },
    galleryKicker: { textContent: '' },
    galleryTitle: { textContent: '' },
    galleryList: { innerHTML: '', hidden: false, classList: { toggle() {} }, append() {} },
    imageGrid: {
      innerHTML: '',
      hidden: false,
      children: [],
      append(...children) { this.children.push(...children); },
    },
  };
  const calls = [];
  const controller = createGalleryViewController({
    state,
    elements,
    currentModel: () => ({ id: 'model', name: 'Model', galleries: [gallery] }),
    currentGallery: overrides.currentGallery || (() => gallery),
    latestGalleries: () => [],
    syncActiveGallerySeenState: () => calls.push('sync-seen'),
    resetActiveImages: () => { state.activeGalleryId = null; state.activeImages = []; calls.push('reset'); },
    fetchGalleryPayload: overrides.fetchGalleryPayload || (async () => ({ dbId: 5, images: [] })),
    galleryImagesFromPayload: payload => payload.images,
    renderHeaderStats: () => calls.push('header'),
    renderModels: () => calls.push('models'),
    renderModelActionButtons: () => calls.push('actions'),
    syncGalleryBackdrop: () => calls.push('backdrop'),
    preloadGalleryAssetsFromPayload: () => calls.push('preload'),
    bindCardImageLoading() {},
    favoriteButton: overrides.favoriteButton || (() => {}),
    toggleGalleryFavorite: async () => {},
    toggleImageFavorite: async () => {},
    setGallerySeen: async () => {},
    setImageSeen: async () => {},
    stepGallery() {},
    openGallery() {},
    openLightbox: overrides.openLightbox || (() => {}),
    setTooltip() {},
    showNotice: message => calls.push(`notice:${message}`),
    formatCount: value => String(value),
    formatDate: value => String(value || ''),
    titleCase: value => String(value),
    render() {},
    documentObject: overrides.documentObject || {},
    sleep: overrides.sleep || (async () => {}),
  });
  return { calls, controller, elements, gallery, state };
}

function fakeElement(tagName) {
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    listeners: new Map(),
    attributes: new Map(),
    append(...children) { this.children.push(...children); },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    querySelector(selector) { return selector === 'img' ? this.image : null; },
  };
  Object.defineProperty(element, 'innerHTML', {
    set(value) {
      element._innerHTML = value;
      if (value.includes('<img')) element.image = fakeElement('img');
    },
    get() { return element._innerHTML || ''; },
  });
  return element;
}

test('stale gallery responses cannot replace images for a newer gallery', async () => {
  const { createGalleryViewController } = await loadModule();
  let resolveRequest;
  const context = fixture(createGalleryViewController, {
    fetchGalleryPayload: () => new Promise(resolve => { resolveRequest = resolve; }),
  });
  const loading = context.controller.loadImages(context.gallery);
  context.state.activeGalleryId = 'model/002';
  resolveRequest({ dbId: 5, images: [{ name: 'stale.jpg' }] });
  await loading;
  assert.deepEqual(context.state.activeImages, []);
  assert.deepEqual(context.calls, []);
});

test('gallery loading retries once before exposing a stable error', async () => {
  const { createGalleryViewController } = await loadModule();
  let attempts = 0;
  const sleeps = [];
  const context = fixture(createGalleryViewController, {
    fetchGalleryPayload: async () => { attempts += 1; throw new Error('network down'); },
    sleep: async delay => sleeps.push(delay),
  });
  await context.controller.loadImages(context.gallery);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(context.state.imagesLoading, false);
  assert.match(context.elements.imageGrid.innerHTML, /Failed to load gallery images/);
  assert.deepEqual(context.calls, ['notice:network down']);
});

test('unresolved gallery routes show loading state without clearing route selection', async () => {
  const { createGalleryViewController } = await loadModule();
  const context = fixture(createGalleryViewController, { currentGallery: () => null });
  context.controller.renderImages();
  assert.equal(context.elements.imageGrid.hidden, false);
  assert.match(context.elements.imageGrid.innerHTML, /Loading gallery images/);
  assert.equal(context.state.selectedGallery, 'model/001');
});

test('image tiles use a mobile-safe wrapper and open from pointer or keyboard activation', async () => {
  const { createGalleryViewController } = await loadModule();
  const opened = [];
  const documentObject = { createElement: fakeElement };
  const context = fixture(createGalleryViewController, {
    documentObject,
    favoriteButton: () => fakeElement('button'),
    openLightbox: index => opened.push(index),
  });
  context.state.imagesLoading = false;
  context.state.activeImages = [{ dbId: 5, name: 'one.jpg', thumb: '/thumb.jpg' }];

  context.controller.renderImageTiles();

  const tile = context.elements.imageGrid.children?.[0];
  assert.equal(tile.tagName, 'DIV');
  assert.equal(tile.attributes.get('role'), 'button');
  tile.listeners.get('click')();
  let prevented = false;
  tile.listeners.get('keydown')({ key: 'Enter', preventDefault: () => { prevented = true; } });
  assert.deepEqual(opened, [0, 0]);
  assert.equal(prevented, true);
});
