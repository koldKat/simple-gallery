export function uniqueBackdropUrls(values) {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

export function createBackdropController({ getUrls, rotationMs = 60_000 }) {
  const media = window.matchMedia('(max-width: 820px)');
  let backdrop = null;
  let activeLayer = 0;
  let currentUrl = '';
  let pendingUrl = '';
  let requestId = 0;
  let rotationTimer = null;
  let lastChangedAt = 0;

  function ensureBackdrop() {
    if (backdrop) return backdrop;
    const root = document.createElement('div');
    root.className = 'gallery-backdrop';
    root.setAttribute('aria-hidden', 'true');
    const layers = [0, 1].map(() => {
      const layer = document.createElement('div');
      layer.className = 'gallery-backdrop-layer';
      root.append(layer);
      return layer;
    });
    const shade = document.createElement('div');
    shade.className = 'gallery-backdrop-shade';
    root.append(shade);
    document.body.prepend(root);
    backdrop = { root, layers };
    return backdrop;
  }

  function randomUrl(urls) {
    if (!urls.length) return '';
    const alternatives = urls.length > 1
      ? urls.filter(url => url !== currentUrl && url !== pendingUrl)
      : urls;
    const pool = alternatives.length ? alternatives : urls;
    return pool[Math.floor(Math.random() * pool.length)] || '';
  }

  function schedule(delay = rotationMs) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
    if (media.matches) return;
    rotationTimer = setTimeout(() => {
      rotationTimer = null;
      sync({ rotate: true });
    }, Math.max(0, delay));
  }

  function clear() {
    clearTimeout(rotationTimer);
    rotationTimer = null;
    requestId += 1;
    currentUrl = '';
    pendingUrl = '';
    lastChangedAt = 0;
    document.body.classList.remove('has-gallery-backdrop');
    backdrop?.layers.forEach(layer => layer.classList.remove('is-visible'));
  }

  function sync(options = {}) {
    if (media.matches) {
      clear();
      return;
    }
    const rotate = Boolean(options.rotate);
    if (!rotate && (pendingUrl || currentUrl)) return;
    if (rotate && pendingUrl) {
      schedule();
      return;
    }
    if (rotate && lastChangedAt) {
      const elapsed = Date.now() - lastChangedAt;
      if (elapsed < rotationMs) {
        schedule(rotationMs - elapsed);
        return;
      }
    }

    const urls = uniqueBackdropUrls(getUrls());
    if (!urls.length) {
      schedule();
      return;
    }
    const url = randomUrl(urls);
    if (!url) {
      schedule();
      return;
    }
    if (url === pendingUrl) return;
    if (url === currentUrl && document.body.classList.contains('has-gallery-backdrop')) {
      schedule();
      return;
    }

    requestId += 1;
    const pendingRequest = requestId;
    pendingUrl = url;
    const preload = new Image();
    preload.decoding = 'async';
    preload.onload = () => {
      if (pendingRequest !== requestId || media.matches) return;
      const element = ensureBackdrop();
      const nextIndex = activeLayer === 0 ? 1 : 0;
      const current = element.layers[activeLayer];
      const next = element.layers[nextIndex];
      next.classList.remove('is-visible');
      next.style.backgroundImage = `url(${JSON.stringify(url)})`;
      void next.offsetWidth;
      next.classList.add('is-visible');
      current.classList.remove('is-visible');
      activeLayer = nextIndex;
      currentUrl = url;
      pendingUrl = '';
      lastChangedAt = Date.now();
      document.body.classList.add('has-gallery-backdrop');
      schedule();
    };
    preload.onerror = () => {
      if (pendingRequest !== requestId) return;
      pendingUrl = '';
      schedule();
    };
    preload.src = url;
  }

  media.addEventListener('change', sync);
  return { clear, sync };
}
