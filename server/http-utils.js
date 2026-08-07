'use strict';

function readRequestBody(req, limitBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body) > limitBytes) {
        rejected = true;
        req.pause();
        reject(new Error('Request body too large.'));
      }
    });
    req.on('end', () => {
      if (!rejected) resolve(body);
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
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

module.exports = {
  readRequestBody,
  sendJson,
};
