'use strict';

function createServerEventBus({
  isWorker,
  sendWorkerMessage,
  getStateNotice,
  getViewStats,
  throttleMs = 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const clients = new Set();
  let scannedUrlsTimer = null;
  let pendingScannedUrls = null;
  let viewStatsTimer = null;

  function broadcast(event, payload) {
    if (isWorker) {
      sendWorkerMessage({ type: 'event', event, payload });
      return;
    }
    const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) response.write(body);
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`event: state\ndata: ${JSON.stringify(getStateNotice())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
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
    scannedUrlsTimer = null;
    viewStatsTimer = null;
    pendingScannedUrls = null;
    for (const response of clients) {
      try {
        response.write('event: close\ndata: {"message":"Server shutting down."}\n\n');
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
