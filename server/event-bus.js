'use strict';

function createServerEventBus({
  isWorker,
  sendWorkerMessage,
  getStateNotice,
  getViewStats,
  throttleMs = 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  heartbeatMs = 25000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const clients = new Set();
  let scannedUrlsTimer = null;
  let pendingScannedUrls = null;
  let viewStatsTimer = null;
  let heartbeatTimer = null;

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat() {
    if (isWorker || heartbeatTimer || !clients.size) return;
    heartbeatTimer = setIntervalFn(() => {
      for (const response of clients) writeToClient(response, ': keep-alive\n\n');
      if (!clients.size) stopHeartbeat();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function removeClient(response) {
    clients.delete(response);
    if (!clients.size) stopHeartbeat();
  }

  function writeToClient(response, body) {
    if (!response || response.destroyed || response.writableEnded) {
      removeClient(response);
      return false;
    }
    try {
      response.write(body);
      return true;
    } catch {
      // A browser or reverse proxy may close an SSE connection between events.
      // It must not be allowed to interrupt unrelated API requests.
      removeClient(response);
      return false;
    }
  }

  function broadcast(event, payload) {
    if (isWorker) {
      sendWorkerMessage({ type: 'event', event, payload });
      return;
    }
    const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) writeToClient(response, body);
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    clients.add(res);
    startHeartbeat();
    writeToClient(res, `event: state\ndata: ${JSON.stringify(getStateNotice())}\n\n`);
    req.on('close', () => removeClient(res));
    res.on?.('close', () => removeClient(res));
    res.on?.('error', () => removeClient(res));
  }

  function scheduleScannedUrls(payload) {
    pendingScannedUrls = payload;
    if (scannedUrlsTimer) return;
    scannedUrlsTimer = setTimer(() => {
      scannedUrlsTimer = null;
      if (!pendingScannedUrls) return;
      const nextPayload = pendingScannedUrls;
      pendingScannedUrls = null;
      broadcast('scanned-urls', nextPayload);
    }, throttleMs);
  }

  function scheduleViewStats() {
    if (viewStatsTimer) return;
    viewStatsTimer = setTimer(() => {
      viewStatsTimer = null;
      broadcast('view-stats', getViewStats());
    }, throttleMs);
  }

  function close() {
    if (scannedUrlsTimer) clearTimer(scannedUrlsTimer);
    if (viewStatsTimer) clearTimer(viewStatsTimer);
    stopHeartbeat();
    scannedUrlsTimer = null;
    viewStatsTimer = null;
    pendingScannedUrls = null;
    for (const response of clients) {
      try {
        writeToClient(response, 'event: close\ndata: {"message":"Server shutting down."}\n\n');
        response.end();
      } catch {
        // Ignore stale event clients during shutdown.
      }
    }
    clients.clear();
  }

  return { broadcast, close, handleEvents, scheduleScannedUrls, scheduleViewStats };
}

module.exports = { createServerEventBus };
