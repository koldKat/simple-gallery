'use strict';

const {
  escapeHtml,
  escapeJsonForHtml,
  formatDateLabel,
  formatCount,
  renderStatsBreakdown,
  seoKeywords,
  renderInstanceTemplate,
} = require('./html-format');
const { requestUrl, absoluteUrlForRequest, modelRoutePath, galleryRoutePath, modelsDirectoryPath } = require('./route-paths');

function createPageRenderer({ appMetadata, seoProfile, normalizeModelName, galleryImagesResponse, getState }) {
  function topSidebarModels(limit = 50) {
    return (getState().models || []).slice(0, limit);
  }

  function renderSidebarLinks(selectedModelId = '') {
    const models = topSidebarModels();
    return `${models.map(model => `
      <a class="model-card${model.id === selectedModelId ? ' is-active' : ''}" href="${modelRoutePath(model.id)}">
        <img src="${escapeHtml(model.cover || '')}" alt="${escapeHtml(normalizeModelName(model.name))}">
        <div>
          <div class="card-title">${escapeHtml(normalizeModelName(model.name))}</div>
          <div class="card-sub">${formatCount(model.galleryCount)} galleries · ${formatCount(model.count)} images</div>
          <div class="card-sub">Updated ${escapeHtml(formatDateLabel(model.updatedAt))}</div>
        </div>
      </a>
    `).join('')}`;
  }

  function renderLatestGalleryCards(galleries) {
    return (galleries || []).map(gallery => `
      <a class="gallery-card latest-gallery-card" href="${galleryRoutePath(gallery.modelId, gallery.name)}">
        <img src="${escapeHtml(gallery.cover || '')}" alt="${escapeHtml(`${normalizeModelName(gallery.modelName)} gallery ${gallery.name}`)}">
        <div>
          <div class="card-title">${escapeHtml(`${normalizeModelName(gallery.modelName)} / ${gallery.name}`)}</div>
          <div class="card-sub">${formatCount(gallery.count)} images · ${escapeHtml(formatDateLabel(gallery.addedAt || gallery.updatedAt))}</div>
        </div>
      </a>
    `).join('');
  }

  function renderModelGalleryCards(model) {
    return (model?.galleries || []).map(gallery => `
      <a class="gallery-card latest-gallery-card" href="${galleryRoutePath(model.id, gallery.name)}">
        <img src="${escapeHtml(gallery.cover || '')}" alt="${escapeHtml(`${normalizeModelName(model.name)} gallery ${gallery.name}`)}">
        <div>
          <div class="card-title">Gallery ${escapeHtml(gallery.name)}</div>
          <div class="card-sub">${formatCount(gallery.count)} images · ${escapeHtml(formatDateLabel(gallery.updatedAt))}</div>
        </div>
      </a>
    `).join('');
  }

  function modelsDirectoryData(req) {
    const allModels = getState().models || [];
    const url = requestUrl(req);
    const selectedLetter = String(url.searchParams.get('letter') || '')
      .trim()
      .toUpperCase();
    const letter = /^[A-Z]$/.test(selectedLetter) ? selectedLetter : '';
    const pageParam = url.searchParams.get('page') || '1';
    const page = Math.max(1, Number(pageParam || 1) || 1);
    const filtered = letter
      ? allModels.filter(model => normalizeModelName(model.name).toUpperCase().startsWith(letter))
      : allModels;
    const perPage = 60;
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
    const safePage = Math.min(page, totalPages);
    const startIndex = (safePage - 1) * perPage;
    return {
      letter,
      page: safePage,
      perPage,
      totalPages,
      totalModels: filtered.length,
      models: filtered.slice(startIndex, startIndex + perPage),
    };
  }

  function renderLetterBar(selectedLetter = '') {
    const letters = ['All', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
    return `
      <div class="letter-bar">
        ${letters.map(letter => {
          const isAll = letter === 'All';
          const href = modelsDirectoryPath(isAll ? '' : letter, 1);
          const active = (isAll && !selectedLetter) || (!isAll && selectedLetter === letter);
          return `<a class="link-btn${active ? ' is-active' : ''}" href="${href}">${letter}</a>`;
        }).join('')}
      </div>
    `;
  }

  function renderPagerRow(letter, page, totalPages) {
    if (totalPages <= 1) return '';
    const windowStart = Math.max(1, page - 2);
    const windowEnd = Math.min(totalPages, page + 2);
    const pageLinks = [];
    for (let current = windowStart; current <= windowEnd; current += 1) {
      pageLinks.push(`<a class="link-btn${current === page ? ' is-active' : ''}" href="${modelsDirectoryPath(letter, current)}">${current}</a>`);
    }
    return `
      <div class="pager-row">
        ${page > 1 ? `<a class="link-btn" href="${modelsDirectoryPath(letter, page - 1)}">Previous</a>` : '<button type="button" disabled>Previous</button>'}
        ${windowStart > 1 ? `<a class="link-btn" href="${modelsDirectoryPath(letter, 1)}">1</a><span>…</span>` : ''}
        ${pageLinks.join('')}
        ${windowEnd < totalPages ? `<span>…</span><a class="link-btn" href="${modelsDirectoryPath(letter, totalPages)}">${totalPages}</a>` : ''}
        ${page < totalPages ? `<a class="link-btn" href="${modelsDirectoryPath(letter, page + 1)}">Next</a>` : '<button type="button" disabled>Next</button>'}
      </div>
    `;
  }

  function renderModelsDirectory(req) {
    const data = modelsDirectoryData(req);
    return `
      ${renderLetterBar(data.letter)}
      <div class="browser-model-grid">
        ${data.models.map(model => `
          <a class="browser-model-card" href="${modelRoutePath(model.id)}">
            <img src="${escapeHtml(model.cover || '')}" alt="${escapeHtml(normalizeModelName(model.name))}">
            <div>
              <div class="card-title">${escapeHtml(normalizeModelName(model.name))}</div>
              <div class="card-sub">${formatCount(model.galleryCount)} galleries · ${formatCount(model.count)} images</div>
              <div class="card-sub">Updated ${escapeHtml(formatDateLabel(model.updatedAt))}</div>
            </div>
          </a>
        `).join('')}
      </div>
      ${renderPagerRow(data.letter, data.page, data.totalPages)}
    `;
  }

  function renderGalleryImagesGrid(model, gallery) {
    const payload = galleryImagesResponse(model.id, gallery.name);
    return (payload.images || []).map(image => `
      <button type="button" class="image-tile" aria-label="${escapeHtml(`Open ${normalizeModelName(model.name)} gallery ${gallery.name} image ${image.name}`)}">
        <img loading="lazy" src="${escapeHtml(image.thumb)}" alt="${escapeHtml(`${normalizeModelName(model.name)} ${gallery.name} ${image.name}`)}">
      </button>
    `).join('');
  }

  function renderSelectedGalleryBarHtml(model, gallery) {
    const index = (model.galleries || []).findIndex(item => item.name === gallery.name);
    const prev = index > 0 ? model.galleries[index - 1] : null;
    const next = index >= 0 && index < model.galleries.length - 1 ? model.galleries[index + 1] : null;
    return `
      <div class="selected-gallery-cover">
        <img src="${escapeHtml(gallery.cover || '')}" alt="${escapeHtml(`${normalizeModelName(model.name)} gallery ${gallery.name}`)}">
      </div>
      <div class="selected-gallery-main">
        <div class="selected-gallery-title">Gallery ${escapeHtml(gallery.name)}</div>
        <div class="card-sub">${formatCount(gallery.count)} images</div>
        <div class="card-sub">${escapeHtml(formatDateLabel(gallery.updatedAt))}</div>
      </div>
      <div class="selected-gallery-actions">
        ${prev ? `<a class="link-btn" href="${galleryRoutePath(model.id, prev.name)}">Previous</a>` : '<button type="button" disabled>Previous</button>'}
        ${next ? `<a class="link-btn" href="${galleryRoutePath(model.id, next.name)}">Next</a>` : '<button type="button" disabled>Next</button>'}
        <a class="link-btn" href="${modelRoutePath(model.id)}">All galleries</a>
      </div>
    `;
  }

  function instanceKeywords(profile, key, variables = {}, extras = []) {
    const configured = Array.isArray(profile[key]) ? profile[key] : [];
    return [...extras, ...configured.map(value => renderInstanceTemplate(value, variables))];
  }

  function renderSeoDocument(req, options = {}) {
    const canonical = absoluteUrlForRequest(req, options.canonicalPath || '/');
    const image = options.image ? absoluteUrlForRequest(req, options.image) : '';
    const app = appMetadata();
    const stats = getState().totals || {};
    const metaRobots = options.metaRobots || 'index,follow';
    const jsonLd = Array.isArray(options.jsonLd) ? options.jsonLd.filter(Boolean) : [];
    const headLinks = Array.isArray(options.headLinks) ? options.headLinks.filter(Boolean) : [];
    const description = options.description || app.name;
    const keywords = seoKeywords(
      ['gallery', 'models', 'galleries', 'photos', 'pictures', 'images'],
      options.keywords || []
    );
    return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(options.title || app.name)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="keywords" content="${escapeHtml(keywords)}">
    <meta name="robots" content="${escapeHtml(metaRobots)}">
    <meta name="bingbot" content="index,follow,max-snippet:-1,max-image-preview:large">
    <meta name="googlebot" content="index,follow,max-snippet:-1,max-image-preview:large">
    <meta name="application-name" content="${escapeHtml(app.name)}">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${escapeHtml(app.name)}">
    <meta property="og:title" content="${escapeHtml(options.title || app.name)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
    <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
    <meta name="twitter:title" content="${escapeHtml(options.title || app.name)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    ${image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : ''}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="stylesheet" href="/css/foundation.css?v=1">
    <link rel="stylesheet" href="/css/admin-shell.css?v=1">
    <link rel="stylesheet" href="/css/admin-import.css?v=1">
    <link rel="stylesheet" href="/css/admin-stats.css?v=1">
    <link rel="stylesheet" href="/css/gallery-shell.css?v=1">
    <link rel="stylesheet" href="/css/gallery-detail.css?v=1">
    <link rel="stylesheet" href="/css/favorites.css?v=1">
    <link rel="stylesheet" href="/css/images.css?v=1">
    <link rel="stylesheet" href="/css/lightbox.css?v=1">
    <link rel="stylesheet" href="/css/responsive.css?v=1">
    ${headLinks.join('\n  ')}
    ${jsonLd.map(entry => `<script type="application/ld+json">${escapeJsonForHtml(entry)}</script>`).join('\n  ')}
  </head>
  <body>
    <div class="app-shell">
      <header class="topbar">
        <div>
          <h1><a class="app-title-link" href="/"><span id="app-name">${escapeHtml(app.name)}</span> <span class="app-version-stack"><span id="app-tagline" class="app-tagline">${escapeHtml(app.tagline)}</span><span id="app-version-label" class="app-version-label">${escapeHtml(app.versionLabel)}</span></span></a></h1>
        </div>
        <div class="topbar-actions">
          <div class="auth-box" id="auth-box"></div>
          <div class="stats-stack">
            <div class="stats-row">
              <span class="stats-label">Totals</span>
              <div class="stats-card">
                <span id="stats" class="stats-breakdown">${renderStatsBreakdown(stats)}</span>
              </div>
            </div>
            <div class="stats-row" id="user-stats-row" hidden>
              <span class="stats-label">Unseen</span>
              <div class="stats-card">
                <span id="user-stats" class="user-stats stats-breakdown"></span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main class="layout">
        <aside class="sidebar">
          <div class="sidebar-head">
            <div class="sidebar-title-row">
              <h2>Models</h2>
              <label class="sidebar-toggle" for="hide-seen-models" hidden>
                <input id="hide-seen-models" type="checkbox">
                <span>Hide seen</span>
              </label>
            </div>
            <div id="model-count" class="sidebar-count">${formatCount(stats.models)} shown (${formatCount(stats.models)} total)</div>
            <input id="search" type="search" placeholder="Filter">
          </div>
          <div id="model-list" class="model-list">${options.sidebarHtml || ''}</div>
        </aside>

        <section class="content">
          <div class="content-head">
            <div>
              <p class="eyebrow" id="gallery-kicker">${escapeHtml(options.kicker || 'Latest')}</p>
              <h2 id="gallery-title">${escapeHtml(options.heading || 'Galleries')}</h2>
            </div>
            <div class="view-actions">
              <a id="home-btn" class="link-btn" href="/" data-tooltip="Latest galleries" aria-label="Latest galleries"${options.mode === 'home' ? ' hidden' : ''}>Home</a>
              <button id="favorites-btn" type="button" data-tooltip="View favorites" aria-label="View favorites" hidden>Favorites</button>
              <a id="browse-models-btn" class="link-btn" href="/models" data-tooltip="Browse all models" aria-label="Browse all models"${options.mode === 'models' ? ' hidden' : ''}>Browse Models</a>
              <button id="model-favorite-btn" type="button" data-tooltip="Favorite model" aria-label="Favorite model" hidden>☆</button>
              <button id="model-seen-btn" type="button" data-tooltip="Mark all galleries in this model seen" aria-label="Mark all galleries in this model seen" hidden>Mark model seen</button>
              <button id="grid-small" type="button" data-tooltip="Small thumbnails" aria-label="Small thumbnails"${options.hasGallery ? '' : ' hidden'}>Small</button>
              <button id="grid-large" type="button" data-tooltip="Large thumbnails" aria-label="Large thumbnails"${options.hasGallery ? '' : ' hidden'}>Large</button>
            </div>
          </div>
          <div id="model-browser" class="model-browser"${options.mode === 'models' ? '' : ' hidden'}>${options.modelBrowserHtml || ''}</div>
          <div id="favorites-view" class="favorites-view" hidden></div>
          <div id="selected-gallery-bar" class="selected-gallery-bar"${options.selectedGalleryBarHtml ? '' : ' hidden'}>${options.selectedGalleryBarHtml || ''}</div>
          <div id="gallery-list" class="gallery-list${options.latest ? ' latest-gallery-list' : ''}"${options.galleryListHtml != null ? '' : ' hidden'}>${options.galleryListHtml || ''}</div>
          <div id="image-grid" class="image-grid"${options.imageGridHtml != null ? '' : ' hidden'}>${options.imageGridHtml || ''}</div>
        </section>
      </main>
    </div>

    <div id="lightbox" class="lightbox" hidden>
      <button id="close-lightbox" class="icon-btn" type="button" data-tooltip="Close" aria-label="Close">×</button>
      <button id="lightbox-download" class="icon-btn lightbox-download" type="button" data-tooltip="Download image" aria-label="Download image">↓</button>
      <button id="lightbox-seen" class="icon-btn lightbox-seen" type="button" data-tooltip="Mark seen" aria-label="Mark seen">✓</button>
      <button id="lightbox-favorite" class="icon-btn lightbox-favorite" type="button" data-tooltip="Favorite image" aria-label="Favorite image">☆</button>
      <button id="prev-image" class="nav-btn prev" type="button" data-tooltip="Previous" aria-label="Previous">‹</button>
      <div class="lightbox-media">
        <img id="lightbox-img" alt="">
        <div id="lightbox-loading" class="lightbox-loading" hidden>
          <div class="lightbox-loading-bar"></div>
          <div id="lightbox-loading-text" class="lightbox-loading-text">Loading...</div>
        </div>
      </div>
      <button id="next-image" class="nav-btn next" type="button" data-tooltip="Next" aria-label="Next">›</button>
      <div id="lightbox-caption" class="caption"></div>
    </div>
  <script type="module" src="/js/app.js?v=108"></script>
  </body>
  </html>`;
  }
  function renderHomePage(req) {
    const app = appMetadata();
    const profile = seoProfile();
    const variables = {
      appName: app.name,
      models: formatCount(getState().totals.models),
      galleries: formatCount(getState().totals.galleries),
      images: formatCount(getState().totals.images),
    };
    const description = renderInstanceTemplate(
      profile.homeDescription,
      variables,
      '{appName} contains {models} models, {galleries} galleries, and {images} images.'
    );
    return renderSeoDocument(req, {
      title: renderInstanceTemplate(profile.homeTitle, variables, '{appName} - Image Galleries'),
      description,
      canonicalPath: '/',
      image: getState().latest?.[0]?.cover || '',
      kicker: 'Latest',
      heading: 'Galleries',
      sidebarHtml: renderSidebarLinks(),
      galleryListHtml: renderLatestGalleryCards(getState().latest || []),
      latest: true,
      mode: 'home',
      keywords: instanceKeywords(profile, 'homeKeywords', variables, [app.name, 'latest galleries']),
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: app.name,
        description,
        url: absoluteUrlForRequest(req, '/'),
      }],
    });
  }

  function renderModelsPage(req) {
    const app = appMetadata();
    const profile = seoProfile();
    const directory = modelsDirectoryData(req);
    const canonicalPath = modelsDirectoryPath(directory.letter, directory.page);
    const heading = directory.letter ? `Models: ${directory.letter}` : 'All Models';
    const variables = {
      appName: app.name,
      letter: directory.letter || '',
      models: directory.letter ? directory.totalModels : (getState().models || []).length,
      page: directory.page,
      pages: directory.totalPages,
    };
    const description = renderInstanceTemplate(
      directory.letter ? profile.modelsLetterDescription : profile.modelsDescription,
      variables,
      directory.letter
        ? 'Browse models under {letter} in {appName}. {models} models listed on page {page} of {pages}.'
        : 'Browse models in {appName}. {models} models listed on page {page} of {pages}.'
    );
    const headLinks = [];
    if (directory.page > 1) {
      headLinks.push(`<link rel="prev" href="${escapeHtml(absoluteUrlForRequest(req, modelsDirectoryPath(directory.letter, directory.page - 1)))}">`);
    }
    if (directory.page < directory.totalPages) {
      headLinks.push(`<link rel="next" href="${escapeHtml(absoluteUrlForRequest(req, modelsDirectoryPath(directory.letter, directory.page + 1)))}">`);
    }
    return renderSeoDocument(req, {
      title: `${heading} | ${app.name}`,
      description,
      canonicalPath,
      image: getState().models?.[0]?.cover || '',
      kicker: 'Models',
      heading,
      sidebarHtml: renderSidebarLinks(),
      modelBrowserHtml: renderModelsDirectory(req),
      mode: 'models',
      headLinks,
      keywords: instanceKeywords(profile, 'modelsKeywords', variables, [heading, 'model directory']),
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `${heading} | ${app.name}`,
        description,
        url: absoluteUrlForRequest(req, canonicalPath),
      }],
    });
  }

  function renderFavoritesPage(req) {
    const app = appMetadata();
    const profile = seoProfile();
    const variables = { appName: app.name };
    const description = renderInstanceTemplate(
      profile.favoritesDescription,
      variables,
      'Saved favorite models, galleries, and images in {appName}.'
    );
    return renderSeoDocument(req, {
      title: `Favorites | ${app.name}`,
      description,
      canonicalPath: '/favorites',
      kicker: 'Favorites',
      heading: 'Saved Galleries and Images',
      sidebarHtml: renderSidebarLinks(),
      mode: 'favorites',
      keywords: instanceKeywords(profile, 'favoritesKeywords', variables, ['favorites', app.name]),
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `Favorites | ${app.name}`,
        description,
        url: absoluteUrlForRequest(req, '/favorites'),
      }],
    });
  }

  function renderModelPage(req, model) {
    const app = appMetadata();
    const profile = seoProfile();
    const modelUrl = absoluteUrlForRequest(req, modelRoutePath(model.id));
    const modelName = normalizeModelName(model.name);
    const variables = {
      appName: app.name,
      modelName,
      galleries: model.galleryCount,
      images: model.count,
    };
    const description = renderInstanceTemplate(
      profile.modelDescription,
      variables,
      '{modelName} has {galleries} galleries and {images} images on {appName}.'
    );
    return renderSeoDocument(req, {
      title: `${modelName} | ${app.name}`,
      description,
      canonicalPath: modelRoutePath(model.id),
      image: model.cover || '',
      kicker: modelName,
      heading: 'Galleries',
      sidebarHtml: renderSidebarLinks(model.id),
      galleryListHtml: renderModelGalleryCards(model),
      mode: 'model',
      keywords: instanceKeywords(profile, 'modelKeywords', variables, [modelName]),
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `${modelName} galleries`,
        description,
        url: modelUrl,
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: (model.galleries || []).map((gallery, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: absoluteUrlForRequest(req, galleryRoutePath(model.id, gallery.name)),
            name: `Gallery ${gallery.name}`,
          })),
        },
      }],
    });
  }

  function renderGalleryPage(req, model, gallery) {
    const app = appMetadata();
    const profile = seoProfile();
    const galleryUrl = absoluteUrlForRequest(req, galleryRoutePath(model.id, gallery.name));
    const payload = galleryImagesResponse(model.id, gallery.name);
    const modelName = normalizeModelName(model.name);
    const variables = {
      appName: app.name,
      modelName,
      galleryName: gallery.name,
      images: gallery.count,
    };
    const description = renderInstanceTemplate(
      profile.galleryDescription,
      variables,
      'Gallery {galleryName} for {modelName} contains {images} images on {appName}.'
    );
    return renderSeoDocument(req, {
      title: `${modelName} / Gallery ${gallery.name} | ${app.name}`,
      description,
      canonicalPath: galleryRoutePath(model.id, gallery.name),
      image: gallery.cover || '',
      kicker: modelName,
      heading: `Gallery ${gallery.name}`,
      sidebarHtml: renderSidebarLinks(model.id),
      selectedGalleryBarHtml: renderSelectedGalleryBarHtml(model, gallery),
      imageGridHtml: renderGalleryImagesGrid(model, gallery),
      hasGallery: true,
      mode: 'model',
      keywords: instanceKeywords(profile, 'galleryKeywords', variables, [modelName, `gallery ${gallery.name}`]),
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'ImageGallery',
          name: `${modelName} / Gallery ${gallery.name}`,
          description,
          url: galleryUrl,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: app.name,
              item: absoluteUrlForRequest(req, '/'),
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: modelName,
              item: absoluteUrlForRequest(req, modelRoutePath(model.id)),
            },
            {
              '@type': 'ListItem',
              position: 3,
              name: `Gallery ${gallery.name}`,
              item: galleryUrl,
            },
          ],
        },
        ...payload.images.slice(0, 20).map(image => ({
          '@context': 'https://schema.org',
          '@type': 'ImageObject',
          contentUrl: absoluteUrlForRequest(req, image.src),
          thumbnailUrl: absoluteUrlForRequest(req, image.thumb),
          name: image.name,
        })),
      ],
    });
  }

  function renderNotFoundPage(req) {
    return renderSeoDocument(req, {
      title: `Not Found | ${appMetadata().name}`,
      description: 'The requested page could not be found.',
      canonicalPath: req.url,
      metaRobots: 'noindex,follow',
      kicker: 'Missing',
      heading: 'Not Found',
      sidebarHtml: renderSidebarLinks(),
      galleryListHtml: '<div class="empty">Page not found.</div>',
      mode: 'home',
    });
  }

  return { renderHomePage, renderModelsPage, renderFavoritesPage, renderModelPage, renderGalleryPage, renderNotFoundPage };
}

module.exports = { createPageRenderer };
