'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createImportPathLock } = require('../server/import-path-lock');

function tempGallery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-import-lock-'));
  const galleryPath = path.join(root, 'alpha', '001');
  fs.mkdirSync(galleryPath, { recursive: true });
  return { root, galleryPath };
}

test('filesystem import locks are visible across processes', () => {
  const context = tempGallery();
  const workerLock = createImportPathLock({
    processRef: { pid: 111, kill() {} },
    nowIso: () => '2026-08-26T12:00:00.000Z',
  });
  const webLock = createImportPathLock({
    processRef: {
      pid: 222,
      kill(pid, signal) {
        assert.equal(pid, 111);
        assert.equal(signal, 0);
      },
    },
  });

  workerLock.mark(context.galleryPath);

  assert.equal(webLock.isActive(context.galleryPath), true);
  assert.equal(webLock.modelHasActive(path.dirname(context.galleryPath)), true);
  workerLock.clear(context.galleryPath);
  assert.equal(webLock.isActive(context.galleryPath), false);
  fs.rmSync(context.root, { recursive: true, force: true });
});

test('filesystem import locks from dead processes are removed', () => {
  const context = tempGallery();
  const workerLock = createImportPathLock({ processRef: { pid: 111, kill() {} } });
  const webLock = createImportPathLock({
    processRef: {
      pid: 222,
      kill() {
        throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
      },
    },
  });

  workerLock.mark(context.galleryPath);

  assert.equal(webLock.isActive(context.galleryPath), false);
  assert.equal(webLock.modelHasActive(path.dirname(context.galleryPath)), false);
  fs.rmSync(context.root, { recursive: true, force: true });
});
