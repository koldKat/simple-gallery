export function createAppPreferencesController({
  state,
  elements,
  storageKeys,
  storage,
  documentObject = document,
  render,
  syncPreloadForCurrentView,
}) {
  let preloadProgress = { total: 0, completed: 0 };
  let preloadProgressBar = null;

  function readStoredFlag(key, fallback = false) {
    try {
      const value = storage.getItem(key);
      if (value == null) return fallback;
      return value === '1';
    } catch {
      return fallback;
    }
  }

  function writeStoredFlag(key, value) {
    try {
      storage.setItem(key, value ? '1' : '0');
    } catch {
      // Keep the in-memory preference when browser storage is unavailable.
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
      preloadModel: readStoredFlag(storageKeys.anonPreloadModel, false),
      preloadGallery: readStoredFlag(storageKeys.anonPreloadGallery, false),
    };
  }

  function saveAnonymousPreloadSettings(settings) {
    writeStoredFlag(storageKeys.anonPreloadModel, Boolean(settings.preloadModel));
    writeStoredFlag(storageKeys.anonPreloadGallery, Boolean(settings.preloadGallery));
    render();
    syncPreloadForCurrentView();
  }

  function ensurePreloadProgressBar() {
    if (preloadProgressBar) return preloadProgressBar;
    const track = documentObject.createElement('div');
    track.className = 'preload-progress';
    track.hidden = true;
    const fill = documentObject.createElement('div');
    fill.className = 'preload-progress-fill';
    track.append(fill);
    elements.modelBrowser.parentNode.insertBefore(track, elements.modelBrowser);
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
    const ratio = Math.max(0, Math.min(1, preloadProgress.completed / preloadProgress.total));
    bar.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  function setPreloadProgress(nextProgress) {
    preloadProgress = nextProgress || { total: 0, completed: 0 };
    renderPreloadProgress();
  }

  function setGridSize(isLarge) {
    elements.imageGrid.classList.toggle('large', isLarge);
    elements.gridLarge.classList.toggle('is-active', isLarge);
    elements.gridSmall.classList.toggle('is-active', !isLarge);
    writeStoredFlag(storageKeys.largeThumbs, isLarge);
  }

  return {
    preloadPreferences,
    readStoredFlag,
    saveAnonymousPreloadSettings,
    setGridSize,
    setPreloadProgress,
    writeStoredFlag,
  };
}
