'use strict';

function initializeSchema({ db, withBusyRetry, defaultVersionLabel, nowIso }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      preload_model INTEGER NOT NULL DEFAULT 0,
      preload_gallery INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      disabled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS model_urls (
      id INTEGER PRIMARY KEY,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS ignored_model_urls (
      source_url TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS galleries (
      id INTEGER PRIMARY KEY,
      model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      source_url TEXT,
      source_provider TEXT NOT NULL DEFAULT 'primary',
      title TEXT NOT NULL DEFAULT '',
      folder TEXT NOT NULL,
      image_count INTEGER NOT NULL DEFAULT 0,
      cover_name TEXT,
      image_bytes INTEGER NOT NULL DEFAULT 0,
      thumb_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'imported',
      error_message TEXT,
      created_at TEXT NOT NULL,
      imported_at TEXT,
      last_seen_at TEXT,
      UNIQUE(model_id, folder)
    );

    CREATE TABLE IF NOT EXISTS gallery_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, gallery_id)
    );

    CREATE TABLE IF NOT EXISTS image_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      image_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, gallery_id, image_name)
    );

    CREATE TABLE IF NOT EXISTS image_seen (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      image_name TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (user_id, gallery_id, image_name)
    );

    CREATE TABLE IF NOT EXISTS model_view_totals (
      model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
      view_count INTEGER NOT NULL DEFAULT 0,
      first_viewed_at TEXT,
      last_viewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS gallery_view_totals (
      gallery_id INTEGER PRIMARY KEY REFERENCES galleries(id) ON DELETE CASCADE,
      view_count INTEGER NOT NULL DEFAULT 0,
      first_viewed_at TEXT,
      last_viewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS image_view_totals (
      gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
      image_name TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 0,
      first_viewed_at TEXT,
      last_viewed_at TEXT,
      PRIMARY KEY (gallery_id, image_name)
    );

    CREATE TABLE IF NOT EXISTS view_dedupe (
      actor_key TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      last_counted_at TEXT NOT NULL,
      PRIMARY KEY (actor_key, target_type, target_key)
    );

    CREATE TABLE IF NOT EXISTS import_errors (
      id INTEGER PRIMARY KEY,
      model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
      gallery_id INTEGER REFERENCES galleries(id) ON DELETE SET NULL,
      model_url TEXT,
      gallery_url TEXT,
      title TEXT,
      folder TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_galleries_model ON galleries(model_id);
    CREATE INDEX IF NOT EXISTS idx_galleries_source_url ON galleries(source_url);
    CREATE INDEX IF NOT EXISTS idx_galleries_model_folder ON galleries(model_id, folder);
    CREATE INDEX IF NOT EXISTS idx_model_favorites_user ON model_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_favorites_user ON gallery_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_image_favorites_user ON image_favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_image_seen_user ON image_seen(user_id);
    CREATE INDEX IF NOT EXISTS idx_image_seen_gallery ON image_seen(gallery_id);
    CREATE INDEX IF NOT EXISTS idx_view_dedupe_last_counted ON view_dedupe(last_counted_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_model_view_totals_count ON model_view_totals(view_count DESC);
    CREATE INDEX IF NOT EXISTS idx_gallery_view_totals_count ON gallery_view_totals(view_count DESC);
    CREATE INDEX IF NOT EXISTS idx_image_view_totals_count ON image_view_totals(view_count DESC);
  `);
  withBusyRetry(() => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('version_label', ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(defaultVersionLabel, nowIso()));
}

module.exports = { initializeSchema };
