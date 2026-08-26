export function createFavoritesController(options) {
  const {
    state,
    elements,
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
    documentObject = document,
  } = options;
  let favoritesLoadPromise = null;
  let favoriteImageGroupPages = new Map();
  let randomFavoritesLoading = false;
  let pendingFavoritesRefresh = false;

  function renderFavoritesLoading() {
    const count = Number(state.user?.favoriteCount || 0);
    const countText = count ? `Loading ${formatCount(count)} favorites` : 'Loading favorites';
    elements.favoritesView.innerHTML = `
      <div class="favorites-loading">
        <strong>${countText}</strong>
        <span>Preparing saved models, galleries, and images. Large favorite lists can take a moment.</span>
        <div class="favorites-loading-bar" aria-hidden="true"></div>
      </div>
    `;
  }

  function createFavoriteImageItem(image, activeImages) {
    const item = documentObject.createElement('div');
    item.className = 'favorite-image-item';

    const openImage = documentObject.createElement('button');
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
      const badge = documentObject.createElement('span');
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
      state.activeImageSource = 'favorites-group';
      state.activeImages = activeImages.slice();
      const index = activeImages.findIndex(entry => entry.dbId === image.dbId && entry.name === image.name);
      openLightbox(Math.max(0, index));
    });

    const actions = documentObject.createElement('div');
    actions.className = 'favorite-image-actions';
    const galleryButton = documentObject.createElement('button');
    galleryButton.type = 'button';
    galleryButton.textContent = 'Gallery';
    galleryButton.addEventListener('click', () => {
      openGallery(image.modelId, image.galleryId);
      render();
    });
    const modelButton = documentObject.createElement('button');
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
      state.activeImageSource = 'favorites-random';
      state.activeImages = images.slice();
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
    elements.favoritesView.hidden = state.mode !== 'favorites';
    if (state.mode !== 'favorites') {
      elements.favoritesView.innerHTML = '';
      return;
    }

    elements.galleryKicker.textContent = 'Favorites';
    elements.galleryTitle.textContent = 'Saved Galleries and Images';
    elements.favoritesView.innerHTML = '';

    if (!state.user) {
      elements.favoritesView.innerHTML = '<div class="empty">Login to view favorites.</div>';
      return;
    }

    if (!state.favorites) {
      if (state.favoritesError) {
        const errorBox = documentObject.createElement('div');
        errorBox.className = 'favorites-loading favorites-load-error';
        const title = documentObject.createElement('strong');
        title.textContent = 'Favorites failed to load';
        const message = documentObject.createElement('span');
        message.textContent = state.favoritesError;
        const retry = documentObject.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => {
          state.favoritesError = null;
          renderFavorites();
        });
        errorBox.append(title, message, retry);
        elements.favoritesView.append(errorBox);
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
      elements.favoritesView.innerHTML = `
        <div class="empty favorites-empty">
          <strong>No favorites yet.</strong>
          <span>Star a model, gallery, or image and it will show up here.</span>
        </div>
      `;
      return;
    }

    const modelSection = documentObject.createElement('section');
    modelSection.className = 'favorites-section';
    modelSection.innerHTML = `<h3>Favorite Models (${formatCount(favoriteModels.length)})</h3>`;
    const modelGrid = documentObject.createElement('div');
    modelGrid.className = 'model-list';

    for (const model of favoriteModels) {
      const button = documentObject.createElement('button');
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
        const badge = documentObject.createElement('span');
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
    if (favoriteModels.length) elements.favoritesView.append(modelSection);

    const gallerySection = documentObject.createElement('section');
    gallerySection.className = 'favorites-section';
    gallerySection.innerHTML = `<h3>Favorite Galleries (${formatCount(favoriteGalleries.length)})</h3>`;
    const galleryGrid = documentObject.createElement('div');
    galleryGrid.className = 'gallery-list latest-gallery-list';

    for (const gallery of favoriteGalleries) {
      const button = documentObject.createElement('button');
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
        const badge = documentObject.createElement('span');
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
    if (favoriteGalleries.length) elements.favoritesView.append(gallerySection);

    const imageSection = documentObject.createElement('section');
    imageSection.className = 'favorites-section';
    const imageHead = documentObject.createElement('div');
    imageHead.className = 'favorites-section-head';
    imageHead.innerHTML = `<h3>Favorite Images (${formatCount(favoriteImageCount)})</h3>`;
    if (favoriteImageCount) {
      const randomButton = documentObject.createElement('button');
      randomButton.type = 'button';
      randomButton.textContent = 'Random';
      randomButton.addEventListener('click', () => openRandomFavoriteImages(randomButton));
      imageHead.append(randomButton);
    }
    imageSection.append(imageHead);
    favoriteImageGroups.forEach((group) => {
      const details = documentObject.createElement('details');
      details.className = 'favorite-image-group';

      const summary = documentObject.createElement('summary');
      summary.className = 'favorite-image-group-summary';
      summary.innerHTML = `
        <span>${titleCase(group.modelName)}</span>
        <span>${formatCount(group.count)} image${Number(group.count) === 1 ? '' : 's'}</span>
      `;
      details.append(summary);

      const imageGrid = documentObject.createElement('div');
      imageGrid.className = 'favorite-image-grid';
      const status = documentObject.createElement('div');
      status.className = 'favorite-image-group-status';
      status.hidden = true;
      const loadMore = documentObject.createElement('button');
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

    if (favoriteImageCount) elements.favoritesView.append(imageSection);
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

  function backdropUrls() {
    const urls = [];
    for (const page of favoriteImageGroupPages.values()) {
      for (const image of page.images || []) urls.push(image.thumb || image.src);
    }
    return urls;
  }

  function patchImageFavorite(galleryDbId, imageName, favorite) {
    const dbId = Number(galleryDbId || 0);
    const name = String(imageName || '');
    for (const page of favoriteImageGroupPages.values()) {
      for (const image of page.images || []) {
        if (Number(image.dbId || 0) === dbId && image.name === name) image.favorite = Boolean(favorite);
      }
    }
  }

  function shouldDeferRefresh() {
    return state.mode === 'favorites' && Array.isArray(state.activeImages) && state.activeImages.length > 0 && String(state.activeGalleryId || '') === 'favorites';
  }

  function markRefreshPending() {
    pendingFavoritesRefresh = true;
  }

  async function flushPendingRefresh() {
    if (!pendingFavoritesRefresh) return null;
    pendingFavoritesRefresh = false;
    return loadFavorites();
  }

  return {
    backdropUrls,
    flushPendingRefresh,
    load: loadFavorites,
    patchImageFavorite,
    render: renderFavorites,
    shouldDeferRefresh,
    markRefreshPending,
  };
}
