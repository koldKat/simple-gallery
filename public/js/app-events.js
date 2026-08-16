export function createAppEventController({
  state,
  elements,
  documentObject = document,
  windowObject = window,
  storageKeys,
  lightboxController,
  renderModels,
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
  initTooltips,
  readStoredFlag,
  syncUserOnlyUi,
  fitSidebarToRenderedCards,
  loadCurrentUser,
  loadCurrentUserStats,
}) {
  function handleDocumentKeydown(event) {
    if (lightboxController.handleKeydown(event)) return;
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
  }

  function handlePopState() {
    if (lightboxController.isOpen()) {
      closeLightbox({ fromHistory: true });
      return;
    }
    const previousMode = state.mode;
    applyRouteFromLocation();
    if (state.mode !== previousMode && ['home', 'models', 'favorites'].includes(state.mode)) {
      advanceSidebarShuffle();
    }
    render();
    syncPreloadForCurrentView();
  }

  function bindControls() {
    elements.search.addEventListener('input', renderModels);
    elements.hideSeenModels.addEventListener('change', () => {
      state.hideSeenModels = elements.hideSeenModels.checked;
      writeStoredFlag(storageKeys.hideSeenModels, state.hideSeenModels);
      renderModels();
    });
    elements.home.addEventListener('click', event => {
      event.preventDefault();
      setMajorMode('home');
      syncRoute();
      render();
    });
    elements.browseModels.addEventListener('click', event => {
      event.preventDefault();
      setMajorMode('models');
      syncRoute();
      render();
    });
    elements.modelFavoriteButton?.addEventListener('click', () => {
      const model = currentModel();
      if (model) toggleModelFavorite(model).catch(error => showNotice(error.message));
    });
    elements.modelSeenButton?.addEventListener('click', () => {
      const model = currentModel();
      if (model) setModelSeen(model, !model.seen).catch(error => showNotice(error.message));
    });
    elements.favoritesButton.addEventListener('click', () => {
      setMajorMode('favorites');
      state.favorites = null;
      state.favoritesError = null;
      syncRoute();
      render();
    });
    elements.gridSmall.addEventListener('click', () => setGridSize(false));
    elements.gridLarge.addEventListener('click', () => setGridSize(true));
  }

  function bindWindowEvents() {
    documentObject.addEventListener('keydown', handleDocumentKeydown);
    windowObject.addEventListener('popstate', handlePopState);
    windowObject.addEventListener('resize', scheduleSidebarLayoutSync);
    windowObject.addEventListener('scroll', scheduleSidebarLayoutSync, { passive: true });
  }

  function bindServerEvents() {
    if (!windowObject.EventSource) return;
    const source = new windowObject.EventSource('/api/events');
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

  async function bootstrap() {
    try {
      await loadCurrentUser();
      await loadCurrentUserStats();
    } catch (error) {
      showNotice(error.message);
    }
    loadState().catch(error => showNotice(error.message));
  }

  function start() {
    bindControls();
    lightboxController.bind();
    bindWindowEvents();
    bindServerEvents();
    initTooltips();
    setGridSize(readStoredFlag(storageKeys.largeThumbs, false));
    state.hideSeenModels = readStoredFlag(storageKeys.hideSeenModels, false);
    if (elements.hideSeenModels) elements.hideSeenModels.checked = state.hideSeenModels;
    syncUserOnlyUi();
    applyRouteFromLocation(true);
    fitSidebarToRenderedCards();
    bootstrap();
  }

  return { bootstrap, handleDocumentKeydown, handlePopState, start };
}
