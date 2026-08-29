'use strict';

function readRequestBuffer(req, limitBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limitBytes) {
        rejected = true;
        req.pause();
        reject(new Error('Request body too large.'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks, size));
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function readRequestBody(req, limitBytes = 1024 * 64) {
  return readRequestBuffer(req, limitBytes).then(buffer => buffer.toString('utf8'));
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendHtml(res, statusCode, html) {
  sendText(res, statusCode, html, 'text/html; charset=utf-8');
}

module.exports = {
  readRequestBody,
  readRequestBuffer,
  sendHtml,
  sendJson,
  sendText,
};
