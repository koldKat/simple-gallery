'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-seen-state.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function gallery(overrides = {}) {
  return { id: 'alpha/001', dbId: 3, count: 2, seen: false, seenCount: 0, ...overrides };
}

function actionController(createSeenStateController, overrides = {}) {
  const current = gallery();
  const state = {
    user: { id: 1 },
    data: { models: [{ galleries: [current] }], latest: [] },
    activeImages: [
      { dbId: 3, name: 'one.jpg', seen: false },
      { dbId: 3, name: 'two.jpg', seen: false },
    ],
  };
  const calls = { cache: [], renders: 0 };
  const controller = createSeenStateController({
    state,
    getCurrentGallery: () => current,
    recomputeModelSeen() {},
    patchGalleryCache: (...args) => calls.cache.push(args),
    fetchJson: async () => ({ seenCount: 1, seen: false }),
    renderHeaderStats: () => { calls.renders += 1; },
    renderModels() {},
    renderModelActionButtons() {},
    patchActiveImageTile() {},
    renderSelectedGalleryBar() {},
    renderGalleries() {},
    renderImageTiles() {},
    renderLightboxMeta() {},
    updateLightbox() {},
    ...overrides,
  });
  return { calls, controller, current, state };
}

test('seen overrides reconcile model, latest, current-model, and active-image state', async () => {
  const { createSeenStateController } = await loadModule();
  const state = {
    data: { models: [{ galleries: [gallery()] }] },
    activeGalleryId: 'alpha/001',
    activeImages: [{ dbId: 3, name: 'one.jpg', seen: false }, { dbId: 3, name: 'two.jpg', seen: false }],
  };
  let recomputes = 0;
  const controller = createSeenStateController({
    state,
    getCurrentGallery: () => state.data.models[0].galleries[0],
    recomputeModelSeen: () => { recomputes += 1; },
    patchGalleryCache() {},
  });
  controller.remember(3, 2, true);
  const data = {
    models: [{ galleries: [gallery()] }],
    latest: [gallery()],
    currentModel: { galleries: [gallery()] },
  };
  controller.applyOverrides(data);

  assert.deepEqual(data.models[0].galleries[0], gallery({ seen: true, seenCount: 2 }));
  assert.equal(data.latest[0].seen, true);
  assert.equal(data.currentModel.galleries[0].seenCount, 2);
  assert.equal(state.activeImages.every(image => image.seen), true);
  assert.equal(recomputes, 2);
});

test('gallery payloads inherit authoritative seen summaries', async () => {
  const { createSeenStateController } = await loadModule();
  const current = gallery({ seen: true, seenCount: 2 });
  const state = { data: { models: [{ galleries: [current] }] }, activeImages: [] };
  const controller = createSeenStateController({
    state,
    getCurrentGallery: () => current,
    recomputeModelSeen() {},
    patchGalleryCache() {},
  });
  const payload = controller.applyToPayload(current, {
    dbId: 3,
    seen: false,
    seenCount: 0,
    images: [{ name: 'one.jpg', seen: false }, { name: 'two.jpg', seen: false }],
  });
  assert.equal(payload.seen, true);
  assert.equal(payload.seenCount, 2);
  assert.equal(payload.images.every(image => image.seen), true);
});

test('cache patches are delegated without changing arguments', async () => {
  const { createSeenStateController } = await loadModule();
  const calls = [];
  const controller = createSeenStateController({
    state: { data: null, activeImages: [] },
    getCurrentGallery: () => null,
    recomputeModelSeen() {},
    patchGalleryCache: (...args) => calls.push(args),
  });
  controller.patchCached(3, 1, false, { imageName: 'one.jpg', imageSeen: true });
  assert.deepEqual(calls, [[3, 1, false, { imageName: 'one.jpg', imageSeen: true }]]);
});

test('marking an image seen reconciles the active gallery and cached payload', async () => {
  const { createSeenStateController } = await loadModule();
  const { calls, controller, current, state } = actionController(createSeenStateController);

  await controller.setImageSeen(state.activeImages[0], true);

  assert.equal(state.activeImages[0].seen, true);
  assert.equal(current.seenCount, 1);
  assert.equal(current.seen, false);
  assert.ok(calls.renders >= 2);
  assert.deepEqual(calls.cache.at(-1), [3, 1, false, { imageName: 'one.jpg', imageSeen: true }]);
});

test('failed image seen requests restore the optimistic local state', async () => {
  const { createSeenStateController } = await loadModule();
  const failure = new Error('request failed');
  const { controller, current, state } = actionController(createSeenStateController, {
    fetchJson: async () => { throw failure; },
  });

  await assert.rejects(controller.setImageSeen(state.activeImages[0], true), failure);

  assert.equal(state.activeImages[0].seen, false);
  assert.equal(current.seenCount, 0);
  assert.equal(current.seen, false);
});

test('image seen writes are serialized while browsing a gallery', async () => {
  const { createSeenStateController } = await loadModule();
  const pending = [];
  const { controller, state } = actionController(createSeenStateController, {
    fetchJson: () => new Promise(resolve => pending.push(resolve)),
  });

  const first = controller.setImageSeen(state.activeImages[0], true);
  const second = controller.setImageSeen(state.activeImages[1], true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1);

  pending.shift()({ seenCount: 1, seen: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1);
  pending.shift()({ seenCount: 2, seen: true });
  await Promise.all([first, second]);

  assert.equal(state.activeImages.every(image => image.seen), true);
});
