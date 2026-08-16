'use strict';

function createDatabaseHousekeeping({
  db,
  retentionMs,
  isWorker,
  now = () => Date.now(),
  intervalMs = 60 * 60 * 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console,
}) {
  let timer = null;

  function run(reason = 'scheduled') {
    const cutoff = new Date(now() - retentionMs).toISOString();
    const current = new Date(now()).toISOString();
    const dedupe = db.prepare('DELETE FROM view_dedupe WHERE last_counted_at < ?').run(cutoff).changes;
    const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(current).changes;
    if (dedupe || sessions || reason === 'startup') {
      log.log(`[db-cleanup] ${reason}: removed ${dedupe} old view dedupe rows, ${sessions} expired sessions.`);
    }
    return { dedupe, sessions };
  }

  function schedule() {
    if (isWorker) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      try {
        run('scheduled');
      } catch (error) {
        log.error(`[db-cleanup] Scheduled cleanup failed: ${error?.message || error}`);
      }
      schedule();
    }, intervalMs);
  }

  function stop() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  return { run, schedule, stop };
}

module.exports = { createDatabaseHousekeeping };
