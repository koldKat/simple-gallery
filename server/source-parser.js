'use strict';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function resolveRemoteUrl(href, baseUrl) {
  try {
    return new URL(decodeHtml(href), baseUrl).toString();
  } catch {
    return null;
  }
}

function canonicalRemoteUrl(remoteUrl) {
  const url = new URL(remoteUrl);
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function canonicalPageUrl(remoteUrl) {
  const url = new URL(remoteUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return url.toString();
}

function createSourceParser({ getProfile, sourceHostAllowed, normalizeModelName }) {
  function extractModelName(modelUrl, html) {
    const profile = getProfile();
    try {
      const url = new URL(modelUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0]?.toLowerCase() === profile.modelPathSegment.toLowerCase() && parts[1]) {
        return normalizeModelName(decodeURIComponent(parts[1]));
      }
    } catch {
      // Fall through to HTML metadata.
    }

    const schemaName = html.match(/"@type"\s*:\s*"Person"[\s\S]*?"name"\s*:\s*"([^"]+)"/i)?.[1];
    if (schemaName) return normalizeModelName(decodeHtml(schemaName));
    if (profile.modelTitleSuffixPattern) {
      const titlePattern = new RegExp(`<title>\\s*([^<]+?)\\s+${profile.modelTitleSuffixPattern}`, 'i');
      const titleName = html.match(titlePattern)?.[1];
      if (titleName) return normalizeModelName(titleName);
    }
    return normalizeModelName(html.match(/<title>\s*([^<]+?)\s*(?:<|$)/i)?.[1] || 'model');
  }

  function extractModelLinks(html, baseUrl) {
    const profile = getProfile();
    const models = [];
    const seen = new Set();
    const segment = escapeRegExp(profile.modelPathSegment);
    const linkRe = new RegExp(`<a\\b([^>]*\\bhref=["'][^"']*/${segment}/[^"']+["'][^>]*)>([\\s\\S]*?)<\\/a>`, 'gi');
    let match;

    while ((match = linkRe.exec(html))) {
      const attrs = match[1];
      const body = match[2];
      const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const sourceUrl = href ? resolveRemoteUrl(href, baseUrl) : null;
      if (!sourceUrl || seen.has(sourceUrl)) continue;
      const nameFromImage = body.match(/<img[^>]*\balt=["']([^"']+)["']/i)?.[1];
      const nameFromUrl = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop();
      seen.add(sourceUrl);
      models.push({
        name: normalizeModelName(decodeHtml(nameFromImage || nameFromUrl)),
        sourceUrl: canonicalRemoteUrl(sourceUrl),
      });
    }
    return models;
  }

  function extractPaginationUrls(html, baseUrl) {
    const profile = getProfile();
    const urls = new Set([canonicalPageUrl(baseUrl)]);
    const linkRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = linkRe.exec(html))) {
      const pageUrl = resolveRemoteUrl(match[1], baseUrl);
      if (!pageUrl) continue;
      try {
        const parsed = new URL(pageUrl);
        if (
          sourceHostAllowed(parsed.hostname, profile)
          && parsed.pathname === profile.modelListPath
          && parsed.searchParams.has(profile.paginationParameter)
        ) {
          urls.add(canonicalPageUrl(pageUrl));
        }
      } catch {
        // Ignore malformed pagination links.
      }
    }
    return Array.from(urls).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  function validateSourceUrl(sourceUrl, expectedPath, example = '') {
    const profile = getProfile();
    const parsed = new URL(sourceUrl);
    if (!sourceHostAllowed(parsed.hostname, profile)) {
      throw new Error('The URL host is not allowed by the configured source profile.');
    }
    if (expectedPath && parsed.pathname !== expectedPath) {
      throw new Error(example ? `Provide a URL such as ${example}.` : `The URL path must be ${expectedPath}.`);
    }
    return { parsed, profile };
  }

  function buildLetterModelListUrls(sourceUrl) {
    const profile = getProfile();
    const { parsed } = validateSourceUrl(sourceUrl, profile.modelListPath, profile.modelListExample);
    const urls = [];
    for (const letter of profile.letterValues) {
      const next = new URL(parsed.toString());
      next.searchParams.set(profile.letterParameter, letter);
      urls.push(next.toString());
    }
    return urls;
  }

  function extractSourceGalleries(html, baseUrl) {
    const profile = getProfile();
    const galleries = [];
    const seen = new Set();
    const startPattern = profile.gallerySectionStartLabel
      ? new RegExp(`<h2\\b[^>]*>\\s*${escapeRegExp(profile.gallerySectionStartLabel)}\\s*<\\/h2>`, 'i')
      : null;
    const endPattern = profile.gallerySectionEndLabel
      ? new RegExp(`<h2\\b[^>]*>\\s*${escapeRegExp(profile.gallerySectionEndLabel)}\\s*<\\/h2>`, 'i')
      : null;
    const sectionStart = startPattern ? html.search(startPattern) : -1;
    const sectionEnd = endPattern ? html.search(endPattern) : -1;
    const sourceHtml = sectionStart >= 0
      ? html.slice(sectionStart, sectionEnd > sectionStart ? sectionEnd : undefined)
      : html;
    const itemRe = new RegExp(`<a\\b([^>]*\\bclass=["'][^"']*\\b${escapeRegExp(profile.galleryLinkClass)}\\b[^"']*["'][^>]*)>([\\s\\S]*?)<\\/a>`, 'gi');
    let match;

    while ((match = itemRe.exec(sourceHtml))) {
      const attrs = match[1];
      const body = match[2];
      const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const sourceUrl = href ? resolveRemoteUrl(href, baseUrl) : null;
      if (!sourceUrl || seen.has(sourceUrl)) continue;
      const pathName = new URL(sourceUrl).pathname;
      if (profile.excludedGalleryPathPrefixes.some(prefix => pathName.startsWith(prefix))) continue;
      if (new RegExp(`${profile.galleryDetailSuffixPattern}$`, 'i').test(pathName)) continue;
      const textClass = escapeRegExp(profile.galleryTextClass);
      const title = decodeHtml(
        body.match(new RegExp(`<span[^>]*class=["'][^"']*\\b${textClass}\\b[^"']*["'][^>]*>\\s*([^<]+?)\\s*<\\/span>`, 'i'))?.[1]
        || body.match(/<img[^>]*\balt=["']([^"']+)["']/i)?.[1]
        || new URL(sourceUrl).pathname.split('/').filter(Boolean).pop()
      );
      seen.add(sourceUrl);
      galleries.push({ sourceUrl, title });
    }
    return galleries;
  }

  function extractDetailUrls(galleryHtml, galleryUrl) {
    const profile = getProfile();
    const galleryPath = new URL(galleryUrl).pathname.replace(/\/$/, '');
    const slug = galleryPath.split('/').filter(Boolean).pop();
    const detailRe = new RegExp(`href=["']([^"']*${escapeRegExp(slug)}${profile.galleryDetailSuffixPattern})["']`, 'gi');
    const detailUrls = [];
    const seen = new Set();
    let match;
    while ((match = detailRe.exec(galleryHtml))) {
      const detailUrl = resolveRemoteUrl(match[1], galleryUrl);
      if (!detailUrl || seen.has(detailUrl)) continue;
      seen.add(detailUrl);
      detailUrls.push(detailUrl);
    }
    detailUrls.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return detailUrls;
  }

  function extractLargeImageUrl(detailHtml, detailUrl) {
    const profile = getProfile();
    if (profile.largeImageLinkLabel) {
      const labelPattern = new RegExp(`<a\\b[^>]*\\bhref=["']([^"']+)["'][^>]*>\\s*${escapeRegExp(profile.largeImageLinkLabel)}\\s*<\\/a>`, 'i');
      const labeledLink = detailHtml.match(labelPattern)?.[1];
      if (labeledLink) return resolveRemoteUrl(labeledLink, detailUrl);
    }
    if (profile.largeImageLinkClass) {
      const classPattern = new RegExp(`<a\\b[^>]*class=["'][^"']*\\b${escapeRegExp(profile.largeImageLinkClass)}\\b[^"']*["'][^>]*>[\\s\\S]*?<img\\b[^>]*\\bsrc=["']([^"']+)["']`, 'i');
      const classImage = detailHtml.match(classPattern)?.[1];
      if (classImage) return resolveRemoteUrl(classImage, detailUrl);
    }
    const preload = detailHtml.match(/<link\b[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*href=["']([^"']+)["']/i)?.[1];
    return preload ? resolveRemoteUrl(preload, detailUrl) : null;
  }

  return {
    extractModelName,
    extractModelLinks,
    extractPaginationUrls,
    validateSourceUrl,
    buildLetterModelListUrls,
    extractSourceGalleries,
    extractDetailUrls,
    extractLargeImageUrl,
  };
}

module.exports = {
  canonicalRemoteUrl,
  canonicalPageUrl,
  createSourceParser,
  decodeHtml,
  escapeRegExp,
  resolveRemoteUrl,
};
