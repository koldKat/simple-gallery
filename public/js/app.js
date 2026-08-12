const state = {
  data: null,
  selectedModel: null,
  selectedGallery: null,
  galleryListExpanded: false,
  hideSeenModels: false,
  mode: 'home',
  modelBrowserLetter: 'all',
  modelBrowserPage: 0,
  lightboxIndex: 0,
  lightboxRequestId: 0,
  lightboxLoading: false,
  lightboxError: false,
  imagesLoading: false,
  activeImages: [],
  activeGalleryId: null,
  user: null,
  userStats: null,
  dataUserId: null,
  favorites: null,
  favoritesLoading: false,
  favoritesError: null,
};

const STORAGE_KEYS = {
  hideSeenModels: 'simple-gallery:hide-seen-models',
  largeThumbs: 'simple-gallery:large-thumbs',
  anonPreloadModel: 'simple-gallery:anon-preload-model',
  anonPreloadGallery: 'simple-gallery:anon-preload-gallery',
};

let lastModelListRenderKey = '';
let lightboxLoadingTimer = null;
let lightboxErrorTimer = null;
let sidebarShuffleVersion = 0;
let sidebarPreview = null;
let appTooltip = null;
let appTooltipTarget = null;
let sidebarLayoutRaf = 0;
let galleryPayloadCache = new Map();
let galleryPayloadInflight = new Map();
let gallerySeenOverrides = new Map();
let preloadQueue = [];
let preloadQueuedKeys = new Set();
let preloadActiveCount = 0;
let preloadImagesInFlight = new Set();
let preloadedImageCache = new Map();
let lightboxDecodedCache = new Map();
let lightboxDecodeInflight = new Map();
let preloadScopeKey = null;
let preloadScopeVersion = 0;
let preloadProgress = { total: 0, completed: 0 };
let preloadProgressBar = null;
let lightboxTouch = null;
let favoritesLoadPromise = null;
let lightboxScrollY = 0;
let lightboxHistoryActive = false;
let favoriteImageGroupPages = new Map();
let randomFavoritesLoading = false;
const mobileTooltipMedia = window.matchMedia('(max-width: 820px), (hover: none), (pointer: coarse)');
const galleryBackdropMedia = window.matchMedia('(max-width: 820px)');
let galleryBackdrop = null;
let galleryBackdropActiveLayer = 0;
let galleryBackdropUrl = '';
let galleryBackdropPendingUrl = '';
let galleryBackdropRequestId = 0;
let galleryBackdropRotationTimer = null;
let galleryBackdropLastChangedAt = 0;
const GALLERY_BACKDROP_ROTATION_MS = 60_000;
const PRELOAD_CONCURRENCY = 3;
const LIGHTBOX_DECODE_CACHE_LIMIT = 12;
const LIGHTBOX_DECODE_AHEAD = 8;
const LIGHTBOX_DECODE_BEHIND = 3;

const els = {
  appName: document.querySelector('#app-name'),
  appTagline: document.querySelector('#app-tagline'),
  versionLabel: document.querySelector('#app-version-label'),
  stats: document.querySelector('#stats'),
  userStatsRow: document.querySelector('#user-stats-row'),
  userStats: document.querySelector('#user-stats'),
  auth: document.querySelector('#auth-box'),
  search: document.querySelector('#search'),
  hideSeenModels: document.querySelector('#hide-seen-models'),
  modelCount: document.querySelector('#model-count'),
  modelList: document.querySelector('#model-list'),
  galleryList: document.querySelector('#gallery-list'),
  selectedGalleryBar: document.querySelector('#selected-gallery-bar'),
  imageGrid: document.querySelector('#image-grid'),
  galleryKicker: document.querySelector('#gallery-kicker'),
  galleryTitle: document.querySelector('#gallery-title'),
  home: document.querySelector('#home-btn'),
  favoritesButton: document.querySelector('#favorites-btn'),
  browseModels: document.querySelector('#browse-models-btn'),
  modelFavoriteButton: document.querySelector('#model-favorite-btn'),
  modelSeenButton: document.querySelector('#model-seen-btn'),
  modelBrowser: document.querySelector('#model-browser'),
  favoritesView: document.querySelector('#favorites-view'),
  gridSmall: document.querySelector('#grid-small'),
  gridLarge: document.querySelector('#grid-large'),
  lightbox: document.querySelector('#lightbox'),
  lightboxImg: document.querySelector('#lightbox-img'),
  lightboxLoading: document.querySelector('#lightbox-loading'),
  lightboxLoadingText: document.querySelector('#lightbox-loading-text'),
  lightboxCaption: document.querySelector('#lightbox-caption'),
  lightboxDownload: document.querySelector('#lightbox-download'),
  lightboxSeen: document.querySelector('#lightbox-seen'),
  lightboxFavorite: document.querySelector('#lightbox-favorite'),
  closeLightbox: document.querySelector('#close-lightbox'),
  prevImage: document.querySelector('#prev-image'),
  nextImage: document.querySelector('#next-image'),
};

function showNotice(message) {
  if (message) console.warn(message);
}

function readStoredFlag(key, fallback = false) {
  try {
    const value = window.localStorage.getItem(key);
    if (value == null) return fallback;
    return value === '1';
  } catch {
    return fallback;
  }
}

function writeStoredFlag(key, value) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Ignore storage failures and keep the in-memory preference.
  }
}

function preloadPreferences() {
  if (state.user) {
    return {
      preloadModel: Boolean(state.user.preloadModel),
      preloadGallery: Boolean(state.user.preloadGallery),
    };
  }
  return {
    preloadModel: readStoredFlag(STORAGE_KEYS.anonPreloadModel, false),
    preloadGallery: readStoredFlag(STORAGE_KEYS.anonPreloadGallery, false),
  };
}

function saveAnonymousPreloadSettings(settings) {
  writeStoredFlag(STORAGE_KEYS.anonPreloadModel, Boolean(settings.preloadModel));
  writeStoredFlag(STORAGE_KEYS.anonPreloadGallery, Boolean(settings.preloadGallery));
  render();
  syncPreloadForCurrentView();
}

function ensurePreloadProgressBar() {
  if (preloadProgressBar) return preloadProgressBar;
  const track = document.createElement('div');
  track.className = 'preload-progress';
  track.hidden = true;
  const fill = document.createElement('div');
  fill.className = 'preload-progress-fill';
  track.append(fill);
  els.modelBrowser.parentNode.insertBefore(track, els.modelBrowser);
  preloadProgressBar = { track, fill };
  return preloadProgressBar;
}

function renderPreloadProgress() {
  const bar = ensurePreloadProgressBar();
  const prefs = preloadPreferences();
  const preloadEnabled = Boolean(prefs.preloadModel || prefs.preloadGallery);
  const inScopedModel = Boolean(state.mode === 'model' && state.selectedModel);
  const hasWork = preloadProgress.total > 0;
  const shouldShow = preloadEnabled && inScopedModel && hasWork;
  bar.track.hidden = !shouldShow;
  if (!shouldShow) {
    bar.fill.style.width = '0%';
    return;
  }
  const ratio = preloadProgress.total > 0
    ? Math.max(0, Math.min(1, preloadProgress.completed / preloadProgress.total))
    : 0;
  bar.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
}

function ensureGalleryBackdrop() {
  if (galleryBackdrop) return galleryBackdrop;
  const root = document.createElement('div');
  root.className = 'gallery-backdrop';
  root.setAttribute('aria-hidden', 'true');
  const layers = [0, 1].map(() => {
    const layer = document.createElement('div');
    layer.className = 'gallery-backdrop-layer';
    root.append(layer);
    return layer;
  });
  const shade = document.createElement('div');
  shade.className = 'gallery-backdrop-shade';
  root.append(shade);
  document.body.prepend(root);
  galleryBackdrop = { root, layers };
  return galleryBackdrop;
}

function uniqueBackdropUrls(values) {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function galleryBackdropContext() {
  if (state.mode === 'home') {
    const urls = uniqueBackdropUrls(latestGalleries().map(gallery => gallery.cover));
    return { urls };
  }
  if (state.mode === 'models') {
    const urls = uniqueBackdropUrls((state.data?.models || []).map(model => model.cover));
    return { urls };
  }
  if (state.mode === 'favorites') {
    const galleryCovers = (state.favorites?.galleries || []).map(gallery => gallery.cover);
    const imageCovers = [];
    for (const page of favoriteImageGroupPages.values()) {
      for (const image of page.images || []) imageCovers.push(image.thumb || image.src);
    }
    const urls = uniqueBackdropUrls([...galleryCovers, ...imageCovers]);
    const fallback = urls.length ? urls : uniqueBackdropUrls(latestGalleries().map(gallery => gallery.cover));
    return { urls: fallback };
  }

  const model = currentModel();
  const gallery = currentGallery();
  if (gallery) {
    const imageCovers = state.activeGalleryId === gallery.id
      ? state.activeImages.map(image => image.thumb || image.src)
      : [];
    const urls = uniqueBackdropUrls(imageCovers.length ? imageCovers : [gallery.cover]);
    return { urls };
  }
  if (model) {
    const urls = uniqueBackdropUrls((model.galleries || []).map(item => item.cover));
    return { urls };
  }
  const urls = uniqueBackdropUrls(latestGalleries().map(item => item.cover));
  return { urls };
}

function randomBackdropUrl(urls) {
  if (!urls.length) return '';
  const alternatives = urls.length > 1
    ? urls.filter(url => url !== galleryBackdropUrl && url !== galleryBackdropPendingUrl)
    : urls;
  const pool = alternatives.length ? alternatives : urls;
  return pool[Math.floor(Math.random() * pool.length)] || '';
}

function scheduleGalleryBackdropRotation(delay = GALLERY_BACKDROP_ROTATION_MS) {
  clearTimeout(galleryBackdropRotationTimer);
  galleryBackdropRotationTimer = null;
  if (galleryBackdropMedia.matches) return;
  galleryBackdropRotationTimer = setTimeout(() => {
    galleryBackdropRotationTimer = null;
    syncGalleryBackdrop({ rotate: true });
  }, Math.max(0, delay));
}

function clearGalleryBackdrop() {
  clearTimeout(galleryBackdropRotationTimer);
  galleryBackdropRotationTimer = null;
  galleryBackdropRequestId += 1;
  galleryBackdropUrl = '';
  galleryBackdropPendingUrl = '';
  galleryBackdropLastChangedAt = 0;
  document.body.classList.remove('has-gallery-backdrop');
  if (!galleryBackdrop) return;
  galleryBackdrop.layers.forEach(layer => layer.classList.remove('is-visible'));
}

function syncGalleryBackdrop(options = {}) {
  if (galleryBackdropMedia.matches) {
    clearGalleryBackdrop();
    return;
  }

  const rotate = Boolean(options.rotate);
  if (!rotate && (galleryBackdropPendingUrl || galleryBackdropUrl)) return;
  if (rotate && galleryBackdropPendingUrl) {
    scheduleGalleryBackdropRotation();
    return;
  }
  if (rotate && galleryBackdropLastChangedAt) {
    const elapsed = Date.now() - galleryBackdropLastChangedAt;
    if (elapsed < GALLERY_BACKDROP_ROTATION_MS) {
      scheduleGalleryBackdropRotation(GALLERY_BACKDROP_ROTATION_MS - elapsed);
      return;
    }
  }

  const context = galleryBackdropContext();
  if (!context.urls.length) {
    scheduleGalleryBackdropRotation();
    return;
  }

  const url = randomBackdropUrl(context.urls);
  if (!url) {
    scheduleGalleryBackdropRotation();
    return;
  }
  if (url === galleryBackdropPendingUrl) return;
  if (url === galleryBackdropUrl && document.body.classList.contains('has-gallery-backdrop')) {
    scheduleGalleryBackdropRotation();
    return;
  }

  const requestId = galleryBackdropRequestId + 1;
  galleryBackdropRequestId = requestId;
  galleryBackdropPendingUrl = url;
  const preload = new Image();
  preload.decoding = 'async';
  preload.onload = () => {
    if (requestId !== galleryBackdropRequestId || galleryBackdropMedia.matches) return;
    const backdrop = ensureGalleryBackdrop();
    const nextIndex = galleryBackdropActiveLayer === 0 ? 1 : 0;
    const current = backdrop.layers[galleryBackdropActiveLayer];
    const next = backdrop.layers[nextIndex];
    next.classList.remove('is-visible');
    next.style.backgroundImage = `url(${JSON.stringify(url)})`;
    // Commit the hidden layer before crossfading it over the current cover.
    void next.offsetWidth;
    next.classList.add('is-visible');
    current.classList.remove('is-visible');
    galleryBackdropActiveLayer = nextIndex;
    galleryBackdropUrl = url;
    galleryBackdropPendingUrl = '';
    galleryBackdropLastChangedAt = Date.now();
    document.body.classList.add('has-gallery-backdrop');
    scheduleGalleryBackdropRotation();
  };
  preload.onerror = () => {
    if (requestId !== galleryBackdropRequestId) return;
    galleryBackdropPendingUrl = '';
    scheduleGalleryBackdropRotation();
  };
  preload.src = url;
}

function ensureAppTooltip() {
  if (appTooltip) return appTooltip;
  const tooltip = document.createElement('div');
  tooltip.className = 'app-tooltip';
  tooltip.hidden = true;
  document.body.append(tooltip);
  appTooltip = tooltip;
  return appTooltip;
}

function setTooltip(element, text) {
  if (!element) return;
  const label = String(text || '').trim();
  delete element.dataset.tooltipAuto;
  element.removeAttribute('title');
  if (!label) {
    element.removeAttribute('data-tooltip');
    element.removeAttribute('aria-label');
    return;
  }
  element.dataset.tooltip = label;
  element.setAttribute('aria-label', label);
}

function defaultButtonTooltip(button) {
  if (!(button instanceof HTMLButtonElement)) return '';
  if (button.matches('.model-card, .browser-model-card, .gallery-card, .favorite-image-card, .image-tile')) return '';
  const buttonText = String(button.textContent || '').replace(/\s+/g, ' ').trim();
  if (button.closest('.letter-bar')) {
    return buttonText === 'All' ? 'Show all models' : `Show models starting with ${buttonText}`;
  }
  if (button.closest('.selected-gallery-actions')) {
    const labels = {
      Previous: 'Open previous gallery',
      Next: 'Open next gallery',
      'All galleries': 'Show all galleries for this model',
      'Hide galleries': 'Hide the gallery list',
      'Mark seen': 'Mark every image in this gallery seen',
      'Mark unseen': 'Mark every image in this gallery unseen',
    };
    return labels[buttonText] || '';
  }
  if (button.closest('.pager-row')) {
    if (buttonText === 'Previous') return 'Open previous models page';
    if (buttonText === 'Next') return 'Open next models page';
  }
  if (button.closest('.favorite-image-actions')) {
    if (buttonText === 'Gallery') return "Open this image's gallery";
    if (buttonText === 'Model') return "Open this image's model";
  }
  if (buttonText === 'Random' && button.closest('.favorites-section-head')) {
    return 'Shuffle favorite images and open the first';
  }
  return '';
}

function ensureDefaultButtonTooltip(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  if (button.dataset.tooltip && !button.dataset.tooltipAuto) return;
  const label = defaultButtonTooltip(button);
  if (!label) {
    if (button.dataset.tooltipAuto) {
      delete button.dataset.tooltip;
      delete button.dataset.tooltipAuto;
      button.removeAttribute('aria-label');
    }
    return;
  }
  button.dataset.tooltip = label;
  button.dataset.tooltipAuto = '1';
  button.setAttribute('aria-label', label);
}

function syncDefaultButtonTooltips(root = document) {
  if (root instanceof HTMLButtonElement) ensureDefaultButtonTooltip(root);
  root.querySelectorAll?.('button').forEach(ensureDefaultButtonTooltip);
}

function positionAppTooltip(anchor, pointerEvent = null) {
  if (!appTooltip || !anchor) return;
  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  const tooltipRect = appTooltip.getBoundingClientRect();
  let left = pointerEvent ? pointerEvent.clientX + margin : rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  let top = pointerEvent ? pointerEvent.clientY + margin : rect.top - tooltipRect.height - margin;
  if (left + tooltipRect.width > window.innerWidth - margin) {
    left = window.innerWidth - tooltipRect.width - margin;
  }
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = window.innerHeight - tooltipRect.height - margin;
  }
  if (top < margin) top = rect.bottom + margin;
  if (left < margin) left = margin;
  appTooltip.style.left = `${Math.round(left)}px`;
  appTooltip.style.top = `${Math.round(top)}px`;
}

