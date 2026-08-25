'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const stylesheetPaths = [
  '/css/foundation.css',
  '/css/admin-shell.css',
  '/css/admin-import.css',
  '/css/admin-stats.css',
  '/css/gallery-shell.css',
  '/css/gallery-detail.css',
  '/css/favorites.css',
  '/css/images.css',
  '/css/lightbox.css',
  '/css/responsive.css',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertStylesheetOrder(html, paths = stylesheetPaths) {
  let previousIndex = -1;
  for (const stylesheet of paths) {
    const index = html.indexOf(`href="${stylesheet}"`);
    assert.ok(index > previousIndex, `${stylesheet} must be loaded in cascade order`);
    previousIndex = index;
  }
}

test('static pages load modular stylesheets in cascade order', () => {
  assertStylesheetOrder(read('public/index.html'));
  assertStylesheetOrder(read('public/admin.html'));
});

test('every directly loaded stylesheet exists and is non-empty', () => {
  for (const stylesheet of stylesheetPaths) {
    const fileName = stylesheet.split('?')[0].replace(/^\//, '');
    assert.ok(read(`public/${fileName}`).trim().length > 0, `${fileName} must contain CSS`);
  }
});

test('server-rendered pages load modular stylesheets in cascade order', () => {
  assertStylesheetOrder(read('server/page-renderer.js'));
});

test('compatibility stylesheet imports every module in cascade order', () => {
  const asLinks = css => css.replaceAll('url(\'', 'href="').replaceAll('\');', '"');
  assertStylesheetOrder(asLinks(read('public/css/style.css')), [
    '/css/foundation.css',
    '/css/admin.css',
    '/css/gallery.css',
    '/css/responsive.css',
  ]);
  assertStylesheetOrder(asLinks(read('public/css/admin.css')), stylesheetPaths.slice(1, 4));
  assertStylesheetOrder(asLinks(read('public/css/gallery.css')), stylesheetPaths.slice(4, -1));
});

test('maintained stylesheet and module references have no manual cache versions', () => {
  const sources = [
    read('public/index.html'),
    read('public/admin.html'),
    read('server/page-renderer.js'),
    read('public/js/app.js'),
    read('public/css/style.css'),
    read('public/css/admin.css'),
    read('public/css/gallery.css'),
  ].join('\n');
  assert.doesNotMatch(sources, /[?&](?:v|ver|version)=\d+/);
});
