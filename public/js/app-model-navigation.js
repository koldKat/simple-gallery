export function createModelNavigationController(options) {
  const {
    state,
    elements,
    searchText,
    shuffledModels,
    formatCount,
    formatDate,
    titleCase,
    bindCardImageLoading,
    openModel,
    render,
    windowObject = window,
    documentObject = document,
  } = options;
  let lastModelListRenderKey = '';
  let sidebarShuffleVersion = 0;
  let sidebarPreview = null;
  let sidebarLayoutRaf = 0;

  function shouldRandomizeSidebarModels(filter) {
    if (filter) return false;
    return !windowObject.matchMedia('(max-width: 820px)').matches;
  }

  function isMobileLayout() {
    return windowObject.matchMedia('(max-width: 820px)').matches;
  }

  function sidebarAvailableHeight() {
    const sidebar = elements.modelList?.closest('.sidebar');
    if (!sidebar) return 0;
    if (isMobileLayout()) {
      sidebar.style.height = '';
      return 0;
    }
    const rect = sidebar.getBoundingClientRect();
    const topInset = Math.max(14, Math.round(rect.top));
    return Math.max(0, windowObject.innerHeight - topInset - 14);
  }

  function fitSidebarToRenderedCards() {
    const sidebar = elements.modelList?.closest('.sidebar');
    if (!sidebar) return;
    if (isMobileLayout()) {
      sidebar.style.height = '';
      return;
    }
    const headerHeight = elements.modelList?.previousElementSibling?.offsetHeight || 0;
    const listHeight = elements.modelList?.scrollHeight || 0;
    sidebar.style.height = `${Math.ceil(headerHeight + listHeight)}px`;
  }

  function sidebarVisibleCount() {
    if (isMobileLayout()) return 0;
    const sidebarHeight = sidebarAvailableHeight();
    const headerHeight = elements.modelList?.previousElementSibling?.offsetHeight || 0;
    const listStyle = elements.modelList ? windowObject.getComputedStyle(elements.modelList) : null;
    const paddingTop = parseFloat(listStyle?.paddingTop || '0') || 0;
    const paddingBottom = parseFloat(listStyle?.paddingBottom || '0') || 0;
    const gap = parseFloat(listStyle?.rowGap || listStyle?.gap || '9') || 9;
    const available = Math.max(0, sidebarHeight - headerHeight - paddingTop - paddingBottom);
    const probeCardHeight = elements.modelList?.querySelector('.model-card')?.offsetHeight || 89;
    const estimatedCardHeight = Math.max(72, probeCardHeight + gap);
    const count = Math.floor((available + gap) / estimatedCardHeight);
    return Math.max(1, count || 1);
  }

  function scheduleSidebarLayoutSync() {
    if (sidebarLayoutRaf) return;
    sidebarLayoutRaf = windowObject.requestAnimationFrame(() => {
      sidebarLayoutRaf = 0;
      lastModelListRenderKey = '';
      renderModels();
    });
  }

  function ensureSidebarPreview() {
    if (sidebarPreview) return sidebarPreview;
    const root = documentObject.createElement('div');
    root.className = 'sidebar-hover-preview';
    root.hidden = true;
    const image = documentObject.createElement('img');
    image.alt = '';
    const caption = documentObject.createElement('div');
    caption.className = 'sidebar-hover-preview-caption';
    root.append(image, caption);
    documentObject.body.append(root);
    sidebarPreview = { root, image, caption };
    return sidebarPreview;
  }

  function hideSidebarPreview() {
    if (!sidebarPreview) return;
    sidebarPreview.root.hidden = true;
    sidebarPreview.root.classList.remove('is-visible');
  }

  function positionSidebarPreview(anchorRect) {
    if (!sidebarPreview || !anchorRect) return;
    const margin = 14;
    const previewWidth = 240;
    const previewHeight = 320;
    let left = anchorRect.right + margin;
    let top = anchorRect.top;
    if (left + previewWidth > windowObject.innerWidth - margin) {
      left = Math.max(margin, anchorRect.left - previewWidth - margin);
    }
    if (top + previewHeight > windowObject.innerHeight - margin) {
      top = Math.max(margin, windowObject.innerHeight - previewHeight - margin);
    }
    sidebarPreview.root.style.left = `${Math.round(left)}px`;
    sidebarPreview.root.style.top = `${Math.round(top)}px`;
  }

  function sidebarPreviewCover(model) {
    const galleries = Array.isArray(model?.galleries) ? model.galleries.slice() : [];
    if (!galleries.length) return model?.cover || '';
    galleries.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
    return galleries[galleries.length - 1]?.cover || model?.cover || '';
  }

  function showSidebarPreview(button, cover, label) {
    if (!cover) return;
    const preview = ensureSidebarPreview();
    preview.image.src = cover;
    preview.caption.textContent = label || '';
    positionSidebarPreview(button.getBoundingClientRect());
    preview.root.hidden = false;
    preview.root.classList.add('is-visible');
  }

  function bindSidebarPreview(button, cover, label) {
    if (!button || !cover) return;
    button.addEventListener('mouseenter', () => {
      showSidebarPreview(button, cover, label);
    });
    button.addEventListener('mousemove', () => {
      positionSidebarPreview(button.getBoundingClientRect());
    });
    button.addEventListener('mouseleave', hideSidebarPreview);
    button.addEventListener('focus', () => {
      showSidebarPreview(button, cover, label);
    });
    button.addEventListener('blur', hideSidebarPreview);
  }

  function renderModels() {
    const filter = searchText(elements.search.value);
    const allModels = state.data?.models || [];
    const honorHideSeen = !filter && state.hideSeenModels;
    const totalModels = allModels.filter(model => !honorHideSeen || !model.seen);
    const models = totalModels.filter(model => {
      return searchText(model.name).includes(filter);
    });
    const count = sidebarVisibleCount();
    const selected = state.selectedModel ? models.find(model => model.id === state.selectedModel) || null : null;
    const pool = selected ? models.filter(model => model.id !== selected.id) : models.slice();
    const randomizeModels = shouldRandomizeSidebarModels(filter);
    const orderedPool = randomizeModels
      ? shuffledModels(pool, sidebarShuffleVersion + models.length)
      : pool;
    const visibleModels = (selected ? [selected, ...orderedPool] : orderedPool).slice(0, count);
    const renderKey = JSON.stringify({
      filter,
      hideSeenModels: honorHideSeen,
      randomizeModels,
      sidebarShuffleVersion,
      count,
      selectedModel: state.selectedModel,
      totalModels: totalModels.length,
      visibleModels: visibleModels.map(model => ({
        id: model.id,
        name: model.name,
        cover: model.cover,
        galleryCount: model.galleryCount,
        count: model.count,
        updatedAt: model.updatedAt,
        seen: model.seen,
      })),
    });

    if (elements.modelCount) elements.modelCount.textContent = `${formatCount(visibleModels.length)} shown (${formatCount(totalModels.length)} total)`;
    if (renderKey === lastModelListRenderKey) {
      fitSidebarToRenderedCards();
      return;
    }
    lastModelListRenderKey = renderKey;
    elements.modelList.innerHTML = '';

    if (!models.length) {
      elements.modelList.innerHTML = `<div class="empty">${state.hideSeenModels ? 'No unseen models found.' : 'No models found.'}</div>`;
      fitSidebarToRenderedCards();
      return;
    }

    for (const model of visibleModels) {
      const button = documentObject.createElement('button');
      button.type = 'button';
      button.className = `model-card${model.id === state.selectedModel ? ' is-active' : ''}`;
      const previewCover = sidebarPreviewCover(model);
      button.innerHTML = `
        <img loading="lazy" decoding="async" src="${previewCover || ''}" alt="">
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
      bindSidebarPreview(button, previewCover, titleCase(model.name));
      button.addEventListener('click', () => {
        openModel(model.id);
        render();
      });
      elements.modelList.append(button);
    }
    fitSidebarToRenderedCards();
  }

  function modelInitial(model) {
    const first = titleCase(model.name).charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : '#';
  }

  function modelsForBrowser() {
    const models = (state.data?.models || []).slice().sort((a, b) => titleCase(a.name).localeCompare(titleCase(b.name)));
    if (state.modelBrowserLetter === 'all') return models;
    return models.filter(model => modelInitial(model) === state.modelBrowserLetter);
  }

  function renderModelBrowser() {
    elements.modelBrowser.hidden = state.mode !== 'models';
    if (state.mode !== 'models') {
      elements.modelBrowser.innerHTML = '';
      return;
    }

    const letters = ['all', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
    const models = modelsForBrowser();
    const pageSize = 60;
    const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
    if (state.modelBrowserPage >= pageCount) state.modelBrowserPage = pageCount - 1;
    const start = state.modelBrowserPage * pageSize;
    const visible = models.slice(start, start + pageSize);

    elements.galleryKicker.textContent = 'Models';
    elements.galleryTitle.textContent = state.modelBrowserLetter === 'all' ? 'All Models' : `Models: ${state.modelBrowserLetter}`;
    elements.modelBrowser.innerHTML = '';

    const letterBar = documentObject.createElement('div');
    letterBar.className = 'letter-bar';
    for (const letter of letters) {
      const button = documentObject.createElement('button');
      button.type = 'button';
      button.className = letter === state.modelBrowserLetter ? 'is-active' : '';
      button.textContent = letter === 'all' ? 'All' : letter;
      button.addEventListener('click', () => {
        state.modelBrowserLetter = letter;
        state.modelBrowserPage = 0;
        render();
      });
      letterBar.append(button);
    }
    elements.modelBrowser.append(letterBar);

    const grid = documentObject.createElement('div');
    grid.className = 'browser-model-grid';
    for (const model of visible) {
      const button = documentObject.createElement('button');
      button.type = 'button';
      button.className = 'browser-model-card';
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
      button.addEventListener('click', () => {
        openModel(model.id);
        render();
      });
      grid.append(button);
    }
    elements.modelBrowser.append(grid);

    const pager = documentObject.createElement('div');
    pager.className = 'pager-row';
    pager.innerHTML = `
      <button type="button" ${state.modelBrowserPage === 0 ? 'disabled' : ''}>Previous</button>
      <span>${models.length ? start + 1 : 0}-${Math.min(start + pageSize, models.length)} of ${models.length}</span>
      <button type="button" ${state.modelBrowserPage >= pageCount - 1 ? 'disabled' : ''}>Next</button>
    `;
    const [prev, next] = pager.querySelectorAll('button');
    prev.addEventListener('click', () => {
      state.modelBrowserPage = Math.max(0, state.modelBrowserPage - 1);
      render();
    });
    next.addEventListener('click', () => {
      state.modelBrowserPage = Math.min(pageCount - 1, state.modelBrowserPage + 1);
      render();
    });
    elements.modelBrowser.append(pager);
  }

  function advanceShuffle() {
    sidebarShuffleVersion += 1;
    lastModelListRenderKey = '';
  }

  return {
    advanceShuffle,
    fitSidebar: fitSidebarToRenderedCards,
    modelsForBrowser,
    previewCover: sidebarPreviewCover,
    renderBrowser: renderModelBrowser,
    renderSidebar: renderModels,
    scheduleLayoutSync: scheduleSidebarLayoutSync,
  };
}
