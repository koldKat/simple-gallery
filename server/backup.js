'use strict';

const fs = require('fs');
const path = require('path');
const { nextDailyDate } = require('./schedule');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function localDateStamp(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function localTimestampStamp(date = new Date()) {
  return `${localDateStamp(date)}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildStoredZip(entryName, content, date = new Date()) {
  const name = Buffer.from(entryName, 'utf8');
  const { time, day } = dosDateTime(date);
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  const centralOffset = local.length + name.length + content.length;
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([local, name, content, central, name, end]);
}

function createBackupService(options) {
  const {
    db,
    backupDirectory,
    defaultTime,
    retentionDays,
    isWorker,
    log = console,
    startupDelayMs = 10_000,
  } = options;
  let timer = null;
  let inFlight = false;

  function pruneOld() {
    let entries = [];
    try {
      const cutoff = new Date();
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
      entries = fs.readdirSync(backupDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^gallery-db-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/.test(entry.name))
        .map(entry => {
          const match = entry.name.match(/^gallery-db-(\d{4})-(\d{2})-(\d{2})-\d{6}\.zip$/);
          const filePath = path.join(backupDirectory, entry.name);
          let stat = null;
          try { stat = fs.statSync(filePath); } catch {}
          const backupDate = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
          return stat ? { name: entry.name, path: filePath, backupDate } : null;
        })
        .filter(entry => entry?.backupDate && entry.backupDate < cutoff);
    } catch {
      return;
    }
    for (const entry of entries) {
      try {
        fs.unlinkSync(entry.path);
        log.log(`[db-backup] Deleted old backup ${entry.name}.`);
      } catch (error) {
        log.warn(`[db-backup] Failed to delete old backup ${entry.name}: ${error?.message || error}`);
      }
    }
  }

  function hasBackupForToday() {
    const today = localDateStamp();
    try {
      return fs.readdirSync(backupDirectory, { withFileTypes: true })
        .some(entry => entry.isFile() && entry.name.startsWith(`gallery-db-${today}-`) && entry.name.endsWith('.zip'));
    } catch {
      return false;
    }
  }

  async function create(reason = 'scheduled') {
    if (isWorker || inFlight) return;
    inFlight = true;
    fs.mkdirSync(backupDirectory, { recursive: true });
    const stamp = localTimestampStamp();
    const tempDbPath = path.join(backupDirectory, `.gallery-db-${stamp}-${process.pid}.tmp`);
    const zipPath = path.join(backupDirectory, `gallery-db-${stamp}.zip`);
    try {
      await db.backup(tempDbPath);
      const content = fs.readFileSync(tempDbPath);
      fs.writeFileSync(zipPath, buildStoredZip(`gallery-${stamp}.db`, content));
      log.log(`[db-backup] Created ${path.basename(zipPath)} (${reason}).`);
      pruneOld();
    } catch (error) {
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
      log.error(`[db-backup] Backup failed: ${error?.message || error}`);
    } finally {
      try { if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath); } catch {}
      inFlight = false;
    }
  }

  function stop() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function schedule(reason = 'startup') {
    stop();
    if (isWorker) return;
    if (reason === 'startup' && !hasBackupForToday()) {
      timer = setTimeout(async () => {
        timer = null;
        await create('startup');
        schedule('post-run');
      }, startupDelayMs);
      return;
    }
    const next = nextDailyDate(defaultTime, new Date(), defaultTime);
    timer = setTimeout(async () => {
      timer = null;
      await create('scheduled');
      schedule('post-run');
    }, Math.max(1000, next.getTime() - Date.now()));
  }

  return { create, hasBackupForToday, pruneOld, schedule, stop };
}

module.exports = { buildStoredZip, createBackupService, crc32, localDateStamp, localTimestampStamp };
