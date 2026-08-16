'use strict';

function createImportProgress({
  getJob,
  isStopRequested,
  isPauseRequested,
  resumableCheckpoint,
  lastRescanMetadata,
  broadcast,
  progressMinMs,
  logLimit,
  now = Date.now,
  nowIso = () => new Date().toISOString(),
}) {
  let lastProgressAt = 0;

  function snapshot() {
    const job = getJob();
    if (!job) {
      return { active: false, canResumeRescanAll: Boolean(resumableCheckpoint()) };
    }
    const lastRescanAll = lastRescanMetadata();
    return {
      active: job.active,
      status: job.status,
      mode: job.mode || '',
      message: job.message,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      sourceUrl: job.sourceUrl,
      modelName: job.modelName,
      modelFolder: job.modelFolder,
      currentModelUrl: job.currentModelUrl || '',
      totals: job.totals,
      current: job.current,
      canResumeRescanAll: !job.active && Boolean(resumableCheckpoint()),
      stopAfterCurrentModel: isStopRequested(),
      pauseRescanAllRequested: isPauseRequested(),
      lastRescanAll: job.mode === 'all' && !job.active && lastRescanAll.lastRescanAllDurationMs ? {
        startedAt: lastRescanAll.lastRescanAllStartedAt,
        finishedAt: lastRescanAll.lastRescanAllFinishedAt,
        durationMs: lastRescanAll.lastRescanAllDurationMs,
        status: lastRescanAll.lastRescanAllStatus,
      } : null,
      logs: job.logs.slice(-80),
    };
  }

  function shouldBroadcast(options) {
    const timestamp = now();
    if (!options.force && timestamp - lastProgressAt < progressMinMs) return false;
    lastProgressAt = timestamp;
    return true;
  }

  function append(message, options = {}) {
    const job = getJob();
    if (!job || options.log === false) return;
    job.logs.push({ at: nowIso(), message });
    if (job.logs.length > logLimit) job.logs.splice(0, job.logs.length - logLimit);
    if (options.broadcast && shouldBroadcast(options)) broadcast('import', snapshot());
  }

  function update(message, patch = {}, options = {}) {
    const job = getJob();
    if (!job) return;
    Object.assign(job, patch);
    job.message = message;
    append(message, options);
    if (shouldBroadcast(options)) broadcast('import', snapshot());
  }

  return {
    snapshot,
    update,
    append,
    resetThrottle: () => { lastProgressAt = 0; },
  };
}

module.exports = { createImportProgress };
