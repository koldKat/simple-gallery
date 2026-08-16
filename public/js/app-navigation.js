export function createAppNavigationController({
  state,
  location,
  history,
  parsePath,
  pathForState,
  releaseDecodedCache,
  resetPreloadScope,
  clearGalleryCache,
  applySeenOverrides,
  syncPreloadScope,
  syncPreloadForCurrentView,
  advanceSidebarShuffle,
  recordView,
  render,
}) {
  function currentModel() {
    if (state.mode !== 'model' || !state.selectedModel) return null;
    return state.data?.models.find(model => model.id === state.selectedModel) || null;
  }

  function currentGallery() {
    const model = currentModel();
    if (!model) return null;
    return model.galleries.find(gallery => gallery.id === state.selectedGallery) || null;
  }

  function resetActiveImages() {
    releaseDecodedCache();
    state.activeImages = [];
    state.activeGalleryId = null;
    state.imagesLoading = false;
  }

  function syncRoute(replace = false) {
    const next = pathForState(state);
    if (location.pathname === next) return;
    history[replace ? 'replaceState' : 'pushState']({}, '', next);
  }

  function setMode(mode) {
    state.selectedModel = null;
    state.selectedGallery = null;
    state.galleryListExpanded = false;
    resetActiveImages();
    state.mode = mode;
    syncPreloadScope();
  }

  function applyRouteFromLocation(replace = false) {
    const route = parsePath(location.pathname);
    if (route.mode === 'home' && route.recognized) {
      setMode('home');
    } else if (route.mode === 'models') {
      setMode('models');
    } else if (route.mode === 'favorites') {
      setMode('favorites');
    } else if (route.mode === 'model' && route.galleryName) {
      state.selectedModel = route.modelId;
      state.selectedGallery = `${route.modelId}/${route.galleryName}`;
      state.galleryListExpanded = false;
      resetActiveImages();
      state.mode = 'model';
    } else if (route.mode === 'model' && route.modelId) {
      state.selectedModel = route.modelId;
      state.selectedGallery = null;
      state.galleryListExpanded = true;
      resetActiveImages();
      state.mode = 'model';
    } else {
      setMode('home');
      if (replace) syncRoute(true);
    }
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

  function setMajorMode(mode) {
    advanceSidebarShuffle();
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
    const libraryChanged = Boolean(state.data && state.data.scannedAt !== data.scannedAt);
    if (libraryChanged) {
      resetPreloadScope();
      resetActiveImages();
    } else if (!state.data) {
      clearGalleryCache();
    }
    applySeenOverrides(data);
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

  return {
    applyRouteFromLocation,
    currentGallery,
    currentModel,
    openGallery,
    openModel,
    resetActiveImages,
    setData,
    setMajorMode,
    setMode,
    stepGallery,
    syncRoute,
  };
}
