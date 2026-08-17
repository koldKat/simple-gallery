'use strict';

const fs = require('fs');
const path = require('path');

function fetchErrorMessage(error) {
  const cause = error?.cause;
  const detail = [
    error?.status ? `HTTP ${error.status}` : '',
    cause?.code,
    cause?.name && cause.name !== 'Error' ? cause.name : '',
    cause?.message,
  ].filter(Boolean).join(': ');
  return detail ? `${error.message} (${detail})` : error.message;
}

function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const atMs = Date.parse(raw);
  if (!Number.isNaN(atMs)) return Math.max(0, atMs - now);
  return 0;
}

function assertAllowedRemoteUrl(remoteUrl, allowedHosts, label) {
  if (!allowedHosts.length) return;
  const parsed = new URL(remoteUrl);
  const host = parsed.hostname.toLowerCase();
  const allowed = ['http:', 'https:'].includes(parsed.protocol)
    && allowedHosts.some(value => host === value || host.endsWith(`.${value}`));
  if (!allowed) throw new Error(`${label} uses an unapproved URL: ${parsed.origin}`);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function createImportNetwork({
  getSourceProfile,
  mkdirp,
  imageExtensions,
  retries,
  timeoutMs,
  backoffBaseMs,
  backoffMaxMs,
  fetchImpl = (...args) => fetch(...args),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
  now = () => Date.now(),
}) {
  function retryDelayMs(attempt, error) {
    if (error?.status === 429) {
      const headerDelay = parseRetryAfterMs(error.retryAfter, now());
      if (headerDelay > 0) return Math.min(headerDelay, backoffMaxMs);
    }
    const baseDelay = Math.min(backoffBaseMs * (2 ** Math.max(0, attempt - 1)), backoffMaxMs);
    return baseDelay + Math.floor(random() * 400);
  }

  async function fetchWithRetry(remoteUrl, options, label) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(remoteUrl, { ...options, signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) {
          const error = new Error(`${label} failed ${response.status} for ${remoteUrl}`);
          error.status = response.status;
          error.retryAfter = response.headers.get('retry-after') || '';
          throw error;
        }
        return response;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (attempt > retries) break;
        await sleep(retryDelayMs(attempt, error));
      }
    }
    throw new Error(`${label} failed after ${retries + 1} attempts for ${remoteUrl}: ${fetchErrorMessage(lastError)}`);
  }

  async function fetchText(remoteUrl, options = {}) {
    const allowedHosts = Array.isArray(options.allowedHosts)
      ? options.allowedHosts.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    assertAllowedRemoteUrl(remoteUrl, allowedHosts, 'Page fetch');
    const response = await fetchWithRetry(remoteUrl, {
      headers: {
        'user-agent': 'SimpleGalleryImporter/1.0',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    }, 'Fetch');
    assertAllowedRemoteUrl(response.url || remoteUrl, allowedHosts, 'Page fetch redirect');
    return response.text();
  }

  function extensionFromResponse(remoteUrl, response) {
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType === 'image/jpeg') return '.jpg';
    if (contentType === 'image/png') return '.png';
    if (contentType === 'image/webp') return '.webp';
    if (contentType === 'image/gif') return '.gif';
    const extension = path.extname(new URL(remoteUrl).pathname).toLowerCase();
    return imageExtensions.has(extension) ? extension : '.jpg';
  }

  async function downloadImage(remoteUrl, outPathBase, options = {}) {
    const profile = getSourceProfile();
    const referer = String(options.referer || profile.referer || '').trim();
    const allowedHosts = Array.isArray(options.allowedHosts)
      ? options.allowedHosts.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    assertAllowedRemoteUrl(remoteUrl, allowedHosts, 'Image download');
    const response = await fetchWithRetry(remoteUrl, {
      headers: {
        'user-agent': 'SimpleGalleryImporter/1.0',
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        ...(referer ? { referer } : {}),
      },
      redirect: 'follow',
    }, 'Image download');
    if (allowedHosts.length) {
      assertAllowedRemoteUrl(response.url || remoteUrl, allowedHosts, 'Image download redirect');
    }
    const extension = extensionFromResponse(remoteUrl, response);
    const outPath = `${outPathBase}${extension}`;
    const buffer = Buffer.from(await response.arrayBuffer());
    mkdirp(path.dirname(outPath));
    fs.writeFileSync(outPath, buffer);
    return outPath;
  }

  return {
    sleep,
    fetchWithRetry,
    fetchText,
    extensionFromResponse,
    downloadImage,
    mapLimit,
  };
}

module.exports = {
  createImportNetwork,
  fetchErrorMessage,
  parseRetryAfterMs,
  assertAllowedRemoteUrl,
  mapLimit,
};
