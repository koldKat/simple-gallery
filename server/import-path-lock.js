'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_PREFIX = '.simple-gallery-importing-';
const LOCK_SUFFIX = '.json';

function createImportPathLock({
  fileSystem = fs,
  processRef = process,
  nowIso = () => new Date().toISOString(),
} = {}) {
  function lockPath(galleryPath) {
    const galleryName = path.basename(galleryPath);
    return path.join(path.dirname(galleryPath), `${LOCK_PREFIX}${galleryName}${LOCK_SUFFIX}`);
  }

  function mark(galleryPath) {
    fileSystem.mkdirSync(path.dirname(galleryPath), { recursive: true });
    fileSystem.writeFileSync(lockPath(galleryPath), JSON.stringify({
      pid: processRef.pid,
      gallery: path.basename(galleryPath),
      startedAt: nowIso(),
    }));
  }

  function clear(galleryPath) {
    fileSystem.rmSync(lockPath(galleryPath), { force: true });
  }

  function processIsRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === processRef.pid) return true;
    try {
      processRef.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  function lockIsActive(filePath) {
    let payload;
    try {
      payload = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
    } catch {
      return true;
    }
    if (processIsRunning(Number(payload.pid))) return true;
    fileSystem.rmSync(filePath, { force: true });
    return false;
  }

  function isActive(galleryPath) {
    const filePath = lockPath(galleryPath);
    return fileSystem.existsSync(filePath) && lockIsActive(filePath);
  }

  function modelHasActive(modelPath) {
    let names;
    try {
      names = fileSystem.readdirSync(modelPath);
    } catch {
      return false;
    }
    return names
      .filter(name => name.startsWith(LOCK_PREFIX) && name.endsWith(LOCK_SUFFIX))
      .some(name => lockIsActive(path.join(modelPath, name)));
  }

  return { clear, isActive, mark, modelHasActive };
}

module.exports = { createImportPathLock, LOCK_PREFIX, LOCK_SUFFIX };
