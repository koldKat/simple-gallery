'use strict';

const CHECKPOINT_KEY = 'rescan_all_checkpoint_v1';

function createRescanCheckpoints({
  db,
  getSetting,
  setSetting,
  withBusyRetry,
  getImportJob,
  getSourceUrls,
  canonicalRemoteUrl,
  nowIso,
}) {
  function metadata() {
    const durationMs = Number(getSetting('last_rescan_all_duration_ms', '0'));
    return {
      lastRescanAllStartedAt: getSetting('last_rescan_all_started_at', ''),
      lastRescanAllFinishedAt: getSetting('last_rescan_all_finished_at', ''),
      lastRescanAllStatus: getSetting('last_rescan_all_status', ''),
      lastRescanAllDurationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
    };
  }

  function recordStarted(startedAt) {
    setSetting('last_rescan_all_started_at', startedAt || nowIso());
    setSetting('last_rescan_all_finished_at', '');
    setSetting('last_rescan_all_status', 'running');
    setSetting('last_rescan_all_duration_ms', '0');
  }

  function recordFinished(status) {
    const importJob = getImportJob();
    if (!importJob || importJob.mode !== 'all') return;
    const startedAt = importJob.startedAt || nowIso();
    const finishedAt = importJob.finishedAt || nowIso();
    const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
    setSetting('last_rescan_all_started_at', startedAt);
    setSetting('last_rescan_all_finished_at', finishedAt);
    setSetting('last_rescan_all_status', status || importJob.status || '');
    setSetting('last_rescan_all_duration_ms', String(Number.isFinite(durationMs) ? durationMs : 0));
  }

  function load() {
    try {
      const value = JSON.parse(getSetting(CHECKPOINT_KEY, 'null'));
      return value && typeof value === 'object' && value.nextUrl ? value : null;
    } catch {
      return null;
    }
  }

  function save(checkpoint) {
    setSetting(CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      nextUrl: String(checkpoint.nextUrl || ''),
      nextIndex: Math.max(0, Number(checkpoint.nextIndex || 0)),
      total: Math.max(0, Number(checkpoint.total || 0)),
      totals: checkpoint.totals || null,
      startedAt: checkpoint.startedAt || nowIso(),
      status: checkpoint.status || 'running',
      updatedAt: nowIso(),
    }));
  }

  function clear() {
    withBusyRetry(() => db.prepare('DELETE FROM app_settings WHERE key = ?').run(CHECKPOINT_KEY));
  }

  function fallback() {
    const status = getSetting('last_rescan_all_status', '');
    if (status !== 'error' && status !== 'stopped' && status !== 'paused') return null;
    const startedAt = getSetting('last_rescan_all_started_at', '') || nowIso();
    const failed = db.prepare(`
      SELECT model_url AS modelUrl
      FROM import_errors
      WHERE model_url IS NOT NULL AND model_url != ''
      ORDER BY id DESC
      LIMIT 1
    `).get();
    if (failed?.modelUrl) {
      return {
        version: 1,
        nextUrl: failed.modelUrl,
        nextIndex: 0,
        total: 0,
        totals: null,
        startedAt,
        status,
        recovered: true,
      };
    }

    const payload = getSourceUrls();
    const checkedByUrl = new Map(db.prepare(`
      SELECT model_urls.source_url AS sourceUrl, models.last_checked_at AS lastCheckedAt
      FROM model_urls
      JOIN models ON models.id = model_urls.model_id
    `).all().map(row => {
      try {
        return [canonicalRemoteUrl(row.sourceUrl), row.lastCheckedAt || ''];
      } catch {
        return [row.sourceUrl, row.lastCheckedAt || ''];
      }
    }));
    const startedAtMs = Date.parse(startedAt) || 0;
    const nextIndex = payload.urls.findIndex(sourceUrl => {
      let key = sourceUrl;
      try {
        key = canonicalRemoteUrl(sourceUrl);
      } catch {
        // Use the stored URL as-is.
      }
      const checkedAtMs = Date.parse(checkedByUrl.get(key) || '') || 0;
      return checkedAtMs < startedAtMs;
    });
    if (nextIndex < 0) return null;
    return {
      version: 1,
      nextUrl: payload.urls[nextIndex],
      nextIndex,
      total: payload.urls.length,
      totals: {
        models: payload.urls.length,
        modelsChecked: nextIndex,
      },
      startedAt,
      status,
      recovered: true,
    };
  }

  function resumable() {
    const checkpoint = load();
    if (checkpoint) return checkpoint;
    const recovered = fallback();
    if (!recovered) return null;
    save(recovered);
    return load();
  }

  return { metadata, recordStarted, recordFinished, load, save, clear, fallback, resumable };
}

module.exports = { CHECKPOINT_KEY, createRescanCheckpoints };
