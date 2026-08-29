'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { AVATAR_DIMENSION, IMAGE_MAX_BYTES, processAvatar } = require('../server/image-policy');

test('avatar processing creates a 512 square JPEG within 256 KiB', async () => {
  const source = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#20775f' } }).png().toBuffer();
  const result = await processAvatar(source);
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, AVATAR_DIMENSION);
  assert.equal(metadata.height, AVATAR_DIMENSION);
  assert.ok(result.length <= IMAGE_MAX_BYTES);
});
