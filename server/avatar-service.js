'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { processAvatar } = require('./image-policy');

function createAvatarService({ publicRoot, fileSystem = fs, now = () => Date.now(), randomBytes = crypto.randomBytes }) {
  const avatarDirectory = path.join(publicRoot, 'uploads', 'avatars');

  function avatarPathFor(userId) {
    const token = randomBytes(6).toString('hex');
    return `/uploads/avatars/${Number(userId)}-${now()}-${token}.jpg`;
  }

  function filePathFor(avatarPath) {
    const relative = String(avatarPath || '').replace(/^\/+/, '');
    const filePath = path.resolve(publicRoot, relative);
    if (!filePath.startsWith(`${avatarDirectory}${path.sep}`)) throw new Error('Invalid avatar path.');
    return filePath;
  }

  async function saveAvatar(userId, source) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user.');
    let image;
    try {
      image = await processAvatar(source);
    } catch {
      throw new Error('Avatar must be a valid image that can be processed.');
    }
    const avatarPath = avatarPathFor(id);
    const targetPath = filePathFor(avatarPath);
    const temporaryPath = `${targetPath}.tmp-${process.pid}`;
    fileSystem.mkdirSync(avatarDirectory, { recursive: true });
    try {
      fileSystem.writeFileSync(temporaryPath, image);
      fileSystem.renameSync(temporaryPath, targetPath);
    } finally {
      try { fileSystem.rmSync(temporaryPath, { force: true }); } catch {}
    }
    return avatarPath;
  }

  function removeAvatar(avatarPath) {
    if (!avatarPath) return;
    try {
      if (path.extname(String(avatarPath)).toLowerCase() !== '.jpg') return;
      fileSystem.rmSync(filePathFor(avatarPath), { force: true });
    } catch {
      // A stale or already-removed avatar must not fail account changes.
    }
  }

  return { saveAvatar, removeAvatar };
}

module.exports = { createAvatarService };
