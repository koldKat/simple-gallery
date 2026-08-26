export function createAppDataService({
  state,
  fetchImpl = fetch,
  getGalleryCache,
  setData,
  applyUserLibraryState,
  clearUserLibraryState,
  render,
  renderAuth,
  syncUserOnlyUi,
  renderHeaderStats,
  renderFavoritesButton,
  syncPreloadForCurrentView,
  showNotice,
}) {
  let stateLoadPromise = null;
  let stateReloadQueued = false;
  let userStateLoadPromise = null;
  let userStateLoadUserId = null;
  let userStateRequestVersion = 0;

  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, {
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

  function recordView(payload) {
    fetchImpl('/api/views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(error => showNotice(error.message));
  }

  function galleryRequestUrl(gallery) {
    const [modelName, galleryName] = String(gallery?.id || '').split('/');
    return `/api/gallery?model=${encodeURIComponent(modelName || '')}&gallery=${encodeURIComponent(galleryName || '')}`;
  }

  async function fetchGalleryPayload(gallery) {
    return getGalleryCache().fetch(gallery);
  }

  function galleryImagesFromPayload(payload) {
    return (payload.images || []).map(image => ({ ...image, dbId: payload.dbId }));
  }

  function latestGalleries() {
    return state.data?.latest || [];
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

  function invalidateUserLibraryRequests() {
    userStateRequestVersion += 1;
    userStateLoadPromise = null;
    userStateLoadUserId = null;
  }

  function loadState() {
    if (stateLoadPromise) {
      stateReloadQueued = true;
      return stateLoadPromise;
    }
    stateLoadPromise = (async () => {
      do {
        stateReloadQueued = false;
        const response = await fetchImpl('/api/state', { cache: 'no-store' });
        const payload = await response.json();
        setData(payload);
        if (payload.user?.id) {
          loadUserLibraryState(payload.user.id).catch(error => showNotice(error.message));
        } else {
          invalidateUserLibraryRequests();
          clearUserLibraryState();
          render();
        }
      } while (stateReloadQueued);
    })().finally(() => {
      stateLoadPromise = null;
    });
    return stateLoadPromise;
  }

  async function loadCurrentUser() {
    const payload = await fetchJson('/api/auth/me', { method: 'GET' });
    const previousUserId = state.user?.id || null;
    state.user = payload.user || null;
    if ((state.user?.id || null) !== previousUserId) {
      invalidateUserLibraryRequests();
      state.userStats = null;
      clearUserLibraryState();
    }
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
    if (state.userLibrary?.loadedForUserId === state.user.id && state.userLibrary?.unseenStats) {
      state.userStats = state.userLibrary.unseenStats;
      renderHeaderStats();
      return;
    }
    const userId = state.user.id;
    const payload = await fetchJson('/api/auth/stats', { method: 'GET' });
    if (state.user?.id !== userId) return;
    state.userStats = payload.stats || null;
    renderHeaderStats();
  }

  async function loadUserLibraryState(expectedUserId = state.user?.id || null) {
    if (!expectedUserId) {
      invalidateUserLibraryRequests();
      clearUserLibraryState();
      render();
      return null;
    }
    if (userStateLoadPromise && userStateLoadUserId === expectedUserId) return userStateLoadPromise;
    const requestVersion = ++userStateRequestVersion;
    userStateLoadUserId = expectedUserId;
    userStateLoadPromise = (async () => {
      const payload = await fetchJson('/api/user-state', { method: 'GET' });
      if (userStateRequestVersion !== requestVersion) return null;
      if ((state.user?.id || null) !== expectedUserId) return null;
      applyUserLibraryState(payload);
      render();
      return payload;
    })().finally(() => {
      if (userStateRequestVersion === requestVersion) {
        userStateLoadPromise = null;
        userStateLoadUserId = null;
      }
    });
    return userStateLoadPromise;
  }

  return {
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
  };
}
