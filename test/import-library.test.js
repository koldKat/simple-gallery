'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../server/db/schema');
const { createLibraryRepository } = require('../server/library-repository');
const { createImportLibrary } = require('../server/import-library');
const { canonicalRemoteUrl } = require('../server/source-parser');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-import-library-'));
  const db = new Database(':memory:');
  const now = '2026-08-16T12:00:00.000Z';
  initializeSchema({ db, defaultVersionLabel: '1.0.0', nowIso: () => now, withBusyRetry: work => work() });
  const repository = createLibraryRepository({
    db,
    nowIso: () => now,
    withBusyRetry: work => work(),
    normalizeModelName: value => value,
    canonicalRemoteUrl,
    getState: () => ({ models: [] }),
  });
  const readDirs = target => {
    try {
      return fs.readdirSync(target, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch {
      return [];
    }
  };
  const readImageFiles = target => {
    try {
      return fs.readdirSync(target).filter(name => /\.(?:jpg|png)$/i.test(name));
    } catch {
      return [];
    }
  };
  const library = createImportLibrary({
    db,
    readDirs,
    readImageFiles,
    mkdirp: target => fs.mkdirSync(target, { recursive: true }),
    canonicalRemoteUrl,
    upsertModelRecord: repository.upsertModelRecord,
    upsertGalleryRecord: repository.upsertGalleryRecord,
    nowIso: () => now,
  });
  return {
    db,
    directory,
    library,
    repository,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('import records canonicalize sources and persist imported galleries', () => {
  const context = fixture();
  const importDb = { scannedUrls: [], models: {} };
  const record = context.library.getImportModelRecord(
    importDb,
    'alpha',
    'Alpha',
    'https://EXAMPLE.test/model/alpha/?from=list'
  );
  context.library.rememberImportedGallery(record, {
    sourceUrl: 'https://EXAMPLE.test/gallery/one/?ref=list',
    title: 'One',
  }, '001', 2);

  assert.deepEqual(importDb.scannedUrls, ['https://example.test/model/alpha']);
  assert.equal(record.galleries['https://example.test/gallery/one'].folder, '001');
  assert.equal(context.repository.galleryDbRecord('alpha', '001').image_count, 2);
  assert.equal(record.createdAt, '2026-08-16T12:00:00.000Z');
  context.close();
});

test('manifest hydration removes missing folders and restores database-backed records', () => {
  const context = fixture();
  const modelPath = path.join(context.directory, 'alpha');
  fs.mkdirSync(path.join(modelPath, '001'), { recursive: true });
  fs.writeFileSync(path.join(modelPath, '001', 'one.jpg'), 'one');
  context.repository.upsertGalleryRecord('alpha', 'Alpha', '001', {
    sourceUrl: 'https://example.test/gallery/one',
    title: 'One',
    count: 1,
    importedAt: 'imported-at',
    lastSeenAt: 'last-seen-at',
  });
  const record = {
    modelFolder: 'alpha',
    modelName: 'Alpha',
    galleries: {
      missing: { folder: '999' },
    },
  };

  context.library.hydrateImportRecordFromManifests(record, modelPath);
  assert.equal(record.galleries.missing, undefined);
  assert.equal(record.galleries['https://example.test/gallery/one'].imageCount, 1);
  assert.equal(record.galleries['https://example.test/gallery/one'].importedAt, 'imported-at');
  assert.equal(context.library.findExistingGalleryForSource(modelPath, 'https://example.test/gallery/one/'), '001');
  assert.equal(context.library.nextGalleryName(modelPath), '002');
  context.close();
});

test('sequence repair removes empty folders, compacts numbering, and updates manifests', () => {
  const context = fixture();
  const modelPath = path.join(context.directory, 'alpha');
  fs.mkdirSync(path.join(modelPath, '002'), { recursive: true });
  fs.mkdirSync(path.join(modelPath, '003'), { recursive: true });
  fs.mkdirSync(path.join(modelPath, '004'), { recursive: true });
  fs.writeFileSync(path.join(modelPath, '002', 'first.jpg'), 'first');
  fs.writeFileSync(path.join(modelPath, '004', 'second.jpg'), 'second');
  const importDb = {
    models: {
      alpha: {
        galleries: {
          first: { folder: '002' },
          second: { folder: '004' },
          missing: { folder: '009' },
        },
      },
    },
  };

  assert.equal(context.library.repairGallerySequence('alpha', modelPath, importDb), true);
  assert.deepEqual(fs.readdirSync(modelPath).sort(), ['001', '002']);
  assert.equal(fs.readFileSync(path.join(modelPath, '001', 'first.jpg'), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(modelPath, '002', 'second.jpg'), 'utf8'), 'second');
  assert.deepEqual(importDb.models.alpha.galleries, {
    first: { folder: '001' },
    second: { folder: '002' },
  });
  context.close();
});
