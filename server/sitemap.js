'use strict';

function validLastmodXml(value, escapeHtml) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `<lastmod>${escapeHtml(date.toISOString())}</lastmod>`;
}

function sitemapUrlsetXml(entries, escapeHtml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(url => `<url><loc>${escapeHtml(url.loc)}</loc>${validLastmodXml(url.lastmod, escapeHtml)}</url>`).join('\n')}
</urlset>`;
}

function createSitemapRenderer(ctx) {
  const {
    escapeHtml,
    absoluteUrlForRequest,
    modelRoutePath,
    galleryRoutePath,
    modelsDirectoryPath,
    normalizeModelName,
    getState,
  } = ctx;

  function renderIndex(req) {
    const state = getState();
    const maps = ['/sitemap-pages.xml', '/sitemap-models.xml', '/sitemap-galleries.xml'];
    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${maps.map(path => `<sitemap><loc>${escapeHtml(absoluteUrlForRequest(req, path))}</loc>${validLastmodXml(state.scannedAt, escapeHtml)}</sitemap>`).join('\n')}
</sitemapindex>`;
  }

  function renderPages(req) {
    const state = getState();
    const allModels = state.models || [];
    const entries = [{ loc: absoluteUrlForRequest(req, '/'), lastmod: state.scannedAt || null }];
    const addPages = (letter, count) => {
      const totalPages = Math.max(1, Math.ceil(count / 60));
      for (let page = 1; page <= totalPages; page += 1) {
        entries.push({ loc: absoluteUrlForRequest(req, modelsDirectoryPath(letter, page)), lastmod: state.scannedAt || null });
      }
    };
    addPages('', allModels.length);
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const count = allModels.filter(model => normalizeModelName(model.name).toUpperCase().startsWith(letter)).length;
      if (count) addPages(letter, count);
    }
    return sitemapUrlsetXml(entries, escapeHtml);
  }

  function renderModels(req) {
    const state = getState();
    return sitemapUrlsetXml((state.models || []).map(model => ({
      loc: absoluteUrlForRequest(req, modelRoutePath(model.id)),
      lastmod: model.updatedAt || state.scannedAt || null,
    })), escapeHtml);
  }

  function renderGalleries(req) {
    const state = getState();
    return sitemapUrlsetXml((state.models || []).flatMap(model => (model.galleries || []).map(gallery => ({
      loc: absoluteUrlForRequest(req, galleryRoutePath(model.id, gallery.name)),
      lastmod: gallery.updatedAt || model.updatedAt || state.scannedAt || null,
    }))), escapeHtml);
  }

  return { renderIndex, renderPages, renderModels, renderGalleries };
}

module.exports = { createSitemapRenderer, sitemapUrlsetXml };
