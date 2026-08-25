'use strict';

function renderWebAppManifest(app = {}) {
  const name = String(app.name || 'Simple Gallery').trim() || 'Simple Gallery';
  const description = String(app.tagline || 'Image gallery browser.').trim() || 'Image gallery browser.';
  return JSON.stringify({
    id: '/',
    name,
    short_name: name,
    description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#111317',
    theme_color: '#111317',
    categories: ['photo', 'entertainment'],
    icons: [
      {
        src: '/icons/favicon-64.png',
        sizes: '64x64',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/app-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/icons/app-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  });
}

module.exports = { renderWebAppManifest };
