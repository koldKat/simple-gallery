import { createAuthController } from './app-auth.js';
import { createBackdropController, uniqueBackdropUrls } from './app-backdrop.js';
import { initAppTooltips, setTooltip } from './app-tooltips.js';
import { createGalleryPayloadCache } from './app-gallery-cache.js';
import { createGalleryViewController } from './app-gallery-view.js';
import { createAppHeaderController } from './app-header.js';
import { createAppEventController } from './app-events.js';
import { createAppDataService } from './app-data.js';
import { createFavoritesController } from './app-favorites.js';
import { createFavoriteActionsController } from './app-favorite-actions.js';
import { createImagePreloader } from './app-preloader.js';
import { createAppPreferencesController } from './app-preferences.js';
import { createLightboxController } from './app-lightbox.js';
import { createModelNavigationController } from './app-model-navigation.js';
import { createAppNavigationController } from './app-navigation.js';
import { createSeenStateController } from './app-seen-state.js';
import {
  formatCount,
  formatDate,
  galleryPath,
  modelPath,
  parseAppPath,
  pathForState,
  searchText,
  shuffledModels,
  titleCase,
} from './app-utils.js';

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
  activeImageSource: null,
  user: null,
  userStats: null,
  userLibrary: emptyUserLibraryState(),
  favorites: null,
  favoritesLoading: false,
  favoritesError: null,
};

function emptyUserLibraryState() {
  return {
    loadedForUserId: null,
    favoriteModelIds: new Set(),
    favoriteGalleryIds: new Set(),
    gallerySeenCounts: new Map(),
    unseenStats: null,
  };
}

function clearUserLibraryState() {
  state.userLibrary = emptyUserLibraryState();
  state.userStats = null;
  applyUserLibraryState();
}

function applyUserLibraryState(payload = null) {
  if (!state.userLibrary) state.userLibrary = emptyUserLibraryState();
  if (payload) {
    state.userLibrary = {
      loadedForUserId: payload.user?.id || state.user?.id || null,
      favoriteModelIds: new Set(payload.favoriteModelIds || []),
      favoriteGalleryIds: new Set((payload.favoriteGalleryIds || []).map(Number)),
      gallerySeenCounts: new Map((payload.gallerySeenCounts || []).map(([galleryId, count]) => [Number(galleryId), Number(count || 0)])),
      unseenStats: payload.unseenStats || null,
    };
    state.userStats = payload.unseenStats || null;
  }
  const favoriteModelIds = state.userLibrary.favoriteModelIds;
  const favoriteGalleryIds = state.userLibrary.favoriteGalleryIds;
  const gallerySeenCounts = state.userLibrary.gallerySeenCounts;
  const applyGallery = gallery => {
    const count = Number(gallery.count || 0);
    const seenCount = Number(gallerySeenCounts.get(Number(gallery.dbId || 0)) || 0);
    gallery.favorite = Boolean(gallery.dbId && favoriteGalleryIds.has(Number(gallery.dbId)));
    gallery.seenCount = Math.min(seenCount, count);
    gallery.seen = count > 0 && gallery.seenCount >= count;
  };
  for (const model of state.data?.models || []) {
    model.favorite = favoriteModelIds.has(model.id);
    for (const gallery of model.galleries || []) applyGallery(gallery);
    recomputeModelSeen(model);
  }
  for (const gallery of state.data?.latest || []) applyGallery(gallery);
}

const STORAGE_KEYS = {
  hideSeenModels: 'simple-gallery:hide-seen-models',
  largeThumbs: 'simple-gallery:large-thumbs',
  anonPreloadModel: 'simple-gallery:anon-preload-model',
  anonPreloadGallery: 'simple-gallery:anon-preload-gallery',
};

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
    const imageCovers = favoritesController.backdropUrls();
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

const appPreferencesController = createAppPreferencesController({
  state,
  elements: els,
  storageKeys: STORAGE_KEYS,
  storage: window.localStorage,
  render: () => render(),
  syncPreloadForCurrentView: () => syncPreloadForCurrentView(),
});
const {
  preloadPreferences,
  readStoredFlag,
  saveAnonymousPreloadSettings,
  setGridSize,
  setPreloadProgress,
  writeStoredFlag,
} = appPreferencesController;

const appDataService = createAppDataService({
  state,
  getGalleryCache: () => galleryCache,
  setData: data => setData(data),
  applyUserLibraryState: payload => applyUserLibraryState(payload),
  clearUserLibraryState: () => clearUserLibraryState(),
  render: () => render(),
  renderAuth: () => renderAuth(),
  syncUserOnlyUi: () => syncUserOnlyUi(),
  renderHeaderStats: () => renderHeaderStats(),
  renderFavoritesButton: () => renderFavoritesButton(),
  syncPreloadForCurrentView: () => syncPreloadForCurrentView(),
  showNotice,
});
const {
  fetchGalleryPayload,
  fetchJson,
  galleryImagesFromPayload,
  galleryRequestUrl,
  latestGalleries,
  loadCurrentUser,
  loadCurrentUserStats,
  loadState,
  loadUserLibraryState,
  recordView,
  saveUserSettings,
} = appDataService;

