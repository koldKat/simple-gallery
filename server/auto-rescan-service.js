'use strict';

function createAutoRescanService({
  getSetting,
  normalizeTime,
  parseWeekdays,
  nextWeeklyDate,
  allWeekdays,
  defaultTime,
  retryMs,
  isWorker,
  getActivity,
  requestWorker,
  broadcastState,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) {
  let timer = null;
  let nextAt = null;

  function normalizeScheduleTime(value) {
    return normalizeTime(value, defaultTime);
  }

  function scheduledDays() {
    const days = parseWeekdays(getSetting('auto_rescan_days', allWeekdays.join(',')));
    return days.length ? days : [...allWeekdays];
  }

  function enabled() {
    return getSetting('auto_rescan_enabled', '1') === '1';
  }

  function scheduledTime() {
    return normalizeScheduleTime(getSetting('auto_rescan_time', defaultTime));
  }

  function nextDate(timeValue, dayValues, from = now()) {
    return nextWeeklyDate(timeValue, dayValues, from, defaultTime);
  }

  function clearScheduledTimer() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(reason = 'settings') {
    clearScheduledTimer();
    if (isWorker) return;
    if (!enabled()) {
      nextAt = null;
      broadcastState();
      return;
    }
    const current = now();
    const next = nextDate(scheduledTime(), scheduledDays(), current);
    nextAt = next.toISOString();
    const delay = Math.max(1000, next.getTime() - current.getTime());
    timer = setTimer(() => run('daily'), delay);
    if (reason !== 'startup') broadcastState();
  }

  function scheduleRetry() {
    clearScheduledTimer();
    if (isWorker) return;
    const current = now();
    const next = new Date(current.getTime() + retryMs);
    nextAt = next.toISOString();
    timer = setTimer(() => run('retry'), retryMs);
    broadcastState();
  }

  async function run(trigger = 'daily') {
    timer = null;
    if (isWorker || !enabled()) {
      nextAt = null;
      return;
    }
    const activity = getActivity();
    if (activity.scanInFlight || activity.importActive) {
      logger.warn(`[auto-rescan] ${trigger} run deferred because a scan/import is already active.`);
      scheduleRetry();
      return;
    }
    try {
      logger.log(`[auto-rescan] Starting scheduled rescan all at ${now().toISOString()}.`);
      await requestWorker('rescan-all-start');
      schedule('post-run');
    } catch (error) {
      logger.error(`[auto-rescan] Scheduled rescan all failed: ${error?.message || error}`);
      schedule('error');
    }
  }

  function stop() {
    clearScheduledTimer();
    nextAt = null;
  }

  return {
    normalizeTime: normalizeScheduleTime,
    days: scheduledDays,
    nextDate,
    schedule,
    run,
    getNextAt: () => nextAt,
    stop,
  };
}

module.exports = { createAutoRescanService };