function showAppTooltip(target, pointerEvent = null) {
  if (mobileTooltipMedia.matches) {
    hideAppTooltip();
    return;
  }
  const text = target?.dataset?.tooltip || '';
  if (!text) return;
  const tooltip = ensureAppTooltip();
  appTooltipTarget = target;
  tooltip.textContent = text;
  tooltip.hidden = false;
  tooltip.classList.add('is-visible');
  positionAppTooltip(target, pointerEvent);
}

function hideAppTooltip(target = null) {
  if (target && appTooltipTarget !== target) return;
  if (!appTooltip) return;
  appTooltipTarget = null;
  appTooltip.classList.remove('is-visible');
  appTooltip.hidden = true;
}

function initAppTooltips() {
  document.querySelectorAll('[title]').forEach(element => {
    setTooltip(element, element.getAttribute('title'));
  });
  syncDefaultButtonTooltips();
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const parentButton = mutation.target instanceof Element
        ? mutation.target.closest('button')
        : mutation.target.parentElement?.closest('button');
      if (parentButton?.dataset.tooltipAuto) ensureDefaultButtonTooltip(parentButton);
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) syncDefaultButtonTooltips(node);
      }
    }
    if (appTooltipTarget && !appTooltipTarget.isConnected) hideAppTooltip();
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  document.addEventListener('mouseover', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (!target || target.contains(event.relatedTarget)) return;
    showAppTooltip(target, event);
  });
  document.addEventListener('mousemove', event => {
    if (appTooltipTarget) positionAppTooltip(appTooltipTarget, event);
  });
  document.addEventListener('mouseout', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (!target || target.contains(event.relatedTarget)) return;
    hideAppTooltip(target);
  });
  document.addEventListener('focusin', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (target) showAppTooltip(target);
  });
  document.addEventListener('focusout', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (target) hideAppTooltip(target);
  });
  window.addEventListener('scroll', () => hideAppTooltip(), { passive: true });
  mobileTooltipMedia.addEventListener('change', event => {
    if (event.matches) hideAppTooltip();
  });
  document.addEventListener('touchstart', () => hideAppTooltip(), { passive: true });
}

function setGridSize(isLarge) {
  els.imageGrid.classList.toggle('large', isLarge);
  els.gridLarge.classList.toggle('is-active', isLarge);
  els.gridSmall.classList.toggle('is-active', !isLarge);
  writeStoredFlag(STORAGE_KEYS.largeThumbs, isLarge);
}

