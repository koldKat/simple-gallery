# Simple Gallery

Node.js and SQLite gallery application served by `server.js`.

## Architecture

`server.js` owns process lifecycle, shared runtime state, importer orchestration, and top-level request dispatch. Supporting concerns are grouped by responsibility:

- `server/routes/` contains API dispatchers, including the Admin API.
- `server/auth-service.js`, `server/settings-store.js`, and `server/view-tracker.js` own sessions, runtime settings, and deduplicated view counters.
- `server/media-library.js`, `server/thumbnail-service.js`, `server/source-profile.js`, `server/source-parser.js`, and `server/import-network.js` own local media operations, thumbnail queueing, configured source policy and parsing, retries, downloads, and bounded concurrency.
- `server/source-url-registry.js` owns saved and ignored source URLs plus library matching audits.
- `server/import-state-store.js` translates importer model/gallery state to and from normalized database rows.
- `server/import-library.js` owns importer manifests, source-to-folder matching, gallery numbering, and local sequence repair.
- `server/import-path-lock.js` publishes filesystem locks that prevent the web scanner from indexing or renumbering galleries while a worker process is importing or repairing them.
- `server/source-model-loader.js` owns paginated source model discovery, missing-model filtering, and loaded-list state.
- `server/gallery-transfer.js` owns full-image URL resolution, bounded downloads, foreground pauses, and partial transfer failures.
- `server/import-progress.js` owns Admin import snapshots, bounded logs, and progress broadcast throttling.
- `server/model-importer.js` owns one model's gallery discovery, persistence, downloads, and refresh decisions.
- `server/import-runner.js` owns multi-model sequencing, Rescan All checkpoints, pause/stop, and resume behavior.
- `server/gallery-verifier.js` owns known-gallery verification, staged all-or-nothing repair, and repaired-model refreshes.
- `server/gallery-provider-registry.js` validates configured non-primary gallery providers and extracts allowlisted direct-image links.
- `server/direct-gallery-importer.js` imports one configured external gallery into an existing model without enrolling it in primary-source discovery.
- `server/library-repository.js` owns model/gallery persistence plus favorite and seen-state queries.
- `server/library-state.js` builds cached runtime library state and deduplicates scanned gallery summaries.
- `server/library-scanner.js` owns gallery/model filesystem scans, aggregate storage totals, and cached-state refreshes.
- `server/user-library.js` builds personalized state, gallery image payloads, and paginated Favorites responses.
- `server/rescan-checkpoints.js` owns Rescan All duration metadata and resumable checkpoint recovery.
- `server/import-errors.js` persists and broadcasts importer failures.
- `server/admin-reporting.js` builds read-only view and user reports plus Admin model choices from live database and traffic state.
- `server/db/`, `server/database-runtime.js`, `server/db-housekeeping.js`, and `server/backup.js` own the database connection, schema initialization, busy retries, runtime metrics, maintenance operations, periodic cleanup lifecycle, and backup retention.
- `server/event-bus.js`, `server/traffic.js`, `server/page-renderer.js`, `server/web-app-manifest.js`, `server/sitemap.js`, `server/routes/site.js`, and `server/static-handler.js` own server-sent events, request accounting, public HTML/SEO, installable-app metadata, sitemap and public route dispatch, and static-file policy.
- `server/auto-rescan-service.js` owns the scheduled Rescan All timer, retry lifecycle, and worker dispatch.
- `server/worker-service.js` owns worker process creation, IPC request correlation, event transport, and shutdown; `server/worker-coordinator.js` owns import command dispatch and worker-state reconciliation.
- `server/schedule.js`, `server/html-format.js`, and `server/route-paths.js` provide pure scheduling, formatting, and route helpers.

The main browser entry point is `public/js/app.js`. Reusable browser controllers and pure helpers live beside it as ES modules, including `app-auth.js`, `app-backdrop.js`, `app-data.js`, `app-events.js`, `app-favorite-actions.js`, `app-favorites.js`, `app-gallery-cache.js`, `app-gallery-view.js`, `app-header.js`, `app-lightbox.js`, `app-model-navigation.js`, `app-navigation.js`, `app-preferences.js`, `app-preloader.js`, `app-seen-state.js`, `app-tooltips.js`, and `app-utils.js`. The HTML loads `app.js` as a module, and `app.js` remains responsible for application state and view orchestration.

Browser styles are loaded in cascade order from focused files under `public/css/`: `foundation.css` owns shared tokens, controls, and the application header; `admin-shell.css`, `admin-import.css`, and `admin-stats.css` own Admin structure/settings, import/audit views, and reporting respectively; `gallery-shell.css` owns the content shell, sidebar, cards, previews, and tooltips; `gallery-detail.css`, `favorites.css`, `images.css`, and `lightbox.css` own their named gallery features; and `responsive.css` owns mobile and reduced-motion overrides. `style.css`, `admin.css`, and `gallery.css` are retained only as compatibility import manifests for stale or external references.

Maintained JavaScript and CSS use clean URLs without manual `?v=N` suffixes. Static responses use `Cache-Control: no-cache` with ETags, so browsers revalidate on each load and receive `304 Not Modified` for unchanged files. Generated thumbnails keep immutable one-year caching because their stored URLs are content-specific.

Keep modules dependency-injected where they need process state. A module should not open the database, start timers, or mutate global application state merely because it is imported. This keeps startup ownership visible in `server.js` and permits isolated tests without opening `gallery.db`.

