'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-lightbox.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.complete = true;
    this.naturalWidth = 100;
    this._src = '';
  }
  set src(value) { this._src = value; }
  get src() { return this._src; }
  get currentSrc() { return this._src; }
  getAttribute(name) { return name === 'src' ? this._src : null; }
  removeAttribute(name) { if (name === 'src') this._src = ''; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name, event = {}) { return this.listeners.get(name)?.(event); }
}

function fixture(createLightboxController) {
  const elementNames = [
    'lightbox', 'lightboxImg', 'lightboxLoading', 'lightboxLoadingText', 'lightboxCaption',
    'lightboxDownload', 'lightboxSeen', 'lightboxFavorite', 'closeLightbox', 'prevImage', 'nextImage',
  ];
  const elements = Object.fromEntries(elementNames.map(name => [name, new FakeElement()]));
  elements.lightbox.hidden = true;
  const body = new FakeElement();
  body.style = {};
  body.append = () => {};
  const history = {
    state: null,
    backCount: 0,
    pushState(nextState) { this.state = nextState; },
    back() { this.backCount += 1; this.state = null; },
  };
  const windowObject = {
    history,
    location: { href: 'https://example.test/model/one/gallery/001' },
    matchMedia: () => ({ matches: false }),
    scrollY: 0,
    scrollTo() {},
    visualViewport: { scale: 1 },
  };
  const documentObject = {
    body,
    documentElement: { scrollTop: 0 },
    createElement: () => ({ click() {}, remove() {} }),
  };
  const state = {
    activeImages: [
      { src: '/one.jpg', name: 'one.jpg', dbId: 7, seen: false, favorite: false },
      { src: '/two.jpg', name: 'two.jpg', dbId: 7, seen: false, favorite: true },
    ],
    lightboxIndex: 0,
    lightboxRequestId: 0,
    lightboxLoading: false,
    lightboxError: false,
    user: { id: 1 },
  };
  const views = [];
  const seen = [];
  const favorites = [];
  const decoded = [];
  const controller = createLightboxController({
    state,
    elements,
    getCurrentGallery: () => ({ name: '001' }),
    getCurrentModel: () => ({ name: 'model one' }),
    titleCase: value => value.replace(/\b\w/g, char => char.toUpperCase()),
    setTooltip() {},
    recordView: payload => views.push(payload),
    setImageSeen: async (image, value) => { image.seen = value; seen.push(image.name); },
    toggleImageFavorite: async image => favorites.push(image.name),
    showNotice() {},
    warmDecodedWindow() {},
    rememberDecodedImage: (url, image) => decoded.push({ url, image }),
    windowObject,
    documentObject,
    createImage: () => ({ complete: true, naturalWidth: 100 }),
  });
  return { controller, decoded, elements, favorites, history, seen, state, views };
}

test('lightbox opens the selected image and records the correct image as seen', async () => {
  const { createLightboxController } = await loadModule();
  const context = fixture(createLightboxController);
  context.controller.open(1);
  await Promise.resolve();

  assert.equal(context.elements.lightbox.hidden, false);
  assert.equal(context.elements.lightboxImg.src, '/two.jpg');
  assert.equal(context.elements.lightboxCaption.textContent, 'Model One / Gallery 001 / two.jpg');
  assert.deepEqual(context.views, [{ type: 'image', galleryDbId: 7, imageName: 'two.jpg' }]);
  assert.deepEqual(context.seen, ['two.jpg']);
});

test('lightbox keyboard navigation steps images and closes through history', async () => {
  const { createLightboxController } = await loadModule();
  const context = fixture(createLightboxController);
  context.controller.open(0);
  let prevented = 0;
  assert.equal(context.controller.handleKeydown({ key: 'ArrowRight', preventDefault: () => { prevented += 1; } }), true);
  assert.equal(context.state.lightboxIndex, 1);
  assert.equal(context.elements.lightboxImg.src, '/two.jpg');
  assert.equal(context.controller.handleKeydown({ key: 'Escape', preventDefault: () => { prevented += 1; } }), true);
  assert.equal(context.elements.lightbox.hidden, true);
  assert.equal(context.history.backCount, 1);
  assert.equal(prevented, 2);
});

test('visible image loads are registered with the decoded-image cache', async () => {
  const { createLightboxController } = await loadModule();
  const context = fixture(createLightboxController);
  context.controller.bind();
  context.controller.open(0);
  context.elements.lightboxImg.dispatch('load');
  assert.equal(context.decoded.length, 1);
  assert.equal(context.decoded[0].url, '/one.jpg');
});