function titleCase(value) {
  return String(value || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function searchText(value) {
  return String(value || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatDate(value) {
  if (!value) return 'date unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date unknown';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function modelPath(modelId) {
  return `/model/${encodeURIComponent(modelId)}`;
}

function galleryPath(modelId, galleryName) {
  return `${modelPath(modelId)}/gallery/${encodeURIComponent(galleryName)}`;
}

function currentPath() {
  if (state.mode === 'models') return '/models';
  if (state.mode === 'favorites') return '/favorites';
  if (state.mode === 'model' && state.selectedModel && state.selectedGallery) {
    const galleryName = String(state.selectedGallery).split('/')[1] || '';
    return galleryPath(state.selectedModel, galleryName);
  }
  if (state.mode === 'model' && state.selectedModel) return modelPath(state.selectedModel);
  return '/';
}

function syncRoute(replace = false) {
  const next = currentPath();
  if (window.location.pathname === next) return;
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', next);
}

function safeDecodePathPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function applyRouteFromLocation(replace = false) {
  const parts = window.location.pathname.split('/').filter(Boolean).map(safeDecodePathPart);
  if (!parts.length) {
    setMode('home');
  } else if (parts[0] === 'models') {
    setMode('models');
  } else if (parts[0] === 'favorites') {
    setMode('favorites');
  } else if (parts[0] === 'model' && parts[1] && parts[2] === 'gallery' && parts[3]) {
    state.selectedModel = parts[1];
    state.selectedGallery = `${parts[1]}/${parts[3]}`;
    state.galleryListExpanded = false;
    resetActiveImages();
    state.mode = 'model';
  } else if (parts[0] === 'model' && parts[1]) {
    state.selectedModel = parts[1];
    state.selectedGallery = null;
    state.galleryListExpanded = true;
    resetActiveImages();
    state.mode = 'model';
  } else {
    setMode('home');
    if (replace) syncRoute(true);
  }
}

function currentModel() {
  if (state.mode !== 'model') return null;
  if (!state.selectedModel) return null;
  return state.data?.models.find(model => model.id === state.selectedModel) || null;
}

function currentGallery() {
  const model = currentModel();
  if (!model) return null;
  return model.galleries.find(gallery => gallery.id === state.selectedGallery) || null;
}

function resetActiveImages() {
  releaseLightboxDecodedCache();
  state.activeImages = [];
  state.activeGalleryId = null;
  state.imagesLoading = false;
}

function recordView(payload) {
  fetch('/api/views', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(error => showNotice(error.message));
}

function openModel(modelId) {
  state.selectedModel = modelId;
  state.selectedGallery = null;
  state.galleryListExpanded = true;
  resetActiveImages();
  state.mode = 'model';
  syncRoute();
  recordView({ type: 'model', modelId });
  syncPreloadForCurrentView();
}

function openGallery(modelId, galleryId) {
  state.selectedModel = modelId;
  state.selectedGallery = galleryId;
  state.galleryListExpanded = false;
  resetActiveImages();
  state.mode = 'model';
  syncRoute();
  const model = state.data?.models.find(item => item.id === modelId);
  const gallery = model?.galleries.find(item => item.id === galleryId);
  if (gallery?.dbId) recordView({ type: 'gallery', galleryDbId: gallery.dbId });
  syncPreloadForCurrentView();
}

function setMode(mode) {
  state.selectedModel = null;
  state.selectedGallery = null;
  state.galleryListExpanded = false;
  resetActiveImages();
  state.mode = mode;
  syncPreloadScope();
}

function setMajorMode(mode) {
  sidebarShuffleVersion += 1;
  setMode(mode);
}

function stepGallery(delta) {
  const model = currentModel();
  const gallery = currentGallery();
  if (!model || !gallery) return;
  const index = model.galleries.findIndex(item => item.id === gallery.id);
  const next = model.galleries[index + delta];
  if (!next) return;
  openGallery(model.id, next.id);
  render();
}

function setData(data) {
  if (state.data?.scannedAt !== data.scannedAt) {
    galleryPayloadCache = new Map();
    galleryPayloadInflight = new Map();
  }
  applyGallerySeenOverrides(data);
  state.data = data;
  state.dataUserId = data.user?.id || null;
  state.user = data.user || null;
  if (state.selectedModel && !data.models.some(model => model.id === state.selectedModel)) {
    setMode('home');
  }
  if (state.selectedGallery && !currentGallery()) {
    state.selectedGallery = null;
    state.galleryListExpanded = true;
    resetActiveImages();
  }
  render();
  syncPreloadForCurrentView();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Request failed.');
  return payload;
}

function syncUserOnlyUi() {
  const loggedIn = Boolean(state.user);
  if (els.userStatsRow) {
    els.userStatsRow.hidden = !loggedIn;
    els.userStatsRow.style.display = loggedIn ? '' : 'none';
  }
  if (!loggedIn && els.userStats) {
    els.userStats.textContent = '';
  }

  const hideSeenToggle = els.hideSeenModels?.closest('.sidebar-toggle');
  if (hideSeenToggle) {
    hideSeenToggle.hidden = !loggedIn;
    hideSeenToggle.style.display = loggedIn ? '' : 'none';
  }
}

function galleryRequestUrl(gallery) {
  const [modelName, galleryName] = String(gallery?.id || '').split('/');
  return `/api/gallery?model=${encodeURIComponent(modelName || '')}&gallery=${encodeURIComponent(galleryName || '')}`;
}

function gallerySeenSummary(dbId) {
  for (const model of state.data?.models || []) {
    for (const gallery of model.galleries || []) {
      if (gallery.dbId === dbId) {
        return {
          seen: Boolean(gallery.seen),
          seenCount: Number(gallery.seenCount || 0),
          count: Number(gallery.count || 0),
        };
      }
    }
  }
  return null;
}

function rememberGallerySeenOverride(galleryDbId, seenCount, seen) {
  const dbId = Number(galleryDbId || 0);
  if (!dbId) return;
  gallerySeenOverrides.set(dbId, {
    seen: Boolean(seen),
    seenCount: Number(seenCount || 0),
  });
}

function applyGallerySeenOverrides(data) {
  if (!data || !gallerySeenOverrides.size) return;
  const matched = new Set();
  const applyToGalleries = (galleries, trackMatch = false) => {
    for (const gallery of galleries || []) {
      const dbId = Number(gallery?.dbId || 0);
      if (!dbId) continue;
      const override = gallerySeenOverrides.get(dbId);
      if (!override) continue;
      if (trackMatch
        && Boolean(gallery.seen) === override.seen
        && Number(gallery.seenCount || 0) === override.seenCount) {
        matched.add(dbId);
      }
      gallery.seen = override.seen;
      gallery.seenCount = override.seenCount;
    }
  };
  for (const model of data.models || []) {
    applyToGalleries(model.galleries, true);
    recomputeModelSeen(model);
  }
  applyToGalleries(data.latest);
  if (data.currentModel) {
    applyToGalleries(data.currentModel.galleries);
    recomputeModelSeen(data.currentModel);
  }
  if (state.activeImages.length) {
    const activeGalleryDbId = Number(currentGallery()?.dbId || state.activeImages[0]?.dbId || 0);
    const activeOverride = gallerySeenOverrides.get(activeGalleryDbId);
    if (activeOverride?.seen) {
      for (const image of state.activeImages) image.seen = true;
    }
  }
  for (const dbId of matched) gallerySeenOverrides.delete(dbId);
}

function applyKnownSeenStateToPayload(gallery, payload) {
  if (!payload || !gallery?.dbId) return payload;
  const summary = gallerySeenSummary(gallery.dbId);
  if (!summary) return payload;
  const images = Array.isArray(payload.images) ? payload.images.map((image) => ({
    ...image,
    seen: summary.seen ? true : Boolean(image.seen),
  })) : [];
  return {
    ...payload,
    seen: summary.seen,
    seenCount: summary.seenCount,
    images,
  };
}

function patchCachedGallerySeenState(galleryDbId, seenCount, seen, options = {}) {
  for (const [key, payload] of galleryPayloadCache.entries()) {
    if (Number(payload?.dbId || 0) !== Number(galleryDbId || 0)) continue;
    const images = Array.isArray(payload.images) ? payload.images.map((image) => {
      if (seen || options.allImages === true) return { ...image, seen: Boolean(seen) };
      if (options.imageName && image.name === options.imageName) {
        return { ...image, seen: Boolean(options.imageSeen) };
      }
      return image;
    }) : [];
    galleryPayloadCache.set(key, {
      ...payload,
      seen: Boolean(seen),
      seenCount: Number(seenCount || 0),
      images,
    });
  }
}

async function fetchGalleryPayload(gallery) {
  const key = String(gallery?.id || '');
  if (!key) throw new Error('Invalid gallery.');
  if (galleryPayloadCache.has(key)) return galleryPayloadCache.get(key);
  if (galleryPayloadInflight.has(key)) return galleryPayloadInflight.get(key);
  const promise = (async () => {
    const response = await fetch(galleryRequestUrl(gallery), { cache: 'no-store' });
    if (!response.ok) {
      let message = 'Failed to load gallery images.';
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {
        // Keep generic message when the response is not JSON.
      }
      throw new Error(message);
    }
    const payload = await response.json();
    const merged = applyKnownSeenStateToPayload(gallery, payload);
    galleryPayloadCache.set(key, merged);
    return merged;
  })();
  galleryPayloadInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    galleryPayloadInflight.delete(key);
  }
}

function galleryImagesFromPayload(payload) {
  return (payload.images || []).map(image => ({ ...image, dbId: payload.dbId }));
}

function cancelPreloadImagesInFlight() {
  for (const abort of preloadImagesInFlight) {
    try {
      abort();
    } catch {
      // Best-effort: old preloads should not keep decoded images alive.
    }
  }
  preloadImagesInFlight.clear();
}

function releaseDecodedImage(image) {
  if (!(image instanceof HTMLImageElement)) return;
  image.onload = null;
  image.onerror = null;
  image.src = '';
}

function rememberPreloadedImage(url, image) {
  if (!url || !(image instanceof HTMLImageElement)) return;
  const existing = preloadedImageCache.get(url);
  if (existing && existing !== image) releaseDecodedImage(existing);
  preloadedImageCache.delete(url);
  preloadedImageCache.set(url, image);
}

function rememberLightboxDecodedImage(url, image) {
  if (!url || !(image instanceof HTMLImageElement)) return;
  const existing = lightboxDecodedCache.get(url);
  if (existing && existing !== image) releaseDecodedImage(existing);
  lightboxDecodedCache.delete(url);
  lightboxDecodedCache.set(url, image);
  while (lightboxDecodedCache.size > LIGHTBOX_DECODE_CACHE_LIMIT) {
    const [oldUrl, oldImage] = lightboxDecodedCache.entries().next().value || [];
    if (!oldUrl) break;
    lightboxDecodedCache.delete(oldUrl);
    releaseDecodedImage(oldImage);
  }
}

function releaseLightboxDecodedCache() {
  for (const image of lightboxDecodeInflight.values()) releaseDecodedImage(image);
  lightboxDecodeInflight = new Map();
  for (const image of lightboxDecodedCache.values()) releaseDecodedImage(image);
  lightboxDecodedCache = new Map();
}

function releasePreloadedImageCache() {
  for (const image of preloadedImageCache.values()) releaseDecodedImage(image);
  preloadedImageCache = new Map();
  releaseLightboxDecodedCache();
}

function resetPreloadScope(nextScopeKey = null) {
  cancelPreloadImagesInFlight();
  releasePreloadedImageCache();
  preloadScopeKey = nextScopeKey || null;
  preloadScopeVersion += 1;
  galleryPayloadCache = new Map();
  galleryPayloadInflight = new Map();
  preloadQueue = [];
  preloadQueuedKeys = new Set();
  preloadProgress = { total: 0, completed: 0 };
  renderPreloadProgress();
}

function syncPreloadScope() {
  let nextScopeKey = null;
  if (state.mode === 'model' && state.selectedModel) {
    const prefs = preloadPreferences();
    if (prefs.preloadModel) {
      nextScopeKey = `model-preload:${state.selectedModel}`;
    } else if (state.selectedGallery) {
      const prefix = prefs.preloadGallery ? 'gallery-preload' : 'gallery-view';
      nextScopeKey = `${prefix}:${state.selectedGallery}`;
    } else {
      nextScopeKey = `model-view:${state.selectedModel}`;
    }
  }
  if (preloadScopeKey === nextScopeKey) return;
  resetPreloadScope(nextScopeKey);
}

function enqueuePreloadTask(key, work) {
  if (!key || preloadQueuedKeys.has(key)) return false;
  preloadQueuedKeys.add(key);
  preloadQueue.push({ key, work, scopeVersion: preloadScopeVersion });
  pumpPreloadQueue();
  return true;
}

function pumpPreloadQueue() {
  while (preloadActiveCount < PRELOAD_CONCURRENCY && preloadQueue.length) {
    const next = preloadQueue.shift();
    if (next.scopeVersion !== preloadScopeVersion) {
      preloadQueuedKeys.delete(next.key);
      continue;
    }
    preloadActiveCount += 1;
    Promise.resolve()
      .then(next.work)
      .catch(() => {})
      .finally(() => {
        preloadQueuedKeys.delete(next.key);
        preloadActiveCount = Math.max(0, preloadActiveCount - 1);
        pumpPreloadQueue();
      });
  }
}

function preloadImageUrl(url) {
  if (!url) return;
  if (preloadedImageCache.has(url)) return;
  const scopeVersion = preloadScopeVersion;
  const queued = enqueuePreloadTask(`img:${url}`, () => new Promise(resolve => {
    if (scopeVersion !== preloadScopeVersion) {
      resolve();
      return;
    }
    const image = new Image();
    let settled = false;
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      preloadImagesInFlight.delete(abort);
    };
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      if (loaded && scopeVersion === preloadScopeVersion) {
        const decoded = typeof image.decode === 'function'
          ? image.decode().catch(() => {})
          : Promise.resolve();
        decoded.then(() => {
          cleanup();
          if (scopeVersion === preloadScopeVersion) {
            rememberPreloadedImage(url, image);
          } else {
            releaseDecodedImage(image);
          }
          if (scopeVersion === preloadScopeVersion) {
            preloadProgress.completed += 1;
            renderPreloadProgress();
          }
          resolve();
        });
      } else {
        cleanup();
        releaseDecodedImage(image);
        if (scopeVersion === preloadScopeVersion) {
          preloadProgress.completed += 1;
          renderPreloadProgress();
        }
        resolve();
      }
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      releaseDecodedImage(image);
      resolve();
    };
    preloadImagesInFlight.add(abort);
    image.decoding = 'async';
    image.loading = 'eager';
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
    if (image.complete) finish(Boolean(image.naturalWidth));
  }));
  if (!queued) return;
  preloadProgress.total += 1;
  renderPreloadProgress();
}

function preloadGalleryAssetsFromPayload(payload) {
  for (const image of payload?.images || []) {
    preloadImageUrl(image.thumb);
    preloadImageUrl(image.src);
  }
}

function preloadGalleryAssets(gallery) {
  if (!gallery?.id) return;
  if (gallery.cover) preloadImageUrl(gallery.cover);
  const scopeVersion = preloadScopeVersion;
  enqueuePreloadTask(`gallery:${gallery.id}`, async () => {
    if (scopeVersion !== preloadScopeVersion) return;
    const payload = await fetchGalleryPayload(gallery);
    if (scopeVersion !== preloadScopeVersion) return;
    preloadGalleryAssetsFromPayload(payload);
  });
}

function preloadModelAssets(model) {
  if (!model?.galleries?.length) return;
  for (const gallery of model.galleries) {
    preloadGalleryAssets(gallery);
  }
}

function syncPreloadForCurrentView() {
  syncPreloadScope();
  renderPreloadProgress();
  const prefs = preloadPreferences();
  const model = currentModel();
  if (model && prefs.preloadModel) preloadModelAssets(model);
  const gallery = currentGallery();
  if (gallery && prefs.preloadGallery) preloadGalleryAssets(gallery);
}

function warmDecodedLightboxWindow(centerIndex = state.lightboxIndex) {
  const prefs = preloadPreferences();
  if (!prefs.preloadGallery && !prefs.preloadModel) return;
  if (!Array.isArray(state.activeImages) || !state.activeImages.length) return;
  const start = Math.max(0, centerIndex - LIGHTBOX_DECODE_BEHIND);
  const end = Math.min(state.activeImages.length - 1, centerIndex + LIGHTBOX_DECODE_AHEAD);
  const wanted = new Set();

  for (let index = start; index <= end; index += 1) {
    const url = state.activeImages[index]?.src;
    if (!url) continue;
    wanted.add(url);
    if (preloadedImageCache.has(url)) continue;
    if (lightboxDecodedCache.has(url)) continue;
    if (lightboxDecodeInflight.has(url)) continue;
    const image = new Image();
    lightboxDecodeInflight.set(url, image);
    image.decoding = 'async';
    image.loading = 'eager';
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      const decoded = typeof image.decode === 'function'
        ? image.decode().catch(() => {})
        : Promise.resolve();
      decoded.then(() => {
        if (lightboxDecodeInflight.get(url) !== image) {
          releaseDecodedImage(image);
          return;
        }
        lightboxDecodeInflight.delete(url);
        rememberLightboxDecodedImage(url, image);
      });
    };
    image.onerror = () => {
      if (lightboxDecodeInflight.get(url) === image) lightboxDecodeInflight.delete(url);
      releaseDecodedImage(image);
    };
    image.src = url;
    if (image.complete && image.naturalWidth) image.onload();
  }

  for (const [url, image] of lightboxDecodeInflight.entries()) {
    if (!wanted.has(url)) {
      lightboxDecodeInflight.delete(url);
      releaseDecodedImage(image);
    }
  }
  for (const [url, image] of lightboxDecodedCache.entries()) {
    if (!wanted.has(url)) {
      lightboxDecodedCache.delete(url);
      releaseDecodedImage(image);
    }
  }
}

function latestGalleries() {
  return state.data?.latest || [];
}

function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function shuffledModels(models, seed) {
  const list = models.slice();
  let stateSeed = (seed >>> 0) || 1;
  function nextRandom() {
    stateSeed = (stateSeed * 1664525 + 1013904223) >>> 0;
    return stateSeed / 4294967296;
  }
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
  return list;
}

function shouldRandomizeSidebarModels(filter) {
  if (filter) return false;
  return !window.matchMedia('(max-width: 820px)').matches;
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 820px)').matches;
}

function sidebarAvailableHeight() {
  const sidebar = els.modelList?.closest('.sidebar');
  if (!sidebar) return 0;
  if (isMobileLayout()) {
    sidebar.style.height = '';
    return 0;
  }
  const rect = sidebar.getBoundingClientRect();
  const topInset = Math.max(14, Math.round(rect.top));
  return Math.max(0, window.innerHeight - topInset - 14);
}

function fitSidebarToRenderedCards() {
  const sidebar = els.modelList?.closest('.sidebar');
  if (!sidebar) return;
  if (isMobileLayout()) {
    sidebar.style.height = '';
    return;
  }
  const headerHeight = els.modelList?.previousElementSibling?.offsetHeight || 0;
  const listHeight = els.modelList?.scrollHeight || 0;
  sidebar.style.height = `${Math.ceil(headerHeight + listHeight)}px`;
}

function sidebarVisibleCount() {
  if (isMobileLayout()) return 0;
  const sidebarHeight = sidebarAvailableHeight();
  const headerHeight = els.modelList?.previousElementSibling?.offsetHeight || 0;
  const listStyle = els.modelList ? window.getComputedStyle(els.modelList) : null;
  const paddingTop = parseFloat(listStyle?.paddingTop || '0') || 0;
  const paddingBottom = parseFloat(listStyle?.paddingBottom || '0') || 0;
  const gap = parseFloat(listStyle?.rowGap || listStyle?.gap || '9') || 9;
  const available = Math.max(0, sidebarHeight - headerHeight - paddingTop - paddingBottom);
  const probeCardHeight = els.modelList?.querySelector('.model-card')?.offsetHeight || 89;
  const estimatedCardHeight = Math.max(72, probeCardHeight + gap);
  const count = Math.floor((available + gap) / estimatedCardHeight);
  return Math.max(1, count || 1);
}

function scheduleSidebarLayoutSync() {
  if (sidebarLayoutRaf) return;
  sidebarLayoutRaf = window.requestAnimationFrame(() => {
    sidebarLayoutRaf = 0;
    lastModelListRenderKey = '';
    renderModels();
  });
}

function updateDocumentTitle() {
  const appName = String(state.data?.app?.name || 'Simple Gallery');
  const homeTitle = String(state.data?.app?.homeTitle || `${appName} - Image Galleries`);
  const model = currentModel();
  const gallery = currentGallery();

  if (state.mode === 'favorites') {
    document.title = `Favorites | ${appName}`;
    return;
  }
  if (state.mode === 'models') {
    document.title = `All Models | ${appName}`;
    return;
  }
  if (model && gallery) {
    document.title = `${titleCase(model.name)} / Gallery ${gallery.name} | ${appName}`;
    return;
  }
  if (model) {
    document.title = `${titleCase(model.name)} | ${appName}`;
    return;
  }
  document.title = homeTitle;
}

function statsBreakdownHtml(values) {
  return `
    <span class="stat-part stat-models"><span class="stat-num">${formatCount(values.models)}</span><span class="stat-word">models</span></span>
    <span class="stat-part stat-galleries"><span class="stat-num">${formatCount(values.galleries)}</span><span class="stat-word">galleries</span></span>
    <span class="stat-part stat-images"><span class="stat-num">${formatCount(values.images)}</span><span class="stat-word">images</span></span>
  `;
}

function renderStatsBreakdown(element, values) {
  if (!element) return;
  element.classList.add('stats-breakdown');
  element.innerHTML = statsBreakdownHtml(values);
}

function renderHeaderStats() {
  const data = state.data;
  if (data) {
    renderStatsBreakdown(els.stats, {
      models: data.totals.models,
      galleries: data.totals.galleries,
      images: data.totals.images,
    });
  }
  syncUserOnlyUi();
  if (!els.userStats) return;
  if (state.user) {
    if (data && state.dataUserId === state.user.id) {
      state.userStats = (data.models || []).reduce((acc, model) => {
        if (!model.seen) acc.models += 1;
        for (const gallery of model.galleries || []) {
          if (!gallery.seen) acc.galleries += 1;
          acc.images += Math.max(0, Number(gallery.count || 0) - Number(gallery.seenCount || 0));
        }
        return acc;
      }, { models: 0, galleries: 0, images: 0 });
    }
    if (state.userStats) renderStatsBreakdown(els.userStats, state.userStats);
  } else {
    state.userStats = null;
    els.userStats.textContent = '';
  }
}

function renderFavoritesButton() {
  if (!els.favoritesButton) return;
  const count = Math.max(0, Number(state.user?.favoriteCount || 0));
  els.favoritesButton.replaceChildren(
    document.createTextNode('Favorites '),
    Object.assign(document.createElement('span'), {
      className: 'favorites-count',
      textContent: `(${formatCount(count)})`,
    })
  );
  els.favoritesButton.hidden = !state.user || state.mode === 'favorites';
}

function updateFavoriteCount(payload, favorite) {
  if (!state.user) return;
  const serverCount = Number(payload?.favoriteCount);
  const current = Math.max(0, Number(state.user.favoriteCount || 0));
  state.user.favoriteCount = Number.isFinite(serverCount)
    ? Math.max(0, serverCount)
    : Math.max(0, current + (favorite ? 1 : -1));
  renderFavoritesButton();
}

function patchActiveImageTile(index) {
  if (state.imagesLoading || state.activeGalleryId !== currentGallery()?.id) return;
  const button = els.imageGrid.children[index];
  const image = state.activeImages[index];
  if (!button || !image || !button.classList.contains('image-tile')) return;
  button.classList.toggle('is-seen', Boolean(image.seen));
  const existingBadge = button.querySelector('.image-seen-toggle');
  if (image.seen) {
    if (!existingBadge) {
      const seen = document.createElement('button');
      seen.type = 'button';
      seen.className = 'seen-badge image-seen-toggle';
      setTooltip(seen, state.user ? 'Mark image unseen' : 'Login to mark unseen');
      seen.textContent = '✓';
      seen.disabled = !state.user;
      seen.addEventListener('click', event => {
        event.stopPropagation();
        setImageSeen(image, false).catch(error => showNotice(error.message));
      });
      button.append(seen);
    }
  } else if (existingBadge) {
    existingBadge.remove();
  }
}

function renderModelActionButtons() {
  syncActiveGallerySeenState();
  const selectedModel = currentModel();
  if (els.modelFavoriteButton) {
    els.modelFavoriteButton.hidden = !(state.mode === 'model' && selectedModel);
    els.modelFavoriteButton.disabled = !state.user || !selectedModel;
    els.modelFavoriteButton.textContent = selectedModel?.favorite ? '★' : '☆';
    setTooltip(els.modelFavoriteButton, state.user ? (selectedModel?.favorite ? 'Unfavorite model' : 'Favorite model') : 'Login to favorite');
    els.modelFavoriteButton.classList.toggle('is-active', Boolean(selectedModel?.favorite));
  }
  if (els.modelSeenButton) {
    els.modelSeenButton.hidden = !(state.mode === 'model' && selectedModel);
    els.modelSeenButton.disabled = !state.user || !selectedModel;
    els.modelSeenButton.textContent = selectedModel?.seen ? 'Mark model unseen' : 'Mark model seen';
    setTooltip(
      els.modelSeenButton,
      state.user
        ? (selectedModel?.seen
          ? 'Mark every gallery and image in this model unseen'
          : 'Mark every gallery and image in this model seen')
        : 'Login to change model seen state'
    );
    els.modelSeenButton.classList.toggle('is-seen-action', Boolean(selectedModel) && !selectedModel?.seen);
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  const selectedModel = currentModel();

  updateDocumentTitle();
  if (els.appName) els.appName.textContent = data.app?.name || 'Simple Gallery';
  if (els.appTagline) els.appTagline.textContent = data.app?.tagline || '';
  els.versionLabel.textContent = data.app?.versionLabel || '';
  renderHeaderStats();
  if (els.hideSeenModels) els.hideSeenModels.checked = state.hideSeenModels;
  const hideSeenToggle = els.hideSeenModels?.closest('.sidebar-toggle');
  if (hideSeenToggle) {
    hideSeenToggle.hidden = !state.user;
    hideSeenToggle.style.display = state.user ? '' : 'none';
  }
  els.home.hidden = state.mode === 'home';
  renderFavoritesButton();
  els.browseModels.hidden = state.mode === 'models';
  renderModelActionButtons();
  els.gridSmall.hidden = !state.selectedGallery;
  els.gridLarge.hidden = !state.selectedGallery;
  renderAuth();
  renderModels();
  renderModelBrowser();
  renderFavorites();
  renderSelectedGalleryBar();
  renderGalleries();
  renderImages();
  syncGalleryBackdrop();
}

function renderAuth() {
  els.auth.innerHTML = '';
  const prefs = preloadPreferences();
  const profile = document.createElement('div');
  profile.className = 'auth-profile';

  const authRow = document.createElement('div');
  authRow.className = 'auth-profile-head';

  if (state.user) {
    const name = document.createElement('span');
    name.textContent = state.user.displayName || state.user.username;
    name.className = 'auth-username';
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.textContent = 'Logout';
    logout.addEventListener('click', async () => {
      await fetchJson('/api/auth/logout', { method: 'POST' });
      state.user = null;
      state.favorites = null;
      syncUserOnlyUi();
      renderHeaderStats();
      if (state.mode === 'favorites') state.mode = 'home';
      await loadState();
    });
    authRow.append(name, logout);
  } else {
    const fieldsRow = document.createElement('div');
    fieldsRow.className = 'auth-credential-row';
    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'auth-button-row';

    const username = document.createElement('input');
    username.type = 'text';
    username.placeholder = 'Username';
    username.autocomplete = 'username';
    const password = document.createElement('input');
    password.type = 'password';
    password.placeholder = 'Password';
    password.autocomplete = 'current-password';
    const login = document.createElement('button');
    login.type = 'button';
    login.textContent = 'Login';
    const register = document.createElement('button');
    register.type = 'button';
    register.textContent = 'Register';

    async function submit(endpoint) {
      const payload = await fetchJson(endpoint, {
        method: 'POST',
        body: JSON.stringify({ username: username.value.trim(), password: password.value }),
      });
      state.user = payload.user;
      state.userStats = null;
      renderAuth();
      syncUserOnlyUi();
      renderFavoritesButton();
      await loadCurrentUserStats();
      await loadState();
    }

    login.addEventListener('click', () => submit('/api/auth/login').catch(error => showNotice(error.message)));
    register.addEventListener('click', () => submit('/api/auth/register').catch(error => showNotice(error.message)));
    fieldsRow.append(username, password);
    buttonsRow.append(login, register);
    authRow.append(fieldsRow, buttonsRow);
  }

  const settings = document.createElement('div');
  settings.className = 'auth-profile-settings';

  const preloadModel = document.createElement('label');
  preloadModel.className = 'auth-setting';
  const preloadModelInput = document.createElement('input');
  preloadModelInput.type = 'checkbox';
  preloadModelInput.checked = Boolean(prefs.preloadModel);
  preloadModelInput.addEventListener('change', () => {
    const next = {
      preloadModel: preloadModelInput.checked,
      preloadGallery: preloadGalleryInput.checked,
    };
    if (state.user) {
      saveUserSettings(next).catch(error => {
        const current = preloadPreferences();
        preloadModelInput.checked = Boolean(current.preloadModel);
        preloadGalleryInput.checked = Boolean(current.preloadGallery);
        showNotice(error.message);
      });
    } else {
      saveAnonymousPreloadSettings(next);
    }
  });
  preloadModel.append(preloadModelInput, document.createTextNode(' Preload model'));

  const preloadGallery = document.createElement('label');
  preloadGallery.className = 'auth-setting';
  const preloadGalleryInput = document.createElement('input');
  preloadGalleryInput.type = 'checkbox';
  preloadGalleryInput.checked = Boolean(prefs.preloadGallery);
  preloadGalleryInput.addEventListener('change', () => {
    const next = {
      preloadModel: preloadModelInput.checked,
      preloadGallery: preloadGalleryInput.checked,
    };
    if (state.user) {
      saveUserSettings(next).catch(error => {
        const current = preloadPreferences();
        preloadModelInput.checked = Boolean(current.preloadModel);
        preloadGalleryInput.checked = Boolean(current.preloadGallery);
        showNotice(error.message);
      });
    } else {
      saveAnonymousPreloadSettings(next);
    }
  });
  preloadGallery.append(preloadGalleryInput, document.createTextNode(' Preload gallery'));

  settings.append(preloadModel, preloadGallery);
  profile.append(settings, authRow);
  els.auth.append(profile);
}

function favoriteButton(isFavorite, label = 'Favorite') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `favorite-btn${isFavorite ? ' is-favorite' : ''}`;
  setTooltip(button, state.user ? label : 'Login to favorite');
  button.textContent = isFavorite ? '★' : '☆';
  button.disabled = !state.user;
  return button;
}

function updateModelFavoriteState(modelId, favorite) {
  for (const model of state.data?.models || []) {
    if (model.id === modelId) model.favorite = favorite;
  }
}

function bindCardImageLoading(container, image) {
  if (!container || !image) return;
  if (!container.querySelector('.card-image-progress')) {
    const progress = document.createElement('div');
    progress.className = 'card-image-progress';
    container.append(progress);
  }
  container.classList.add('card-image-host', 'is-loading');
  function finish(loaded) {
    container.classList.remove('is-loading');
    container.classList.toggle('is-error', !loaded);
  }
  image.addEventListener('load', () => finish(true), { once: true });
  image.addEventListener('error', () => finish(false), { once: true });
  if (image.complete) finish(Boolean(image.naturalWidth));
}

function ensureSidebarPreview() {
  if (sidebarPreview) return sidebarPreview;
  const root = document.createElement('div');
  root.className = 'sidebar-hover-preview';
  root.hidden = true;
  const image = document.createElement('img');
  image.alt = '';
  const caption = document.createElement('div');
  caption.className = 'sidebar-hover-preview-caption';
  root.append(image, caption);
  document.body.append(root);
  sidebarPreview = { root, image, caption };
  return sidebarPreview;
}

function hideSidebarPreview() {
  if (!sidebarPreview) return;
  sidebarPreview.root.hidden = true;
  sidebarPreview.root.classList.remove('is-visible');
}

function positionSidebarPreview(anchorRect) {
  if (!sidebarPreview || !anchorRect) return;
  const margin = 14;
  const previewWidth = 240;
  const previewHeight = 320;
  let left = anchorRect.right + margin;
  let top = anchorRect.top;
  if (left + previewWidth > window.innerWidth - margin) {
    left = Math.max(margin, anchorRect.left - previewWidth - margin);
  }
  if (top + previewHeight > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - previewHeight - margin);
  }
  sidebarPreview.root.style.left = `${Math.round(left)}px`;
  sidebarPreview.root.style.top = `${Math.round(top)}px`;
}

