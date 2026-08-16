'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function createThumbnailService({
  db,
  mediaRoot,
  mkdirp,
  fileSize,
  galleryDbId,
  thumbSize,
  concurrency,
  isWorker,
  getState,
  setState,
  runtimeStats,
  broadcast,
  stateNotice,
  shouldAutoRescan,
  scanLibrary,
  runConvert = execFile,
  stateBroadcastDelayMs = 500,
  rescanDelayMs = 500,
}) {
  const queue = [];
  const queued = new Set();
  let active = 0;
  let rescanTimer = null;
  let stateBroadcastTimer = null;
  let skipAutoRescan = false;
  let stopped = false;

  function needsThumb(sourcePath, thumbPath) {
    try {
      const sourceStat = fs.statSync(sourcePath);
      const thumbStat = fs.statSync(thumbPath);
      return thumbStat.size === 0 || thumbStat.mtimeMs < sourceStat.mtimeMs;
    } catch {
      return true;
    }
  }

  function createThumb(sourcePath, thumbPath) {
    return new Promise(resolve => {
      mkdirp(path.dirname(thumbPath));
      const tmpPath = `${thumbPath}.tmp-${process.pid}`;
      const args = [
        sourcePath,
        '-auto-orient',
        '-thumbnail',
        `${thumbSize}x${thumbSize}^`,
        '-gravity',
        'center',
        '-extent',
        `${thumbSize}x${thumbSize}`,
        '-strip',
        '-quality',
        '82',
        tmpPath,
      ];
      runConvert('convert', args, { timeout: 30000 }, error => {
        if (error) {
          fs.rm(tmpPath, { force: true }, () => resolve(false));
          return;
        }
        fs.rename(tmpPath, thumbPath, renameError => {
          if (renameError) {
            fs.rm(tmpPath, { force: true }, () => resolve(false));
            return;
          }
          resolve(true);
        });
      });
    });
  }

  function galleryPathPartsForFile(filePath) {
    const relative = path.relative(mediaRoot(), filePath);
    if (!relative || relative.startsWith('..')) return null;
    const parts = relative.split(path.sep);
    if (parts.length < 3) return null;
    return { modelId: parts[0], galleryName: parts[1] };
  }

  function scheduleStateBroadcast() {
    if (stateBroadcastTimer || stopped) return;
    stateBroadcastTimer = setTimeout(() => {
      stateBroadcastTimer = null;
      const state = getState();
      setState({
        ...state,
        totals: { ...(state.totals || {}) },
        runtime: runtimeStats(),
      });
      broadcast('state', stateNotice());
    }, stateBroadcastDelayMs);
  }

  function applyThumbDelta(sourcePath, previousSize, nextSize) {
    const parts = galleryPathPartsForFile(sourcePath);
    if (!parts) return;
    const delta = Number(nextSize || 0) - Number(previousSize || 0);
    const createdNewThumb = Number(previousSize || 0) <= 0 && Number(nextSize || 0) > 0;
    if (!delta && !createdNewThumb) return;

    const galleryId = galleryDbId(parts.modelId, parts.galleryName);
    if (galleryId) {
      db.prepare(`
        UPDATE galleries
        SET thumb_bytes = MAX(0, COALESCE(thumb_bytes, 0) + ?)
        WHERE id = ?
      `).run(delta, galleryId);
    }

    const state = getState();
    const model = (state.models || []).find(item => item.id === parts.modelId);
    const gallery = model?.galleries?.find(item => item.name === parts.galleryName);
    if (gallery) {
      gallery.thumbBytes = Math.max(0, Number(gallery.thumbBytes || 0) + delta);
      if (createdNewThumb) gallery.missingThumbs = Math.max(0, Number(gallery.missingThumbs || 0) - 1);
    }
    if (model?._totals) {
      model._totals.thumbBytes = Math.max(0, Number(model._totals.thumbBytes || 0) + delta);
      if (createdNewThumb) {
        model._totals.missingThumbs = Math.max(0, Number(model._totals.missingThumbs || 0) - 1);
        model._totals.thumbs = Number(model._totals.thumbs || 0) + 1;
      }
      model._totals.totalBytes = Number(model._totals.imageBytes || 0) + Number(model._totals.thumbBytes || 0);
    }

    state.totals.thumbBytes = Math.max(0, Number(state.totals.thumbBytes || 0) + delta);
    if (createdNewThumb) {
      state.totals.missingThumbs = Math.max(0, Number(state.totals.missingThumbs || 0) - 1);
      state.totals.thumbs = Number(state.totals.thumbs || 0) + 1;
    }
    state.totals.totalBytes = Number(state.totals.imageBytes || 0) + Number(state.totals.thumbBytes || 0);
    scheduleStateBroadcast();
  }

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      if (stopped) return;
      if (skipAutoRescan) {
        skipAutoRescan = false;
        return;
      }
      if (!isWorker && shouldAutoRescan()) scanLibrary();
    }, rescanDelayMs);
  }

  function processQueue() {
    while (!stopped && active < concurrency && queue.length) {
      const item = queue.shift();
      active += 1;
      createThumb(item.sourcePath, item.thumbPath)
        .then(created => {
          if (created) applyThumbDelta(item.sourcePath, item.previousSize, fileSize(item.thumbPath));
        })
        .finally(() => {
          active -= 1;
          queued.delete(item.key);
          processQueue();
          if (!active && !queue.length) scheduleRescan();
        });
    }
  }

  function enqueue(sourcePath, thumbPath) {
    if (stopped) return;
    const key = `${sourcePath}\n${thumbPath}`;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ key, sourcePath, thumbPath, previousSize: fileSize(thumbPath) });
    processQueue();
  }

  function skipNextAutoRescan() {
    skipAutoRescan = true;
  }

  function stop() {
    stopped = true;
    queue.length = 0;
    queued.clear();
    clearTimeout(rescanTimer);
    clearTimeout(stateBroadcastTimer);
    rescanTimer = null;
    stateBroadcastTimer = null;
  }

  return { needsThumb, enqueue, skipNextAutoRescan, stop };
}

module.exports = { createThumbnailService };
