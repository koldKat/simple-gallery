'use strict';

const { decodeHtml, resolveRemoteUrl } = require('./source-parser');

function hostAllowed(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function compilePattern(value, label) {
  try {
    return new RegExp(String(value || ''), 'i');
  } catch {
    throw new Error(`${label} is not a valid regular expression.`);
  }
}

function attributeValue(attributes, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return attributes.match(new RegExp(`\\b${escaped}=["']([^"']+)["']`, 'i'))?.[1] || '';
}

function createGalleryProviderRegistry({ getProfile, canonicalRemoteUrl }) {
  function providers() {
    return getProfile().galleryProviders || [];
  }

  function accepts(provider, sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      return ['http:', 'https:'].includes(parsed.protocol)
        && hostAllowed(parsed.hostname, provider.allowedHosts)
        && compilePattern(provider.galleryPathPattern, `${provider.id} galleryPathPattern`).test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function identify(sourceUrl, providerId = '') {
    const requestedId = String(providerId || '').trim().toLowerCase();
    const candidates = requestedId
      ? providers().filter(provider => provider.id === requestedId)
      : providers();
    const provider = candidates.find(candidate => accepts(candidate, sourceUrl));
    if (provider) return provider;
    if (requestedId && !candidates.length) throw new Error(`Gallery provider "${requestedId}" is not configured.`);
    throw new Error('No configured gallery provider accepts this URL. Add a matching galleryProviders entry in Admin > Runtime Profile.');
  }

  function extract(provider, html, sourceUrl) {
    if (provider.type !== 'direct-images') throw new Error(`Unsupported gallery provider type: ${provider.type}`);
    const titleElement = String(html || '').match(/<title\b[^>]*>\s*([\s\S]*?)\s*<\/title>/i)?.[1] || '';
    const suffixPattern = provider.titleSuffixPattern
      ? compilePattern(provider.titleSuffixPattern, `${provider.id} titleSuffixPattern`)
      : null;
    const title = decodeHtml(titleElement.replace(/<[^>]+>/g, '')).replace(suffixPattern || /$^/, '').trim() || 'Imported gallery';
    const imageUrls = [];
    const seen = new Set();
    const anchorPattern = /<a\b([^>]*)>/gi;
    let match;
    while ((match = anchorPattern.exec(String(html || '')))) {
      const attributes = match[1];
      const classNames = decodeHtml(attributeValue(attributes, 'class')).split(/\s+/);
      if (!classNames.includes(provider.imageLinkClass)) continue;
      const rawUrl = attributeValue(attributes, provider.imageUrlAttribute);
      const imageUrl = rawUrl ? resolveRemoteUrl(rawUrl, sourceUrl) : null;
      if (!imageUrl || seen.has(imageUrl)) continue;
      let parsed;
      try {
        parsed = new URL(imageUrl);
      } catch {
        continue;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (!hostAllowed(parsed.hostname, provider.allowedImageHosts)) continue;
      seen.add(imageUrl);
      imageUrls.push(imageUrl);
    }
    if (!imageUrls.length) throw new Error(`Provider "${provider.id}" found no gallery images.`);
    return {
      providerId: provider.id,
      sourceUrl: canonicalRemoteUrl(sourceUrl),
      title,
      imageUrls,
      referer: provider.referer || sourceUrl,
      allowedImageHosts: [...provider.allowedImageHosts],
    };
  }

  function inspect(sourceUrl, html, providerId = '') {
    const provider = identify(sourceUrl, providerId);
    return extract(provider, html, sourceUrl);
  }

  return { accepts, extract, identify, inspect, providers };
}

module.exports = { createGalleryProviderRegistry, hostAllowed };