function sidebarPreviewCover(model) {
  const galleries = Array.isArray(model?.galleries) ? model.galleries.slice() : [];
  if (!galleries.length) return model?.cover || '';
  galleries.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
  return galleries[galleries.length - 1]?.cover || model?.cover || '';
}

function showSidebarPreview(button, cover, label) {
  if (!cover) return;
  const preview = ensureSidebarPreview();
  preview.image.src = cover;
  preview.caption.textContent = label || '';
  positionSidebarPreview(button.getBoundingClientRect());
  preview.root.hidden = false;
  preview.root.classList.add('is-visible');
}

function bindSidebarPreview(button, cover, label) {
  if (!button || !cover) return;
  button.addEventListener('mouseenter', () => {
    showSidebarPreview(button, cover, label);
  });
  button.addEventListener('mousemove', () => {
    positionSidebarPreview(button.getBoundingClientRect());
  });
  button.addEventListener('mouseleave', hideSidebarPreview);
  button.addEventListener('focus', () => {
    showSidebarPreview(button, cover, label);
  });
  button.addEventListener('blur', hideSidebarPreview);
}

function updateGalleryFavoriteState(dbId, favorite) {
  for (const model of state.data?.models || []) {
    for (const gallery of model.galleries || []) {
      if (gallery.dbId === dbId) gallery.favorite = favorite;
    }
  }
  for (const gallery of state.favorites?.galleries || []) {
    if (gallery.dbId === dbId) gallery.favorite = favorite;
  }
}

function updateImageFavoriteState(galleryDbId, imageName, favorite) {
  const dbId = Number(galleryDbId || 0);
  const name = String(imageName || '');
  if (!dbId || !name) return;

  for (const image of state.activeImages || []) {
    if (Number(image.dbId || 0) === dbId && image.name === name) {
      image.favorite = Boolean(favorite);
    }
  }

  for (const [key, payload] of galleryPayloadCache.entries()) {
    if (Number(payload?.dbId || 0) !== dbId || !Array.isArray(payload.images)) continue;
    galleryPayloadCache.set(key, {
      ...payload,
      images: payload.images.map(image => (
        image.name === name ? { ...image, favorite: Boolean(favorite) } : image
      )),
    });
  }

  for (const page of favoriteImageGroupPages.values()) {
    for (const image of page.images || []) {
      if (Number(image.dbId || 0) === dbId && image.name === name) {
        image.favorite = Boolean(favorite);
      }
    }
  }
}

