'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStoredZip, createBackupService, crc32 } = require('../server/backup');

test('backup CRC and stored ZIP layout remain compatible', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const content = Buffer.from('database bytes');
  const archive = buildStoredZip('gallery.db', content, new Date(2026, 7, 16, 2, 30, 0));
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const nameLength = archive.readUInt16LE(26);
  assert.equal(archive.subarray(30, 30 + nameLength).toString(), 'gallery.db');
  assert.deepEqual(archive.subarray(30 + nameLength, 30 + nameLength + content.length), content);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});

test('backup service writes an archive and removes its temporary database', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-gallery-backup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const messages = [];
  const service = createBackupService({
    db: {
      async backup(target) {
        fs.writeFileSync(target, Buffer.from('temporary database'));
      },
    },
    backupDirectory: directory,
    defaultTime: '02:30',
    retentionDays: 30,
    isWorker: false,
    log: {
      log: message => messages.push(message),
      warn: message => messages.push(message),
      error: message => messages.push(message),
    },
  });

  await service.create('test');
  const files = fs.readdirSync(directory);
  assert.equal(files.filter(file => file.endsWith('.zip')).length, 1);
  assert.equal(files.filter(file => file.endsWith('.tmp')).length, 0);
  assert.match(messages.join('\n'), /Created gallery-db-.* \(test\)\./);
});

test('worker backup service never invokes the database', async () => {
  let called = false;
  const service = createBackupService({
    db: { backup: async () => { called = true; } },
    backupDirectory: path.join(os.tmpdir(), 'simple-gallery-worker-backup'),
    defaultTime: '02:30',
    retentionDays: 30,
    isWorker: true,
  });
  await service.create('test');
  service.schedule('startup');
  service.stop();
  assert.equal(called, false);
});
