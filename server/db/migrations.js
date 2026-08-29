'use strict';

const path = require('path');

function createDatabaseMigrations({ db, mediaRoot, galleryStorageStats, log = console.log }) {
  function migrateGallerySourceUrlUniqueness() {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'galleries'").get()?.sql || '';
    if (!/\bsource_url\s+TEXT\s+UNIQUE\b/i.test(schema)) return;
    const oldColumns = new Set(db.prepare('PRAGMA table_info(galleries)').all().map(column => column.name));
    const sourceProviderExpression = oldColumns.has('source_provider') ? 'source_provider' : "'primary'";

    db.pragma('foreign_keys = OFF');
    const migrate = db.transaction(() => {
      db.exec(`
        ALTER TABLE galleries RENAME TO galleries_old;
        CREATE TABLE galleries (
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
        INSERT INTO galleries (
          id, model_id, source_url, source_provider, title, folder, image_count, cover_name, image_bytes, thumb_bytes, status,
          error_message, created_at, imported_at, last_seen_at
        )
        SELECT
          id, model_id, source_url, ${sourceProviderExpression}, title, folder, image_count, NULL, 0, 0, status,
          error_message, created_at, imported_at, last_seen_at
        FROM galleries_old;
        DROP TABLE galleries_old;
        CREATE INDEX IF NOT EXISTS idx_galleries_model ON galleries(model_id);
        CREATE INDEX IF NOT EXISTS idx_galleries_source_url ON galleries(source_url);
      `);
    });
    migrate();
    db.pragma('foreign_keys = ON');
  }

  function repairRenamedGalleryForeignKeys() {
    const brokenTables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('gallery_favorites', 'image_favorites', 'image_seen', 'import_errors')
        AND sql LIKE '%galleries_old%'
    `).all().map(row => row.name);

    if (!brokenTables.length) return;

    db.pragma('foreign_keys = OFF');
    const repair = db.transaction(() => {
      if (brokenTables.includes('gallery_favorites')) {
        db.exec(`
          ALTER TABLE gallery_favorites RENAME TO gallery_favorites_old;
          CREATE TABLE gallery_favorites (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, gallery_id)
          );
          INSERT OR IGNORE INTO gallery_favorites (user_id, gallery_id, created_at)
          SELECT user_id, gallery_id, created_at
          FROM gallery_favorites_old
          WHERE EXISTS (SELECT 1 FROM galleries WHERE galleries.id = gallery_favorites_old.gallery_id);
          DROP TABLE gallery_favorites_old;
        `);
      }

      if (brokenTables.includes('image_favorites')) {
        db.exec(`
          ALTER TABLE image_favorites RENAME TO image_favorites_old;
          CREATE TABLE image_favorites (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
            image_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, gallery_id, image_name)
          );
          INSERT OR IGNORE INTO image_favorites (user_id, gallery_id, image_name, created_at)
          SELECT user_id, gallery_id, image_name, created_at
          FROM image_favorites_old
          WHERE EXISTS (SELECT 1 FROM galleries WHERE galleries.id = image_favorites_old.gallery_id);
          DROP TABLE image_favorites_old;
        `);
      }

      if (brokenTables.includes('image_seen')) {
        db.exec(`
          ALTER TABLE image_seen RENAME TO image_seen_old;
          CREATE TABLE image_seen (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
            image_name TEXT NOT NULL,
            seen_at TEXT NOT NULL,
            PRIMARY KEY (user_id, gallery_id, image_name)
          );
          INSERT OR IGNORE INTO image_seen (user_id, gallery_id, image_name, seen_at)
          SELECT user_id, gallery_id, image_name, seen_at
          FROM image_seen_old
          WHERE EXISTS (SELECT 1 FROM galleries WHERE galleries.id = image_seen_old.gallery_id);
          DROP TABLE image_seen_old;
        `);
      }

      if (brokenTables.includes('import_errors')) {
        db.exec(`
          ALTER TABLE import_errors RENAME TO import_errors_old;
          CREATE TABLE import_errors (
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
          INSERT OR IGNORE INTO import_errors (
            id, model_id, gallery_id, model_url, gallery_url, title, folder, message, created_at
          )
          SELECT
            id,
            model_id,
            CASE
              WHEN gallery_id IS NULL THEN NULL
              WHEN EXISTS (SELECT 1 FROM galleries WHERE galleries.id = import_errors_old.gallery_id) THEN gallery_id
              ELSE NULL
            END,
            model_url, gallery_url, title, folder, message, created_at
          FROM import_errors_old;
          DROP TABLE import_errors_old;
        `);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_gallery_favorites_user ON gallery_favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_image_favorites_user ON image_favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_image_seen_user ON image_seen(user_id);
        CREATE INDEX IF NOT EXISTS idx_image_seen_gallery ON image_seen(gallery_id);
      `);
    });
    repair();
    db.pragma('foreign_keys = ON');
  }

  function migrateGalleryStorageColumns() {
    const columns = db.prepare(`PRAGMA table_info(galleries)`).all().map(column => column.name);
    if (!columns.includes('cover_name')) {
      db.exec(`ALTER TABLE galleries ADD COLUMN cover_name TEXT;`);
    }
    if (!columns.includes('image_bytes')) {
      db.exec(`ALTER TABLE galleries ADD COLUMN image_bytes INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!columns.includes('thumb_bytes')) {
      db.exec(`ALTER TABLE galleries ADD COLUMN thumb_bytes INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  function migrateGalleryProviderColumn() {
    const columns = db.prepare(`PRAGMA table_info(galleries)`).all().map(column => column.name);
    if (!columns.includes('source_provider')) {
      db.exec(`ALTER TABLE galleries ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'primary';`);
    }
  }

  function migrateUserPreferenceColumns() {
    const columns = db.prepare(`PRAGMA table_info(users)`).all().map(column => column.name);
    if (!columns.includes('preload_model')) {
      db.exec(`ALTER TABLE users ADD COLUMN preload_model INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!columns.includes('preload_gallery')) {
      db.exec(`ALTER TABLE users ADD COLUMN preload_gallery INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  function migrateUserSecurityColumns() {
    const initialColumns = new Set(db.prepare(`PRAGMA table_info(users)`).all().map(column => column.name));
    if (initialColumns.has('username')) {
      const duplicate = db.prepare(`
        SELECT group_concat(username, ', ') AS usernames
        FROM users
        GROUP BY lower(username)
        HAVING COUNT(*) > 1
        LIMIT 1
      `).get();
      if (duplicate?.usernames) {
        throw new Error(`Cannot apply case-insensitive username protection: duplicate usernames differ only by case (${duplicate.usernames}).`);
      }
    }
    db.transaction(() => {
      const columns = new Set(db.prepare(`PRAGMA table_info(users)`).all().map(column => column.name));
      if (!columns.has('email')) db.exec(`ALTER TABLE users ADD COLUMN email TEXT;`);
      if (!columns.has('avatar_path')) db.exec(`ALTER TABLE users ADD COLUMN avatar_path TEXT;`);
      if (!columns.has('failed_login_count')) db.exec(`ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;`);
      if (!columns.has('locked_until')) db.exec(`ALTER TABLE users ADD COLUMN locked_until TEXT;`);
      if (!columns.has('admin_locked')) db.exec(`ALTER TABLE users ADD COLUMN admin_locked INTEGER NOT NULL DEFAULT 0;`);
      if (initialColumns.has('username')) {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase_unique ON users(username COLLATE NOCASE);`);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
        ON users(email)
        WHERE email IS NOT NULL;
      `);
    })();
  }

  function backfillGalleryStorageColumns() {
    const pending = db.prepare(`
      SELECT EXISTS(
        SELECT 1
        FROM galleries
        WHERE status != 'failed'
          AND image_count > 0
          AND (
            cover_name IS NULL OR trim(cover_name) = ''
            OR (image_bytes = 0 AND thumb_bytes = 0)
          )
      ) AS needed
    `).get();
    if (!pending?.needed) return;

    const rows = db.prepare(`
      SELECT
        galleries.id,
        models.folder AS model_folder,
        galleries.folder AS gallery_folder,
        galleries.image_count,
        galleries.cover_name,
        galleries.image_bytes,
        galleries.thumb_bytes
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE galleries.status != 'failed'
        AND galleries.image_count > 0
    `).all();
    if (!rows.length) return;

    const update = db.prepare(`
      UPDATE galleries
      SET cover_name = COALESCE(?, cover_name),
          image_bytes = ?,
          thumb_bytes = ?
      WHERE id = ?
    `);
    const run = db.transaction(() => {
      for (const row of rows) {
        const hasBytes = Number(row.image_bytes || 0) > 0 || Number(row.thumb_bytes || 0) > 0;
        const hasCoverName = Boolean(String(row.cover_name || '').trim());
        if (hasBytes && hasCoverName) continue;
        const galleryPath = path.join(mediaRoot(), row.model_folder, row.gallery_folder);
        const stats = galleryStorageStats(galleryPath);
        const coverName = stats.imageNames[0] || null;
        update.run(
          coverName,
          Number(stats.imageBytes || 0),
          Number(stats.thumbBytes || 0),
          row.id
        );
      }
    });
    run();
  }

  function repairShiftedRecoveredGalleryRows() {
    const rows = db.prepare(`
      SELECT
        galleries.id,
        galleries.error_message,
        galleries.created_at,
        galleries.image_bytes,
        galleries.thumb_bytes,
        galleries.cover_name,
        models.folder AS model_folder,
        galleries.folder AS gallery_folder
      FROM galleries
      JOIN models ON models.id = galleries.model_id
      WHERE galleries.imported_at = 'imported'
        AND galleries.error_message GLOB '[0-9]*'
        AND galleries.created_at GLOB '[0-9]*'
        AND galleries.image_bytes LIKE '%T%Z'
        AND galleries.thumb_bytes LIKE '%T%Z'
        AND galleries.cover_name LIKE '%T%Z'
    `).all();
    if (!rows.length) return;

    const update = db.prepare(`
      UPDATE galleries
      SET cover_name = ?,
          image_bytes = ?,
          thumb_bytes = ?,
          error_message = NULL,
          created_at = ?,
          imported_at = ?
      WHERE id = ?
    `);
    const repair = db.transaction(() => {
      for (const row of rows) {
        const galleryPath = path.join(mediaRoot(), row.model_folder, row.gallery_folder);
        const storage = galleryStorageStats(galleryPath);
        update.run(
          storage.imageNames[0] || null,
          Number(storage.imageBytes || row.error_message || 0),
          Number(storage.thumbBytes || row.created_at || 0),
          row.image_bytes,
          row.thumb_bytes,
          row.id
        );
      }
    });
    repair();
    log(`[db-migration] Repaired ${rows.length} shifted recovered gallery rows.`);
  }

  return {
    migrateGallerySourceUrlUniqueness,
    repairRenamedGalleryForeignKeys,
    migrateGalleryStorageColumns,
    migrateGalleryProviderColumn,
    migrateUserPreferenceColumns,
    migrateUserSecurityColumns,
    backfillGalleryStorageColumns,
    repairShiftedRecoveredGalleryRows,
  };
}

module.exports = { createDatabaseMigrations };
