'use strict';

const path = require('path');

function createGalleryTransfer({
  mapLimit,
  fetchText,
  extractLargeImageUrl,
  downloadImage,
  sanitizeFileBase,
  concurrency,
  shouldPause,
  foregroundPauseMs,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  async function pauseForForegroundBrowsing() {
    if (shouldPause()) await wait(foregroundPauseMs);
  }

  async function resolveImageUrls(detailUrls) {
    await pauseForForegroundBrowsing();
    const resolved = await mapLimit(detailUrls, concurrency, async (detailUrl, index) => {
      try {
        const detailHtml = await fetchText(detailUrl);
        const imageUrl = extractLargeImageUrl(detailHtml, detailUrl);
        if (!imageUrl) {
          return { ok: false, index, detailUrl, message: `No large image found for ${detailUrl}` };
        }
        return { ok: true, index, detailUrl, imageUrl };
      } catch (error) {
        return {
          ok: false,
          index,
          detailUrl,
          message: error.message || 'Failed to resolve image URL.',
        };
      }
    });
    return {
      successes: resolved.filter(item => item?.ok && item.imageUrl),
      failures: resolved.filter(item => !item?.ok),
    };
  }

  async function downloadImages(items, galleryPath, title, onProgress = null) {
    const downloaded = [];
    const failures = [];
    await pauseForForegroundBrowsing();
    await mapLimit(items, concurrency, async (item, index) => {
      const fileBase = path.join(galleryPath, String(index).padStart(2, '0'));
      const outPathBase = `${fileBase}-${sanitizeFileBase(title)}`;
      try {
        const outPath = await downloadImage(item.imageUrl, outPathBase, {
          referer: item.referer || '',
          allowedHosts: item.allowedHosts || [],
        });
        downloaded.push({ ...item, outPath });
        if (onProgress) onProgress(downloaded.length, items.length);
      } catch (error) {
        failures.push({ ...item, message: error.message || 'Image download failed.' });
      }
    });
    downloaded.sort((a, b) => a.index - b.index);
    failures.sort((a, b) => a.index - b.index);
    return { downloaded, failures };
  }

  return { pauseForForegroundBrowsing, resolveImageUrls, downloadImages };
}

module.exports = { createGalleryTransfer };
