const els = {
  tabMain: document.querySelector('#admin-tab-main'),
  tabErrors: document.querySelector('#admin-tab-errors'),
  tabUsers: document.querySelector('#admin-tab-users'),
  tabAudit: document.querySelector('#admin-tab-audit'),
  mainPanelGroup: document.querySelector('#admin-main-panel-group'),
  errorsPanelGroup: document.querySelector('#admin-errors-panel-group'),
  usersPanelGroup: document.querySelector('#admin-users-panel-group'),
  auditPanelGroup: document.querySelector('#admin-audit-panel-group'),
  status: document.querySelector('#admin-status'),
  adminTitle: document.querySelector('#admin-title'),
  settingsForm: document.querySelector('#settings-form'),
  instanceSettingsForm: document.querySelector('#instance-settings-form'),
  versionLabel: document.querySelector('#version-label'),
  appName: document.querySelector('#app-name'),
  appTagline: document.querySelector('#app-tagline'),
  adminName: document.querySelector('#admin-name'),
  contentRoot: document.querySelector('#content-root'),
  mediaUrlPrefix: document.querySelector('#media-url-prefix'),
  sourceProfile: document.querySelector('#source-profile'),
  seoProfile: document.querySelector('#seo-profile'),
  saveInstanceSettings: document.querySelector('#save-instance-settings-btn'),
  autoRescanEnabled: document.querySelector('#auto-rescan-enabled'),
  autoRescanTime: document.querySelector('#auto-rescan-time'),
  autoRescanNext: document.querySelector('#auto-rescan-next'),
  lastRescanAllDuration: document.querySelector('#last-rescan-all-duration'),
  saveSettings: document.querySelector('#save-settings-btn'),
  form: document.querySelector('#import-form'),
  url: document.querySelector('#model-url'),
  allModelsUrl: document.querySelector('#all-models-url'),
  button: document.querySelector('#import-btn'),
  load: document.querySelector('#load-btn'),
  findMissingModels: document.querySelector('#find-missing-models-btn'),
  importLoaded: document.querySelector('#import-loaded-btn'),
  rescanAll: document.querySelector('#rescan-all-btn'),
  stopAfterModel: document.querySelector('#stop-after-model-btn'),
  refreshGallery: document.querySelector('#refresh-gallery-btn'),
  verifyKnown: document.querySelector('#verify-known-btn'),
  auditUrls: document.querySelector('#audit-urls-btn'),
  pauseRescanAll: document.querySelector('#pause-rescan-all-btn'),
  resumeRescanAll: document.querySelector('#resume-rescan-all-btn'),
  scannedUrlCount: document.querySelector('#scanned-url-count'),
  urlAudit: document.querySelector('#url-audit'),
  loadedModels: document.querySelector('#loaded-models'),
  error: document.querySelector('#admin-error'),
  kicker: document.querySelector('#import-kicker'),
  title: document.querySelector('#import-title'),
  galleries: document.querySelector('#galleries-stat'),
  known: document.querySelector('#known-stat'),
  images: document.querySelector('#images-stat'),
  skipped: document.querySelector('#skipped-stat'),
  dbSize: document.querySelector('#db-size-stat'),
  vacuumDb: document.querySelector('#vacuum-db-btn'),
  actualSize: document.querySelector('#actual-size-stat'),
  thumbSize: document.querySelector('#thumb-size-stat'),
  heapSize: document.querySelector('#heap-size-stat'),
  rssSize: document.querySelector('#rss-size-stat'),
  trafficIn: document.querySelector('#traffic-in-stat'),
  trafficOut: document.querySelector('#traffic-out-stat'),
  importErrors: document.querySelector('#import-errors'),
  clearErrors: document.querySelector('#clear-errors-btn'),
  logs: document.querySelector('#log-list'),
  refreshViewStats: document.querySelector('#refresh-view-stats-btn'),
  modelViews: document.querySelector('#model-views-stat'),
  galleryViews: document.querySelector('#gallery-views-stat'),
  imageViews: document.querySelector('#image-views-stat'),
  viewStats: document.querySelector('#view-stats'),
  refreshUsers: document.querySelector('#refresh-users-btn'),
  usersList: document.querySelector('#admin-users-list'),
  refreshAudit: document.querySelector('#refresh-audit-btn'),
  auditList: document.querySelector('#admin-audit-list'),
};

let DEFAULT_ADMIN_TITLE = 'Gallery Admin';

let loadedModels = [];
let importActive = false;
let rescanAllActive = false;
let canResumeRescanAll = false;
let pauseRescanAllRequested = false;
let loadedPageCount = 1;
let loadedTotalFound = 0;
let loadedKnownCount = 0;
let loadedMissingOnly = false;
let adminPanel = 'main';
let lastRuntime = {};
let lastViewStatsPayload = null;
let lastViewStatsRankingCount = 0;
let viewStatsResyncScheduled = false;
let viewStatsResizeObserver = null;
let viewStatsRefreshInFlight = false;
let runtimeRefreshInFlight = false;
let adminLibraryRoot = '';

function setAdminPanel(panel) {
  adminPanel = panel === 'errors' ? 'errors' : panel === 'users' ? 'users' : panel === 'audit' ? 'audit' : 'main';
  els.mainPanelGroup.hidden = adminPanel !== 'main';
  els.errorsPanelGroup.hidden = adminPanel !== 'errors';
  els.usersPanelGroup.hidden = adminPanel !== 'users';
  els.auditPanelGroup.hidden = adminPanel !== 'audit';
  els.tabMain.classList.toggle('is-active', adminPanel === 'main');
  els.tabErrors.classList.toggle('is-active', adminPanel === 'errors');
  els.tabUsers.classList.toggle('is-active', adminPanel === 'users');
  els.tabAudit.classList.toggle('is-active', adminPanel === 'audit');
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const decimals = Math.max(0, unit - 1);
  return `${size.toFixed(decimals)} ${units[unit]}`;
}

function formatTrafficSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const decimals = unit <= 1 ? 0 : unit - 1;
  return `${size.toFixed(decimals)} ${units[unit]}`;
}

function renderTrafficSplit(remoteBytes, localBytes) {
  return `${formatTrafficSize(remoteBytes)} / ${formatTrafficSize(localBytes)}`;
}

const countryNameFormatter = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function countryFlag(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '🏳️';
  return String.fromCodePoint(...Array.from(code).map(char => 127397 + char.charCodeAt(0)));
}

function countryLabel(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  if (code === 'UNKNOWN' || !code) return 'Unknown';
  return countryNameFormatter?.of(code) || code;
}

function countryFlagMarkup(countryCode) {
  const code = String(countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return '<span class="country-flag country-flag-fallback">--</span>';
  }
  const lower = code.toLowerCase();
  return `<img class="country-flag" src="https://flagcdn.com/24x18/${lower}.png" srcset="https://flagcdn.com/48x36/${lower}.png 2x" width="24" height="18" alt="${escapeHtml(code)} flag" loading="lazy" decoding="async">`;
}

function renderCountryTraffic(rows) {
  const countries = Array.isArray(rows) ? rows : [];
  if (!lastViewStatsPayload) {
    refreshViewStats().catch(() => {});
    return;
  }
  renderViewStats({
    ...lastViewStatsPayload,
    countries,
  }, { count: Math.max(1, lastViewStatsRankingCount || Math.min(countries.length || 1, 10)) });
}

function renderLibraryTotals(libraryState) {
  const totals = libraryState?.totals || {};
  const runtime = libraryState?.runtime || lastRuntime || {};
  if (libraryState?.runtime && Object.keys(libraryState.runtime).length) {
    lastRuntime = libraryState.runtime;
  }
  els.actualSize.textContent = formatSize(totals.imageBytes);
  els.thumbSize.textContent = formatSize(totals.thumbBytes);
  els.dbSize.textContent = formatSize(runtime.dbBytes);
  const heapUsed = Number(runtime.heapUsedBytes || 0);
  const heapTotal = Number(runtime.heapTotalBytes || 0);
  const heapAvailable = Math.max(0, heapTotal - heapUsed);
  els.heapSize.textContent = `${formatSize(heapUsed)} / ${formatSize(heapAvailable)}`;
  const cpuCores = Number(runtime.cpuCores || 0);
  const cpuTotalCores = Math.max(1, Number(runtime.cpuTotalCores || 1));
  els.rssSize.textContent = `${formatSize(runtime.rssBytes)} / ${((cpuCores / cpuTotalCores) * 100).toFixed(1)}%`;
  els.trafficIn.textContent = renderTrafficSplit(runtime.trafficRemoteInBytes, runtime.trafficLocalInBytes);
  els.trafficOut.textContent = renderTrafficSplit(runtime.trafficRemoteOutBytes, runtime.trafficLocalOutBytes);
  renderCountryTraffic(runtime.remoteCountryTraffic);
}

function renderAppSettings(libraryState) {
  const app = libraryState?.app || {};
  DEFAULT_ADMIN_TITLE = String(app.adminName || 'Gallery Admin').trim() || 'Gallery Admin';
  document.title = DEFAULT_ADMIN_TITLE;
  els.adminTitle.textContent = DEFAULT_ADMIN_TITLE;
  adminLibraryRoot = String(app.root || '').trim();
  els.versionLabel.value = String(app.versionLabel || '');
  els.appName.value = String(app.name || '');
  els.appTagline.value = String(app.tagline || '');
  els.adminName.value = String(app.adminName || '');
  els.contentRoot.value = String(app.contentRoot || '');
  els.mediaUrlPrefix.value = String(app.mediaUrlPrefix || '');
  els.sourceProfile.value = prettyJson(app.sourceProfile);
  els.seoProfile.value = prettyJson(app.seoProfile);
  els.url.value = String(app.lastSourceUrl || '');
  els.allModelsUrl.value = String(app.allModelsUrl || '');
  els.autoRescanEnabled.checked = Boolean(app.autoRescanEnabled);
  els.autoRescanTime.value = String(app.autoRescanTime || '');
  els.autoRescanNext.textContent = app.nextAutoRescanAt
    ? `Next auto rescan: ${formatDateTime(app.nextAutoRescanAt)}`
    : 'Next auto rescan: not scheduled';
  renderLastRescanAll(app);
}

function prettyJson(value) {
  try {
    return JSON.stringify(JSON.parse(String(value || '{}')), null, 2);
  } catch {
    return String(value || '{}');
  }
}

function importDestination(folder) {
  const root = adminLibraryRoot.replace(/\/+$/, '');
  const name = String(folder || '').replace(/^\/+/, '');
  if (!root) return name;
  return `${root}/${name}`;
}

async function saveAdminSettings(settings) {
  const response = await fetch('/api/admin/app-settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Save settings failed.');
  return payload;
}

