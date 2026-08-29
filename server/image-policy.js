'use strict';

const IMAGE_MAX_BYTES = 256 * 1024;
const AVATAR_DIMENSION = 512;
const JPEG_QUALITIES = Object.freeze([88, 80, 72, 64, 56, 48, 40, 32, 24]);
let sharpModule = null;

function sharp() {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = require('sharp');
    return sharpModule;
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') {
      throw new Error('Avatar processing requires sharp. Run npm install in the application directory.');
    }
    throw error;
  }
}

async function processAvatar(input) {
  const imageProcessor = sharp();
  for (const quality of JPEG_QUALITIES) {
    const image = await imageProcessor(input, { failOn: 'error', limitInputPixels: 64_000_000 })
      .rotate()
      .resize({ width: AVATAR_DIMENSION, height: AVATAR_DIMENSION, fit: 'cover', position: 'centre' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (image.length <= IMAGE_MAX_BYTES) return image;
  }
  throw new Error('Could not compress avatar below 256 KB.');
}

module.exports = { AVATAR_DIMENSION, IMAGE_MAX_BYTES, processAvatar };
