export function createAppDataService({
  state,
  fetchImpl = fetch,
  getGalleryCache,
  setData,
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

  function loadState() {
    if (stateLoadPromise) {
      stateReloadQueued = true;
      return stateLoadPromise;
    }
    stateLoadPromise = (async () => {
      do {
        stateReloadQueued = false;
        const response = await fetchImpl('/api/state', { cache: 'no-store' });
        setData(await response.json());
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

  return {
    fetchGalleryPayload,
    fetchJson,
    galleryImagesFromPayload,
    galleryRequestUrl,
    latestGalleries,
    loadCurrentUser,
    loadCurrentUserStats,
    loadState,
    recordView,
    saveUserSettings,
  };
}
