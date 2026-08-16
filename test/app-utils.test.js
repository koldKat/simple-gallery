'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadBrowserModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-utils.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('browser route helpers encode paths and recover state', async () => {
  const utils = await loadBrowserModule();
  assert.equal(utils.modelPath('name/with space'), '/model/name%2Fwith%20space');
  assert.equal(utils.galleryPath('model one', '001/a'), '/model/model%20one/gallery/001%2Fa');
  assert.equal(utils.pathForState({
    mode: 'model',
    selectedModel: 'model one',
    selectedGallery: 'model one/001',
  }), '/model/model%20one/gallery/001');
  assert.deepEqual(utils.parseAppPath('/model/model%20one/gallery/001'), {
    recognized: true,
    mode: 'model',
    modelId: 'model one',
    galleryName: '001',
  });
  assert.deepEqual(utils.parseAppPath('/not-a-route'), { recognized: false, mode: 'home' });
});

test('browser display helpers preserve existing normalization', async () => {
  const utils = await loadBrowserModule();
  assert.equal(utils.titleCase('jane_doe'), 'Jane Doe');
  assert.equal(utils.searchText('  Jane-Doe  '), 'jane doe');
  assert.equal(utils.formatCount(1234567), '1,234,567');
  assert.equal(utils.formatDate('invalid'), 'date unknown');
});

test('seeded sidebar shuffle is deterministic without mutating input', async () => {
  const { shuffledModels } = await loadBrowserModule();
  const models = ['a', 'b', 'c', 'd', 'e'];
  const first = shuffledModels(models, 42);
  const second = shuffledModels(models, 42);
  assert.deepEqual(first, second);
  assert.deepEqual(models, ['a', 'b', 'c', 'd', 'e']);
  assert.notDeepEqual(first, models);
});
