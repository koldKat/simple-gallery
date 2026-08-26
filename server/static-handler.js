'use strict';

const fs = require('fs');
const path = require('path');

function createStaticHandler(ctx) {
  const {
    requestUrl,
    isLocalhostRequest,
    mediaUrlPrefix,
    mediaRoot,
    publicRoot,
    thumbDirectory,
    mimeTypes,
    markForegroundActivity,
  } = ctx;
  const fileSystem = ctx.fileSystem || fs;
  const maxConcurrentReads = Math.max(1, Number(ctx.maxConcurrentReads) || 128);
  const maxQueuedReads = Math.max(maxConcurrentReads, Number(ctx.maxQueuedReads) || 1024);
  const logError = ctx.logError || console.error;
  const readQueue = [];
  let activeReads = 0;

  function isFileCapacityError(error) {
    return error?.code === 'EMFILE' || error?.code === 'ENFILE';
  }

  function sendUnavailable(res) {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '1',
    });
    res.end('Server is busy. Please retry.');
  }

  function pumpReads() {
    while (activeReads < maxConcurrentReads && readQueue.length) {
      const entry = readQueue.shift();
      if (entry.cancel && typeof entry.res.off === 'function') entry.res.off('close', entry.cancel);
      if (entry.res.destroyed || entry.res.writableEnded) continue;
      activeReads += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeReads = Math.max(0, activeReads - 1);
        queueMicrotask(pumpReads);
      };
      try {
        entry.work(release);
      } catch (error) {
        logError(`[static] Failed to start file response: ${error.message}`);
        sendUnavailable(entry.res);
        release();
      }
    }
  }

  function queueRead(res, work) {
    for (let index = readQueue.length - 1; index >= 0; index -= 1) {
      if (readQueue[index].res.destroyed || readQueue[index].res.writableEnded) readQueue.splice(index, 1);
    }
    if (readQueue.length >= maxQueuedReads) {
      sendUnavailable(res);
      return;
    }
    const entry = { res, work, cancel: null };
    if (typeof res.once === 'function') {
      entry.cancel = () => {
        const index = readQueue.indexOf(entry);
        if (index >= 0) readQueue.splice(index, 1);
      };
      res.once('close', entry.cancel);
    }
    readQueue.push(entry);
    pumpReads();
  }

  return function serveStatic(req, res) {
    const url = requestUrl(req);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Malformed URL');
      return;
    }
    const requested = decodedPath === '/' ? '/index.html' : decodedPath;

    if ((requested === '/admin.html' || requested === '/js/admin.js') && !isLocalhostRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Admin is only available from localhost.');
      return;
    }

    const mediaPrefix = mediaUrlPrefix();
    const isMediaRequest = requested.startsWith(`${mediaPrefix}/`);
    const basePath = path.resolve(isMediaRequest ? mediaRoot() : publicRoot);
    const relativeRequest = isMediaRequest ? requested.slice(mediaPrefix.length) : requested;
    const filePath = path.resolve(basePath, `.${relativeRequest}`);

    if (filePath !== basePath && !filePath.startsWith(`${basePath}${path.sep}`)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    queueRead(res, release => {
      fileSystem.stat(filePath, (error, stat) => {
        if (error || !stat.isFile()) {
          if (isFileCapacityError(error)) {
            logError(`[static] File descriptor capacity reached while reading ${filePath}.`);
            sendUnavailable(res);
          } else if (!res.writableEnded && !res.destroyed) {
            res.writeHead(404);
            res.end('Not found');
          }
          release();
          return;
        }
        if (res.destroyed || res.writableEnded) {
          release();
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const immutable = requested.includes(`/${thumbDirectory}/`);
        const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
        const etag = `"${stat.size}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
        markForegroundActivity(requested);
        const headers = {
          'content-type': mimeTypes[ext] || 'application/octet-stream',
          'cache-control': cacheControl,
          etag,
        };
        if (!immutable && req.headers?.['if-none-match'] === etag) {
          res.writeHead(304, headers);
          res.end();
          release();
          return;
        }

        let stream;
        try {
          stream = fileSystem.createReadStream(filePath);
        } catch (streamError) {
          logError(`[static] Failed to open ${filePath}: ${streamError.message}`);
          sendUnavailable(res);
          release();
          return;
        }

        stream.once('error', streamError => {
          logError(`[static] Failed to stream ${filePath}: ${streamError.message}`);
          if (!res.headersSent) sendUnavailable(res);
          else if (!res.destroyed && typeof res.destroy === 'function') res.destroy();
        });
        stream.once('close', release);
        stream.once('open', () => {
          if (res.destroyed || res.writableEnded) {
            stream.destroy();
            return;
          }
          res.writeHead(200, { ...headers, 'content-length': stat.size });
          stream.pipe(res);
        });
        if (typeof res.once === 'function') {
          res.once('close', () => {
            if (!stream.destroyed) stream.destroy();
          });
        }
      });
    });
  };
}

module.exports = { createStaticHandler };
