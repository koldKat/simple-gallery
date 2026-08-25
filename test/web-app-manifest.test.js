'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderWebAppManifest } = require('../server/web-app-manifest');

test('install manifest uses runtime branding and standalone display metadata', () => {
  const manifest = JSON.parse(renderWebAppManifest({
    name: 'Configured Gallery',
    tagline: 'Configured description',
  }));

  assert.equal(manifest.name, 'Configured Gallery');
  assert.equal(manifest.short_name, 'Configured Gallery');
  assert.equal(manifest.description, 'Configured description');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['64x64', '192x192', '512x512']);
  assert.ok(manifest.icons.slice(1).every(icon => icon.purpose === 'any maskable'));
});
