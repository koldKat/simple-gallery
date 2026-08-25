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

    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
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
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': stat.size });
      fs.createReadStream(filePath).pipe(res);
    });
  };
}

module.exports = { createStaticHandler };
