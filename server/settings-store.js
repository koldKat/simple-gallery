'use strict';

const fs = require('fs');

function createSettingsStore({ db, versionPath, nowIso, withBusyRetry }) {
  function getSafe(key, fallback = '') {
    try {
      return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || fallback;
    } catch {
      return fallback;
    }
  }

  function getJson(key, fallback = {}) {
    try {
      const parsed = JSON.parse(getSafe(key, ''));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function get(key, fallback = '') {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || fallback;
  }

  function set(key, value) {
    withBusyRetry(() => db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, nowIso()));
  }

  function writeVersionMirror(value) {
    const tempPath = `${versionPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tempPath, `${value}\n`, 'utf8');
      fs.renameSync(tempPath, versionPath);
    } finally {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    }
  }

  function setVersion(value) {
    const previousFile = fs.readFileSync(versionPath, 'utf8');
    const save = db.transaction(() => {
      db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('version_label', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).run(value, nowIso());
      writeVersionMirror(value);
    });

    try {
      withBusyRetry(save);
    } catch (error) {
      try { fs.writeFileSync(versionPath, previousFile, 'utf8'); } catch {}
      throw error;
    }
  }

  function normalizeJson(value, label) {
    let parsed;
    try {
      parsed = JSON.parse(String(value || '{}'));
    } catch {
      throw new Error(`${label} must be valid JSON.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    return JSON.stringify(parsed);
  }

  return {
    getSafe,
    getJson,
    get,
    set,
    setVersion,
    normalizeJson,
  };
}

module.exports = { createSettingsStore };
