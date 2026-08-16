'use strict';

function estimateRequestBytes(req) {
  const method = String(req.method || 'GET');
  const url = String(req.url || '/');
  const version = String(req.httpVersion || '1.1');
  let total = Buffer.byteLength(`${method} ${url} HTTP/${version}\r\n`);
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index] || '');
    const value = String(rawHeaders[index + 1] || '');
    total += Buffer.byteLength(`${name}: ${value}\r\n`);
  }
  total += 2;
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > 0) total += contentLength;
  return total;
}

function clientIpForRequest(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || String(req.socket?.remoteAddress || '').trim();
  if (!raw) return '';
  return raw.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
}

function createTrafficService(options) {
  const {
    getSetting,
    setSetting,
    geoLookup,
    isWorker,
    flushEvery = 50,
  } = options;
  let localInBytes = 0;
  let localOutBytes = 0;
  let remoteInBytes = 0;
  let remoteOutBytes = 0;
  let remoteCountryBytes = new Map();
  let dirty = 0;

  function countryForRequest(req) {
    const ip = clientIpForRequest(req);
    if (!ip) return 'Unknown';
    const match = geoLookup(ip);
    return String(match?.country || 'Unknown').toUpperCase();
  }

  function snapshot() {
    return {
      trafficInBytes: Number((localInBytes || 0) + (remoteInBytes || 0)),
      trafficOutBytes: Number((localOutBytes || 0) + (remoteOutBytes || 0)),
      trafficLocalInBytes: Number(localInBytes || 0),
      trafficLocalOutBytes: Number(localOutBytes || 0),
      trafficRemoteInBytes: Number(remoteInBytes || 0),
      trafficRemoteOutBytes: Number(remoteOutBytes || 0),
      remoteCountryTraffic: Array.from(remoteCountryBytes.entries())
        .map(([country, totals]) => ({
          country,
          inBytes: Number(totals?.inBytes || 0),
          outBytes: Number(totals?.outBytes || 0),
          totalBytes: Number((totals?.inBytes || 0) + (totals?.outBytes || 0)),
        }))
        .sort((a, b) => b.totalBytes - a.totalBytes || a.country.localeCompare(b.country)),
    };
  }

  function flush() {
    if (isWorker) return;
    const totals = snapshot();
    setSetting('traffic_in', String(Math.max(0, totals.trafficInBytes)));
    setSetting('traffic_out', String(Math.max(0, totals.trafficOutBytes)));
    setSetting('traffic_local_in', String(Math.max(0, totals.trafficLocalInBytes)));
    setSetting('traffic_local_out', String(Math.max(0, totals.trafficLocalOutBytes)));
    setSetting('traffic_remote_in', String(Math.max(0, totals.trafficRemoteInBytes)));
    setSetting('traffic_remote_out', String(Math.max(0, totals.trafficRemoteOutBytes)));
    setSetting('traffic_remote_countries', JSON.stringify(Object.fromEntries(remoteCountryBytes.entries())));
  }

  function load() {
    localInBytes = Number(getSetting('traffic_local_in', '0')) || 0;
    localOutBytes = Number(getSetting('traffic_local_out', '0')) || 0;
    remoteInBytes = Number(getSetting('traffic_remote_in', '0')) || 0;
    remoteOutBytes = Number(getSetting('traffic_remote_out', '0')) || 0;
    try {
      const raw = JSON.parse(getSetting('traffic_remote_countries', '{}'));
      remoteCountryBytes = new Map(Object.entries(raw || {}).map(([country, totals]) => [country, {
        inBytes: Number(totals?.inBytes || 0),
        outBytes: Number(totals?.outBytes || 0),
      }]));
    } catch {
      remoteCountryBytes = new Map();
    }
  }

  function track(req, res, isLocal) {
    const country = isLocal ? null : countryForRequest(req);
    const requestIn = estimateRequestBytes(req);
    const startOut = Number(req.socket?.bytesWritten || 0);
    res.on('finish', () => {
      const responseOut = Math.max(0, Number(req.socket?.bytesWritten || 0) - startOut);
      if (isLocal) {
        localInBytes += Math.max(0, requestIn);
        localOutBytes += responseOut;
      } else {
        remoteInBytes += Math.max(0, requestIn);
        remoteOutBytes += responseOut;
        const current = remoteCountryBytes.get(country || 'Unknown') || { inBytes: 0, outBytes: 0 };
        current.inBytes += Math.max(0, requestIn);
        current.outBytes += responseOut;
        remoteCountryBytes.set(country || 'Unknown', current);
      }
      dirty += 1;
      if (dirty >= flushEvery) {
        dirty = 0;
        flush();
      }
    });
  }

  return { flush, load, snapshot, track };
}

module.exports = { clientIpForRequest, createTrafficService, estimateRequestBytes };