## Running

Install dependencies with `npm install`, then start the application with:

```bash
node server.js
```

The default address is `http://localhost:3020/`. Set `PORT`, `DB_PATH`, `DB_BACKUP_DIR`, or `MEDIA_ROOT` to override the corresponding neutral defaults. The web process defaults to at most 128 concurrent static-file reads and 1,024 queued static reads; override these safeguards with `STATIC_READ_CONCURRENCY` and `STATIC_READ_QUEUE_LIMIT` when the host's file-descriptor budget requires different limits.

Rescan All and other imports run in a child worker process so their network and image-processing descriptors are isolated from the web process. Worker spawn, exit, and IPC failures are returned to the requesting Admin action without terminating the web process. Imports and repairs publish per-gallery filesystem locks before creating or replacing content; the web scanner honors those locks, including across processes, so it cannot renumber or index a partially written gallery. Stale locks from terminated processes are removed automatically. If web traffic reaches the configured static-read capacity, excess requests receive a retryable `503` response instead of exhausting file descriptors and terminating the server.

## Installable App

The public site exposes `/manifest.webmanifest` with the application name and description from the runtime profile. Supported mobile and desktop browsers can install the site from their browser menu. Opening it from the installed icon uses standalone display mode without the normal browser address bar. Android receives 192px and 512px maskable icons, while Apple devices receive a dedicated 180px touch icon.

## Instance Profile

Deployment-specific values live in the SQLite `app_settings` table and are editable from **Admin > Runtime Profile**. The repository contains only neutral defaults.

- Application name, tagline, and Admin name control runtime branding.
- Content root and media URL prefix control where files are stored and how they are served.
- Source Profile JSON configures allowed hosts, URL shapes, pagination, section labels, exclusions, and image extraction selectors.
- SEO Profile JSON configures titles, descriptions, and keywords using placeholders such as `{appName}`, `{modelName}`, `{galleryName}`, `{models}`, `{galleries}`, and `{images}`.

Source and SEO profiles are Admin-only data and are not included in the public state endpoint. A fresh installation must configure a source profile before importing.

### Additional Gallery Providers

The Source Profile may contain a `galleryProviders` array for importing individual galleries from additional sites. Provider configuration remains deployment data rather than repository code. No provider definitions are bundled with the application, so deploying the code alone does not configure any additional source. The currently supported provider type is `direct-images`, which extracts full-image URLs from matching anchor elements.

```json
{
  "galleryProviders": [
    {
      "id": "example-direct",
      "type": "direct-images",
      "allowedHosts": ["gallery.example"],
      "allowedImageHosts": ["images.example"],
      "galleryPathPattern": "^/galleries/[^/]+/?$",
      "imageLinkClass": "full-image",
      "imageUrlAttribute": "href",
      "titleSuffixPattern": "\\s+-\\s+Example$",
      "referer": "https://gallery.example/"
    }
  ]
}
```

Add this property to the existing Source Profile object rather than replacing its primary-source fields. Then use **Admin > Import Gallery** with an existing model name or exact folder and the gallery URL. The URL is matched to a provider automatically.

Imported galleries store their provider ID. Rescan All continues to discover galleries only from each model's primary source. Verify Known uses the stored provider for additional galleries; if that provider is removed or no longer accepts the saved URL, the gallery is skipped and preserved rather than treated as invalid. Repairs are downloaded into a staging directory and replace existing files only when every expected image succeeds. Initial and redirected page and image URLs are restricted to their configured host lists.

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

The public library payload and logged-in personalization are split deliberately. `GET /api/state` returns the shared base library state plus the current public user summary, while `GET /api/user-state` returns only compact per-user overlay data such as favorite model ids, favorite gallery ids, gallery seen counts, and unseen totals. The browser renders the base library first, then applies the overlay so logged-in startup does not wait on full-library personalization.

## Admin Configuration

The Admin page does not embed source URLs or configured values in its HTML or JavaScript. Version, source URLs, schedule settings, application identity, content root, source profile, SEO profile, and runtime statistics are populated from the private Admin state endpoint after loading. Initial data fields use neutral empty or loading states.

Admin HTML, APIs, scans, imports, and database maintenance are restricted to localhost requests. Public routes expose only gallery browsing, account actions, personalized state, favorites, seen state, view recording, sitemaps, and server-sent status updates.

Auto Rescan All can be enabled for a selected 24-hour time and one or more weekdays. Installations without a saved weekday selection run every day, preserving the original schedule behavior.

### Application Version

The application version remains a manually entered value in Admin. Saving the Admin settings writes the same value to both `app_settings.version_label` and the tracked `VERSION` file; there is no automatic version incrementing.

For an established database, `app_settings.version_label` is the runtime value. On a fresh database where that setting does not exist, startup seeds it from `VERSION`. Startup only reads the file and never overwrites it.

## Database Safety

`gallery.db` is a live SQLite database. Starting the server can write to it during schema initialization, cleanup, traffic accounting, scheduled work, or normal requests.

Do not run a second server against a synchronized copy and do not synchronize `gallery.db`, `gallery.db-wal`, or `gallery.db-shm` while the authoritative server is running. Sync application files separately and use a stopped-server copy or a database backup when moving database state.

## Verification

Run the isolated unit and integration suite with:

```bash
npm test
```

The tests use in-memory or temporary databases and do not open the repository's live `gallery.db`.
