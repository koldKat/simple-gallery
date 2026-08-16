'use strict';

const fs = require('fs');
const path = require('path');

function sanitizeFolderName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

function normalizeModelName(name) {
  return String(name || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase()) || 'Model';
}

function sanitizeFileBase(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'image';
}

function createMediaLibrary({ mediaRoot, mediaUrlPrefix, thumbDirectory, imageExtensions }) {
  function toUrl(filePath) {
    const relative = path.relative(mediaRoot(), filePath)
      .split(path.sep)
      .map(encodeURIComponent)
      .join('/');
    return `${mediaUrlPrefix()}/${relative}`;
  }

  function safeName(name) {
    return name.replace(/\.[^.]+$/, '.jpg');
  }

  function isImage(fileName) {
    return imageExtensions.has(path.extname(fileName).toLowerCase());
  }

  function readDirs(dirPath) {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(entry => {
          if (entry.isDirectory()) return true;
          if (!entry.isSymbolicLink()) return false;
          try {
            return fs.statSync(path.join(dirPath, entry.name)).isDirectory();
          } catch {
            return false;
          }
        })
        .map(entry => entry.name)
        .filter(name => !name.startsWith('.'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } catch {
      return [];
    }
  }

  function readImageFiles(dirPath) {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && isImage(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } catch {
      return [];
    }
  }

  function mkdirp(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  function removeFile(filePath) {
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  function cleanupStaleThumbs(thumbRoot, wantedThumbNames) {
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(thumbRoot, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const entryPath = path.join(thumbRoot, entry.name);
      if (entry.isDirectory()) continue;
      if (entry.name.includes('.tmp-') || !wantedThumbNames.has(entry.name)) {
        if (removeFile(entryPath)) removed += 1;
      }
    }
    return removed;
  }

  function removeEmptyThumbDir(thumbRoot) {
    try {
      fs.rmdirSync(thumbRoot);
    } catch {
      // Keep non-empty or unavailable thumbnail directories in place.
    }
  }

  function fileSize(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  function galleryStorageStats(galleryPath) {
    const imageNames = readImageFiles(galleryPath);
    const thumbRoot = path.join(galleryPath, thumbDirectory);
    let imageBytes = 0;
    let thumbBytes = 0;
    let missingThumbs = 0;

    for (const fileName of imageNames) {
      const sourcePath = path.join(galleryPath, fileName);
      const thumbPath = path.join(thumbRoot, safeName(fileName));
      const hasThumb = fs.existsSync(thumbPath);
      imageBytes += fileSize(sourcePath);
      thumbBytes += hasThumb ? fileSize(thumbPath) : 0;
      if (!hasThumb) missingThumbs += 1;
    }

    return { imageNames, imageBytes, thumbBytes, missingThumbs };
  }

  function galleryCoverUrl(modelFolder, galleryFolder, coverName, options = {}) {
    const firstImage = String(coverName || '').trim();
    if (!firstImage) return null;
    const galleryPath = path.join(mediaRoot(), modelFolder, galleryFolder);
    const sourcePath = path.join(galleryPath, firstImage);
    const thumbPath = path.join(galleryPath, thumbDirectory, safeName(firstImage));
    if (options.cached) {
      return toUrl(Number(options.thumbBytes || 0) > 0 ? thumbPath : sourcePath);
    }
    return fs.existsSync(thumbPath) ? toUrl(thumbPath) : toUrl(sourcePath);
  }

  return {
    toUrl,
    safeName,
    isImage,
    readDirs,
    readImageFiles,
    mkdirp,
    removeFile,
    cleanupStaleThumbs,
    removeEmptyThumbDir,
    fileSize,
    galleryStorageStats,
    galleryCoverUrl,
  };
}

module.exports = {
  createMediaLibrary,
  sanitizeFolderName,
  normalizeModelName,
  sanitizeFileBase,
};
