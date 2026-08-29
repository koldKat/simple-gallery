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
      if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code) || attempt === attempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
  throw lastError;
}

function createDatabaseRuntime({
  db,
  dbPath,
  fileSize,
  trafficSnapshot,
  uptimeStats = () => ({}),
  log = console.log,
  processRef = process,
  osModule = os,
}) {
  let lastCpuUsage = processRef.cpuUsage();
  let lastCpuWallNs = processRef.hrtime.bigint();
  let lastLiveCpuUsage = processRef.cpuUsage();
  let lastLiveCpuWallNs = processRef.hrtime.bigint();

  function processStats(live = false) {
    const usage = processRef.memoryUsage();
    const nowNs = processRef.hrtime.bigint();
    const cpuNow = processRef.cpuUsage();
    const previousUsage = live ? lastLiveCpuUsage : lastCpuUsage;
    const previousWallNs = live ? lastLiveCpuWallNs : lastCpuWallNs;
    const elapsedMicros = Number(nowNs - previousWallNs) / 1000;
    const cpuMicros = Number(cpuNow.user - previousUsage.user) + Number(cpuNow.system - previousUsage.system);
    if (live) {
      lastLiveCpuWallNs = nowNs;
      lastLiveCpuUsage = cpuNow;
    } else {
      lastCpuWallNs = nowNs;
      lastCpuUsage = cpuNow;
    }
    const cpuPercent = elapsedMicros > 0 ? (cpuMicros / elapsedMicros) * 100 : 0;
    const cpuCores = cpuPercent / 100;
    return {
      rssBytes: Number(usage.rss || 0),
      heapUsedBytes: Number(usage.heapUsed || 0),
      heapTotalBytes: Number(usage.heapTotal || 0),
      cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : 0,
      cpuCores: Number.isFinite(cpuCores) ? Math.max(0, cpuCores) : 0,
      cpuTotalCores: osModule.cpus().length,
    };
  }

  function runtimeStats() {
    return {
      ...processStats(),
      dbBytes: fileSize(dbPath),
      ...trafficSnapshot(),
      ...uptimeStats(),
    };
  }

  function liveRuntimeStats() {
    return {
      ...processStats(true),
      dbBytes: fileSize(dbPath),
      ...trafficSnapshot(),
      ...uptimeStats(),
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

  return { checkpointWal, runtimeStats, liveRuntimeStats, vacuumDatabase };
}

module.exports = { createDatabaseRuntime, withBusyRetry };