function recomputeModelSeen(model) {
  const galleries = model?.galleries || [];
  const seenCount = galleries.reduce((sum, gallery) => sum + Number(gallery.seenCount || 0), 0);
  model.seenCount = seenCount;
  model.seen = Number(model.count || 0) > 0 && seenCount >= Number(model.count || 0);
}

function updateGallerySeenState(dbId, seenCount, seen) {
  for (const model of state.data?.models || []) {
    for (const gallery of model.galleries || []) {
      if (gallery.dbId === dbId) {
        gallery.seenCount = seenCount;
        gallery.seen = seen;
      }
    }
    recomputeModelSeen(model);
  }
  for (const gallery of state.data?.latest || []) {
    if (gallery.dbId === dbId) {
      gallery.seenCount = seenCount;
      gallery.seen = seen;
    }
  }
  for (const gallery of state.data?.currentModel?.galleries || []) {
    if (gallery.dbId === dbId) {
      gallery.seenCount = seenCount;
      gallery.seen = seen;
    }
  }
  if (state.data?.currentModel) recomputeModelSeen(state.data.currentModel);
  for (const gallery of state.favorites?.galleries || []) {
    if (gallery.dbId === dbId) {
      gallery.seenCount = seenCount;
      gallery.seen = seen;
    }
  }
}

function activeGallerySeenSummary(gallery = currentGallery()) {
  const galleryDbId = Number(gallery?.dbId || 0);
  if (!gallery || !galleryDbId) return null;
  const galleryImages = state.activeImages.filter(image => Number(image.dbId || 0) === galleryDbId);
  if (!galleryImages.length) return null;
  const seenCount = galleryImages.reduce((sum, image) => sum + (image.seen ? 1 : 0), 0);
  return {
    dbId: galleryDbId,
    seenCount,
    seen: seenCount >= galleryImages.length,
  };
}

function syncActiveGallerySeenState() {
  const gallery = currentGallery();
  const summary = activeGallerySeenSummary(gallery);
  if (!gallery || !summary) return;
  const { dbId, seenCount, seen } = summary;
  if (Number(gallery.seenCount || 0) === seenCount && Boolean(gallery.seen) === seen) return;
  updateGallerySeenState(dbId, seenCount, seen);
  rememberGallerySeenOverride(dbId, seenCount, seen);
  patchCachedGallerySeenState(dbId, seenCount, seen);
}

async function toggleGalleryFavorite(gallery) {
  if (!state.user || !gallery.dbId) return;
  const favorite = !gallery.favorite;
  const payload = await fetchJson('/api/favorites/gallery', {
    method: favorite ? 'POST' : 'DELETE',
    body: JSON.stringify({ galleryId: gallery.dbId }),
  });
  gallery.favorite = favorite;
  updateGalleryFavoriteState(gallery.dbId, favorite);
  updateFavoriteCount(payload, favorite);
  if (state.mode === 'favorites') {
    await loadFavorites();
    return;
  }
  render();
}

async function toggleModelFavorite(model) {
  if (!state.user || !model?.id) return;
  const favorite = !model.favorite;
  const payload = await fetchJson('/api/favorites/model', {
    method: favorite ? 'POST' : 'DELETE',
    body: JSON.stringify({ modelId: model.id }),
  });
  model.favorite = favorite;
  updateModelFavoriteState(model.id, favorite);
  updateFavoriteCount(payload, favorite);
  if (state.mode === 'favorites') {
    await loadFavorites();
    return;
  }
  render();
}

function seenButton(isSeen, label = 'Mark seen') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `seen-btn${isSeen ? ' is-seen' : ''}`;
  setTooltip(button, state.user ? label : 'Login to mark seen');
  button.textContent = isSeen ? '✓' : '○';
  button.disabled = !state.user;
  return button;
}

async function setImageSeen(image, seen, options = {}) {
  if (!state.user || !image.dbId) return;
  if (Boolean(image.seen) === Boolean(seen)) {
    syncActiveGallerySeenState();
    if (options.render !== false) renderSelectedGalleryBar();
    return;
  }
  const previous = Boolean(image.seen);
  image.seen = Boolean(seen);
  syncActiveGallerySeenState();
  if (options.render !== false) {
    renderHeaderStats();
    renderModels();
    renderModelActionButtons();
    patchActiveImageTile(state.activeImages.indexOf(image));
    renderSelectedGalleryBar();
  }
  renderLightboxMeta();
  try {
    const payload = await fetchJson('/api/seen/image', {
      method: seen ? 'POST' : 'DELETE',
      body: JSON.stringify({ galleryId: image.dbId, imageName: image.name }),
    });
    const localSummary = activeGallerySeenSummary();
    const summary = localSummary?.dbId === Number(image.dbId || 0)
      ? localSummary
      : { seenCount: payload.seenCount, seen: payload.seen };
    updateGallerySeenState(image.dbId, summary.seenCount, summary.seen);
    rememberGallerySeenOverride(image.dbId, summary.seenCount, summary.seen);
    patchCachedGallerySeenState(image.dbId, summary.seenCount, summary.seen, {
      imageName: image.name,
      imageSeen: seen,
    });
    if (options.render !== false) {
      renderHeaderStats();
      renderModels();
      renderModelActionButtons();
      patchActiveImageTile(state.activeImages.indexOf(image));
      renderSelectedGalleryBar();
    }
    renderLightboxMeta();
  } catch (error) {
    image.seen = previous;
    syncActiveGallerySeenState();
    if (options.render !== false) {
      renderHeaderStats();
      renderModels();
      renderModelActionButtons();
      patchActiveImageTile(state.activeImages.indexOf(image));
      renderSelectedGalleryBar();
    }
    renderLightboxMeta();
    throw error;
  }
}

async function markGallerySeen(gallery) {
  if (!state.user || !gallery.dbId) return;
  const payload = await fetchJson('/api/seen/gallery', {
    method: 'POST',
    body: JSON.stringify({ galleryId: gallery.dbId }),
  });
  gallery.seenCount = payload.seenCount;
  gallery.seen = payload.seen;
  updateGallerySeenState(gallery.dbId, payload.seenCount, payload.seen);
  rememberGallerySeenOverride(gallery.dbId, payload.seenCount, payload.seen);
  patchCachedGallerySeenState(gallery.dbId, payload.seenCount, payload.seen, { allImages: true });
  for (const image of state.activeImages) {
    if (image.dbId === gallery.dbId) image.seen = true;
  }
  renderHeaderStats();
  renderModels();
  renderModelActionButtons();
  renderSelectedGalleryBar();
  renderGalleries();
  renderImageTiles();
  updateLightbox();
}

async function setGallerySeen(gallery, seen) {
  if (!state.user || !gallery?.dbId) return;
  const payload = await fetchJson('/api/seen/gallery', {
    method: seen ? 'POST' : 'DELETE',
    body: JSON.stringify({ galleryId: gallery.dbId }),
  });
  gallery.seenCount = payload.seenCount;
  gallery.seen = payload.seen;
  updateGallerySeenState(gallery.dbId, payload.seenCount, payload.seen);
  rememberGallerySeenOverride(gallery.dbId, payload.seenCount, payload.seen);
  patchCachedGallerySeenState(gallery.dbId, payload.seenCount, payload.seen, { allImages: true });
  for (const image of state.activeImages) {
    if (image.dbId === gallery.dbId) image.seen = Boolean(seen);
  }
  renderHeaderStats();
  renderModels();
  renderModelActionButtons();
  renderSelectedGalleryBar();
  renderGalleries();
  renderImageTiles();
  renderLightboxMeta();
}

async function saveUserSettings(settings) {
  const payload = await fetchJson('/api/auth/settings', {
    method: 'POST',
    body: JSON.stringify(settings),
  });
  state.user = payload.user || null;
  render();
  syncPreloadForCurrentView();
}

async function setModelSeen(model, seen) {
  if (!state.user || !model?.id) return;
  const payload = await fetchJson('/api/seen/model', {
    method: seen ? 'POST' : 'DELETE',
    body: JSON.stringify({ modelId: model.id }),
  });
  const seenByGalleryId = new Map((payload.galleries || []).map(item => [item.galleryId, item]));
  for (const gallery of model.galleries || []) {
    const summary = seenByGalleryId.get(gallery.dbId);
    if (!summary) continue;
    gallery.seenCount = summary.seenCount;
    gallery.seen = seen ? summary.count > 0 && summary.seenCount >= summary.count : false;
    updateGallerySeenState(gallery.dbId, gallery.seenCount, gallery.seen);
    rememberGallerySeenOverride(gallery.dbId, gallery.seenCount, gallery.seen);
    patchCachedGallerySeenState(gallery.dbId, gallery.seenCount, gallery.seen, { allImages: true });
  }
  for (const image of state.activeImages) {
    if (seenByGalleryId.has(image.dbId)) image.seen = Boolean(seen);
  }
  recomputeModelSeen(model);
  renderHeaderStats();
  renderModels();
  renderModelActionButtons();
  renderSelectedGalleryBar();
  renderGalleries();
  renderImageTiles();
  updateLightbox();
}

async function toggleImageFavorite(image) {
  if (!state.user || !image.dbId) return;
  const favorite = !image.favorite;
  const payload = await fetchJson('/api/favorites/image', {
    method: favorite ? 'POST' : 'DELETE',
    body: JSON.stringify({ galleryId: image.dbId, imageName: image.name }),
  });
  const nextFavorite = Boolean(payload.favorite);
  image.favorite = nextFavorite;
  updateImageFavoriteState(image.dbId, image.name, nextFavorite);
  updateFavoriteCount(payload, nextFavorite);
  if (state.mode === 'favorites') {
    await loadFavorites();
    renderLightboxMeta();
    return;
  }
  renderImageTiles();
  renderLightboxMeta();
}

