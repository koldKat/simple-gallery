export function createLightboxController(options) {
  const {
    state,
    elements,
    getCurrentGallery,
    getCurrentModel,
    titleCase,
    setTooltip,
    recordView,
    setImageSeen,
    toggleImageFavorite,
    showNotice,
    warmDecodedWindow,
    rememberDecodedImage,
    onClose,
    windowObject = window,
    documentObject = document,
    createImage = () => new Image(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now(),
  } = options;
  let loadingTimer = null;
  let errorTimer = null;
  let touch = null;
  let scrollY = 0;
  let historyActive = false;
  let bound = false;
  let selectedImageKey = '';

  function imageKey(image) {
    if (!image) return '';
    return `${Number(image.dbId || 0)}\n${String(image.name || '')}`;
  }

  function selectIndex(index) {
    state.lightboxIndex = index;
    selectedImageKey = imageKey(state.activeImages[index]);
  }

  function activeImage() {
    if (selectedImageKey) {
      const index = state.activeImages.findIndex(image => imageKey(image) === selectedImageKey);
      if (index < 0) return null;
      state.lightboxIndex = index;
    }
    return state.activeImages[state.lightboxIndex];
  }

  function isOpen() {
    return !elements.lightbox.hidden;
  }

  function lockScroll() {
    const shouldLock = windowObject.matchMedia('(max-width: 820px), (pointer: coarse)').matches;
    if (!shouldLock || documentObject.body.classList.contains('lightbox-scroll-locked')) return;
    scrollY = windowObject.scrollY || documentObject.documentElement.scrollTop || 0;
    documentObject.body.style.top = `-${scrollY}px`;
    documentObject.body.classList.add('lightbox-scroll-locked');
  }

  function unlockScroll() {
    if (!documentObject.body.classList.contains('lightbox-scroll-locked')) return;
    documentObject.body.classList.remove('lightbox-scroll-locked');
    documentObject.body.style.top = '';
    windowObject.scrollTo(0, scrollY);
  }

  function pushHistory() {
    if (historyActive || windowObject.history.state?.lightbox) return;
    windowObject.history.pushState(
      { ...(windowObject.history.state || {}), lightbox: true },
      '',
      windowObject.location.href
    );
    historyActive = true;
  }

  function renderLoadState() {
    elements.lightboxLoading.hidden = !(state.lightboxLoading || state.lightboxError);
    elements.lightboxLoading.classList.toggle('is-error', state.lightboxError);
    elements.lightboxImg.classList.toggle('is-loading', state.lightboxLoading);
    elements.lightboxImg.classList.toggle('is-error', state.lightboxError);
    elements.lightboxLoadingText.textContent = state.lightboxError ? 'Image failed to load' : 'Loading...';
    const image = activeImage();
    elements.lightboxDownload.disabled = Boolean(state.lightboxLoading || state.lightboxError || !image?.src);
    setTooltip(elements.lightboxDownload, state.lightboxError ? 'Image unavailable' : 'Download image');
  }

  function renderMeta() {
    const gallery = getCurrentGallery();
    const image = activeImage();
    if (!image) return;
    const modelName = image.modelName || getCurrentModel()?.name || '';
    const galleryName = image.galleryName || gallery?.name || '';
    elements.lightboxCaption.textContent = `${titleCase(modelName)} / Gallery ${galleryName} / ${image.name}`;
    elements.lightboxSeen.textContent = image.seen ? '✓' : '○';
    elements.lightboxSeen.classList.toggle('is-seen', Boolean(image.seen));
    elements.lightboxSeen.disabled = !state.user || !image.dbId;
    setTooltip(elements.lightboxSeen, state.user ? (image.seen ? 'Mark unseen' : 'Mark seen') : 'Login to mark seen');
    elements.lightboxFavorite.textContent = image.favorite ? '★' : '☆';
    elements.lightboxFavorite.classList.toggle('is-favorite', Boolean(image.favorite));
    elements.lightboxFavorite.disabled = !state.user || !image.dbId;
    setTooltip(elements.lightboxFavorite, state.user ? 'Favorite image' : 'Login to favorite');
    elements.prevImage.disabled = state.lightboxIndex <= 0;
    elements.nextImage.disabled = state.lightboxIndex >= state.activeImages.length - 1;
  }

  function update() {
    const image = activeImage();
    if (!image) return;
    const requestId = state.lightboxRequestId + 1;
    state.lightboxRequestId = requestId;
    state.lightboxLoading = false;
    state.lightboxError = false;
    clearTimer(loadingTimer);
    clearTimer(errorTimer);
    elements.lightboxImg.dataset.requestId = String(requestId);
    elements.lightboxImg.classList.add('is-pending');
    elements.lightboxImg.src = image.src;
    renderMeta();

    if (elements.lightboxImg.complete && elements.lightboxImg.naturalWidth) {
      elements.lightboxImg.classList.remove('is-pending');
      renderLoadState();
      warmDecodedWindow(state.lightboxIndex);
      return;
    }
    renderLoadState();
    loadingTimer = setTimer(() => {
      if (Number(elements.lightboxImg.dataset.requestId || 0) !== requestId) return;
      if (elements.lightboxImg.complete) return;
      elements.lightboxImg.classList.remove('is-pending');
      state.lightboxLoading = true;
      renderLoadState();
    }, 250);
    warmDecodedWindow(state.lightboxIndex);
  }

  function markActiveSeen() {
    const image = activeImage();
    if (image?.dbId) recordView({ type: 'image', galleryDbId: image.dbId, imageName: image.name });
    if (image && !image.seen) setImageSeen(image, true).catch(error => showNotice(error.message));
  }

  function open(index) {
    selectIndex(index);
    lockScroll();
    pushHistory();
    elements.lightbox.hidden = false;
    update();
    markActiveSeen();
  }

  function close(options = {}) {
    elements.lightbox.hidden = true;
    unlockScroll();
    clearTimer(loadingTimer);
    clearTimer(errorTimer);
    state.lightboxRequestId += 1;
    state.lightboxLoading = false;
    state.lightboxError = false;
    elements.lightboxImg.dataset.requestId = String(state.lightboxRequestId);
    elements.lightboxImg.removeAttribute('src');
    elements.lightboxImg.classList.add('is-pending');
    elements.lightboxImg.classList.remove('is-loading', 'is-error');
    elements.lightboxLoading.hidden = true;
    selectedImageKey = '';
    if (typeof onClose === 'function') onClose();
    if (!options.fromHistory && historyActive && windowObject.history.state?.lightbox) {
      historyActive = false;
      windowObject.history.back();
      return;
    }
    if (options.fromHistory) historyActive = false;
  }

  function step(delta) {
    if (!state.activeImages.length) return;
    if (!activeImage()) return;
    const nextIndex = state.lightboxIndex + delta;
    if (nextIndex < 0 || nextIndex >= state.activeImages.length) return;
    selectIndex(nextIndex);
    update();
    markActiveSeen();
  }

  function reconcileActiveImages() {
    if (!isOpen() || !state.activeImages.length) return;
    let index = selectedImageKey
      ? state.activeImages.findIndex(image => imageKey(image) === selectedImageKey)
      : state.lightboxIndex;
    if (index < 0) index = Math.min(state.lightboxIndex, state.activeImages.length - 1);
    selectIndex(index);
    const image = activeImage();
    if (!image) return;
    if (elements.lightboxImg.getAttribute('src') !== image.src) update();
    else renderMeta();
  }

  function download() {
    const image = activeImage();
    if (!image?.src) return;
    const link = documentObject.createElement('a');
    link.href = image.src;
    link.download = image.name || '';
    documentObject.body.append(link);
    link.click();
    link.remove();
  }

  function isControlTarget(target) {
    return Boolean(target?.closest?.('button, a, input, textarea, select'));
  }

  function isViewportZoomed() {
    return Number(windowObject.visualViewport?.scale || 1) > 1.02;
  }

  function handleTouchStart(event) {
    if (!isOpen() || isControlTarget(event.target) || event.touches.length !== 1 || isViewportZoomed()) {
      touch = null;
      return;
    }
    const point = event.touches[0];
    touch = {
      startX: point.clientX,
      startY: point.clientY,
      lastX: point.clientX,
      lastY: point.clientY,
      startedAt: now(),
    };
  }

  function handleTouchMove(event) {
    if (!touch || event.touches.length !== 1 || isViewportZoomed()) {
      touch = null;
      return;
    }
    event.preventDefault();
    const point = event.touches[0];
    touch.lastX = point.clientX;
    touch.lastY = point.clientY;
  }

  function handleTouchEnd() {
    if (!touch) return;
    if (isViewportZoomed()) {
      touch = null;
      return;
    }
    const deltaX = touch.lastX - touch.startX;
    const deltaY = touch.lastY - touch.startY;
    const elapsed = now() - touch.startedAt;
    touch = null;
    if (elapsed > 900) return;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return;
    step(deltaX < 0 ? 1 : -1);
  }

  function handleImageLoad() {
    if (!isOpen()) return;
    clearTimer(loadingTimer);
    clearTimer(errorTimer);
    const requestId = Number(elements.lightboxImg.dataset.requestId || 0);
    if (requestId && requestId !== state.lightboxRequestId) return;
    elements.lightboxImg.classList.remove('is-pending');
    state.lightboxLoading = false;
    state.lightboxError = false;
    const image = activeImage();
    if (image?.src === elements.lightboxImg.currentSrc || image?.src === elements.lightboxImg.src) {
      const decoded = createImage();
      decoded.decoding = 'async';
      decoded.loading = 'eager';
      decoded.src = image.src;
      if (decoded.complete && decoded.naturalWidth) rememberDecodedImage(image.src, decoded);
    }
    warmDecodedWindow(state.lightboxIndex);
    renderLoadState();
  }

  function handleImageError() {
    if (!isOpen()) return;
    const requestId = Number(elements.lightboxImg.dataset.requestId || 0);
    if (requestId && requestId !== state.lightboxRequestId) return;
    const image = activeImage();
    if (!image || elements.lightboxImg.getAttribute('src') !== image.src) return;
    if (!elements.lightboxImg.complete) return;

    clearTimer(errorTimer);
    errorTimer = setTimer(() => {
      if (!isOpen() || requestId !== state.lightboxRequestId) return;
      const current = activeImage();
      if (!current || elements.lightboxImg.getAttribute('src') !== current.src) return;
      if (!elements.lightboxImg.complete || elements.lightboxImg.naturalWidth) return;
      clearTimer(loadingTimer);
      elements.lightboxImg.classList.remove('is-pending');
      state.lightboxLoading = false;
      state.lightboxError = true;
      renderLoadState();
    }, 500);
  }

  function handleKeydown(event) {
    if (!isOpen()) return false;
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      const image = activeImage();
      if (image) toggleImageFavorite(image).catch(error => showNotice(error.message));
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
      return true;
    }
    return false;
  }

  function bind() {
    if (bound) return;
    bound = true;
    elements.closeLightbox.addEventListener('click', () => close());
    elements.lightboxDownload.addEventListener('click', event => {
      event.stopPropagation();
      download();
    });
    elements.lightboxImg.addEventListener('load', handleImageLoad);
    elements.lightboxImg.addEventListener('error', handleImageError);
    elements.lightboxFavorite.addEventListener('click', event => {
      event.stopPropagation();
      const image = activeImage();
      if (image) toggleImageFavorite(image).catch(error => showNotice(error.message));
    });
    elements.lightboxSeen.addEventListener('click', event => {
      event.stopPropagation();
      const image = activeImage();
      if (image) setImageSeen(image, !image.seen).catch(error => showNotice(error.message));
    });
    elements.prevImage.addEventListener('click', () => step(-1));
    elements.nextImage.addEventListener('click', () => step(1));
    elements.lightbox.addEventListener('click', event => {
      if (event.target === elements.lightbox) close();
    });
    elements.lightbox.addEventListener('touchstart', handleTouchStart, { passive: true });
    elements.lightbox.addEventListener('touchmove', handleTouchMove, { passive: false });
    elements.lightbox.addEventListener('touchend', handleTouchEnd);
    elements.lightbox.addEventListener('touchcancel', () => { touch = null; });
  }

  return {
    bind,
    close,
    handleKeydown,
    isOpen,
    open,
    reconcileActiveImages,
    renderMeta,
    step,
    update,
  };
}
