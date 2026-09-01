export function createSeenStateController({
  state,
  getCurrentGallery,
  recomputeModelSeen,
  patchGalleryCache,
  fetchJson,
  renderHeaderStats,
  renderModels,
  renderModelActionButtons,
  patchActiveImageTile,
  renderSelectedGalleryBar,
  renderGalleries,
  renderImageTiles,
  renderLightboxMeta,
  updateLightbox,
}) {
  const overrides = new Map();
  let imageWriteQueue = Promise.resolve();

  function queueImageWrite(work) {
    const request = imageWriteQueue.catch(() => {}).then(work);
    imageWriteQueue = request.catch(() => {});
    return request;
  }

  function syncUserStatsDelta(previousSeenCount, nextSeenCount, galleryCount) {
    if (!state.userStats) return;
    const previousSeen = Number(previousSeenCount || 0);
    const nextSeen = Number(nextSeenCount || 0);
    const total = Number(galleryCount || 0);
    const previousGallerySeen = total > 0 && previousSeen >= total;
    const nextGallerySeen = total > 0 && nextSeen >= total;
    state.userStats.images = Math.max(0, Number(state.userStats.images || 0) + previousSeen - nextSeen);
    if (!previousGallerySeen && nextGallerySeen) state.userStats.galleries = Math.max(0, Number(state.userStats.galleries || 0) - 1);
    if (previousGallerySeen && !nextGallerySeen) state.userStats.galleries = Math.max(0, Number(state.userStats.galleries || 0) + 1);
  }

  function syncUserModelStats() {
    if (!state.userStats) return;
    let unseenModels = 0;
    for (const model of state.data?.models || []) {
      if (!model.seen) unseenModels += 1;
    }
    state.userStats.models = unseenModels;
  }

  function gallerySummary(dbId) {
    for (const model of state.data?.models || []) {
      for (const gallery of model.galleries || []) {
        if (gallery.dbId === dbId) {
          return {
            seen: Boolean(gallery.seen),
            seenCount: Number(gallery.seenCount || 0),
            count: Number(gallery.count || 0),
          };
        }
      }
    }
    return null;
  }

  function remember(galleryDbId, seenCount, seen) {
    const dbId = Number(galleryDbId || 0);
    if (!dbId) return;
    if (state.userLibrary) state.userLibrary.gallerySeenCounts.set(dbId, Number(seenCount || 0));
    overrides.set(dbId, { seen: Boolean(seen), seenCount: Number(seenCount || 0) });
  }

  function applyOverrides(data) {
    if (!data || !overrides.size) return;
    const matched = new Set();
    const applyToGalleries = (galleries, trackMatch = false) => {
      for (const gallery of galleries || []) {
        const dbId = Number(gallery?.dbId || 0);
        if (!dbId) continue;
        const override = overrides.get(dbId);
        if (!override) continue;
        if (trackMatch
          && Boolean(gallery.seen) === override.seen
          && Number(gallery.seenCount || 0) === override.seenCount) {
          matched.add(dbId);
        }
        gallery.seen = override.seen;
        gallery.seenCount = override.seenCount;
      }
    };
    for (const model of data.models || []) {
      applyToGalleries(model.galleries, true);
      recomputeModelSeen(model);
    }
    applyToGalleries(data.latest);
    if (data.currentModel) {
      applyToGalleries(data.currentModel.galleries);
      recomputeModelSeen(data.currentModel);
    }
    if (state.activeImages.length) {
      const activeGalleryDbId = Number(getCurrentGallery()?.dbId || state.activeImages[0]?.dbId || 0);
      const activeOverride = overrides.get(activeGalleryDbId);
      if (activeOverride?.seen) {
        for (const image of state.activeImages) image.seen = true;
      }
    }
    for (const dbId of matched) overrides.delete(dbId);
  }

  function applyToPayload(gallery, payload) {
    if (!payload || !gallery?.dbId) return payload;
    const summary = gallerySummary(gallery.dbId);
    if (!summary) return payload;
    const images = Array.isArray(payload.images) ? payload.images.map(image => ({
      ...image,
      seen: summary.seen ? true : Boolean(image.seen),
    })) : [];
    return { ...payload, seen: summary.seen, seenCount: summary.seenCount, images };
  }

  function patchCached(galleryDbId, seenCount, seen, options = {}) {
    patchGalleryCache(galleryDbId, seenCount, seen, options);
  }

  function updateGallery(dbId, seenCount, seen) {
    for (const model of state.data?.models || []) {
      for (const gallery of model.galleries || []) {
        if (gallery.dbId === dbId) {
          gallery.seenCount = seenCount;
          gallery.seen = seen;
        }
      }
      recomputeModelSeen(model);
    }
    for (const gallery of state.data?.latest || []) {
      if (gallery.dbId === dbId) {
        gallery.seenCount = seenCount;
        gallery.seen = seen;
      }
    }
    for (const gallery of state.data?.currentModel?.galleries || []) {
      if (gallery.dbId === dbId) {
        gallery.seenCount = seenCount;
        gallery.seen = seen;
      }
    }
    if (state.data?.currentModel) recomputeModelSeen(state.data.currentModel);
    for (const gallery of state.favorites?.galleries || []) {
      if (gallery.dbId === dbId) {
        gallery.seenCount = seenCount;
        gallery.seen = seen;
      }
    }
  }

  function activeGallerySummary(gallery = getCurrentGallery()) {
    const galleryDbId = Number(gallery?.dbId || 0);
    if (!gallery || !galleryDbId) return null;
    const images = state.activeImages.filter(image => Number(image.dbId || 0) === galleryDbId);
    if (!images.length) return null;
    const seenCount = images.reduce((sum, image) => sum + (image.seen ? 1 : 0), 0);
    return { dbId: galleryDbId, seenCount, seen: seenCount >= images.length };
  }

  function syncActiveGallery() {
    const gallery = getCurrentGallery();
    const summary = activeGallerySummary(gallery);
    if (!gallery || !summary) return;
    const { dbId, seenCount, seen } = summary;
    if (Number(gallery.seenCount || 0) === seenCount && Boolean(gallery.seen) === seen) return;
    updateGallery(dbId, seenCount, seen);
    remember(dbId, seenCount, seen);
    patchCached(dbId, seenCount, seen);
  }

  function renderSeenState(options = {}) {
    renderHeaderStats();
    renderModels();
    renderModelActionButtons();
    if (Number.isInteger(options.imageIndex)) patchActiveImageTile(options.imageIndex);
    renderSelectedGalleryBar();
    if (options.full) {
      renderGalleries();
      renderImageTiles();
    }
  }

  async function setImageSeen(image, seen, options = {}) {
    if (!state.user || !image.dbId) return;
    if (Boolean(image.seen) === Boolean(seen)) {
      syncActiveGallery();
      if (options.render !== false) renderSelectedGalleryBar();
      return;
    }
    const previous = Boolean(image.seen);
    const previousSummary = activeGallerySummary() || { seenCount: 0, seen: false };
    const imageIndex = state.activeImages.indexOf(image);
    image.seen = Boolean(seen);
    syncActiveGallery();
    const optimisticSummary = activeGallerySummary() || previousSummary;
    syncUserStatsDelta(previousSummary.seenCount, optimisticSummary.seenCount, state.activeImages.length);
    syncUserModelStats();
    if (options.render !== false) renderSeenState({ imageIndex });
    renderLightboxMeta();
    try {
      const payload = await queueImageWrite(() => fetchJson('/api/seen/image', {
        method: seen ? 'POST' : 'DELETE',
        body: JSON.stringify({ galleryId: image.dbId, imageName: image.name }),
      }));
      const localSummary = activeGallerySummary();
      const summary = localSummary?.dbId === Number(image.dbId || 0)
        ? localSummary
        : { seenCount: payload.seenCount, seen: payload.seen };
      updateGallery(image.dbId, summary.seenCount, summary.seen);
      remember(image.dbId, summary.seenCount, summary.seen);
      syncUserModelStats();
      patchCached(image.dbId, summary.seenCount, summary.seen, {
        imageName: image.name,
        imageSeen: seen,
      });
      if (options.render !== false) renderSeenState({ imageIndex });
      renderLightboxMeta();
    } catch (error) {
      image.seen = previous;
      syncActiveGallery();
      const revertedSummary = activeGallerySummary() || previousSummary;
      syncUserStatsDelta(optimisticSummary.seenCount, revertedSummary.seenCount, state.activeImages.length);
      syncUserModelStats();
      if (options.render !== false) renderSeenState({ imageIndex });
      renderLightboxMeta();
      throw error;
    }
  }

  async function setGallerySeen(gallery, seen) {
    if (!state.user || !gallery?.dbId) return;
    const previousSeenCount = Number(gallery.seenCount || 0);
    const galleryCount = Number(gallery.count || 0);
    const payload = await fetchJson('/api/seen/gallery', {
      method: seen ? 'POST' : 'DELETE',
      body: JSON.stringify({ galleryId: gallery.dbId }),
    });
    gallery.seenCount = payload.seenCount;
    gallery.seen = payload.seen;
    updateGallery(gallery.dbId, payload.seenCount, payload.seen);
    remember(gallery.dbId, payload.seenCount, payload.seen);
    syncUserStatsDelta(previousSeenCount, payload.seenCount, galleryCount);
    syncUserModelStats();
    patchCached(gallery.dbId, payload.seenCount, payload.seen, { allImages: true });
    for (const image of state.activeImages) {
      if (image.dbId === gallery.dbId) image.seen = Boolean(seen);
    }
    renderSeenState({ full: true });
    renderLightboxMeta();
  }

  async function setModelSeen(model, seen) {
    if (!state.user || !model?.id) return;
    const payload = await fetchJson('/api/seen/model', {
      method: seen ? 'POST' : 'DELETE',
      body: JSON.stringify({ modelId: model.id }),
    });
    const seenByGalleryId = new Map((payload.galleries || []).map(item => [item.galleryId, item]));
    for (const gallery of model.galleries || []) {
      const summary = seenByGalleryId.get(gallery.dbId);
      if (!summary) continue;
      const previousSeenCount = Number(gallery.seenCount || 0);
      gallery.seenCount = summary.seenCount;
      gallery.seen = seen ? summary.count > 0 && summary.seenCount >= summary.count : false;
      updateGallery(gallery.dbId, gallery.seenCount, gallery.seen);
      remember(gallery.dbId, gallery.seenCount, gallery.seen);
      syncUserStatsDelta(previousSeenCount, gallery.seenCount, summary.count);
      patchCached(gallery.dbId, gallery.seenCount, gallery.seen, { allImages: true });
    }
    for (const image of state.activeImages) {
      if (seenByGalleryId.has(image.dbId)) image.seen = Boolean(seen);
    }
    recomputeModelSeen(model);
    syncUserModelStats();
    renderSeenState({ full: true });
    updateLightbox();
  }

  return {
    activeGallerySummary,
    applyOverrides,
    applyToPayload,
    gallerySummary,
    patchCached,
    remember,
    setGallerySeen,
    setImageSeen,
    setModelSeen,
    syncActiveGallery,
    updateGallery,
  };
}
