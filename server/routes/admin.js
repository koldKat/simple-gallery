'use strict';

function handleAdminRoute(ctx, req, res, url) {
  if (!url.pathname.startsWith('/api/admin/')) return false;
  const {
    isLocalhostRequest, sendJson, readRequestBody, importSnapshot, appMetadata, getState,
    parseAutoRescanDays, defaultVersionLabel, setVersionLabel, setAppSetting,
    normalizeAutoRescanTime, normalizedJsonSetting, scheduleAutoRescan, broadcast, stateNotice,
    getImportJob, requestWorker, scanLibrary, getScannedUrlPayload, auditSavedModelUrls,
    ignoredModelUrlsResponse, ignoreModelUrl, unignoreModelUrl, syncScannedUrlsFile,
    viewStatsResponse, adminUsersResponse, deleteAdminUser, revokeAdminUserSessions, setAdminUserLocked, adminSummaryStats, liveRuntimeStats, adminModelOptionsResponse, loadImportErrors, dismissImportError,
    clearImportErrors, vacuumDatabase, runtimeStats, getLoadedModelList,
  } = ctx;

  if (!isLocalhostRequest(req)) {
    sendJson(res, 403, { error: 'Admin API is only available from localhost.' });
    return true;
  }
  if (url.pathname === '/api/admin/import-status') {
    sendJson(res, 200, importSnapshot());
    return true;
  }
  if (url.pathname === '/api/admin/state') {
    const state = getState ? getState() : null;
    sendJson(res, 200, {
      status: state?.status || 'starting',
      message: state?.message || '',
      scannedAt: state?.scannedAt || null,
      totals: state?.totals || {},
      runtime: runtimeStats(),
      app: appMetadata({ includePrivate: true }),
    });
    return true;
  }
  if (url.pathname === '/api/admin/app-settings' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const hasAutoRescanDays = Object.hasOwn(payload, 'autoRescanDays');
        const autoRescanDays = hasAutoRescanDays ? parseAutoRescanDays(payload.autoRescanDays) : null;
        if (hasAutoRescanDays && !autoRescanDays.length) {
          throw new Error('Select at least one Auto Rescan All day.');
        }
        if (Object.hasOwn(payload, 'versionLabel')) {
          const versionLabel = String(payload.versionLabel || '').trim().slice(0, 40) || defaultVersionLabel;
          setVersionLabel(versionLabel);
        }
        if (Object.hasOwn(payload, 'lastSourceUrl')) {
          setAppSetting('last_source_url', String(payload.lastSourceUrl || '').trim().slice(0, 1000));
        }
        if (Object.hasOwn(payload, 'allModelsUrl')) {
          setAppSetting('all_models_url', String(payload.allModelsUrl || '').trim().slice(0, 1000));
        }
        if (Object.hasOwn(payload, 'autoRescanEnabled')) {
          setAppSetting('auto_rescan_enabled', payload.autoRescanEnabled ? '1' : '0');
        }
        if (Object.hasOwn(payload, 'autoRescanTime')) {
          setAppSetting('auto_rescan_time', normalizeAutoRescanTime(payload.autoRescanTime));
        }
        if (hasAutoRescanDays) setAppSetting('auto_rescan_days', autoRescanDays.join(','));
        if (Object.hasOwn(payload, 'appName')) {
          setAppSetting('app_name', String(payload.appName || '').trim().slice(0, 120) || 'Simple Gallery');
        }
        if (Object.hasOwn(payload, 'appTagline')) {
          setAppSetting('app_tagline', String(payload.appTagline || '').trim().slice(0, 160));
        }
        if (Object.hasOwn(payload, 'adminName')) {
          setAppSetting('admin_name', String(payload.adminName || '').trim().slice(0, 120) || 'Gallery Admin');
        }
        if (Object.hasOwn(payload, 'contentRoot')) {
          setAppSetting('content_root', String(payload.contentRoot || '').trim().slice(0, 1000));
        }
        if (Object.hasOwn(payload, 'mediaUrlPrefix')) {
          const prefix = `/${String(payload.mediaUrlPrefix || '').trim().replace(/^\/+|\/+$/g, '')}`;
          setAppSetting('media_url_prefix', prefix === '/' ? '/media' : prefix.slice(0, 200));
        }
        if (Object.hasOwn(payload, 'sourceProfile')) {
          setAppSetting('source_profile', normalizedJsonSetting(payload.sourceProfile, 'Source profile'));
        }
        if (Object.hasOwn(payload, 'seoProfile')) {
          setAppSetting('seo_profile', normalizedJsonSetting(payload.seoProfile, 'SEO profile'));
        }
        scheduleAutoRescan();
        broadcast('state', stateNotice());
        sendJson(res, 200, { app: appMetadata({ includePrivate: true }) });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Save settings failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/stop-after-current-model' && req.method === 'POST') {
    if (!getImportJob()?.active) {
      sendJson(res, 409, { error: 'No active import.' });
      return true;
    }
    requestWorker('stop-after-current-model')
      .then(snapshot => sendJson(res, 200, snapshot))
      .catch(error => sendJson(res, 409, { error: error.message || 'Stop request failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/refresh-gallery' && req.method === 'POST') {
    scanLibrary()
      .then(state => sendJson(res, 200, state))
      .catch(error => sendJson(res, 500, { error: error.message || 'Refresh failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/scanned-urls') {
    sendJson(res, 200, getScannedUrlPayload());
    return true;
  }
  if (url.pathname === '/api/admin/url-audit') {
    sendJson(res, 200, auditSavedModelUrls());
    return true;
  }
  if (url.pathname === '/api/admin/ignored-model-urls') {
    sendJson(res, 200, ignoredModelUrlsResponse());
    return true;
  }
  if (url.pathname === '/api/admin/ignore-model-url' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const sourceUrl = String(payload.sourceUrl || '').trim();
        if (!sourceUrl) throw new Error('Missing URL.');
        ignoreModelUrl(sourceUrl, payload.reason || 'Ignored from URL audit.');
        const scanned = syncScannedUrlsFile();
        broadcast('scanned-urls', scanned);
        sendJson(res, 200, { ok: true, audit: auditSavedModelUrls(), ignored: ignoredModelUrlsResponse(), scanned });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Ignore URL failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/unignore-model-url' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const sourceUrl = String(payload.sourceUrl || '').trim();
        if (!sourceUrl) throw new Error('Missing URL.');
        unignoreModelUrl(sourceUrl);
        const scanned = syncScannedUrlsFile();
        broadcast('scanned-urls', scanned);
        sendJson(res, 200, {
          ok: true,
          audit: auditSavedModelUrls(),
          ignored: ignoredModelUrlsResponse(),
          scanned,
        });
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Unignore URL failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/view-stats') {
    sendJson(res, 200, viewStatsResponse());
    return true;
  }
  if (url.pathname === '/api/admin/stats') {
    sendJson(res, 200, adminSummaryStats());
    return true;
  }
  if (url.pathname === '/api/admin/live') {
    sendJson(res, 200, liveRuntimeStats());
    return true;
  }
  if (url.pathname === '/api/admin/users') {
    sendJson(res, 200, adminUsersResponse());
    return true;
  }
  if (url.pathname === '/api/admin/users/delete' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        sendJson(res, 200, deleteAdminUser(payload.id));
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'User deletion failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/users/revoke-sessions' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => sendJson(res, 200, revokeAdminUserSessions(JSON.parse(body || '{}').id)))
      .catch(error => sendJson(res, 400, { error: error.message || 'Session revoke failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/users/lock' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        sendJson(res, 200, setAdminUserLocked(payload.id, payload.locked === true));
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Account lock update failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/model-options') {
    sendJson(res, 200, adminModelOptionsResponse());
    return true;
  }
  if (url.pathname === '/api/admin/import-errors') {
    sendJson(res, 200, loadImportErrors());
    return true;
  }
  if (url.pathname === '/api/admin/import-errors/dismiss' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const id = Number(payload.id || 0);
        if (!id) throw new Error('Missing error id.');
        sendJson(res, 200, dismissImportError(id));
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Dismiss import error failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/import-errors/clear' && req.method === 'POST') {
    clearImportErrors();
    sendJson(res, 200, loadImportErrors());
    return true;
  }
  if (url.pathname === '/api/admin/vacuum-db' && req.method === 'POST') {
    if (getImportJob()?.active) {
      sendJson(res, 409, { error: 'Cannot vacuum while an import is running.' });
      return true;
    }
    try {
      vacuumDatabase('manual');
      sendJson(res, 200, { ok: true, runtime: runtimeStats() });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Vacuum failed.' });
    }
    return true;
  }
  if (url.pathname === '/api/admin/loaded-models') {
    sendJson(res, 200, getLoadedModelList() || { sourceUrl: '', pageCount: 0, models: [] });
    return true;
  }
  if (url.pathname === '/api/admin/load-model-list' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const sourceUrl = String(payload.url || '').trim();
        if (!sourceUrl) throw new Error('Missing URL.');
        return requestWorker('load-model-list', { url: sourceUrl });
      })
      .then(result => sendJson(res, 200, result))
      .catch(error => sendJson(res, 400, { error: error.message || 'Load failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/load-missing-models' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const sourceUrl = String(payload.url || '').trim();
        if (!sourceUrl) throw new Error('Missing URL.');
        return requestWorker('load-missing-models', { url: sourceUrl });
      })
      .then(result => sendJson(res, 200, result))
      .catch(error => sendJson(res, 400, { error: error.message || 'Find missing models failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/import' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        const urls = Array.isArray(payload.urls) ? payload.urls.map(value => String(value).trim()).filter(Boolean) : [];
        return requestWorker('import-start', {
          loaded: Boolean(payload.loaded),
          urls,
          url: String(payload.url || '').trim(),
        });
      })
      .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
      .catch(error => sendJson(res, 400, { error: error.message || 'Import failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/import-gallery' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const payload = JSON.parse(body || '{}');
        return requestWorker('direct-gallery-import', {
          model: String(payload.model || '').trim(),
          url: String(payload.url || '').trim(),
          providerId: String(payload.providerId || '').trim(),
        });
      })
      .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
      .catch(error => sendJson(res, 400, { error: error.message || 'Gallery import failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/rescan-all' && req.method === 'POST') {
    requestWorker('rescan-all-start')
      .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
      .catch(error => sendJson(res, 400, { error: error.message || 'Rescan all failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/rescan-all/resume' && req.method === 'POST') {
    requestWorker('rescan-all-resume')
      .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
      .catch(error => sendJson(res, 400, { error: error.message || 'Resume Rescan All failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/rescan-all/pause' && req.method === 'POST') {
    requestWorker('rescan-all-pause')
      .then(snapshot => sendJson(res, 200, snapshot))
      .catch(error => sendJson(res, 409, { error: error.message || 'Pause Rescan All failed.' }));
    return true;
  }
  if (url.pathname === '/api/admin/verify-known' && req.method === 'POST') {
    requestWorker('verify-known-start')
      .then(snapshot => sendJson(res, snapshot.status === 'error' ? 400 : 200, snapshot))
      .catch(error => sendJson(res, 400, { error: error.message || 'Verify known failed.' }));
    return true;
  }
  sendJson(res, 404, { error: 'Not found.' });
  return true;
}

module.exports = { handleAdminRoute };
