'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const stylesheetPaths = [
  '/css/foundation.css?v=1',
  '/css/admin-shell.css?v=1',
  '/css/admin-import.css?v=1',
  '/css/admin-stats.css?v=1',
  '/css/gallery-shell.css?v=1',
  '/css/gallery-detail.css?v=1',
  '/css/favorites.css?v=1',
  '/css/images.css?v=1',
  '/css/lightbox.css?v=1',
  '/css/responsive.css?v=1',
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
    '/css/foundation.css?v=1',
    '/css/admin.css?v=1',
    '/css/gallery.css?v=1',
    '/css/responsive.css?v=1',
  ]);
  assertStylesheetOrder(asLinks(read('public/css/admin.css')), stylesheetPaths.slice(1, 4));
  assertStylesheetOrder(asLinks(read('public/css/gallery.css')), stylesheetPaths.slice(4, -1));
});