function renderModels() {
  const filter = searchText(els.search.value);
  const allModels = state.data?.models || [];
  const honorHideSeen = !filter && state.hideSeenModels;
  const totalModels = allModels.filter(model => !honorHideSeen || !model.seen);
  const models = totalModels.filter(model => {
    return searchText(model.name).includes(filter);
  });
  const count = sidebarVisibleCount();
  const selected = state.selectedModel ? models.find(model => model.id === state.selectedModel) || null : null;
  const pool = selected ? models.filter(model => model.id !== selected.id) : models.slice();
  const randomizeModels = shouldRandomizeSidebarModels(filter);
  const orderedPool = randomizeModels
    ? shuffledModels(pool, sidebarShuffleVersion + models.length)
    : pool;
  const visibleModels = (selected ? [selected, ...orderedPool] : orderedPool).slice(0, count);
  const renderKey = JSON.stringify({
    filter,
    hideSeenModels: honorHideSeen,
    randomizeModels,
    sidebarShuffleVersion,
    count,
    selectedModel: state.selectedModel,
    totalModels: totalModels.length,
    visibleModels: visibleModels.map(model => ({
      id: model.id,
      name: model.name,
      cover: model.cover,
      galleryCount: model.galleryCount,
      count: model.count,
      updatedAt: model.updatedAt,
      seen: model.seen,
    })),
  });

  if (els.modelCount) els.modelCount.textContent = `${formatCount(visibleModels.length)} shown (${formatCount(totalModels.length)} total)`;
  if (renderKey === lastModelListRenderKey) {
    fitSidebarToRenderedCards();
    return;
  }
  lastModelListRenderKey = renderKey;
  els.modelList.innerHTML = '';

  if (!models.length) {
    els.modelList.innerHTML = `<div class="empty">${state.hideSeenModels ? 'No unseen models found.' : 'No models found.'}</div>`;
    fitSidebarToRenderedCards();
    return;
  }

  for (const model of visibleModels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-card${model.id === state.selectedModel ? ' is-active' : ''}`;
    const previewCover = sidebarPreviewCover(model);
    button.innerHTML = `
      <img loading="lazy" decoding="async" src="${previewCover || ''}" alt="">
      <div>
        <div class="card-title">${titleCase(model.name)}</div>
        <div class="card-sub">${formatCount(model.galleryCount)} galleries · ${formatCount(model.count)} images</div>
        <div class="card-sub">Updated ${formatDate(model.updatedAt)}</div>
      </div>
    `;
    if (model.seen) {
      const badge = document.createElement('span');
      badge.className = 'seen-badge';
      badge.textContent = '✓';
      button.append(badge);
    }
    bindCardImageLoading(button, button.querySelector('img'));
    bindSidebarPreview(button, previewCover, titleCase(model.name));
    button.addEventListener('click', () => {
      openModel(model.id);
      render();
    });
    els.modelList.append(button);
  }
  fitSidebarToRenderedCards();
}

function renderSelectedGalleryBar() {
  syncActiveGallerySeenState();
  const model = currentModel();
  const gallery = currentGallery();
  els.selectedGalleryBar.innerHTML = '';
  els.selectedGalleryBar.hidden = !model || !gallery;
  if (!model || !gallery) return;

  const index = model.galleries.findIndex(item => item.id === gallery.id);
  els.galleryKicker.textContent = titleCase(model.name);
  els.galleryTitle.textContent = `Gallery ${gallery.name}`;

  const coverWrap = document.createElement('div');
  coverWrap.className = 'selected-gallery-cover';
  const cover = document.createElement('img');
  cover.src = gallery.cover || '';
  cover.alt = '';
  coverWrap.append(cover);
  bindCardImageLoading(coverWrap, cover);
  if (gallery.seen) {
    const seen = document.createElement('button');
    seen.type = 'button';
    seen.className = 'seen-badge image-seen-toggle';
    setTooltip(seen, state.user ? 'Mark gallery unseen' : 'Login to mark unseen');
    seen.textContent = '✓';
    seen.disabled = !state.user;
    seen.addEventListener('click', event => {
      event.stopPropagation();
      setGallerySeen(gallery, false).catch(error => showNotice(error.message));
    });
    coverWrap.append(seen);
  }

  const meta = document.createElement('div');
  meta.className = 'selected-gallery-main';
  meta.innerHTML = `
    <div class="selected-gallery-title">Gallery ${gallery.name}</div>
    <div class="card-sub">${formatCount(gallery.count)} images</div>
    <div class="card-sub">${formatDate(gallery.updatedAt)}</div>
  `;

  const actions = document.createElement('div');
  actions.className = 'selected-gallery-actions';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'gallery-action-btn';
  prev.textContent = 'Previous';
  prev.disabled = index <= 0;
  prev.addEventListener('click', () => stepGallery(-1));

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'gallery-action-btn';
  next.textContent = 'Next';
  next.disabled = index < 0 || index >= model.galleries.length - 1;
  next.addEventListener('click', () => stepGallery(1));

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'gallery-action-btn';
  toggle.textContent = state.galleryListExpanded ? 'Hide galleries' : 'All galleries';
  toggle.addEventListener('click', () => {
    state.galleryListExpanded = !state.galleryListExpanded;
    render();
  });

  const markSeen = document.createElement('button');
  markSeen.type = 'button';
  markSeen.className = 'gallery-action-btn gallery-seen-btn';
  markSeen.textContent = gallery.seen ? 'Mark unseen' : 'Mark seen';
  markSeen.disabled = !state.user;
  markSeen.classList.toggle('is-seen-action', !gallery.seen);
  markSeen.addEventListener('click', () => {
    setGallerySeen(gallery, !gallery.seen).catch(error => showNotice(error.message));
  });

  const fav = favoriteButton(gallery.favorite, 'Favorite gallery');
  fav.addEventListener('click', () => {
    toggleGalleryFavorite(gallery).catch(error => showNotice(error.message));
  });

  actions.append(toggle, prev, next, markSeen, fav);
  els.selectedGalleryBar.append(coverWrap, meta, actions);
}

function renderGalleries() {
  const model = currentModel();
  els.galleryList.innerHTML = '';
  const selectedGallery = currentGallery();
  const collapsed = Boolean(model && selectedGallery && !state.galleryListExpanded);
  els.galleryList.hidden = state.mode === 'models' || state.mode === 'favorites' || collapsed;
  els.galleryList.classList.toggle('latest-gallery-list', state.mode === 'home');

  if (state.mode === 'models' || state.mode === 'favorites' || collapsed) return;

  if (state.mode === 'model' && state.selectedModel && !model) {
    els.galleryKicker.textContent = 'Model';
    els.galleryTitle.textContent = 'Loading galleries';
    els.galleryList.hidden = false;
    els.galleryList.innerHTML = '<div class="empty">Loading model galleries...</div>';
    return;
  }

  if (!model) {
    const latest = latestGalleries();
    els.galleryKicker.textContent = 'Latest';
    els.galleryTitle.textContent = 'Galleries';
    for (const gallery of latest) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-card latest-gallery-card';
      button.innerHTML = `
        <img loading="lazy" decoding="async" src="${gallery.cover || ''}" alt="">
        <div>
          <div class="card-title">${titleCase(gallery.modelName)} / ${gallery.name}</div>
          <div class="card-sub">${formatCount(gallery.count)} images · ${formatDate(gallery.addedAt || gallery.updatedAt)}</div>
        </div>
      `;
      if (gallery.seen) {
        const badge = document.createElement('span');
        badge.className = 'seen-badge';
        badge.textContent = '✓';
        button.append(badge);
      }
      bindCardImageLoading(button, button.querySelector('img'));
      const fav = favoriteButton(gallery.favorite, 'Favorite gallery');
      fav.addEventListener('click', event => {
        event.stopPropagation();
        toggleGalleryFavorite(gallery).catch(error => showNotice(error.message));
      });
      button.append(fav);
      button.addEventListener('click', () => {
        openGallery(gallery.modelId, gallery.id);
        render();
      });
      els.galleryList.append(button);
    }
    return;
  }

  els.galleryKicker.textContent = titleCase(model.name);
  els.galleryTitle.textContent = 'Galleries';

  for (const gallery of model.galleries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `gallery-card latest-gallery-card${gallery.id === state.selectedGallery ? ' is-active' : ''}`;
    button.innerHTML = `
      <img loading="lazy" decoding="async" src="${gallery.cover || ''}" alt="">
      <div>
        <div class="card-title">Gallery ${gallery.name}</div>
        <div class="card-sub">${formatCount(gallery.count)} images · ${formatDate(gallery.updatedAt)}</div>
      </div>
    `;
    if (gallery.seen) {
      const seen = document.createElement('button');
      seen.type = 'button';
      seen.className = 'seen-badge image-seen-toggle';
      setTooltip(seen, state.user ? 'Mark gallery unseen' : 'Login to mark unseen');
      seen.textContent = '✓';
      seen.disabled = !state.user;
      seen.addEventListener('click', event => {
        event.stopPropagation();
        setGallerySeen(gallery, false).catch(error => showNotice(error.message));
      });
      button.append(seen);
    }
    bindCardImageLoading(button, button.querySelector('img'));
    const fav = favoriteButton(gallery.favorite, 'Favorite gallery');
    fav.addEventListener('click', event => {
      event.stopPropagation();
      toggleGalleryFavorite(gallery).catch(error => showNotice(error.message));
    });
    button.append(fav);
    button.addEventListener('click', () => {
      openGallery(model.id, gallery.id);
      render();
    });
    els.galleryList.append(button);
  }
}

function renderImages() {
  const gallery = currentGallery();
  els.imageGrid.innerHTML = '';
  els.imageGrid.hidden = state.mode !== 'model' || !gallery;

  if (state.mode === 'favorites') {
    els.imageGrid.hidden = true;
    els.imageGrid.innerHTML = '';
    return;
  }

  if (state.mode === 'model' && state.selectedGallery && !gallery) {
    els.imageGrid.hidden = false;
    els.imageGrid.innerHTML = '<div class="empty">Loading gallery images...</div>';
    return;
  }

  if (!gallery) {
    resetActiveImages();
    els.imageGrid.innerHTML = '';
    return;
  }

  if (state.activeGalleryId !== gallery.id) {
    state.activeGalleryId = gallery.id;
    state.activeImages = [];
    state.imagesLoading = true;
    renderImageLoadingTiles(gallery);
    loadGalleryImages(gallery);
    return;
  }
  if (state.imagesLoading) {
    renderImageLoadingTiles(gallery);
    return;
  }
  renderImageTiles();
}

function renderFavoritesLoading() {
  const count = Number(state.user?.favoriteCount || 0);
  const countText = count ? `Loading ${formatCount(count)} favorites` : 'Loading favorites';
  els.favoritesView.innerHTML = `
    <div class="favorites-loading">
      <strong>${countText}</strong>
      <span>Preparing saved models, galleries, and images. Large favorite lists can take a moment.</span>
      <div class="favorites-loading-bar" aria-hidden="true"></div>
    </div>
  `;
}

function createFavoriteImageItem(image, activeImages) {
  const item = document.createElement('div');
  item.className = 'favorite-image-item';

  const openImage = document.createElement('button');
  openImage.type = 'button';
  openImage.className = 'favorite-image-card';
  openImage.innerHTML = `
    <img loading="lazy" decoding="async" src="${image.thumb}" alt="">
    <div class="favorite-image-meta">
      <div class="card-title">${titleCase(image.modelName)} / ${image.galleryName}</div>
    </div>
  `;
  const thumb = openImage.querySelector('img');
  thumb.addEventListener('error', () => {
    if (thumb.getAttribute('src') !== image.src) thumb.src = image.src;
  }, { once: true });
  if (image.seen) {
    const badge = document.createElement('span');
    badge.className = 'seen-badge';
    badge.textContent = '✓';
    openImage.append(badge);
  }
  bindCardImageLoading(openImage, thumb);
  const fav = favoriteButton(true, 'Unfavorite image');
  fav.addEventListener('click', event => {
    event.stopPropagation();
    toggleImageFavorite(image).catch(error => showNotice(error.message));
  });
  openImage.append(fav);
  openImage.addEventListener('click', () => {
    state.activeGalleryId = 'favorites';
    state.activeImages = activeImages;
    const index = activeImages.findIndex(entry => entry.dbId === image.dbId && entry.name === image.name);
    openLightbox(Math.max(0, index));
  });

  const actions = document.createElement('div');
  actions.className = 'favorite-image-actions';
  const galleryButton = document.createElement('button');
  galleryButton.type = 'button';
  galleryButton.textContent = 'Gallery';
  galleryButton.addEventListener('click', () => {
    openGallery(image.modelId, image.galleryId);
    render();
  });
  const modelButton = document.createElement('button');
  modelButton.type = 'button';
  modelButton.textContent = 'Model';
  modelButton.addEventListener('click', () => {
    openModel(image.modelId);
    render();
  });
  actions.append(galleryButton, modelButton);
  item.append(openImage, actions);
  return item;
}

async function loadFavoriteImageGroup(group, details, imageGrid, status, loadMore) {
  const key = group.modelId;
  const page = favoriteImageGroupPages.get(key) || { images: [], total: Number(group.count || 0), hasMore: true, loading: false };
  favoriteImageGroupPages.set(key, page);
  const rendered = Number(imageGrid.dataset.rendered || 0);
  for (const image of page.images.slice(rendered)) imageGrid.append(createFavoriteImageItem(image, page.images));
  imageGrid.dataset.rendered = String(page.images.length);
  if (page.loading || (!page.hasMore && page.images.length)) {
    status.hidden = true;
    loadMore.hidden = !page.hasMore;
    return;
  }

  page.loading = true;
  status.hidden = false;
  status.textContent = page.images.length ? 'Loading more favorites...' : 'Loading favorite images...';
  loadMore.hidden = true;
  try {
    const payload = await fetchJson(`/api/favorites/images?model=${encodeURIComponent(key)}&offset=${page.images.length}&limit=120`);
    page.images.push(...(payload.images || []));
    page.total = Number(payload.total || page.total);
    page.hasMore = Boolean(payload.hasMore);
    if (!details.isConnected) return;
    const nextRendered = Number(imageGrid.dataset.rendered || 0);
    for (const image of page.images.slice(nextRendered)) imageGrid.append(createFavoriteImageItem(image, page.images));
    imageGrid.dataset.rendered = String(page.images.length);
    loadMore.textContent = 'Load more';
    loadMore.hidden = !page.hasMore;
    syncGalleryBackdrop();
  } catch (error) {
    if (details.isConnected) {
      status.textContent = error.message || 'Failed to load favorite images.';
      status.hidden = false;
      loadMore.textContent = 'Retry';
      loadMore.hidden = false;
    }
    return;
  } finally {
    page.loading = false;
  }
  status.hidden = true;
}

async function openRandomFavoriteImages(button) {
  if (randomFavoritesLoading) return;
  randomFavoritesLoading = true;
  button.disabled = true;
  button.textContent = 'Loading...';
  try {
    const payload = await fetchJson('/api/favorites/images?random=1&limit=200');
    const images = payload.images || [];
    if (!images.length) return;
    state.activeGalleryId = 'favorites';
    state.activeImages = images;
    openLightbox(0);
  } catch (error) {
    showNotice(error.message);
  } finally {
    randomFavoritesLoading = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = 'Random';
    }
  }
}

function renderFavorites() {
  els.favoritesView.hidden = state.mode !== 'favorites';
  if (state.mode !== 'favorites') {
    els.favoritesView.innerHTML = '';
    return;
  }

  els.galleryKicker.textContent = 'Favorites';
  els.galleryTitle.textContent = 'Saved Galleries and Images';
  els.favoritesView.innerHTML = '';

  if (!state.user) {
    els.favoritesView.innerHTML = '<div class="empty">Login to view favorites.</div>';
    return;
  }

  if (!state.favorites) {
    if (state.favoritesError) {
      const errorBox = document.createElement('div');
      errorBox.className = 'favorites-loading favorites-load-error';
      const title = document.createElement('strong');
      title.textContent = 'Favorites failed to load';
      const message = document.createElement('span');
      message.textContent = state.favoritesError;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        state.favoritesError = null;
        renderFavorites();
      });
      errorBox.append(title, message, retry);
      els.favoritesView.append(errorBox);
      return;
    }
    renderFavoritesLoading();
    if (!state.favoritesLoading) loadFavorites().catch(error => showNotice(error.message));
    return;
  }

  const favoriteGalleries = state.favorites.galleries || [];
  const favoriteImageGroups = state.favorites.imageGroups || [];
  const favoriteImageCount = Number(state.favorites.imageCount || 0);
  const favoriteModels = state.favorites.models || [];
  if (!favoriteModels.length && !favoriteGalleries.length && !favoriteImageCount) {
    els.favoritesView.innerHTML = `
      <div class="empty favorites-empty">
        <strong>No favorites yet.</strong>
        <span>Star a model, gallery, or image and it will show up here.</span>
      </div>
    `;
    return;
  }

  const modelSection = document.createElement('section');
  modelSection.className = 'favorites-section';
  modelSection.innerHTML = `<h3>Favorite Models (${formatCount(favoriteModels.length)})</h3>`;
  const modelGrid = document.createElement('div');
  modelGrid.className = 'model-list';

  for (const model of favoriteModels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-card';
    button.innerHTML = `
      <img loading="lazy" decoding="async" src="${model.cover || ''}" alt="">
      <div>
        <div class="card-title">${titleCase(model.name)}</div>
        <div class="card-sub">${formatCount(model.galleryCount)} galleries · ${formatCount(model.count)} images</div>
        <div class="card-sub">Updated ${formatDate(model.updatedAt)}</div>
      </div>
    `;
    if (model.seen) {
      const badge = document.createElement('span');
      badge.className = 'seen-badge';
      badge.textContent = '✓';
      button.append(badge);
    }
    bindCardImageLoading(button, button.querySelector('img'));
    const fav = favoriteButton(true, 'Unfavorite model');
    fav.addEventListener('click', event => {
      event.stopPropagation();
      toggleModelFavorite(model).catch(error => showNotice(error.message));
    });
    button.append(fav);
    button.addEventListener('click', () => {
      openModel(model.id);
      render();
    });
    modelGrid.append(button);
  }

  modelSection.append(modelGrid);
  if (favoriteModels.length) els.favoritesView.append(modelSection);

  const gallerySection = document.createElement('section');
  gallerySection.className = 'favorites-section';
  gallerySection.innerHTML = `<h3>Favorite Galleries (${formatCount(favoriteGalleries.length)})</h3>`;
  const galleryGrid = document.createElement('div');
  galleryGrid.className = 'gallery-list latest-gallery-list';

  for (const gallery of favoriteGalleries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-card latest-gallery-card';
    button.innerHTML = `
      <img loading="lazy" decoding="async" src="${gallery.cover || ''}" alt="">
      <div>
        <div class="card-title">${titleCase(gallery.modelName)} / ${gallery.name}</div>
        <div class="card-sub">${gallery.count || 0} images · ${formatDate(gallery.updatedAt)}</div>
      </div>
    `;
    if (gallery.seen) {
      const badge = document.createElement('span');
      badge.className = 'seen-badge';
      badge.textContent = '✓';
      button.append(badge);
    }
    bindCardImageLoading(button, button.querySelector('img'));
    const fav = favoriteButton(true, 'Unfavorite gallery');
    fav.addEventListener('click', event => {
      event.stopPropagation();
      toggleGalleryFavorite(gallery).catch(error => showNotice(error.message));
    });
    button.append(fav);
    button.addEventListener('click', () => {
      openGallery(gallery.modelId, gallery.id);
      render();
    });
    galleryGrid.append(button);
  }

  gallerySection.append(galleryGrid);
  if (favoriteGalleries.length) els.favoritesView.append(gallerySection);

  const imageSection = document.createElement('section');
  imageSection.className = 'favorites-section';
  const imageHead = document.createElement('div');
  imageHead.className = 'favorites-section-head';
  imageHead.innerHTML = `<h3>Favorite Images (${formatCount(favoriteImageCount)})</h3>`;
  if (favoriteImageCount) {
    const randomButton = document.createElement('button');
    randomButton.type = 'button';
    randomButton.textContent = 'Random';
    randomButton.addEventListener('click', () => openRandomFavoriteImages(randomButton));
    imageHead.append(randomButton);
  }
  imageSection.append(imageHead);
  favoriteImageGroups.forEach((group) => {
    const details = document.createElement('details');
    details.className = 'favorite-image-group';

    const summary = document.createElement('summary');
    summary.className = 'favorite-image-group-summary';
    summary.innerHTML = `
      <span>${titleCase(group.modelName)}</span>
      <span>${formatCount(group.count)} image${Number(group.count) === 1 ? '' : 's'}</span>
    `;
    details.append(summary);

    const imageGrid = document.createElement('div');
    imageGrid.className = 'favorite-image-grid';
    const status = document.createElement('div');
    status.className = 'favorite-image-group-status';
    status.hidden = true;
    const loadMore = document.createElement('button');
    loadMore.type = 'button';
    loadMore.className = 'favorite-image-load-more';
    loadMore.textContent = 'Load more';
    loadMore.hidden = true;
    loadMore.addEventListener('click', () => loadFavoriteImageGroup(group, details, imageGrid, status, loadMore));
    details.addEventListener('toggle', () => {
      if (details.open && !imageGrid.childElementCount) {
        loadFavoriteImageGroup(group, details, imageGrid, status, loadMore);
      }
    });
    details.append(imageGrid, status, loadMore);
    imageSection.append(details);
  });

  if (favoriteImageCount) els.favoritesView.append(imageSection);
}

async function loadGalleryImages(gallery, attempt = 0) {
  try {
    const payload = await fetchGalleryPayload(gallery);
    if (state.activeGalleryId !== gallery.id) return;
    state.imagesLoading = false;
    state.activeImages = galleryImagesFromPayload(payload);
    syncActiveGallerySeenState();
    renderHeaderStats();
    renderModels();
    renderModelActionButtons();
    renderSelectedGalleryBar();
    renderImageTiles();
    syncGalleryBackdrop();
    if (state.user?.preloadGallery || state.user?.preloadModel) {
      preloadGalleryAssetsFromPayload(payload);
    }
  } catch (error) {
    if (state.activeGalleryId !== gallery.id) return;
    if (attempt < 1) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (state.activeGalleryId !== gallery.id) return;
      return loadGalleryImages(gallery, attempt + 1);
    }
    state.imagesLoading = false;
    els.imageGrid.innerHTML = '<div class="empty">Failed to load gallery images.</div>';
    showNotice(error.message);
  }
}

function renderImageLoadingTiles(gallery) {
  els.imageGrid.innerHTML = '';
  const placeholderCount = Math.max(8, Math.min(Number(gallery?.count || 12), 24));
  for (let index = 0; index < placeholderCount; index += 1) {
    const tile = document.createElement('div');
    tile.className = 'image-tile image-tile-loading';
    tile.innerHTML = `
      <div class="image-tile-skeleton"></div>
      <div class="image-tile-loading-bar"></div>
    `;
    els.imageGrid.append(tile);
  }
}

function renderImageTiles() {
  els.imageGrid.innerHTML = '';
  state.activeImages.forEach((image, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `image-tile${image.seen ? ' is-seen' : ''}`;
    button.innerHTML = `<img loading="lazy" src="${image.thumb}" alt="${image.name}">`;
    if (image.seen) {
      const seen = document.createElement('button');
      seen.type = 'button';
      seen.className = 'seen-badge image-seen-toggle';
      setTooltip(seen, state.user ? 'Mark image unseen' : 'Login to mark unseen');
      seen.textContent = '✓';
      seen.disabled = !state.user;
      seen.addEventListener('click', event => {
        event.stopPropagation();
        setImageSeen(image, false).catch(error => showNotice(error.message));
      });
      button.append(seen);
    }
    const fav = favoriteButton(image.favorite, 'Favorite image');
    fav.addEventListener('click', event => {
      event.stopPropagation();
      toggleImageFavorite(image).catch(error => showNotice(error.message));
    });
    button.append(fav);
    bindCardImageLoading(button, button.querySelector('img'));
    button.addEventListener('click', () => {
      const currentIndex = state.activeImages.findIndex(item => item.dbId === image.dbId && item.name === image.name);
      openLightbox(currentIndex >= 0 ? currentIndex : index);
    });
    els.imageGrid.append(button);
  });
}

function modelInitial(model) {
  const first = titleCase(model.name).charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

function modelsForBrowser() {
  const models = (state.data?.models || []).slice().sort((a, b) => titleCase(a.name).localeCompare(titleCase(b.name)));
  if (state.modelBrowserLetter === 'all') return models;
  return models.filter(model => modelInitial(model) === state.modelBrowserLetter);
}

function renderModelBrowser() {
  els.modelBrowser.hidden = state.mode !== 'models';
  if (state.mode !== 'models') {
    els.modelBrowser.innerHTML = '';
    return;
  }

  const letters = ['all', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
  const models = modelsForBrowser();
  const pageSize = 60;
  const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
  if (state.modelBrowserPage >= pageCount) state.modelBrowserPage = pageCount - 1;
  const start = state.modelBrowserPage * pageSize;
  const visible = models.slice(start, start + pageSize);

  els.galleryKicker.textContent = 'Models';
  els.galleryTitle.textContent = state.modelBrowserLetter === 'all' ? 'All Models' : `Models: ${state.modelBrowserLetter}`;
  els.modelBrowser.innerHTML = '';

  const letterBar = document.createElement('div');
  letterBar.className = 'letter-bar';
  for (const letter of letters) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = letter === state.modelBrowserLetter ? 'is-active' : '';
    button.textContent = letter === 'all' ? 'All' : letter;
    button.addEventListener('click', () => {
      state.modelBrowserLetter = letter;
      state.modelBrowserPage = 0;
      render();
    });
    letterBar.append(button);
  }
  els.modelBrowser.append(letterBar);

  const grid = document.createElement('div');
  grid.className = 'browser-model-grid';
  for (const model of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'browser-model-card';
    button.innerHTML = `
      <img loading="lazy" decoding="async" src="${model.cover || ''}" alt="">
      <div>
        <div class="card-title">${titleCase(model.name)}</div>
            <div class="card-sub">${formatCount(model.galleryCount)} galleries · ${formatCount(model.count)} images</div>
        <div class="card-sub">Updated ${formatDate(model.updatedAt)}</div>
      </div>
    `;
    if (model.seen) {
      const badge = document.createElement('span');
      badge.className = 'seen-badge';
      badge.textContent = '✓';
      button.append(badge);
    }
    bindCardImageLoading(button, button.querySelector('img'));
    button.addEventListener('click', () => {
      openModel(model.id);
      render();
    });
    grid.append(button);
  }
  els.modelBrowser.append(grid);

  const pager = document.createElement('div');
  pager.className = 'pager-row';
  pager.innerHTML = `
    <button type="button" ${state.modelBrowserPage === 0 ? 'disabled' : ''}>Previous</button>
    <span>${models.length ? start + 1 : 0}-${Math.min(start + pageSize, models.length)} of ${models.length}</span>
    <button type="button" ${state.modelBrowserPage >= pageCount - 1 ? 'disabled' : ''}>Next</button>
  `;
  const [prev, next] = pager.querySelectorAll('button');
  prev.addEventListener('click', () => {
    state.modelBrowserPage = Math.max(0, state.modelBrowserPage - 1);
    render();
  });
  next.addEventListener('click', () => {
    state.modelBrowserPage = Math.min(pageCount - 1, state.modelBrowserPage + 1);
    render();
  });
  els.modelBrowser.append(pager);
}

function lockLightboxScroll() {
  const shouldLock = window.matchMedia('(max-width: 820px), (pointer: coarse)').matches;
  if (!shouldLock) return;
  if (document.body.classList.contains('lightbox-scroll-locked')) return;
  lightboxScrollY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.top = `-${lightboxScrollY}px`;
  document.body.classList.add('lightbox-scroll-locked');
}

function unlockLightboxScroll() {
  if (!document.body.classList.contains('lightbox-scroll-locked')) return;
  document.body.classList.remove('lightbox-scroll-locked');
  document.body.style.top = '';
  window.scrollTo(0, lightboxScrollY);
}

function pushLightboxHistory() {
  if (lightboxHistoryActive || window.history.state?.lightbox) return;
  window.history.pushState({ ...(window.history.state || {}), lightbox: true }, '', window.location.href);
  lightboxHistoryActive = true;
}

function openLightbox(index) {
  state.lightboxIndex = index;
  lockLightboxScroll();
  pushLightboxHistory();
  els.lightbox.hidden = false;
  updateLightbox();
  markActiveImageSeen();
}

function markActiveImageSeen() {
  const image = state.activeImages[state.lightboxIndex];
  if (image?.dbId) recordView({ type: 'image', galleryDbId: image.dbId, imageName: image.name });
  if (image && !image.seen) setImageSeen(image, true).catch(error => showNotice(error.message));
}

function closeLightbox(options = {}) {
  els.lightbox.hidden = true;
  unlockLightboxScroll();
  clearTimeout(lightboxLoadingTimer);
  clearTimeout(lightboxErrorTimer);
  state.lightboxRequestId += 1;
  state.lightboxLoading = false;
  state.lightboxError = false;
  els.lightboxImg.dataset.requestId = String(state.lightboxRequestId);
  els.lightboxImg.removeAttribute('src');
  els.lightboxImg.classList.add('is-pending');
  els.lightboxImg.classList.remove('is-loading', 'is-error');
  els.lightboxLoading.hidden = true;
  if (!options.fromHistory && lightboxHistoryActive && window.history.state?.lightbox) {
    lightboxHistoryActive = false;
    window.history.back();
    return;
  }
  if (options.fromHistory) lightboxHistoryActive = false;
}

function downloadActiveImage() {
  const image = state.activeImages[state.lightboxIndex];
  if (!image?.src) return;
  const link = document.createElement('a');
  link.href = image.src;
  link.download = image.name || '';
  document.body.append(link);
  link.click();
  link.remove();
}

function renderLightboxLoadState() {
  els.lightboxLoading.hidden = !(state.lightboxLoading || state.lightboxError);
  els.lightboxLoading.classList.toggle('is-error', state.lightboxError);
  els.lightboxImg.classList.toggle('is-loading', state.lightboxLoading);
  els.lightboxImg.classList.toggle('is-error', state.lightboxError);
  els.lightboxLoadingText.textContent = state.lightboxError ? 'Image failed to load' : 'Loading...';
  const image = state.activeImages[state.lightboxIndex];
  els.lightboxDownload.disabled = Boolean(state.lightboxLoading || state.lightboxError || !image?.src);
  setTooltip(els.lightboxDownload, state.lightboxError ? 'Image unavailable' : 'Download image');
}

function renderLightboxMeta() {
  const gallery = currentGallery();
  const image = state.activeImages[state.lightboxIndex];
  if (!image) return;
  const modelName = image.modelName || currentModel()?.name || '';
  const galleryName = image.galleryName || gallery?.name || '';
  els.lightboxCaption.textContent = `${titleCase(modelName)} / Gallery ${galleryName} / ${image.name}`;
  els.lightboxSeen.textContent = image.seen ? '✓' : '○';
  els.lightboxSeen.classList.toggle('is-seen', Boolean(image.seen));
  els.lightboxSeen.disabled = !state.user || !image.dbId;
  setTooltip(els.lightboxSeen, state.user ? (image.seen ? 'Mark unseen' : 'Mark seen') : 'Login to mark seen');
  els.lightboxFavorite.textContent = image.favorite ? '★' : '☆';
  els.lightboxFavorite.classList.toggle('is-favorite', Boolean(image.favorite));
  els.lightboxFavorite.disabled = !state.user || !image.dbId;
  setTooltip(els.lightboxFavorite, state.user ? 'Favorite image' : 'Login to favorite');
  els.prevImage.disabled = state.lightboxIndex <= 0;
  els.nextImage.disabled = state.lightboxIndex >= state.activeImages.length - 1;
}

function updateLightbox() {
  const image = state.activeImages[state.lightboxIndex];
  if (!image) return;
  const requestId = state.lightboxRequestId + 1;
  state.lightboxRequestId = requestId;
  state.lightboxLoading = false;
  state.lightboxError = false;
  clearTimeout(lightboxLoadingTimer);
  clearTimeout(lightboxErrorTimer);
  els.lightboxImg.dataset.requestId = String(requestId);
  els.lightboxImg.classList.add('is-pending');
  els.lightboxImg.src = image.src;
  renderLightboxMeta();

  if (els.lightboxImg.complete && els.lightboxImg.naturalWidth) {
    els.lightboxImg.classList.remove('is-pending');
    state.lightboxLoading = false;
    state.lightboxError = false;
    renderLightboxLoadState();
    warmDecodedLightboxWindow(state.lightboxIndex);
  } else {
    renderLightboxLoadState();
    lightboxLoadingTimer = setTimeout(() => {
      if (Number(els.lightboxImg.dataset.requestId || 0) !== requestId) return;
      if (els.lightboxImg.complete) return;
      els.lightboxImg.classList.remove('is-pending');
      state.lightboxLoading = true;
      renderLightboxLoadState();
    }, 250);
    warmDecodedLightboxWindow(state.lightboxIndex);
  }
}

function stepLightbox(delta) {
  if (!state.activeImages.length) return;
  const nextIndex = state.lightboxIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.activeImages.length) return;
  state.lightboxIndex = nextIndex;
  updateLightbox();
  markActiveImageSeen();
}

function lightboxControlTarget(target) {
  return Boolean(target?.closest?.('button, a, input, textarea, select'));
}

function isViewportZoomed() {
  return Number(window.visualViewport?.scale || 1) > 1.02;
}

function handleLightboxTouchStart(event) {
  if (els.lightbox.hidden || lightboxControlTarget(event.target) || event.touches.length !== 1 || isViewportZoomed()) {
    lightboxTouch = null;
    return;
  }
  const touch = event.touches[0];
  lightboxTouch = {
    startX: touch.clientX,
    startY: touch.clientY,
    lastX: touch.clientX,
    lastY: touch.clientY,
    startedAt: Date.now(),
  };
}

function handleLightboxTouchMove(event) {
  if (!lightboxTouch || event.touches.length !== 1 || isViewportZoomed()) {
    lightboxTouch = null;
    return;
  }
  event.preventDefault();
  const touch = event.touches[0];
  lightboxTouch.lastX = touch.clientX;
  lightboxTouch.lastY = touch.clientY;
}

function handleLightboxTouchEnd() {
  if (!lightboxTouch) return;
  if (isViewportZoomed()) {
    lightboxTouch = null;
    return;
  }
  const deltaX = lightboxTouch.lastX - lightboxTouch.startX;
  const deltaY = lightboxTouch.lastY - lightboxTouch.startY;
  const elapsed = Date.now() - lightboxTouch.startedAt;
  lightboxTouch = null;
  if (elapsed > 900) return;
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return;
  stepLightbox(deltaX < 0 ? 1 : -1);
}

async function loadState() {
  const response = await fetch('/api/state', { cache: 'no-store' });
  setData(await response.json());
}

async function loadCurrentUser() {
  const payload = await fetchJson('/api/auth/me', { method: 'GET' });
  const previousUserId = state.user?.id || null;
  state.user = payload.user || null;
  if ((state.user?.id || null) !== previousUserId) state.userStats = null;
  renderAuth();
  syncUserOnlyUi();
  renderHeaderStats();
  renderFavoritesButton();
}

async function loadCurrentUserStats() {
  if (!state.user) {
    state.userStats = null;
    renderHeaderStats();
    return;
  }
  const userId = state.user.id;
  const payload = await fetchJson('/api/auth/stats', { method: 'GET' });
  if (state.user?.id !== userId) return;
  state.userStats = payload.stats || null;
  renderHeaderStats();
}

async function loadFavorites() {
  if (favoritesLoadPromise) return favoritesLoadPromise;
  state.favoritesLoading = true;
  state.favoritesError = null;
  favoritesLoadPromise = fetchJson('/api/favorites')
    .then(payload => {
      state.favorites = payload;
      if (state.favorites.user) state.user = state.favorites.user;
      favoriteImageGroupPages = new Map();
      render();
      return payload;
    })
    .catch(error => {
      state.favoritesError = error.message || 'Failed to load favorites.';
      render();
      throw error;
    })
    .finally(() => {
      state.favoritesLoading = false;
      favoritesLoadPromise = null;
    });
  return favoritesLoadPromise;
}

els.search.addEventListener('input', renderModels);
els.hideSeenModels.addEventListener('change', () => {
  state.hideSeenModels = els.hideSeenModels.checked;
  writeStoredFlag(STORAGE_KEYS.hideSeenModels, state.hideSeenModels);
  renderModels();
});
els.home.addEventListener('click', (event) => {
  event.preventDefault();
  setMajorMode('home');
  syncRoute();
  render();
});
els.browseModels.addEventListener('click', (event) => {
  event.preventDefault();
  setMajorMode('models');
  syncRoute();
  render();
});
els.modelFavoriteButton?.addEventListener('click', () => {
  const model = currentModel();
  if (!model) return;
  toggleModelFavorite(model).catch(error => showNotice(error.message));
});
els.modelSeenButton?.addEventListener('click', () => {
  const model = currentModel();
  if (!model) return;
  setModelSeen(model, !model.seen).catch(error => showNotice(error.message));
});
els.favoritesButton.addEventListener('click', () => {
  setMajorMode('favorites');
  state.favorites = null;
  state.favoritesError = null;
  syncRoute();
  render();
});
els.gridSmall.addEventListener('click', () => {
  setGridSize(false);
});
els.gridLarge.addEventListener('click', () => {
  setGridSize(true);
});
els.closeLightbox.addEventListener('click', closeLightbox);
els.lightboxDownload.addEventListener('click', event => {
  event.stopPropagation();
  downloadActiveImage();
});
els.lightboxImg.addEventListener('load', () => {
  if (els.lightbox.hidden) return;
  clearTimeout(lightboxLoadingTimer);
  clearTimeout(lightboxErrorTimer);
  const requestId = Number(els.lightboxImg.dataset.requestId || 0);
  if (requestId && requestId !== state.lightboxRequestId) return;
  els.lightboxImg.classList.remove('is-pending');
  state.lightboxLoading = false;
  state.lightboxError = false;
  const image = state.activeImages[state.lightboxIndex];
  if (image?.src === els.lightboxImg.currentSrc || image?.src === els.lightboxImg.src) {
    const decoded = new Image();
    decoded.decoding = 'async';
    decoded.loading = 'eager';
    decoded.src = image.src;
    if (decoded.complete && decoded.naturalWidth) rememberLightboxDecodedImage(image.src, decoded);
  }
  warmDecodedLightboxWindow(state.lightboxIndex);
  renderLightboxLoadState();
});
els.lightboxImg.addEventListener('error', () => {
  if (els.lightbox.hidden) return;
  const requestId = Number(els.lightboxImg.dataset.requestId || 0);
  if (requestId && requestId !== state.lightboxRequestId) return;
  const image = state.activeImages[state.lightboxIndex];
  if (!image || els.lightboxImg.getAttribute('src') !== image.src) return;

  // A late error from the previous src can arrive after this shared element
  // has started loading the next one. Do not let it fail the current request.
  if (!els.lightboxImg.complete) return;

  clearTimeout(lightboxErrorTimer);
  lightboxErrorTimer = setTimeout(() => {
    if (els.lightbox.hidden || requestId !== state.lightboxRequestId) return;
    const activeImage = state.activeImages[state.lightboxIndex];
    if (!activeImage || els.lightboxImg.getAttribute('src') !== activeImage.src) return;
    if (!els.lightboxImg.complete || els.lightboxImg.naturalWidth) return;
    clearTimeout(lightboxLoadingTimer);
    els.lightboxImg.classList.remove('is-pending');
    state.lightboxLoading = false;
    state.lightboxError = true;
    renderLightboxLoadState();
  }, 500);
});
els.lightboxFavorite.addEventListener('click', event => {
  event.stopPropagation();
  const image = state.activeImages[state.lightboxIndex];
  if (!image) return;
  toggleImageFavorite(image).catch(error => showNotice(error.message));
});
els.lightboxSeen.addEventListener('click', event => {
  event.stopPropagation();
  const image = state.activeImages[state.lightboxIndex];
  if (!image) return;
  setImageSeen(image, !image.seen).catch(error => showNotice(error.message));
});
els.prevImage.addEventListener('click', () => stepLightbox(-1));
els.nextImage.addEventListener('click', () => stepLightbox(1));
els.lightbox.addEventListener('click', event => {
  if (event.target === els.lightbox) closeLightbox();
});
els.lightbox.addEventListener('touchstart', handleLightboxTouchStart, { passive: true });
els.lightbox.addEventListener('touchmove', handleLightboxTouchMove, { passive: false });
els.lightbox.addEventListener('touchend', handleLightboxTouchEnd);
els.lightbox.addEventListener('touchcancel', () => { lightboxTouch = null; });
document.addEventListener('keydown', event => {
  if (!els.lightbox.hidden && (event.key === ' ' || event.key === 'Spacebar')) {
    event.preventDefault();
    const image = state.activeImages[state.lightboxIndex];
    if (image) toggleImageFavorite(image).catch(error => showNotice(error.message));
    return;
  }
  if (!els.lightbox.hidden && event.key === 'Escape') {
    event.preventDefault();
    closeLightbox();
    return;
  }
  if (!els.lightbox.hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    stepLightbox(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (event.target?.closest?.('input, textarea, select, button, a')) return;
  if ((event.key === ' ' || event.key === 'Spacebar') && state.mode === 'model') {
    event.preventDefault();
    if (state.selectedGallery) {
      if (state.activeImages.length) openLightbox(0);
      return;
    }
    const model = currentModel();
    const firstGallery = model?.galleries?.[0];
    if (model && firstGallery) {
      openGallery(model.id, firstGallery.id);
      render();
    }
    return;
  }
  if (state.mode === 'model' && state.selectedGallery && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    stepGallery(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
window.addEventListener('popstate', () => {
  if (!els.lightbox.hidden) {
    closeLightbox({ fromHistory: true });
    return;
  }
  const previousMode = state.mode;
  applyRouteFromLocation();
  if (state.mode !== previousMode && (state.mode === 'home' || state.mode === 'models' || state.mode === 'favorites')) {
    sidebarShuffleVersion += 1;
  }
  render();
  syncPreloadForCurrentView();
});

window.addEventListener('resize', () => {
  scheduleSidebarLayoutSync();
});

window.addEventListener('scroll', () => {
  scheduleSidebarLayoutSync();
}, { passive: true });

if (window.EventSource) {
  const source = new EventSource('/api/events');
  source.addEventListener('state', event => {
    const notice = JSON.parse(event.data);
    if (notice.app && state.data) {
      state.data = { ...state.data, app: { ...(state.data.app || {}), ...notice.app } };
      render();
    }
    if (notice.status === 'ready' || notice.status === 'error') {
      loadState().catch(error => showNotice(error.message));
    }
  });
  source.addEventListener('notice', event => {
    const notice = JSON.parse(event.data);
    showNotice(notice.message);
  });
}

initAppTooltips();
galleryBackdropMedia.addEventListener('change', () => syncGalleryBackdrop());
setGridSize(readStoredFlag(STORAGE_KEYS.largeThumbs, false));
state.hideSeenModels = readStoredFlag(STORAGE_KEYS.hideSeenModels, false);
if (els.hideSeenModels) els.hideSeenModels.checked = state.hideSeenModels;
syncUserOnlyUi();
applyRouteFromLocation(true);
fitSidebarToRenderedCards();
async function bootstrapApp() {
  try {
    await loadCurrentUser();
    await loadCurrentUserStats();
  } catch (error) {
    showNotice(error.message);
  }
  loadState().catch(error => showNotice(error.message));
}

bootstrapApp();