const appNavigationController = createAppNavigationController({
  state,
  location: window.location,
  history: window.history,
  parsePath: parseAppPath,
  pathForState,
  releaseDecodedCache: () => releaseLightboxDecodedCache(),
  resetPreloadScope: () => imagePreloader.resetScope(),
  clearGalleryCache: () => galleryCache.clear(),
  applySeenOverrides: data => applyGallerySeenOverrides(data),
  syncPreloadScope: () => syncPreloadScope(),
  syncPreloadForCurrentView: () => syncPreloadForCurrentView(),
  advanceSidebarShuffle: () => advanceSidebarShuffle(),
  recordView,
  render: () => render(),
});
const {
  applyRouteFromLocation,
  currentGallery,
  currentModel,
  openGallery,
  openModel,
  resetActiveImages,
  setData,
  setMajorMode,
  stepGallery,
  syncRoute,
} = appNavigationController;
const appHeaderController = createAppHeaderController({
  state,
  elements: els,
  currentModel,
  currentGallery,
  syncActiveGallerySeenState: () => syncActiveGallerySeenState(),
  setTooltip,
  formatCount,
  titleCase,
});
const {
  renderFavoritesButton,
  renderMetadata: renderHeaderMetadata,
  renderModelActions: renderModelActionButtons,
  renderStats: renderHeaderStats,
  syncUserOnlyUi,
  updateFavoriteCount,
} = appHeaderController;

