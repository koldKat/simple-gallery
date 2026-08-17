'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMediaLibrary,
  sanitizeFolderName,
  normalizeModelName,
  sanitizeFileBase,
} = require('../server/media-library');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-media-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let root = directory;
  let prefix = '/media';
  const library = createMediaLibrary({
    mediaRoot: () => root,
    mediaUrlPrefix: () => prefix,
    thumbDirectory: '.thumbs',
    imageExtensions: new Set(['.jpg', '.jpeg', '.png', '.webp']),
  });
  return {
    directory,
    library,
    setRoot(value) { root = value; },
    setPrefix(value) { prefix = value; },
  };
}

test('media names retain the established normalization rules', () => {
  assert.equal(sanitizeFolderName(' Jane O\'Doe '), 'jane-odoe');
  assert.equal(sanitizeFolderName('---'), 'model');
  assert.equal(normalizeModelName('jane__doe-smith'), 'Jane Doe Smith');
  assert.equal(normalizeModelName(''), 'Model');
  assert.equal(sanitizeFileBase(' Image #12.JPG '), 'image-12-jpg');
  assert.equal(sanitizeFileBase('x'.repeat(300)).length, 160);
});

test('directory and image discovery is filtered and naturally sorted', (t) => {
  const { directory, library } = fixture(t);
  fs.mkdirSync(path.join(directory, 'model-10'));
  fs.mkdirSync(path.join(directory, 'model-2'));
  fs.mkdirSync(path.join(directory, '.hidden'));
  fs.symlinkSync(path.join(directory, 'model-2'), path.join(directory, 'linked'));
  fs.writeFileSync(path.join(directory, '10.JPG'), 'ten');
  fs.writeFileSync(path.join(directory, '2.png'), 'two');
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'ignore');

  assert.deepEqual(library.readDirs(directory), ['linked', 'model-2', 'model-10']);
  assert.deepEqual(library.readImageFiles(directory), ['2.png', '10.JPG']);
  assert.deepEqual(library.readImageFiles(path.join(directory, 'missing')), []);
});

test('media URLs encode path segments and use live runtime configuration', (t) => {
  const context = fixture(t);
  const nested = path.join(context.directory, 'Jane Doe', '001', 'one image.jpg');
  assert.equal(context.library.toUrl(nested), '/media/Jane%20Doe/001/one%20image.jpg');

  const parent = path.dirname(context.directory);
  context.setRoot(parent);
  context.setPrefix('/files');
  assert.match(context.library.toUrl(nested), /^\/files\/simple-gallery-media-/);
});

test('gallery storage reports exact image, thumbnail, and missing totals', (t) => {
  const { directory, library } = fixture(t);
  const gallery = path.join(directory, 'model', '001');
  const thumbs = path.join(gallery, '.thumbs');
  fs.mkdirSync(thumbs, { recursive: true });
  fs.writeFileSync(path.join(gallery, 'one.png'), Buffer.alloc(7));
  fs.writeFileSync(path.join(gallery, 'two.jpg'), Buffer.alloc(11));
  fs.writeFileSync(path.join(thumbs, 'one.jpg'), Buffer.alloc(3));

  assert.deepEqual(library.galleryStorageStats(gallery), {
    imageNames: ['one.png', 'two.jpg'],
    imageBytes: 18,
    thumbBytes: 3,
    missingThumbs: 1,
  });
});

test('thumbnail cleanup and cover selection preserve wanted files', (t) => {
  const { directory, library } = fixture(t);
  const gallery = path.join(directory, 'model', '001');
  const thumbs = path.join(gallery, '.thumbs');
  fs.mkdirSync(path.join(thumbs, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(gallery, 'cover.png'), 'source');
  fs.writeFileSync(path.join(thumbs, 'cover.jpg'), 'thumb');
  fs.writeFileSync(path.join(thumbs, 'stale.jpg'), 'stale');
  fs.writeFileSync(path.join(thumbs, 'cover.jpg.tmp-1'), 'temp');

  assert.equal(library.galleryCoverUrl('model', '001', 'cover.png'), '/media/model/001/.thumbs/cover.jpg');
  assert.equal(library.galleryCoverUrl('model', '001', 'cover.png', { cached: true, thumbBytes: 0 }), '/media/model/001/cover.png');
  assert.equal(library.cleanupStaleThumbs(thumbs, new Set(['cover.jpg'])), 2);
  assert.deepEqual(fs.readdirSync(thumbs).sort(), ['cover.jpg', 'nested']);

  library.removeEmptyThumbDir(thumbs);
  assert.equal(fs.existsSync(thumbs), true);
});
