'use strict';

function createSourceProfileService({ getJson }) {
  function get() {
    const profile = getJson('source_profile', {});
    return {
      allowedHosts: Array.isArray(profile.allowedHosts) ? profile.allowedHosts.map(value => String(value).toLowerCase()) : [],
      referer: String(profile.referer || ''),
      modelPathSegment: String(profile.modelPathSegment || 'item').replace(/^\/+|\/+$/g, ''),
      modelListPath: String(profile.modelListPath || '/items'),
      paginationParameter: String(profile.paginationParameter || 'offset'),
      letterParameter: String(profile.letterParameter || 'letter'),
      letterValues: String(profile.letterValues || 'abcdefghijklmnopqrstuvwxyz'),
      modelListExample: String(profile.modelListExample || ''),
      modelExample: String(profile.modelExample || ''),
      modelTitleSuffixPattern: String(profile.modelTitleSuffixPattern || ''),
      gallerySectionStartLabel: String(profile.gallerySectionStartLabel || ''),
      gallerySectionEndLabel: String(profile.gallerySectionEndLabel || ''),
      galleryLinkClass: String(profile.galleryLinkClass || 'item'),
      galleryTextClass: String(profile.galleryTextClass || 'title'),
      excludedGalleryPathPrefixes: Array.isArray(profile.excludedGalleryPathPrefixes)
        ? profile.excludedGalleryPathPrefixes.map(value => String(value))
        : [],
      galleryDetailSuffixPattern: String(profile.galleryDetailSuffixPattern || '-\\d+\\.html'),
      largeImageLinkLabel: String(profile.largeImageLinkLabel || ''),
      largeImageLinkClass: String(profile.largeImageLinkClass || ''),
    };
  }

  function getSeo() {
    return getJson('seo_profile', {});
  }

  function hostAllowed(hostname, profile = get()) {
    const host = String(hostname || '').toLowerCase();
    return profile.allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
  }

  function requireProfile() {
    const profile = get();
    if (!profile.allowedHosts.length) throw new Error('Configure a source profile in Admin before importing.');
    return profile;
  }

  function sourceSlug(sourceUrl) {
    if (!sourceUrl) return null;
    try {
      return new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || null;
    } catch {
      return null;
    }
  }

  function isVerifiableGalleryUrl(sourceUrl) {
    if (!sourceUrl) return false;
    try {
      const profile = requireProfile();
      const parsed = new URL(sourceUrl);
      const pathName = parsed.pathname;
      return hostAllowed(parsed.hostname, profile)
        && !profile.excludedGalleryPathPrefixes.some(prefix => pathName.startsWith(prefix))
        && !new RegExp(`${profile.galleryDetailSuffixPattern}$`, 'i').test(pathName);
    } catch {
      return false;
    }
  }

  return { get, getSeo, hostAllowed, isVerifiableGalleryUrl, requireProfile, sourceSlug };
}

module.exports = { createSourceProfileService };
