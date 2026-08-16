export function createAppHeaderController({
  state,
  elements,
  documentObject = document,
  currentModel,
  currentGallery,
  syncActiveGallerySeenState,
  setTooltip,
  formatCount,
  titleCase,
}) {
  function syncUserOnlyUi() {
    const loggedIn = Boolean(state.user);
    if (elements.userStatsRow) {
      elements.userStatsRow.hidden = !loggedIn;
      elements.userStatsRow.style.display = loggedIn ? '' : 'none';
    }
    if (!loggedIn && elements.userStats) elements.userStats.textContent = '';
    const hideSeenToggle = elements.hideSeenModels?.closest('.sidebar-toggle');
    if (hideSeenToggle) {
      hideSeenToggle.hidden = !loggedIn;
      hideSeenToggle.style.display = loggedIn ? '' : 'none';
    }
  }

  function updateDocumentTitle() {
    const appName = String(state.data?.app?.name || 'Simple Gallery');
    const homeTitle = String(state.data?.app?.homeTitle || `${appName} - Image Galleries`);
    const model = currentModel();
    const gallery = currentGallery();
    if (state.mode === 'favorites') documentObject.title = `Favorites | ${appName}`;
    else if (state.mode === 'models') documentObject.title = `All Models | ${appName}`;
    else if (model && gallery) documentObject.title = `${titleCase(model.name)} / Gallery ${gallery.name} | ${appName}`;
    else if (model) documentObject.title = `${titleCase(model.name)} | ${appName}`;
    else documentObject.title = homeTitle;
  }

  function renderMetadata() {
    const data = state.data;
    if (!data) return;
    updateDocumentTitle();
    if (elements.appName) elements.appName.textContent = data.app?.name || 'Simple Gallery';
    if (elements.appTagline) elements.appTagline.textContent = data.app?.tagline || '';
    if (elements.versionLabel) elements.versionLabel.textContent = data.app?.versionLabel || '';
  }

  function renderStatsBreakdown(element, values) {
    if (!element) return;
    element.classList.add('stats-breakdown');
    element.innerHTML = `
      <span class="stat-part stat-models"><span class="stat-num">${formatCount(values.models)}</span><span class="stat-word">models</span></span>
      <span class="stat-part stat-galleries"><span class="stat-num">${formatCount(values.galleries)}</span><span class="stat-word">galleries</span></span>
      <span class="stat-part stat-images"><span class="stat-num">${formatCount(values.images)}</span><span class="stat-word">images</span></span>
    `;
  }

  function renderStats() {
    const data = state.data;
    if (data) renderStatsBreakdown(elements.stats, data.totals);
    syncUserOnlyUi();
    if (!elements.userStats) return;
    if (!state.user) {
      state.userStats = null;
      elements.userStats.textContent = '';
      return;
    }
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
    if (state.userStats) renderStatsBreakdown(elements.userStats, state.userStats);
  }

  function renderFavoritesButton() {
    const button = elements.favoritesButton;
    if (!button) return;
    const count = Math.max(0, Number(state.user?.favoriteCount || 0));
    button.replaceChildren(
      documentObject.createTextNode('Favorites '),
      Object.assign(documentObject.createElement('span'), {
        className: 'favorites-count',
        textContent: `(${formatCount(count)})`,
      })
    );
    button.hidden = !state.user || state.mode === 'favorites';
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

  function renderModelActions() {
    syncActiveGallerySeenState();
    const selectedModel = currentModel();
    if (elements.modelFavoriteButton) {
      const button = elements.modelFavoriteButton;
      button.hidden = !(state.mode === 'model' && selectedModel);
      button.disabled = !state.user || !selectedModel;
      button.textContent = selectedModel?.favorite ? '★' : '☆';
      setTooltip(button, state.user ? (selectedModel?.favorite ? 'Unfavorite model' : 'Favorite model') : 'Login to favorite');
      button.classList.toggle('is-active', Boolean(selectedModel?.favorite));
    }
    if (elements.modelSeenButton) {
      const button = elements.modelSeenButton;
      button.hidden = !(state.mode === 'model' && selectedModel);
      button.disabled = !state.user || !selectedModel;
      button.textContent = selectedModel?.seen ? 'Mark model unseen' : 'Mark model seen';
      setTooltip(
        button,
        state.user
          ? (selectedModel?.seen
            ? 'Mark every gallery and image in this model unseen'
            : 'Mark every gallery and image in this model seen')
          : 'Login to change model seen state'
      );
      button.classList.toggle('is-seen-action', Boolean(selectedModel) && !selectedModel?.seen);
    }
  }

  return {
    renderFavoritesButton,
    renderMetadata,
    renderModelActions,
    renderStats,
    syncUserOnlyUi,
    updateDocumentTitle,
    updateFavoriteCount,
  };
}
