export function createImagePreloader(options) {
  const {
    getState,
    getPreferences,
    getCurrentModel,
    getCurrentGallery,
    fetchGalleryPayload,
    clearGalleryCache,
    onProgress,
    createImage = () => new Image(),
    isImage = image => image instanceof HTMLImageElement,
    concurrency = 3,
    decodeCacheLimit = 12,
    decodeAhead = 8,
    decodeBehind = 3,
  } = options;
  let queue = [];
  let queuedKeys = new Set();
  let activeCount = 0;
  let imagesInFlight = new Set();
  let preloadedImages = new Map();
  let decodedImages = new Map();
  let decodeInflight = new Map();
  let scopeKey = null;
  let scopeVersion = 0;
  let progress = { total: 0, completed: 0 };

  function notifyProgress() {
    onProgress({ ...progress });
  }

  function releaseImage(image) {
    if (!isImage(image)) return;
    image.onload = null;
    image.onerror = null;
    image.src = '';
  }

  function cancelInFlight() {
    for (const abort of imagesInFlight) {
      try { abort(); } catch {}
    }
    imagesInFlight.clear();
  }

  function rememberPreloaded(url, image) {
    if (!url || !isImage(image)) return;
    const existing = preloadedImages.get(url);
    if (existing && existing !== image) releaseImage(existing);
    preloadedImages.delete(url);
    preloadedImages.set(url, image);
  }

  function rememberDecoded(url, image) {
    if (!url || !isImage(image)) return;
    const existing = decodedImages.get(url);
    if (existing && existing !== image) releaseImage(existing);
    decodedImages.delete(url);
    decodedImages.set(url, image);
    while (decodedImages.size > decodeCacheLimit) {
      const [oldUrl, oldImage] = decodedImages.entries().next().value || [];
      if (!oldUrl) break;
      decodedImages.delete(oldUrl);
      releaseImage(oldImage);
    }
  }

  function rememberDecodedImage(url, image) {
    rememberDecoded(url, image);
  }

  function releaseLightboxDecodedCache() {
    for (const image of decodeInflight.values()) releaseImage(image);
    decodeInflight = new Map();
    for (const image of decodedImages.values()) releaseImage(image);
    decodedImages = new Map();
  }

  function releaseAllImages() {
    for (const image of preloadedImages.values()) releaseImage(image);
    preloadedImages = new Map();
    releaseLightboxDecodedCache();
  }

  function resetScope(nextScopeKey = null) {
    cancelInFlight();
    releaseAllImages();
    scopeKey = nextScopeKey || null;
    scopeVersion += 1;
    clearGalleryCache();
    queue = [];
    queuedKeys = new Set();
    progress = { total: 0, completed: 0 };
    notifyProgress();
  }

  function syncScope() {
    const state = getState();
    let nextScopeKey = null;
    if (state.mode === 'model' && state.selectedModel) {
      const prefs = getPreferences();
      if (prefs.preloadModel) {
        nextScopeKey = `model-preload:${state.selectedModel}`;
      } else if (state.selectedGallery) {
        const prefix = prefs.preloadGallery ? 'gallery-preload' : 'gallery-view';
        nextScopeKey = `${prefix}:${state.selectedGallery}`;
      } else {
        nextScopeKey = `model-view:${state.selectedModel}`;
      }
    }
    if (scopeKey === nextScopeKey) return;
    resetScope(nextScopeKey);
  }

  function enqueue(key, work) {
    if (!key || queuedKeys.has(key)) return false;
    queuedKeys.add(key);
    queue.push({ key, work, scopeVersion });
    pump();
    return true;
  }

  function pump() {
    while (activeCount < concurrency && queue.length) {
      const next = queue.shift();
      if (next.scopeVersion !== scopeVersion) {
        queuedKeys.delete(next.key);
        continue;
      }
      activeCount += 1;
      Promise.resolve()
        .then(next.work)
        .catch(() => {})
        .finally(() => {
          queuedKeys.delete(next.key);
          activeCount = Math.max(0, activeCount - 1);
          pump();
        });
    }
  }

  function preloadUrl(url) {
    if (!url || preloadedImages.has(url)) return;
    const taskScope = scopeVersion;
    const queued = enqueue(`img:${url}`, () => new Promise(resolve => {
      if (taskScope !== scopeVersion) {
        resolve();
        return;
      }
      const image = createImage();
      let settled = false;
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        imagesInFlight.delete(abort);
      };
      const finish = loaded => {
        if (settled) return;
        settled = true;
        if (loaded && taskScope === scopeVersion) {
          const decoded = typeof image.decode === 'function' ? image.decode().catch(() => {}) : Promise.resolve();
          decoded.then(() => {
            cleanup();
            if (taskScope === scopeVersion) rememberPreloaded(url, image);
            else releaseImage(image);
            if (taskScope === scopeVersion) {
              progress.completed += 1;
              notifyProgress();
            }
            resolve();
          });
        } else {
          cleanup();
          releaseImage(image);
          if (taskScope === scopeVersion) {
            progress.completed += 1;
            notifyProgress();
          }
          resolve();
        }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        releaseImage(image);
        resolve();
      };
      imagesInFlight.add(abort);
      image.decoding = 'async';
      image.loading = 'eager';
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
      if (image.complete) finish(Boolean(image.naturalWidth));
    }));
    if (!queued) return;
    progress.total += 1;
    notifyProgress();
  }

  function preloadPayload(payload) {
    for (const image of payload?.images || []) {
      preloadUrl(image.thumb);
      preloadUrl(image.src);
    }
  }

  function preloadGallery(gallery) {
    if (!gallery?.id) return;
    if (gallery.cover) preloadUrl(gallery.cover);
    const taskScope = scopeVersion;
    enqueue(`gallery:${gallery.id}`, async () => {
      if (taskScope !== scopeVersion) return;
      const payload = await fetchGalleryPayload(gallery);
      if (taskScope !== scopeVersion) return;
      preloadPayload(payload);
    });
  }

  function syncForCurrentView() {
    syncScope();
    notifyProgress();
    const prefs = getPreferences();
    const model = getCurrentModel();
    if (model && prefs.preloadModel) {
      for (const gallery of model.galleries || []) preloadGallery(gallery);
    }
    const gallery = getCurrentGallery();
    if (gallery && prefs.preloadGallery) preloadGallery(gallery);
  }

  function warmDecodedWindow(centerIndex = getState().lightboxIndex) {
    const prefs = getPreferences();
    if (!prefs.preloadGallery && !prefs.preloadModel) return;
    const activeImages = getState().activeImages;
    if (!Array.isArray(activeImages) || !activeImages.length) return;
    const start = Math.max(0, centerIndex - decodeBehind);
    const end = Math.min(activeImages.length - 1, centerIndex + decodeAhead);
    const wanted = new Set();
    for (let index = start; index <= end; index += 1) {
      const url = activeImages[index]?.src;
      if (!url) continue;
      wanted.add(url);
      if (preloadedImages.has(url) || decodedImages.has(url) || decodeInflight.has(url)) continue;
      const image = createImage();
      decodeInflight.set(url, image);
      image.decoding = 'async';
      image.loading = 'eager';
      image.onload = () => {
        image.onload = null;
        image.onerror = null;
        const decoded = typeof image.decode === 'function' ? image.decode().catch(() => {}) : Promise.resolve();
        decoded.then(() => {
          if (decodeInflight.get(url) !== image) {
            releaseImage(image);
            return;
          }
          decodeInflight.delete(url);
          rememberDecoded(url, image);
        });
      };
      image.onerror = () => {
        if (decodeInflight.get(url) === image) decodeInflight.delete(url);
        releaseImage(image);
      };
      image.src = url;
      if (image.complete && image.naturalWidth) image.onload();
    }
    for (const [url, image] of decodeInflight.entries()) {
      if (!wanted.has(url)) {
        decodeInflight.delete(url);
        releaseImage(image);
      }
    }
    for (const [url, image] of decodedImages.entries()) {
      if (!wanted.has(url)) {
        decodedImages.delete(url);
        releaseImage(image);
      }
    }
  }

  return {
    preloadPayload,
    rememberDecodedImage,
    releaseLightboxDecodedCache,
    resetScope,
    syncForCurrentView,
    syncScope,
    warmDecodedWindow,
  };
}