const backdropController = createBackdropController({
  getUrls: () => galleryBackdropContext().urls,
});
const syncGalleryBackdrop = options => backdropController.sync(options);
const seenStateController = createSeenStateController({
  state,
  getCurrentGallery: currentGallery,
  recomputeModelSeen,
  patchGalleryCache: (...args) => galleryCache.patchSeen(...args),
  fetchJson,
  renderHeaderStats: (...args) => renderHeaderStats(...args),
  renderModels: (...args) => renderModels(...args),
  renderModelActionButtons: (...args) => renderModelActionButtons(...args),
  patchActiveImageTile: (...args) => patchActiveImageTile(...args),
  renderSelectedGalleryBar: (...args) => renderSelectedGalleryBar(...args),
  renderGalleries: (...args) => renderGalleries(...args),
  renderImageTiles: (...args) => renderImageTiles(...args),
  renderLightboxMeta: (...args) => renderLightboxMeta(...args),
  updateLightbox: (...args) => updateLightbox(...args),
});
const {
  applyOverrides: applyGallerySeenOverrides,
  applyToPayload: applyKnownSeenStateToPayload,
  setGallerySeen,
  setImageSeen,
  setModelSeen,
  syncActiveGallery: syncActiveGallerySeenState,
} = seenStateController;
const galleryCache = createGalleryPayloadCache({
  requestUrl: galleryRequestUrl,
  mergePayload: applyKnownSeenStateToPayload,
});
const imagePreloader = createImagePreloader({
  getState: () => state,
  getPreferences: preloadPreferences,
  getCurrentModel: currentModel,
  getCurrentGallery: currentGallery,
  fetchGalleryPayload,
  clearGalleryCache: () => galleryCache.clear(),
  onProgress: setPreloadProgress,
});
const releaseLightboxDecodedCache = () => imagePreloader.releaseLightboxDecodedCache();
const syncPreloadScope = () => imagePreloader.syncScope();
const syncPreloadForCurrentView = () => imagePreloader.syncForCurrentView();
const preloadGalleryAssetsFromPayload = payload => imagePreloader.preloadPayload(payload);
const warmDecodedLightboxWindow = index => imagePreloader.warmDecodedWindow(index);
const favoriteActions = createFavoriteActionsController({
  state,
  setTooltip,
  fetchJson,
  galleryCache,
  getFavoritesController: () => favoritesController,
  updateFavoriteCount,
  loadFavorites: (...args) => loadFavorites(...args),
  render: (...args) => render(...args),
  renderImageTiles: (...args) => renderImageTiles(...args),
  renderLightboxMeta: (...args) => renderLightboxMeta(...args),
});
const {
  favoriteButton,
  toggleGallery: toggleGalleryFavorite,
  toggleImage: toggleImageFavorite,
  toggleModel: toggleModelFavorite,
} = favoriteActions;
const lightboxController = createLightboxController({
  state,
  elements: els,
  getCurrentGallery: currentGallery,
  getCurrentModel: currentModel,
  titleCase,
  setTooltip,
  recordView,
  setImageSeen,
  toggleImageFavorite,
  showNotice,
  warmDecodedWindow: warmDecodedLightboxWindow,
  rememberDecodedImage: (url, image) => imagePreloader.rememberDecodedImage(url, image),
  onClose: () => {
    favoritesController.flushPendingRefresh?.().catch(error => showNotice(error.message));
  },
});
const openLightbox = index => lightboxController.open(index);
const closeLightbox = options => lightboxController.close(options);
const updateLightbox = () => lightboxController.update();
const renderLightboxMeta = () => lightboxController.renderMeta();
const reconcileLightboxImages = () => lightboxController.reconcileActiveImages();
const favoritesController = createFavoritesController({
  state,
  elements: els,
  formatCount,
  formatDate,
  titleCase,
  fetchJson,
  bindCardImageLoading,
  favoriteButton,
  toggleImageFavorite,
  toggleGalleryFavorite,
  toggleModelFavorite,
  openLightbox,
  openGallery,
  openModel,
  render,
  showNotice,
  syncGalleryBackdrop,
});
const renderFavorites = () => favoritesController.render();
const loadFavorites = () => favoritesController.load();
const authController = createAuthController({
  state,
  authElement: els.auth,
  preloadPreferences,
  fetchJson,
  syncUserOnlyUi,
  renderHeaderStats,
  renderFavoritesButton,
  loadCurrentUserStats,
  loadState,
  saveUserSettings,
  saveAnonymousPreloadSettings,
  clearUserLibraryState: () => clearUserLibraryState(),
  showNotice,
});
const renderAuth = () => authController.render();
const modelNavigationController = createModelNavigationController({
  state,
  elements: els,
  searchText,
  shuffledModels,
  formatCount,
  formatDate,
  titleCase,
  bindCardImageLoading,
  openModel,
  render,
});
const renderModels = () => modelNavigationController.renderSidebar();
const renderModelBrowser = () => modelNavigationController.renderBrowser();
const fitSidebarToRenderedCards = () => modelNavigationController.fitSidebar();
const scheduleSidebarLayoutSync = () => modelNavigationController.scheduleLayoutSync();
const advanceSidebarShuffle = () => modelNavigationController.advanceShuffle();
const galleryViewController = createGalleryViewController({
  state,
  elements: els,
  currentModel,
  currentGallery,
  latestGalleries,
  syncActiveGallerySeenState,
  resetActiveImages,
  fetchGalleryPayload,
  galleryImagesFromPayload,
  renderHeaderStats,
  renderModels,
  renderModelActionButtons,
  syncGalleryBackdrop,
  preloadGalleryAssetsFromPayload,
  bindCardImageLoading,
  favoriteButton,
  toggleGalleryFavorite,
  toggleImageFavorite,
  setGallerySeen,
  setImageSeen,
  stepGallery,
  openGallery,
  openLightbox,
  reconcileLightboxImages,
  setTooltip,
  showNotice,
  formatCount,
  formatDate,
  titleCase,
  render,
});
const renderSelectedGalleryBar = () => galleryViewController.renderSelectedGalleryBar();
const renderGalleries = () => galleryViewController.renderGalleries();
const renderImages = () => galleryViewController.renderImages();
const renderImageTiles = () => galleryViewController.renderImageTiles();

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

function render() {
  const data = state.data;
  if (!data) return;
  const selectedModel = currentModel();

  renderHeaderMetadata();
  renderHeaderStats();
  if (els.hideSeenModels) els.hideSeenModels.checked = state.hideSeenModels;
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


function recomputeModelSeen(model) {
  const galleries = model?.galleries || [];
  const seenCount = galleries.reduce((sum, gallery) => sum + Number(gallery.seenCount || 0), 0);
  model.seenCount = seenCount;
  model.seen = Number(model.count || 0) > 0 && seenCount >= Number(model.count || 0);
}

const appEventController = createAppEventController({
  state,
  elements: els,
  storageKeys: STORAGE_KEYS,
  lightboxController,
  renderModels,
  renderAppMetadata: renderHeaderMetadata,
  writeStoredFlag,
  setMajorMode,
  syncRoute,
  render,
  currentModel,
  toggleModelFavorite,
  setModelSeen,
  showNotice,
  setGridSize,
  openLightbox,
  openGallery,
  stepGallery,
  closeLightbox,
  applyRouteFromLocation,
  advanceSidebarShuffle,
  syncPreloadForCurrentView,
  scheduleSidebarLayoutSync,
  loadState,
  initTooltips: initAppTooltips,
  readStoredFlag,
  syncUserOnlyUi,
  fitSidebarToRenderedCards,
  loadCurrentUser,
  loadCurrentUserStats,
});
appEventController.start();
