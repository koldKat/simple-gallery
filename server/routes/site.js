'use strict';

function decodeRouteParts(pathname) {
  return String(pathname || '').split('/').filter(Boolean).map(part => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function handleSiteRoute(context, req, res, url) {
  const {
    sendJson,
    sendHtml,
    sendText,
    stateForUser,
    galleryImagesResponseForUser,
    handleEvents,
    absoluteUrlForRequest,
    renderSitemapIndex,
    renderPagesSitemap,
    renderModelsSitemap,
    renderGalleriesSitemap,
    renderHomePage,
    renderModelsPage,
    renderFavoritesPage,
    renderModelPage,
    renderGalleryPage,
    renderNotFoundPage,
    getState,
  } = context;

  if (url.pathname === '/api/state') {
    sendJson(res, 200, stateForUser(req));
    return true;
  }
  if (url.pathname === '/api/gallery') {
    const modelName = String(url.searchParams.get('model') || '');
    const galleryName = String(url.searchParams.get('gallery') || '');
    sendJson(res, 200, galleryImagesResponseForUser(req, modelName, galleryName));
    return true;
  }
  if (url.pathname === '/api/events') {
    handleEvents(req, res);
    return true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname === '/robots.txt') {
    sendText(
      res,
      200,
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\n\nSitemap: ${absoluteUrlForRequest(req, '/sitemap.xml')}\n`
    );
    return true;
  }
  const sitemapRoutes = new Map([
    ['/sitemap.xml', renderSitemapIndex],
    ['/sitemap-pages.xml', renderPagesSitemap],
    ['/sitemap-models.xml', renderModelsSitemap],
    ['/sitemap-galleries.xml', renderGalleriesSitemap],
  ]);
  const renderSitemap = sitemapRoutes.get(url.pathname);
  if (renderSitemap) {
    sendText(res, 200, renderSitemap(req), 'application/xml; charset=utf-8');
    return true;
  }
  if (url.pathname === '/') {
    sendHtml(res, 200, renderHomePage(req));
    return true;
  }
  if (url.pathname === '/models') {
    sendHtml(res, 200, renderModelsPage(req));
    return true;
  }
  if (url.pathname === '/favorites') {
    sendHtml(res, 200, renderFavoritesPage(req));
    return true;
  }

  const routeParts = decodeRouteParts(url.pathname);
  if (routeParts[0] === 'model' && routeParts[1] && routeParts.length === 2) {
    const model = (getState().models || []).find(item => item.id === routeParts[1]);
    sendHtml(res, model ? 200 : 404, model ? renderModelPage(req, model) : renderNotFoundPage(req));
    return true;
  }
  if (routeParts[0] === 'model' && routeParts[1] && routeParts[2] === 'gallery' && routeParts[3] && routeParts.length === 4) {
    const model = (getState().models || []).find(item => item.id === routeParts[1]);
    const gallery = model?.galleries?.find(item => item.name === routeParts[3]);
    sendHtml(res, model && gallery ? 200 : 404, model && gallery ? renderGalleryPage(req, model, gallery) : renderNotFoundPage(req));
    return true;
  }
  return false;
}

module.exports = { decodeRouteParts, handleSiteRoute };
