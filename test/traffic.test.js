'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIpForRequest, createTrafficService, estimateRequestBytes } = require('../server/traffic');

function request({ ip = '127.0.0.1', forwarded = '', bytesWritten = 0, url = '/', contentLength = 0 } = {}) {
  const headers = contentLength ? { 'content-length': String(contentLength) } : {};
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  return {
    method: contentLength ? 'POST' : 'GET',
    url,
    httpVersion: '1.1',
    headers,
    rawHeaders: Object.entries(headers).flat(),
    socket: { remoteAddress: ip, bytesWritten },
  };
}

test('request byte estimation includes request line, headers, and declared body', () => {
  const req = request({ url: '/api/test', contentLength: 25 });
  const expected = Buffer.byteLength('POST /api/test HTTP/1.1\r\ncontent-length: 25\r\n\r\n') + 25;
  assert.equal(estimateRequestBytes(req), expected);
  assert.equal(clientIpForRequest(request({ ip: '::ffff:127.0.0.1' })), '127.0.0.1');
  assert.equal(clientIpForRequest(request({ forwarded: '203.0.113.5, 10.0.0.1' })), '203.0.113.5');
});

test('traffic service hydrates, records local and remote totals, and persists on cadence', () => {
  const stored = {
    traffic_local_in: '10',
    traffic_local_out: '20',
    traffic_remote_in: '30',
    traffic_remote_out: '40',
    traffic_remote_countries: JSON.stringify({ CA: { inBytes: 5, outBytes: 7 } }),
  };
  const writes = [];
  const service = createTrafficService({
    getSetting: (key, fallback) => stored[key] ?? fallback,
    setSetting: (key, value) => writes.push([key, value]),
    geoLookup: ip => ip === '203.0.113.5' ? { country: 'US' } : null,
    isWorker: false,
    flushEvery: 2,
  });
  service.load();

  const localReq = request({ bytesWritten: 100, url: '/local' });
  const localRes = new EventEmitter();
  service.track(localReq, localRes, true);
  localReq.socket.bytesWritten = 250;
  localRes.emit('finish');

  const remoteReq = request({ forwarded: '203.0.113.5', bytesWritten: 500, url: '/remote' });
  const remoteRes = new EventEmitter();
  service.track(remoteReq, remoteRes, false);
  remoteReq.socket.bytesWritten = 725;
  remoteRes.emit('finish');

  const snapshot = service.snapshot();
  assert.equal(snapshot.trafficLocalOutBytes, 170);
  assert.equal(snapshot.trafficRemoteOutBytes, 265);
  assert.equal(snapshot.remoteCountryTraffic[0].country, 'US');
  assert.equal(snapshot.remoteCountryTraffic.find(item => item.country === 'CA').totalBytes, 12);
  assert.deepEqual(writes.map(([key]) => key), [
    'traffic_in',
    'traffic_out',
    'traffic_local_in',
    'traffic_local_out',
    'traffic_remote_in',
    'traffic_remote_out',
    'traffic_remote_countries',
  ]);
  assert.match(writes.at(-1)[1], /"US"/);
});

test('worker traffic snapshots remain in memory without persistence', () => {
  let writes = 0;
  const service = createTrafficService({
    getSetting: (_key, fallback) => fallback,
    setSetting: () => { writes += 1; },
    geoLookup: () => null,
    isWorker: true,
    flushEvery: 1,
  });
  const req = request();
  const res = new EventEmitter();
  service.track(req, res, true);
  res.emit('finish');
  service.flush();
  assert.equal(service.snapshot().trafficLocalInBytes, estimateRequestBytes(req));
  assert.equal(writes, 0);
});
