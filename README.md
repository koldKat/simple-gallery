# Simple Gallery

Node.js and SQLite gallery application served by `server.js`.

## Running

Install dependencies with `npm install`, then start the application with:

```bash
node server.js
```

The default address is `http://localhost:3020/`. Set `PORT`, `DB_PATH`, `DB_BACKUP_DIR`, or `MEDIA_ROOT` to override the corresponding neutral defaults.

## Instance Profile

Deployment-specific values live in the SQLite `app_settings` table and are editable from **Admin > Runtime Profile**. The repository contains only neutral defaults.

- Application name, tagline, and Admin name control runtime branding.
- Content root and media URL prefix control where files are stored and how they are served.
- Source Profile JSON configures allowed hosts, URL shapes, pagination, section labels, exclusions, and image extraction selectors.
- SEO Profile JSON configures titles, descriptions, and keywords using placeholders such as `{appName}`, `{modelName}`, `{galleryName}`, `{models}`, `{galleries}`, and `{images}`.

Source and SEO profiles are Admin-only data and are not included in the public state endpoint. A fresh installation must configure a source profile before importing.

## Favorites

The favorites overview is grouped and paginated so large accounts do not transfer and render every favorite image at once.

- `GET /api/favorites` returns favorite models, favorite galleries, image-group summaries, and the total favorite-image count.
- `GET /api/favorites/images?model=<folder>&offset=0&limit=120` returns one model's favorite images. The limit is capped at 250.
- `GET /api/favorites/images?random=1&limit=200` returns a bounded random selection for lightbox browsing.
- Image groups load only when opened. Additional pages are loaded with **Load more**.

All favorites endpoints require an authenticated session.

## Tooltips

Visual tooltips are desktop-only. They are suppressed on screens up to 820 pixels wide and on devices that report no hover support or a coarse pointer. Accessible control labels remain available to assistive technology.

## Cover Backdrops

Desktop views use gallery thumbnails as shaded, blurred page backdrops. Home chooses from the 60 latest galleries; Models chooses from model covers; model pages choose from that model's galleries; open galleries choose from their loaded images; and Favorites uses favorite gallery or loaded favorite-image covers. A random cover is selected initially, then changes on a single global 60-second cadence. Navigation only changes the pool used by the next scheduled rotation; it never changes the current backdrop or resets the timer. Covers are preloaded and crossfaded between two fixed layers. Backdrops are disabled at the mobile breakpoint and respect reduced-motion preferences.

Authentication and compact unseen statistics are loaded before the full personalized library state so the account header does not wait for the large state response.

## Admin Configuration

The Admin page does not embed source URLs or configured values in its HTML or JavaScript. Version, source URLs, schedule settings, application identity, content root, source profile, SEO profile, and runtime statistics are populated from the private Admin state endpoint after loading. Initial data fields use neutral empty or loading states.

### Application Version

The application version remains a manually entered value in Admin. Saving the Admin settings writes the same value to both `app_settings.version_label` and the tracked `VERSION` file; there is no automatic version incrementing.

For an established database, `app_settings.version_label` is the runtime value. On a fresh database where that setting does not exist, startup seeds it from `VERSION`. Startup only reads the file and never overwrites it.

## Database Safety

`gallery.db` is a live SQLite database. Starting the server can write to it during schema initialization, cleanup, traffic accounting, scheduled work, or normal requests.

Do not run a second server against a synchronized copy and do not synchronize `gallery.db`, `gallery.db-wal`, or `gallery.db-shm` while the authoritative server is running. Sync application files separately and use a stopped-server copy or a database backup when moving database state.
