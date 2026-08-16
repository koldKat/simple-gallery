'use strict';

const os = require('os');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withBusyRetry(work, attempts = 12, delayMs = 150) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return work();
    } catch (error) {
      lastError = error;
      if (error?.code !== 'SQLITE_BUSY' || attempt === attempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
  throw lastError;
}

function createDatabaseRuntime({ db, dbPath, fileSize, trafficSnapshot, log = console.log }) {
  let lastCpuUsage = process.cpuUsage();
  let lastCpuWallNs = process.hrtime.bigint();

  function runtimeStats() {
    const usage = process.memoryUsage();
    const nowNs = process.hrtime.bigint();
    const cpuNow = process.cpuUsage();
    const elapsedMicros = Number(nowNs - lastCpuWallNs) / 1000;
    const cpuMicros = Number(cpuNow.user - lastCpuUsage.user) + Number(cpuNow.system - lastCpuUsage.system);
    lastCpuWallNs = nowNs;
    lastCpuUsage = cpuNow;
    const cpuPercent = elapsedMicros > 0 ? (cpuMicros / elapsedMicros) * 100 : 0;
    const cpuCores = cpuPercent / 100;
    return {
      rssBytes: Number(usage.rss || 0),
      heapUsedBytes: Number(usage.heapUsed || 0),
      heapTotalBytes: Number(usage.heapTotal || 0),
      cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : 0,
      cpuCores: Number.isFinite(cpuCores) ? Math.max(0, cpuCores) : 0,
      cpuTotalCores: os.cpus().length,
      dbBytes: fileSize(dbPath),
      ...trafficSnapshot(),
    };
  }

  function checkpointWal(reason = 'manual') {
    const walPath = `${dbPath}-wal`;
    const beforeBytes = fileSize(walPath);
    const result = db.pragma('wal_checkpoint(TRUNCATE)')?.[0] || {};
    const afterBytes = fileSize(walPath);
    log(
      `[db-wal] Checkpoint ${reason}: ${beforeBytes} -> ${afterBytes} bytes ` +
      `(busy=${result.busy ?? 0}, log=${result.log ?? 0}, checkpointed=${result.checkpointed ?? 0}).`
    );
  }

  function vacuumDatabase(reason = 'manual') {
    const beforeBytes = fileSize(dbPath);
    log(`[db-vacuum] Starting database vacuum (${reason}).`);
    db.exec('VACUUM');
    const afterBytes = fileSize(dbPath);
    const delta = afterBytes - beforeBytes;
    const deltaText = delta === 0 ? 'no size change' : `${delta > 0 ? '+' : ''}${delta} bytes`;
    log(`[db-vacuum] Finished database vacuum (${reason}): ${beforeBytes} -> ${afterBytes} bytes (${deltaText}).`);
    checkpointWal(reason);
  }

  return { checkpointWal, runtimeStats, vacuumDatabase };
}

module.exports = { createDatabaseRuntime, withBusyRetry };
