export function createGalleryViewController(options) {
  const {
    state,
    elements,
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
    setTooltip,
    showNotice,
    formatCount,
    formatDate,
    titleCase,
    render,
    documentObject = document,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = options;

  function renderSelectedGalleryBar() {
    syncActiveGallerySeenState();
    const model = currentModel();
    const gallery = currentGallery();
    elements.selectedGalleryBar.innerHTML = '';
    elements.selectedGalleryBar.hidden = !model || !gallery;
    if (!model || !gallery) return;

    const index = model.galleries.findIndex(item => item.id === gallery.id);
    elements.galleryKicker.textContent = titleCase(model.name);
    elements.galleryTitle.textContent = `Gallery ${gallery.name}`;

    const coverWrap = documentObject.createElement('div');
    coverWrap.className = 'selected-gallery-cover';
    const cover = documentObject.createElement('img');
    cover.src = gallery.cover || '';
    cover.alt = '';
    coverWrap.append(cover);
    bindCardImageLoading(coverWrap, cover);
    if (gallery.seen) {
      const seen = documentObject.createElement('button');
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

    const meta = documentObject.createElement('div');
    meta.className = 'selected-gallery-main';
    meta.innerHTML = `
      <div class="selected-gallery-title">Gallery ${gallery.name}</div>
      <div class="card-sub">${formatCount(gallery.count)} images</div>
      <div class="card-sub">${formatDate(gallery.updatedAt)}</div>
    `;

    const actions = documentObject.createElement('div');
    actions.className = 'selected-gallery-actions';

    const prev = documentObject.createElement('button');
    prev.type = 'button';
    prev.className = 'gallery-action-btn';
    prev.textContent = 'Previous';
    prev.disabled = index <= 0;
    prev.addEventListener('click', () => stepGallery(-1));

    const next = documentObject.createElement('button');
    next.type = 'button';
    next.className = 'gallery-action-btn';
    next.textContent = 'Next';
    next.disabled = index < 0 || index >= model.galleries.length - 1;
    next.addEventListener('click', () => stepGallery(1));

    const toggle = documentObject.createElement('button');
    toggle.type = 'button';
    toggle.className = 'gallery-action-btn';
    toggle.textContent = state.galleryListExpanded ? 'Hide galleries' : 'All galleries';
    toggle.addEventListener('click', () => {
      state.galleryListExpanded = !state.galleryListExpanded;
      render();
    });

    const markSeen = documentObject.createElement('button');
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
    elements.selectedGalleryBar.append(coverWrap, meta, actions);
  }

  function renderGalleries() {
    const model = currentModel();
    elements.galleryList.innerHTML = '';
    const selectedGallery = currentGallery();
    const collapsed = Boolean(model && selectedGallery && !state.galleryListExpanded);
    elements.galleryList.hidden = state.mode === 'models' || state.mode === 'favorites' || collapsed;
    elements.galleryList.classList.toggle('latest-gallery-list', state.mode === 'home');

    if (state.mode === 'models' || state.mode === 'favorites' || collapsed) return;

    if (state.mode === 'model' && state.selectedModel && !model) {
      elements.galleryKicker.textContent = 'Model';
      elements.galleryTitle.textContent = 'Loading galleries';
      elements.galleryList.hidden = false;
      elements.galleryList.innerHTML = '<div class="empty">Loading model galleries...</div>';
      return;
    }

    if (!model) {
      const latest = latestGalleries();
      elements.galleryKicker.textContent = 'Latest';
      elements.galleryTitle.textContent = 'Galleries';
      for (const gallery of latest) {
        const button = documentObject.createElement('button');
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
          const badge = documentObject.createElement('span');
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
        elements.galleryList.append(button);
      }
      return;
    }

    elements.galleryKicker.textContent = titleCase(model.name);
    elements.galleryTitle.textContent = 'Galleries';

    for (const gallery of model.galleries) {
      const button = documentObject.createElement('button');
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
        const seen = documentObject.createElement('button');
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
      elements.galleryList.append(button);
    }
  }

  function renderImages() {
    const gallery = currentGallery();
    elements.imageGrid.innerHTML = '';
    elements.imageGrid.hidden = state.mode !== 'model' || !gallery;

    if (state.mode === 'favorites') {
      elements.imageGrid.hidden = true;
      elements.imageGrid.innerHTML = '';
      return;
    }

    if (state.mode === 'model' && state.selectedGallery && !gallery) {
      elements.imageGrid.hidden = false;
      elements.imageGrid.innerHTML = '<div class="empty">Loading gallery images...</div>';
      return;
    }

    if (!gallery) {
      resetActiveImages();
      elements.imageGrid.innerHTML = '';
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
        await sleep(250);
        if (state.activeGalleryId !== gallery.id) return;
        return loadGalleryImages(gallery, attempt + 1);
      }
      state.imagesLoading = false;
      elements.imageGrid.innerHTML = '<div class="empty">Failed to load gallery images.</div>';
      showNotice(error.message);
    }
  }

  function renderImageLoadingTiles(gallery) {
    elements.imageGrid.innerHTML = '';
    const placeholderCount = Math.max(8, Math.min(Number(gallery?.count || 12), 24));
    for (let index = 0; index < placeholderCount; index += 1) {
      const tile = documentObject.createElement('div');
      tile.className = 'image-tile image-tile-loading';
      tile.innerHTML = `
        <div class="image-tile-skeleton"></div>
        <div class="image-tile-loading-bar"></div>
      `;
      elements.imageGrid.append(tile);
    }
  }

  function renderImageTiles() {
    elements.imageGrid.innerHTML = '';
    state.activeImages.forEach((image, index) => {
      const button = documentObject.createElement('button');
      button.type = 'button';
      button.className = `image-tile${image.seen ? ' is-seen' : ''}`;
      button.innerHTML = `<img loading="lazy" src="${image.thumb}" alt="${image.name}">`;
      if (image.seen) {
        const seen = documentObject.createElement('button');
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
      elements.imageGrid.append(button);
    });
  }

  return {
    loadImages: loadGalleryImages,
    renderGalleries,
    renderImages,
    renderImageTiles,
    renderSelectedGalleryBar,
  };
}
