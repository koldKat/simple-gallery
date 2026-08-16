'use strict';

function createSourceModelLoader({
  requireSourceProfile,
  validateSourceUrl,
  fetchText,
  extractPaginationUrls,
  extractModelLinks,
  canonicalPageUrl,
  canonicalRemoteUrl,
  loadImportDb,
  readDirs,
  mediaRoot,
  normalizeModelName,
  sanitizeFolderName,
  broadcast,
  nowIso,
}) {
  let loadedList = null;
  let removalBroadcastCount = 0;

  function knownImportedModelUrls(importDb = loadImportDb()) {
    const profile = requireSourceProfile();
    const urls = new Set();
    for (const url of importDb.scannedUrls || []) {
      try {
        const canonical = canonicalRemoteUrl(url);
        const parsed = new URL(canonical);
        if (parsed.pathname.startsWith(`/${profile.modelPathSegment}/`)) urls.add(canonical);
      } catch {
        // Ignore malformed older values.
      }
    }
    for (const record of Object.values(importDb.models || {})) {
      for (const url of record.modelUrls || []) {
        try {
          urls.add(canonicalRemoteUrl(url));
        } catch {
          // Ignore malformed older values.
        }
      }
    }
    return urls;
  }

  function knownLocalModelFolders() {
    return new Set(readDirs(mediaRoot()));
  }

  function isKnownModel(model, knownUrls, knownFolders) {
    const profile = requireSourceProfile();
    if (knownUrls.has(canonicalRemoteUrl(model.sourceUrl))) return true;
    try {
      const parts = new URL(model.sourceUrl).pathname.split('/').filter(Boolean);
      if (parts[0]?.toLowerCase() === profile.modelPathSegment.toLowerCase() && parts[1]) {
        return knownFolders.has(sanitizeFolderName(normalizeModelName(decodeURIComponent(parts[1]))));
      }
    } catch {
      // Fall through to the display name.
    }
    return knownFolders.has(sanitizeFolderName(model.name));
  }

  async function load(sourceUrl, options = {}) {
    const profile = requireSourceProfile();
    validateSourceUrl(sourceUrl, profile.modelListPath, profile.modelListExample);

    const firstHtml = await fetchText(sourceUrl);
    const pageUrls = [];
    const queuedPageUrls = extractPaginationUrls(firstHtml, sourceUrl);
    const seenPageUrls = new Set();
    const allModels = new Map();

    for (const model of extractModelLinks(firstHtml, sourceUrl)) allModels.set(model.sourceUrl, model);
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        sourceUrl: canonicalPageUrl(sourceUrl),
        pageCount: pageUrls.length,
        pagesSeen: 1,
        modelsFound: allModels.size,
        completed: false,
      });
    }

    while (queuedPageUrls.length) {
      const pageUrl = queuedPageUrls.shift();
      if (seenPageUrls.has(pageUrl)) continue;
      seenPageUrls.add(pageUrl);
      pageUrls.push(pageUrl);
      if (pageUrl === canonicalPageUrl(sourceUrl)) continue;

      const html = await fetchText(pageUrl);
      for (const model of extractModelLinks(html, pageUrl)) allModels.set(model.sourceUrl, model);
      for (const discoveredPageUrl of extractPaginationUrls(html, pageUrl)) {
        if (!seenPageUrls.has(discoveredPageUrl) && !queuedPageUrls.includes(discoveredPageUrl)) {
          queuedPageUrls.push(discoveredPageUrl);
        }
      }
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          sourceUrl: canonicalPageUrl(sourceUrl),
          pageCount: Math.max(pageUrls.length + queuedPageUrls.length, pageUrls.length),
          pagesSeen: pageUrls.length,
          modelsFound: allModels.size,
          completed: false,
        });
      }
    }

    const allModelsSorted = Array.from(allModels.values()).sort((a, b) => a.name.localeCompare(b.name));
    const knownUrls = options.missingOnly ? knownImportedModelUrls() : new Set();
    const knownFolders = options.missingOnly ? knownLocalModelFolders() : new Set();
    const models = options.missingOnly
      ? allModelsSorted.filter(model => !isKnownModel(model, knownUrls, knownFolders))
      : allModelsSorted;

    loadedList = {
      sourceUrl: canonicalPageUrl(sourceUrl),
      loadedAt: nowIso(),
      pageCount: pageUrls.length,
      totalFound: allModelsSorted.length,
      knownCount: allModelsSorted.length - models.length,
      missingOnly: Boolean(options.missingOnly),
      models,
    };
    removalBroadcastCount = 0;
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        sourceUrl: canonicalPageUrl(sourceUrl),
        pageCount: pageUrls.length,
        pagesSeen: pageUrls.length,
        modelsFound: allModelsSorted.length,
        completed: true,
      });
    }
    return loadedList;
  }

  function remove(sourceUrl, modelName = '') {
    if (!loadedList?.models?.length) return;
    const canonicalSourceUrl = sourceUrl ? canonicalRemoteUrl(sourceUrl) : '';
    const before = loadedList.models.length;
    loadedList.models = loadedList.models.filter(model => {
      try {
        if (canonicalSourceUrl && canonicalRemoteUrl(model.sourceUrl) === canonicalSourceUrl) return false;
      } catch {
        // Keep malformed loaded entries instead of interrupting the import.
      }
      if (modelName && model.name === modelName) return false;
      return true;
    });
    if (loadedList.models.length === before) return;
    removalBroadcastCount += 1;
    if (removalBroadcastCount === 1 || removalBroadcastCount % 10 === 0 || !loadedList.models.length) {
      broadcast('loaded-models', loadedList);
    }
  }

  function broadcastLoaded() {
    if (loadedList) broadcast('loaded-models', loadedList);
  }

  function set(value) {
    loadedList = value || null;
    removalBroadcastCount = 0;
  }

  return {
    load,
    get: () => loadedList,
    set,
    remove,
    broadcast: broadcastLoaded,
  };
}

module.exports = { createSourceModelLoader };
