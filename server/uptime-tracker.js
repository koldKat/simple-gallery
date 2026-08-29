'use strict';

function createUptimeTracker({
  db,
  getSetting,
  setSetting,
  now = () => Date.now(),
  graceSeconds = 15,
  heartbeatIntervalMs = 10000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = message => console.warn(message),
}) {
  const startedAt = Math.floor(now() / 1000);
  let heartbeatTimer = null;
  let birthAt = null;

  function numericSetting(key) {
    return Number(getSetting(key, '0')) || 0;
  }

  function appBirthAt() {
    const quoteIdentifier = value => `"${String(value).replace(/"/g, '""')}"`;
    const timestampColumns = new Set([
      'created_at', 'updated_at', 'seen_at', 'imported_at', 'first_viewed_at',
      'last_viewed_at', 'last_seen_at', 'last_counted_at',
    ]);
    const selects = [];
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all();
    for (const table of tables) {
      const tableName = quoteIdentifier(table.name);
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
      for (const column of columns) {
        if (!timestampColumns.has(String(column.name).toLowerCase())) continue;
        const columnName = quoteIdentifier(column.name);
        selects.push(`SELECT CAST(strftime('%s', ${columnName}) AS INTEGER) AS timestamp FROM ${tableName}`);
      }
    }
    if (!selects.length) return startedAt;
    const row = db.prepare(`
      SELECT MIN(timestamp) AS timestamp FROM (${selects.join(' UNION ALL ')})
      WHERE timestamp > 0
    `).get();
    const timestamp = Number(row?.timestamp) || 0;
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : startedAt;
  }

  function updateHeartbeat() {
    try {
      setSetting('server_last_heartbeat', String(Math.floor(now() / 1000)));
      return true;
    } catch (error) {
      log(`[uptime] Heartbeat write failed: ${error.message || error}`);
      return false;
    }
  }

  function initialize() {
    try {
      const stoppedAt = numericSetting('server_stopped_at');
      const lastHeartbeat = numericSetting('server_last_heartbeat');
      const reference = stoppedAt || lastHeartbeat;
      const gap = reference > 0 ? Math.max(0, startedAt - reference) : 0;
      if (gap > graceSeconds) {
        setSetting('server_total_downtime_s', String(numericSetting('server_total_downtime_s') + gap - graceSeconds));
        setSetting('server_session_start_at', String(startedAt - graceSeconds));
      } else if (!numericSetting('server_session_start_at')) {
        setSetting('server_session_start_at', String(startedAt));
      }
      setSetting('server_stopped_at', '0');
      updateHeartbeat();
      return true;
    } catch (error) {
      log(`[uptime] Initialization write failed: ${error.message || error}`);
      return false;
    }
  }

  function start() {
    initialize();
    if (heartbeatTimer) return;
    heartbeatTimer = setIntervalFn(updateHeartbeat, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function stop() {
    if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
    try {
      setSetting('server_stopped_at', String(Math.floor(now() / 1000)));
    } catch (error) {
      log(`[uptime] Stop marker write failed: ${error.message || error}`);
    }
  }

  function stats() {
    const current = Math.floor(now() / 1000);
    if (!birthAt) birthAt = appBirthAt();
    const appAgeSeconds = Math.max(0, current - birthAt);
    const downtimeSeconds = numericSetting('server_total_downtime_s');
    const sessionStartAt = numericSetting('server_session_start_at') || startedAt;
    return {
      appAgeSeconds,
      sessionUptimeSeconds: Math.max(0, current - sessionStartAt),
      downtimeSeconds,
      uptimePercent: appAgeSeconds
        ? Math.max(0, Math.min(100, Math.round(((appAgeSeconds - downtimeSeconds) / appAgeSeconds) * 10000) / 100))
        : 100,
    };
  }

  return { start, stop, stats, initialize, updateHeartbeat };
}

module.exports = { createUptimeTracker };
