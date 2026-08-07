'use strict';

function originForRequest(req) {
  const rawProto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim().toLowerCase();
  const proto = rawProto === 'https' ? 'https' : 'http';
  const rawHost = String(req.headers.host || 'localhost').split(',')[0].trim();
  try {
    return new URL(`${proto}://${rawHost || 'localhost'}`).origin;
  } catch {
    return `${proto}://localhost`;
  }
}

function requestUrl(req) {
  const raw = String(req?.url || '/');
  const normalized = raw.startsWith('//') ? '/' : (raw.startsWith('/') ? raw : `/${raw}`);
  try {
    return new URL(normalized, originForRequest(req));
  } catch {
    return new URL('/', 'http://localhost');
  }
}

function absoluteUrlForRequest(req, pathname) {
  return new URL(pathname, originForRequest(req)).toString();
}

function modelRoutePath(modelId) {
  return `/model/${encodeURIComponent(modelId)}`;
}

function galleryRoutePath(modelId, galleryName) {
  return `${modelRoutePath(modelId)}/gallery/${encodeURIComponent(galleryName)}`;
}

function modelsDirectoryPath(letter = '', page = 1) {
  const params = new URLSearchParams();
  const normalizedLetter = String(letter || '').trim().toUpperCase();
  const pageNumber = Math.max(1, Number(page || 1) || 1);
  if (/^[A-Z]$/.test(normalizedLetter)) params.set('letter', normalizedLetter);
  if (pageNumber > 1) params.set('page', String(pageNumber));
  const query = params.toString();
  return query ? `/models?${query}` : '/models';
}

module.exports = {
  originForRequest,
  requestUrl,
  absoluteUrlForRequest,
  modelRoutePath,
  galleryRoutePath,
  modelsDirectoryPath,
};