function renderScanProgress(notice) {
  if (notice?.status === 'scanning' && notice.scanProgress) {
    const progress = notice.scanProgress;
    const progressState = {
      totals: progress.totals || notice.totals || {},
      runtime: notice.runtime || lastRuntime,
    };
    renderLibraryTotals(progressState);
    const total = Number(progress.total || 0);
    const current = Number(progress.current || 0);
    document.title = total > 0
      ? `${Math.min(100, Math.max(0, (current / total) * 100)).toFixed(2)}% | ${DEFAULT_ADMIN_TITLE}`
      : DEFAULT_ADMIN_TITLE;
    els.status.textContent = 'Refreshing Gallery';
    els.kicker.textContent = 'Scanning';
    els.title.textContent = total
      ? `Scanning ${current}/${total} models${progress.model ? ` -> ${progress.model}` : ''}`
      : 'Preparing gallery scan';
    els.galleries.textContent = `${progress.totals?.galleries || 0}`;
    els.images.textContent = `${progress.totals?.images || 0}`;
    return;
  }
  if (!rescanAllActive) document.title = DEFAULT_ADMIN_TITLE;
  renderLibraryTotals(notice);
  if (notice?.status === 'ready' || notice?.status === 'error') {
    els.status.textContent = importActive ? 'Import Running' : 'Localhost Admin';
    if (!importActive) {
      els.kicker.textContent = 'Idle';
      els.title.textContent = notice.message || 'No import running';
    }
  }
}

