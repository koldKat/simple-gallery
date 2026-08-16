export function createFavoriteActionsController({
  state,
  setTooltip,
  fetchJson,
  galleryCache,
  getFavoritesController,
  updateFavoriteCount,
  loadFavorites,
  render,
  renderImageTiles,
  renderLightboxMeta,
}) {
  function favoriteButton(isFavorite, label = 'Favorite') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `favorite-btn${isFavorite ? ' is-favorite' : ''}`;
    setTooltip(button, state.user ? label : 'Login to favorite');
    button.textContent = isFavorite ? '★' : '☆';
    button.disabled = !state.user;
    return button;
  }

  function updateModel(modelId, favorite) {
    for (const model of state.data?.models || []) {
      if (model.id === modelId) model.favorite = favorite;
    }
  }

  function updateGallery(dbId, favorite) {
    for (const model of state.data?.models || []) {
      for (const gallery of model.galleries || []) {
        if (gallery.dbId === dbId) gallery.favorite = favorite;
      }
    }
    for (const gallery of state.favorites?.galleries || []) {
      if (gallery.dbId === dbId) gallery.favorite = favorite;
    }
  }

  function updateImage(galleryDbId, imageName, favorite) {
    const dbId = Number(galleryDbId || 0);
    const name = String(imageName || '');
    if (!dbId || !name) return;
    for (const image of state.activeImages || []) {
      if (Number(image.dbId || 0) === dbId && image.name === name) {
        image.favorite = Boolean(favorite);
      }
    }
    galleryCache.patchFavorite(dbId, name, favorite);
    getFavoritesController()?.patchImageFavorite(dbId, name, favorite);
  }

  async function toggleGallery(gallery) {
    if (!state.user || !gallery.dbId) return;
    const favorite = !gallery.favorite;
    const payload = await fetchJson('/api/favorites/gallery', {
      method: favorite ? 'POST' : 'DELETE',
      body: JSON.stringify({ galleryId: gallery.dbId }),
    });
    gallery.favorite = favorite;
    updateGallery(gallery.dbId, favorite);
    updateFavoriteCount(payload, favorite);
    if (state.mode === 'favorites') {
      await loadFavorites();
      return;
    }
    render();
  }

  async function toggleModel(model) {
    if (!state.user || !model?.id) return;
    const favorite = !model.favorite;
    const payload = await fetchJson('/api/favorites/model', {
      method: favorite ? 'POST' : 'DELETE',
      body: JSON.stringify({ modelId: model.id }),
    });
    model.favorite = favorite;
    updateModel(model.id, favorite);
    updateFavoriteCount(payload, favorite);
    if (state.mode === 'favorites') {
      await loadFavorites();
      return;
    }
    render();
  }

  async function toggleImage(image) {
    if (!state.user || !image.dbId) return;
    const favorite = !image.favorite;
    const payload = await fetchJson('/api/favorites/image', {
      method: favorite ? 'POST' : 'DELETE',
      body: JSON.stringify({ galleryId: image.dbId, imageName: image.name }),
    });
    const nextFavorite = Boolean(payload.favorite);
    image.favorite = nextFavorite;
    updateImage(image.dbId, image.name, nextFavorite);
    updateFavoriteCount(payload, nextFavorite);
    if (state.mode === 'favorites') {
      await loadFavorites();
      renderLightboxMeta();
      return;
    }
    renderImageTiles();
    renderLightboxMeta();
  }

  return { favoriteButton, toggleGallery, toggleImage, toggleModel, updateGallery, updateImage, updateModel };
}