async function refreshLibraryTotals() {
  if (runtimeRefreshInFlight) return;
  runtimeRefreshInFlight = true;
  try {
    const response = await fetch('/api/admin/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Runtime refresh failed (${response.status}).`);
    renderLibraryTotals(await response.json());
  } finally {
    runtimeRefreshInFlight = false;
  }
}

function setImportControlsDisabled(disabled) {
  els.button.disabled = disabled;
  els.load.disabled = disabled;
  els.findMissingModels.disabled = disabled;
  els.importLoaded.disabled = disabled || !loadedModels.length;
  els.rescanAll.disabled = disabled;
  els.pauseRescanAll.disabled = !disabled || !rescanAllActive || pauseRescanAllRequested;
  els.resumeRescanAll.disabled = disabled || !canResumeRescanAll;
  els.stopAfterModel.disabled = !disabled;
  els.refreshGallery.disabled = disabled;
  els.verifyKnown.disabled = disabled;
  els.auditUrls.disabled = disabled;
  els.url.disabled = disabled;
  els.allModelsUrl.disabled = disabled;
  els.vacuumDb.disabled = disabled;
}

function beginActiveRun() {
  if (importActive) return false;
  importActive = true;
  setImportControlsDisabled(true);
  return true;
}

async function refreshScannedUrlCount() {
  try {
    const response = await fetch('/api/admin/scanned-urls', { cache: 'no-store' });
    const scanned = await response.json();
    if (!response.ok) throw new Error(scanned.error || 'Failed to load saved URL count.');
    renderScannedUrlCount(scanned);
  } catch (error) {
    els.scannedUrlCount.textContent = 'saved model URLs unavailable';
    els.error.textContent = error.message || 'Failed to load saved URL count.';
  }
}

async function clearImportErrors() {
  const response = await fetch('/api/admin/import-errors/clear', { method: 'POST' });
  if (response.ok) renderImportErrors(await response.json());
}

async function dismissImportError(id) {
  const response = await fetch('/api/admin/import-errors/dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Dismiss import error failed.');
  renderImportErrors(payload);
}

function renderScannedUrlCount(scanned) {
  const active = Number.isFinite(Number(scanned.active)) ? Number(scanned.active) : (scanned.urls || []).length;
  const ignored = Number(scanned.ignored || 0);
  els.scannedUrlCount.textContent = `${active} saved model URLs${ignored ? ` (${ignored} ignored)` : ''}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function renderUrlAudit(payload) {
  const unmatched = payload?.unmatched || [];
  const total = Number(payload?.savedModelUrls || 0);
  const ignored = Number(payload?.ignoredCount || 0);
  els.urlAudit.hidden = false;
  els.urlAudit.innerHTML = `
    <div class="loaded-models-head">${unmatched.length} unmatched of ${total} active saved model URLs${ignored ? ` (${ignored} ignored)` : ''}</div>
    <div class="url-audit-list">
      ${unmatched.length ? unmatched.map(item => `
        <div class="url-audit-item">
          <strong>${escapeHtml(item.modelName || item.expectedFolder || 'Unknown model')}</strong>
          <span>${escapeHtml(item.reason)}</span>
          <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.sourceUrl)}</a>
          <button type="button" data-ignore-url="${escapeHtml(item.sourceUrl)}">Ignore URL</button>
        </div>
      `).join('') : '<div class="empty small-empty">No unmatched saved model URLs.</div>'}
    </div>
  `;
}

function renderAuditView(auditPayload, ignoredPayload) {
  const unmatched = auditPayload?.unmatched || [];
  const total = Number(auditPayload?.savedModelUrls || 0);
  const ignoredCount = Number(ignoredPayload?.ignoredCount || auditPayload?.ignoredCount || 0);
  const ignored = ignoredPayload?.ignored || [];
  els.auditList.innerHTML = `
    <section class="admin-audit-section">
      <div class="loaded-models-head">${unmatched.length} unmatched of ${total} active saved model URLs${ignoredCount ? ` (${ignoredCount} ignored)` : ''}</div>
      <div class="url-audit-list">
        ${unmatched.length ? unmatched.map(item => `
          <div class="url-audit-item">
            <strong>${escapeHtml(item.modelName || item.expectedFolder || 'Unknown model')}</strong>
            <span>${escapeHtml(item.reason)}</span>
            <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.sourceUrl)}</a>
            <button type="button" data-ignore-url="${escapeHtml(item.sourceUrl)}">Ignore URL</button>
          </div>
        `).join('') : '<div class="empty small-empty">No unmatched saved model URLs.</div>'}
      </div>
    </section>
    <section class="admin-audit-section">
      <div class="loaded-models-head">${ignored.length} ignored model URLs</div>
      <div class="url-audit-list">
        ${ignored.length ? ignored.map(item => `
          <div class="url-audit-item">
            <strong>${escapeHtml(item.reason || 'Ignored URL')}</strong>
            <span>${escapeHtml(formatDateTime(item.createdAt))}</span>
            <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.sourceUrl)}</a>
            <button type="button" data-unignore-url="${escapeHtml(item.sourceUrl)}">Unignore</button>
          </div>
        `).join('') : '<div class="empty small-empty">No ignored model URLs.</div>'}
      </div>
    </section>
  `;
}

async function refreshAuditView() {
  const [auditResponse, ignoredResponse] = await Promise.all([
    fetch('/api/admin/url-audit', { cache: 'no-store' }),
    fetch('/api/admin/ignored-model-urls', { cache: 'no-store' }),
  ]);
  const auditPayload = await auditResponse.json();
  const ignoredPayload = await ignoredResponse.json();
  if (!auditResponse.ok) throw new Error(auditPayload.error || 'URL audit failed.');
  if (!ignoredResponse.ok) throw new Error(ignoredPayload.error || 'Ignored URLs load failed.');
  renderAuditView(auditPayload, ignoredPayload);
}

function formatDateTime(value) {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (!totalSeconds) return '0s';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function renderLastRescanAll(app = {}) {
  if (!els.lastRescanAllDuration) return;
  const durationMs = Number(app.lastRescanAllDurationMs || app.durationMs || 0);
  const finishedAt = app.lastRescanAllFinishedAt || app.finishedAt || '';
  const status = app.lastRescanAllStatus || app.status || '';
  if (!durationMs || !finishedAt) {
    els.lastRescanAllDuration.textContent = status === 'running'
      ? 'Last Rescan All: running'
      : 'Last Rescan All: not recorded';
    return;
  }
  els.lastRescanAllDuration.textContent = `Last Rescan All: ${formatDuration(durationMs)}, finished ${formatDateTime(finishedAt)}${status ? ` (${status})` : ''}`;
}

function renderRanking(title, rows, formatter) {
  return `
    <article class="view-ranking" data-ranking-card="${escapeHtml(title)}">
      <h3>${title}</h3>
      ${rows.length ? rows.map((row, index) => `
        <div class="view-ranking-row">
          <strong>${index + 1}. ${formatter(row)}</strong>
          <span>${row.views} views · ${formatDateTime(row.lastViewedAt)}</span>
        </div>
      `).join('') : '<div class="empty small-empty">No views yet.</div>'}
    </article>
  `;
}

function renderCountryRanking(rows) {
  const items = Array.isArray(rows) ? rows : [];
  return `
    <article class="view-ranking" data-country-card="1">
      <h3>Remote Traffic By Country</h3>
      ${items.length ? items.map(row => `
        <div class="view-ranking-row country-ranking-row">
          <strong>${countryFlagMarkup(row.country)} ${escapeHtml(countryLabel(row.country))}</strong>
          <span>${formatTrafficSize(row.inBytes)} / ${formatTrafficSize(row.outBytes)} / ${formatTrafficSize(row.totalBytes)}</span>
        </div>
      `).join('') : '<div class="empty small-empty">No remote traffic by country yet.</div>'}
    </article>
  `;
}

function maxRankingRowsAvailable(payload) {
  return Math.max(
    Number(payload?.models?.length || 0),
    Number(payload?.galleries?.length || 0),
    Number(payload?.images?.length || 0),
    1
  );
}

function measuredRankingCount(payload) {
  const available = maxRankingRowsAvailable(payload);
  const countryCard = els.viewStats.querySelector('[data-country-card]');
  const rankingCard = els.viewStats.querySelector('[data-ranking-card]');
  const countryRows = Array.from(countryCard?.querySelectorAll('.country-ranking-row') || []);
  const rankingRows = Array.from(rankingCard?.querySelectorAll('.view-ranking-row') || []);
  if (!countryCard || !rankingCard || !countryRows.length || !rankingRows.length) {
    return Math.min(available, Math.max(1, lastViewStatsRankingCount || 1));
  }
  const firstCountry = countryRows[0];
  const lastCountry = countryRows[countryRows.length - 1];
  const countryBlockHeight = (lastCountry.offsetTop + lastCountry.offsetHeight) - firstCountry.offsetTop;
  const firstRanking = rankingRows[0];
  const secondRanking = rankingRows[1] || null;
  const rankingHeight = firstRanking.offsetHeight || 1;
  const rankingStep = secondRanking
    ? Math.max(1, secondRanking.offsetTop - firstRanking.offsetTop)
    : rankingHeight;
  const desired = Math.floor(Math.max(0, countryBlockHeight - rankingHeight) / Math.max(1, rankingStep)) + 1;
  return Math.min(available, Math.max(1, desired));
}

function scheduleViewStatsResync() {
  if (!lastViewStatsPayload || viewStatsResyncScheduled) return;
  viewStatsResyncScheduled = true;
  window.requestAnimationFrame(() => {
    viewStatsResyncScheduled = false;
    if (!lastViewStatsPayload) return;
    const desired = measuredRankingCount(lastViewStatsPayload);
    if (desired !== lastViewStatsRankingCount) {
      renderViewStats(lastViewStatsPayload, { count: desired });
    }
  });
}

function bindViewStatsLiveSync() {
  if (viewStatsResizeObserver) {
    viewStatsResizeObserver.disconnect();
    viewStatsResizeObserver = null;
  }
  const countryCard = els.viewStats.querySelector('[data-country-card]');
  if (countryCard && typeof ResizeObserver !== 'undefined') {
    viewStatsResizeObserver = new ResizeObserver(() => scheduleViewStatsResync());
    viewStatsResizeObserver.observe(countryCard);
  }
  els.viewStats.querySelectorAll('[data-country-card] .country-flag').forEach(img => {
    img.addEventListener('load', scheduleViewStatsResync, { once: true });
    img.addEventListener('error', scheduleViewStatsResync, { once: true });
  });
}

function renderViewStats(payload, options = {}) {
  lastViewStatsPayload = payload;
  const totals = payload?.totals || {};
  els.modelViews.textContent = `${totals.modelViews || 0}`;
  els.galleryViews.textContent = `${totals.galleryViews || 0}`;
  els.imageViews.textContent = `${totals.imageViews || 0}`;
  const countryRows = Array.isArray(payload?.countries) ? payload.countries : [];
  const available = maxRankingRowsAvailable(payload);
  const rankingCount = Math.min(available, Math.max(1, Number(options.count || Math.min(countryRows.length || 1, available))));
  lastViewStatsRankingCount = rankingCount;
  els.viewStats.innerHTML = [
    renderRanking('Top Models', (payload?.models || []).slice(0, rankingCount), row => row.name || row.folder),
    renderRanking('Top Galleries', (payload?.galleries || []).slice(0, rankingCount), row => `${row.modelName} / ${row.gallery}`),
    renderRanking('Top Images', (payload?.images || []).slice(0, rankingCount), row => `${row.modelName} / ${row.gallery} / ${row.imageName}`),
    renderCountryRanking(countryRows),
  ].join('');
  bindViewStatsLiveSync();
  scheduleViewStatsResync();
}

function renderUsers(payload) {
  const users = payload?.users || [];
  els.usersList.innerHTML = users.length ? users.map(user => `
    <article class="admin-user-card">
      <div class="admin-user-card-head">
        <strong>${escapeHtml(user.displayName || user.username)}</strong>
        <span>${user.disabledAt ? 'Disabled' : user.activeSessions ? `Active (${user.activeSessions} sessions)` : 'Inactive'}</span>
      </div>
      <div class="admin-user-card-meta">@${escapeHtml(user.username)}</div>
      <div class="admin-user-card-meta">Created: ${formatDateTime(user.createdAt)}</div>
      <div class="admin-user-card-meta">Last login: ${formatDateTime(user.lastLoginAt)}</div>
    </article>
  `).join('') : '<div class="empty small-empty">No registered users.</div>';
}

async function refreshUsers() {
  const response = await fetch('/api/admin/users', { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Users load failed.');
  renderUsers(payload);
}

async function refreshViewStats() {
  if (viewStatsRefreshInFlight) return;
  viewStatsRefreshInFlight = true;
  const response = await fetch('/api/admin/view-stats', { cache: 'no-store' });
  try {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'View stats failed.');
    renderViewStats({
      ...payload,
      countries: Array.isArray(lastRuntime?.remoteCountryTraffic) ? lastRuntime.remoteCountryTraffic : (payload.countries || []),
    });
  } finally {
    viewStatsRefreshInFlight = false;
  }
}

function renderImportErrors(payload) {
  const errors = (payload?.errors || []).slice(-12).reverse();
  els.tabErrors.classList.toggle('has-errors', errors.length > 0);
  els.importErrors.hidden = !errors.length;
  if (!errors.length) {
    els.importErrors.innerHTML = '';
    els.tabErrors.textContent = 'Errors';
    return;
  }
  els.tabErrors.textContent = `Errors (${errors.length})`;
  els.importErrors.innerHTML = `
    <div class="loaded-models-head">${errors.length} recent import errors</div>
    <div class="import-error-list">
      ${errors.map(error => `
        <div class="import-error-item">
          <strong>${error.modelName || 'Import error'}${error.gallery ? ` / ${error.gallery}` : ''}</strong>
          <div class="import-error-meta">
            <span>${new Date(error.at).toLocaleString()} - ${error.title || error.sourceUrl || error.modelUrl || ''}</span>
            <button type="button" data-dismiss-error="${error.id}">Dismiss</button>
          </div>
          <small>${error.message || 'Unknown error'}</small>
        </div>
      `).join('')}
    </div>
  `;
}

function renderImport(snapshot) {
  if (!snapshot || !snapshot.status) {
    canResumeRescanAll = Boolean(snapshot?.canResumeRescanAll);
    rescanAllActive = false;
    pauseRescanAllRequested = false;
    document.title = DEFAULT_ADMIN_TITLE;
    els.kicker.textContent = 'Idle';
    els.title.textContent = 'No import running';
    importActive = false;
    setImportControlsDisabled(importActive);
    return;
  }

  importActive = Boolean(snapshot.active);
  canResumeRescanAll = Boolean(snapshot.canResumeRescanAll);
  pauseRescanAllRequested = Boolean(snapshot.pauseRescanAllRequested);
  const totals = snapshot.totals || {};
  // Older running servers do not expose mode, but Rescan All still reports a
  // multi-model total. Once restarted, mode provides the exact distinction.
  rescanAllActive = importActive && (
    snapshot.mode === 'all'
    || (!snapshot.mode && Number(totals.models) > 1)
  );
  if (rescanAllActive && Number(totals.models) > 0) {
    const percentage = Math.min(
      100,
      Math.max(0, (Number(totals.modelsChecked || 0) / Number(totals.models)) * 100),
    );
    document.title = `${percentage.toFixed(2)}% | ${DEFAULT_ADMIN_TITLE}`;
  } else if (!rescanAllActive) {
    document.title = DEFAULT_ADMIN_TITLE;
  }
  els.status.textContent = snapshot.active ? 'Import Running' : 'Localhost Admin';
  els.kicker.textContent = snapshot.status;
  els.title.textContent = snapshot.modelName
    ? `${snapshot.modelName} -> ${importDestination(snapshot.modelFolder)}${totals.models ? ` (${totals.modelsChecked || 0}/${totals.models} models)` : ''}`
    : snapshot.message || 'Import';
  els.galleries.textContent = `${totals.galleriesProcessed || 0} / ${totals.galleries || 0}`;
  els.known.textContent = `${totals.newGalleries || 0} / ${totals.knownGalleries || 0}`;
  els.images.textContent = `${totals.imagesImported || 0} / ${totals.images || 0}`;
  els.skipped.textContent = `${(totals.galleriesSkipped || 0) + (totals.imagesSkipped || 0)}`;
  setImportControlsDisabled(importActive);
  els.pauseRescanAll.textContent = pauseRescanAllRequested ? 'Pausing After Model' : 'Pause Rescan All';
  els.stopAfterModel.textContent = snapshot.stopAfterCurrentModel ? 'Stopping After Model' : 'Stop After Model';
  removeProcessedLoadedModel(snapshot);

  els.logs.innerHTML = '';
  for (const log of (snapshot.logs || []).slice().reverse()) {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = `[${new Date(log.at).toLocaleTimeString()}] ${log.message}`;
    els.logs.append(item);
  }
}

async function loadStatus() {
  const [importResponse, stateResponse, loadedResponse, errorsResponse, viewStatsResponse, usersResponse, auditResponse, ignoredResponse] = await Promise.all([
    fetch('/api/admin/import-status', { cache: 'no-store' }),
    fetch('/api/admin/state', { cache: 'no-store' }),
    fetch('/api/admin/loaded-models', { cache: 'no-store' }),
    fetch('/api/admin/import-errors', { cache: 'no-store' }),
    fetch('/api/admin/view-stats', { cache: 'no-store' }),
    fetch('/api/admin/users', { cache: 'no-store' }),
    fetch('/api/admin/url-audit', { cache: 'no-store' }),
    fetch('/api/admin/ignored-model-urls', { cache: 'no-store' }),
  ]);
  renderImport(await importResponse.json());
  const libraryState = await stateResponse.json();
  renderLibraryTotals(libraryState);
  renderAppSettings(libraryState);
  renderLoadedModels(await loadedResponse.json());
  renderImportErrors(await errorsResponse.json());
  renderViewStats(await viewStatsResponse.json());
  renderUsers(await usersResponse.json());
  renderAuditView(await auditResponse.json(), await ignoredResponse.json());
  await refreshScannedUrlCount();
}

function renderLoadedModels(payload) {
  loadedModels = payload?.models || [];
  loadedPageCount = payload?.pageCount || loadedPageCount || 1;
  loadedTotalFound = Number(payload?.totalFound || loadedModels.length || 0);
  loadedKnownCount = Number(payload?.knownCount || 0);
  loadedMissingOnly = Boolean(payload?.missingOnly);
  renderLoadedModelList();
}

function renderLoadedModelList() {
  els.loadedModels.hidden = !loadedModels.length && !loadedMissingOnly;
  setImportControlsDisabled(importActive);
  if (!loadedModels.length) {
    els.loadedModels.innerHTML = loadedMissingOnly
      ? `<div class="loaded-models-head">0 missing models found across ${loadedPageCount} pages (${loadedTotalFound} total, ${loadedKnownCount} known)</div>`
      : '';
    return;
  }
  const summary = loadedMissingOnly
    ? `${loadedModels.length} missing models across ${loadedPageCount} pages (${loadedTotalFound} total, ${loadedKnownCount} known)`
    : `${loadedModels.length} models remaining across ${loadedPageCount} pages`;
  els.loadedModels.innerHTML = `
    <div class="loaded-models-head">${summary}</div>
    <div class="loaded-models-grid">
      ${loadedModels.map(model => `<span>${model.name}</span>`).join('')}
    </div>
  `;
}

function removeProcessedLoadedModel(snapshot) {
  if (!loadedModels.length) return;
  const currentUrl = snapshot?.currentModelUrl || '';
  const modelName = snapshot?.modelName || '';
  const before = loadedModels.length;
  loadedModels = loadedModels.filter(model => {
    if (currentUrl && model.sourceUrl === currentUrl) return false;
    if (modelName && model.name === modelName) return false;
    return true;
  });
  if (loadedModels.length !== before) renderLoadedModelList();
}

els.load.addEventListener('click', async () => {
  if (!beginActiveRun()) return;
  els.error.textContent = '';
  try {
    await clearImportErrors();
    const sourceUrl = els.url.value.trim();
    await saveAdminSettings({ lastSourceUrl: sourceUrl });
    const response = await fetch('/api/admin/load-model-list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Load failed.');
    renderLoadedModels(payload);
    importActive = false;
    setImportControlsDisabled(importActive);
  } catch (error) {
    els.error.textContent = error.message || 'Load failed.';
    importActive = false;
    setImportControlsDisabled(importActive);
  }
});

els.tabMain.addEventListener('click', () => setAdminPanel('main'));
els.tabErrors.addEventListener('click', () => setAdminPanel('errors'));
els.tabUsers.addEventListener('click', () => setAdminPanel('users'));
els.tabAudit.addEventListener('click', () => setAdminPanel('audit'));
els.importErrors.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-dismiss-error]');
  if (!button) return;
  const id = Number(button.dataset.dismissError || 0);
  if (!id) return;
  button.disabled = true;
  els.error.textContent = '';
  try {
    await dismissImportError(id);
  } catch (error) {
    els.error.textContent = error.message || 'Dismiss import error failed.';
    button.disabled = false;
  }
});

els.findMissingModels.addEventListener('click', async () => {
  if (!beginActiveRun()) return;
  els.error.textContent = '';
  try {
    await clearImportErrors();
    const sourceUrl = els.allModelsUrl.value.trim();
    await saveAdminSettings({ allModelsUrl: sourceUrl });
    const response = await fetch('/api/admin/load-missing-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Find missing models failed.');
    renderLoadedModels(payload);
    importActive = false;
    setImportControlsDisabled(importActive);
  } catch (error) {
    els.error.textContent = error.message || 'Find missing models failed.';
    importActive = false;
    setImportControlsDisabled(importActive);
  }
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!beginActiveRun()) return;
  els.error.textContent = '';
  try {
    await clearImportErrors();
    const sourceUrl = els.url.value.trim();
    await saveAdminSettings({ lastSourceUrl: sourceUrl });
    const response = await fetch('/api/admin/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Import failed.');
    renderImport(payload);
    await refreshLibraryTotals();
    await refreshScannedUrlCount();
  } catch (error) {
    els.error.textContent = error.message || 'Import failed.';
    setImportControlsDisabled(importActive);
  }
});

els.importLoaded.addEventListener('click', async () => {
  if (!beginActiveRun()) return;
  els.error.textContent = '';
  try {
    await clearImportErrors();
    const response = await fetch('/api/admin/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loaded: true }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Import loaded failed.');
    renderImport(payload);
    await refreshLibraryTotals();
    await refreshScannedUrlCount();
  } catch (error) {
    els.error.textContent = error.message || 'Import loaded failed.';
    setImportControlsDisabled(importActive);
  }
});

els.rescanAll.addEventListener('click', async () => {
  if (!beginActiveRun()) return;
  els.error.textContent = '';
  try {
    await clearImportErrors();
    const response = await fetch('/api/admin/rescan-all', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Rescan all failed.');
    renderImport(payload);
    await refreshLibraryTotals();
    await refreshScannedUrlCount();
  } catch (error) {
    els.error.textContent = error.message || 'Rescan all failed.';
    setImportControlsDisabled(importActive);
  }
});

els.resumeRescanAll.addEventListener('click', async () => {
  if (!beginActiveRun()) return;
  els.error.textContent = '';
  try {
    const response = await fetch('/api/admin/rescan-all/resume', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Resume Rescan All failed.');
    renderImport(payload);
    await refreshLibraryTotals();
    await refreshScannedUrlCount();
  } catch (error) {
    importActive = false;
    els.error.textContent = error.message || 'Resume Rescan All failed.';
    setImportControlsDisabled(false);
  }
});

els.pauseRescanAll.addEventListener('click', async () => {
  if (!importActive || !rescanAllActive || pauseRescanAllRequested) return;
  els.error.textContent = '';
  els.pauseRescanAll.disabled = true;
  try {
    const response = await fetch('/api/admin/rescan-all/pause', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Pause Rescan All failed.');
    renderImport(payload);
  } catch (error) {
    els.error.textContent = error.message || 'Pause Rescan All failed.';
    setImportControlsDisabled(importActive);
  }
});

els.stopAfterModel.addEventListener('click', async () => {
  if (!importActive) return;
  els.error.textContent = '';
  els.stopAfterModel.disabled = true;
  try {
    const response = await fetch('/api/admin/stop-after-current-model', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Stop request failed.');
    renderImport(payload);
  } catch (error) {
    els.error.textContent = error.message || 'Stop request failed.';
    els.stopAfterModel.disabled = !importActive;
  }
});

els.refreshGallery.addEventListener('click', async () => {
  if (importActive) return;
  els.error.textContent = '';
  els.refreshGallery.disabled = true;
  try {
    const response = await fetch('/api/admin/refresh-gallery', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Refresh failed.');
    renderLibraryTotals(payload);
  } catch (error) {
    els.error.textContent = error.message || 'Refresh failed.';
  } finally {
    els.refreshGallery.disabled = importActive;
  }
});

els.verifyKnown.addEventListener('click', async () => {
  if (!beginActiveRun()) return;
  els.error.textContent = '';
  try {
    await clearImportErrors();
    const response = await fetch('/api/admin/verify-known', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Verify known failed.');
    renderImport(payload);
    await refreshLibraryTotals();
  } catch (error) {
    els.error.textContent = error.message || 'Verify known failed.';
    setImportControlsDisabled(importActive);
  }
});

els.auditUrls.addEventListener('click', async () => {
  if (importActive) return;
  els.error.textContent = '';
  els.auditUrls.disabled = true;
  try {
    const response = await fetch('/api/admin/url-audit', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'URL audit failed.');
    renderUrlAudit(payload);
  } catch (error) {
    els.error.textContent = error.message || 'URL audit failed.';
  } finally {
    els.auditUrls.disabled = importActive;
  }
});

els.urlAudit.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-ignore-url]');
  if (!button) return;
  const sourceUrl = button.dataset.ignoreUrl || '';
  if (!sourceUrl) return;
  button.disabled = true;
  els.error.textContent = '';
  try {
    const response = await fetch('/api/admin/ignore-model-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUrl, reason: 'Ignored from URL audit.' }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Ignore URL failed.');
    renderUrlAudit(payload.audit);
    renderScannedUrlCount(payload.scanned);
  } catch (error) {
    els.error.textContent = error.message || 'Ignore URL failed.';
    button.disabled = false;
  }
});

els.auditList.addEventListener('click', async (event) => {
  const ignoreButton = event.target.closest('[data-ignore-url]');
  const unignoreButton = event.target.closest('[data-unignore-url]');
  if (!ignoreButton && !unignoreButton) return;
  els.error.textContent = '';
  if (ignoreButton) {
    const sourceUrl = ignoreButton.dataset.ignoreUrl || '';
    if (!sourceUrl) return;
    ignoreButton.disabled = true;
    try {
      const response = await fetch('/api/admin/ignore-model-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceUrl, reason: 'Ignored from URL audit.' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Ignore URL failed.');
      renderAuditView(payload.audit, payload.ignored || { ignoredCount: Number(payload.audit?.ignoredCount || 0), ignored: [] });
      renderScannedUrlCount(payload.scanned);
      await refreshAuditView();
    } catch (error) {
      els.error.textContent = error.message || 'Ignore URL failed.';
      ignoreButton.disabled = false;
    }
    return;
  }
  const sourceUrl = unignoreButton.dataset.unignoreUrl || '';
  if (!sourceUrl) return;
  unignoreButton.disabled = true;
  try {
    const response = await fetch('/api/admin/unignore-model-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUrl }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Unignore URL failed.');
    renderAuditView(payload.audit, payload.ignored);
    renderScannedUrlCount(payload.scanned);
  } catch (error) {
    els.error.textContent = error.message || 'Unignore URL failed.';
    unignoreButton.disabled = false;
  }
});

els.refreshViewStats.addEventListener('click', async () => {
  els.error.textContent = '';
  els.refreshViewStats.disabled = true;
  try {
    await refreshViewStats();
  } catch (error) {
    els.error.textContent = error.message || 'View stats failed.';
  } finally {
    els.refreshViewStats.disabled = false;
  }
});

els.refreshUsers.addEventListener('click', async () => {
  els.error.textContent = '';
  els.refreshUsers.disabled = true;
  try {
    await refreshUsers();
  } catch (error) {
    els.error.textContent = error.message || 'Users load failed.';
  } finally {
    els.refreshUsers.disabled = false;
  }
});

els.refreshAudit.addEventListener('click', async () => {
  els.error.textContent = '';
  els.refreshAudit.disabled = true;
  try {
    await refreshAuditView();
  } catch (error) {
    els.error.textContent = error.message || 'URL audit failed.';
  } finally {
    els.refreshAudit.disabled = false;
  }
});

els.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.error.textContent = '';
  els.saveSettings.disabled = true;
  try {
    const payload = await saveAdminSettings({
      versionLabel: els.versionLabel.value.trim(),
      autoRescanEnabled: els.autoRescanEnabled.checked,
      autoRescanTime: els.autoRescanTime.value,
    });
    els.versionLabel.value = payload.app?.versionLabel || els.versionLabel.value;
    els.autoRescanEnabled.checked = Boolean(payload.app?.autoRescanEnabled);
    els.autoRescanTime.value = payload.app?.autoRescanTime || els.autoRescanTime.value;
    els.autoRescanNext.textContent = payload.app?.nextAutoRescanAt
      ? `Next auto rescan: ${formatDateTime(payload.app.nextAutoRescanAt)}`
      : 'Next auto rescan: not scheduled';
    renderLastRescanAll(payload.app);
  } catch (error) {
    els.error.textContent = error.message || 'Save settings failed.';
  } finally {
    els.saveSettings.disabled = false;
  }
});

els.instanceSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.error.textContent = '';
  els.saveInstanceSettings.disabled = true;
  try {
    JSON.parse(els.sourceProfile.value || '{}');
    JSON.parse(els.seoProfile.value || '{}');
    const payload = await saveAdminSettings({
      appName: els.appName.value.trim(),
      appTagline: els.appTagline.value.trim(),
      adminName: els.adminName.value.trim(),
      contentRoot: els.contentRoot.value.trim(),
      mediaUrlPrefix: els.mediaUrlPrefix.value.trim(),
      sourceProfile: els.sourceProfile.value,
      seoProfile: els.seoProfile.value,
    });
    renderAppSettings({ app: payload.app });
  } catch (error) {
    els.error.textContent = error.message || 'Save profile failed.';
  } finally {
    els.saveInstanceSettings.disabled = false;
  }
});

els.vacuumDb.addEventListener('click', async () => {
  els.error.textContent = '';
  els.vacuumDb.disabled = true;
  try {
    const response = await fetch('/api/admin/vacuum-db', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Vacuum failed.');
    renderLibraryTotals({ runtime: payload.runtime });
    await refreshLibraryTotals();
  } catch (error) {
    els.error.textContent = error.message || 'Vacuum failed.';
  } finally {
    els.vacuumDb.disabled = importActive;
  }
});

els.clearErrors?.addEventListener('click', async () => {
  els.error.textContent = '';
  els.clearErrors.disabled = true;
  try {
    await clearImportErrors();
  } catch (error) {
    els.error.textContent = error.message || 'Clear errors failed.';
  } finally {
    els.clearErrors.disabled = false;
  }
});

if (window.EventSource) {
  const source = new EventSource('/api/events');
  source.addEventListener('import', event => {
    const snapshot = JSON.parse(event.data);
    renderImport(snapshot);
    if (snapshot.lastRescanAll) renderLastRescanAll(snapshot.lastRescanAll);
    if (!snapshot.active) {
      refreshLibraryTotals();
      refreshScannedUrlCount();
    }
  });
  source.addEventListener('scanned-urls', event => renderScannedUrlCount(JSON.parse(event.data)));
  source.addEventListener('state', event => renderScanProgress(JSON.parse(event.data)));
  source.addEventListener('loaded-models', event => renderLoadedModels(JSON.parse(event.data)));
  source.addEventListener('import-errors', event => renderImportErrors(JSON.parse(event.data)));
  source.addEventListener('view-stats', event => renderViewStats(JSON.parse(event.data)));
}

setAdminPanel('main');
loadStatus();
window.setInterval(() => {
  refreshLibraryTotals().catch(() => {});
}, 5000);
