const DRAG_THRESHOLD_PX = 3;
const SUMMARY_HIDE_MS = 8000;
const AUTOSCROLL_ZONE_PX = 40;
const AUTOSCROLL_SPEED_PX = 12;
const DEFAULT_FREQ_INDEX = '2';
const MAX_SITES = 50;
const PENDING_ADD_MAX_AGE_MS = 10 * 60 * 1000;
const SUPPORTED_BACKUP_VERSION = 1;

let currentLang = 'en';
const checkingIds = new Set();
let drag = null;
let suppressClick = false;
let pendingHttpConfirm = null;
let isRefreshingAll = false;
let refreshTracker = null;
let activeSiteCount = 0;
let changedOnly = false; // I5: "changed only" list filter (toggle from batch summary)
let summaryTimer = null;

function toggleSettingsPanel(forceOpen = null) {
  const panel = document.getElementById('settings-panel');
  const btn = document.getElementById('btn-settings');
  if (!panel) return;

  const shouldOpen = forceOpen === null ? !panel.classList.contains('open') : forceOpen;
  panel.classList.toggle('open', shouldOpen);
  if (btn) btn.setAttribute('aria-expanded', String(shouldOpen));
}

// Applies the color theme and highlights the matching switcher button.
function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === value);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get('language');
  currentLang = data.language || detectLanguage();

  updateLangButtonsUI();
  applyTranslations();
  renderSites();

  await maybeOpenPendingAdd();

  document.getElementById('btn-add-view').addEventListener('click', () => showForm());
  document.getElementById('btn-cancel').addEventListener('click', () => showList());
  document.getElementById('btn-save').addEventListener('click', saveSite);
  document.getElementById('btn-refresh-all').addEventListener('click', refreshAll);
  document.getElementById('btn-mark-read').addEventListener('click', markAllRead);
  document.getElementById('btn-settings').addEventListener('click', () => toggleSettingsPanel());
  document.getElementById('btn-close-settings').addEventListener('click', () => toggleSettingsPanel(false));
  document.getElementById('btn-backup').addEventListener('click', createBackup);
  document.getElementById('btn-restore').addEventListener('click', () => document.getElementById('restore-file-input').click());
  document.getElementById('restore-file-input').addEventListener('change', restoreBackup);

  chrome.storage.onChanged.addListener(onStorageChanged);

  document.getElementById('site-url').addEventListener('input', () => {
    pendingHttpConfirm = null;
    clearFormMessage();
  });

  document.querySelectorAll('.lang-btn[data-lang]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      currentLang = e.currentTarget.getAttribute('data-lang');
      await chrome.storage.local.set({ language: currentLang });
      updateLangButtonsUI();
      applyTranslations();
      renderSites();
    });
  });


  // Theme (K2 follow-up): light/dark palette switch, stored in storage.
  const storedTheme = await chrome.storage.local.get('theme');
  applyTheme(storedTheme.theme);
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.theme === 'light' ? 'light' : 'dark';
      await chrome.storage.local.set({ theme });
      applyTheme(theme);
    });
  });
  initDragAndDrop(document.getElementById('sites-container'));
});

function flashFromResult(result) {
  const t = TRANSLATIONS[currentLang];
  switch (result && result.status) {
    case 'unchanged': return { text: t.checkNoChange, kind: 'ok' };
    case 'baseline': return { text: t.checkBaseline, kind: 'ok' };
    case 'changed': return { text: t.checkChanged, kind: 'warn' };
    default: return null;
  }
}

async function triggerCheck(siteId) {
  if (checkingIds.has(siteId)) return;
  checkingIds.add(siteId);

  const btn = findCard(siteId)?.querySelector('.btn-refresh');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spinning');
  }

  let result;
  try {
    result = await chrome.runtime.sendMessage({ action: 'checkNow', siteId });
  } catch (err) {
    result = { status: 'error', error: String(err && err.message || err) };
  } finally {
    checkingIds.delete(siteId);
  }

  await refreshCard(siteId, flashFromResult(result));
}

// Button icon is inline SVG in HTML - do NOT overwrite textContent (it would
// wipe the SVG). Only update state, title and aria-label.
function updateRefreshAllButton() {
  const btn = document.getElementById('btn-refresh-all');
  if (!btn) return;

  const t = TRANSLATIONS[currentLang];
  const label = isRefreshingAll ? t.btnRefreshAllBusy : t.btnRefreshAll;
  btn.disabled = isRefreshingAll || activeSiteCount === 0;
  btn.classList.toggle('busy', isRefreshingAll);
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function showSummary(text, kind = '', autoHideMs = 0) {
  const box = document.getElementById('refresh-summary');
  clearTimeout(summaryTimer);
  box.textContent = text;
  box.className = `refresh-summary${kind ? ' ' + kind : ''}`;
  if (autoHideMs) summaryTimer = setTimeout(clearSummary, autoHideMs);
}

function clearSummary() {
  clearTimeout(summaryTimer);
  const box = document.getElementById('refresh-summary');
  box.textContent = '';
  box.className = 'refresh-summary';
}


// Summary built from DOM nodes (no string HTML) - safe for site names.
function summaryText(text) {
  return document.createTextNode(text);
}

function summaryButton(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'summary-link';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function showSummaryNodes(parts, kind = '', autoHideMs = 0) {
  const box = document.getElementById('refresh-summary');
  clearTimeout(summaryTimer);
  box.replaceChildren(...parts);
  box.className = `refresh-summary${kind ? ' ' + kind : ''}`;
  if (autoHideMs) summaryTimer = setTimeout(clearSummary, autoHideMs);
}
function progressText() {
  const t = TRANSLATIONS[currentLang];
  const done = refreshTracker.total - refreshTracker.pending.size;
  return `${t.summaryProgress} ${done}/${refreshTracker.total}\u2026`;
}

function setCardChecking(siteId) {
  const btn = findCard(siteId)?.querySelector('.btn-refresh');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spinning');
  }
}

function onStorageChanged(changes, area) {
  if (area !== 'local' || !changes.sites || !refreshTracker) return;

  let progressed = false;
  for (const site of changes.sites.newValue || []) {
    if (!refreshTracker.pending.has(site.id)) continue;
    if ((site.lastAttemptTime || 0) > refreshTracker.before.get(site.id)) {
      refreshTracker.pending.delete(site.id);
      checkingIds.delete(site.id);
      refreshCard(site.id);
      progressed = true;
    }
  }
  if (progressed) showSummary(progressText());
}

async function refreshAll() {
  if (isRefreshingAll) return;

  const data = await chrome.storage.local.get('sites');
  const active = (data.sites || []).filter((s) => !s.isPaused);
  if (active.length === 0) return;

  isRefreshingAll = true;
  refreshTracker = {
    total: active.length,
    pending: new Set(active.map((s) => s.id)),
    before: new Map(active.map((s) => [s.id, s.lastAttemptTime || 0]))
  };
  active.forEach((s) => {
    checkingIds.add(s.id);
    setCardChecking(s.id);
  });
  updateRefreshAllButton();
  showSummary(progressText());

  const res = await callBackground({ action: 'checkAll' });

  isRefreshingAll = false;
  refreshTracker = null;
  active.forEach((s) => checkingIds.delete(s.id));
  await renderSites();

  const t = TRANSLATIONS[currentLang];
  if (!res.ok) {
    showSummary(t.errRefresh, 'warn', SUMMARY_HIDE_MS);
    return;
  }
  const checked = res.total - res.skipped;
  const text = `${t.summaryRefreshed}: ${checked} \u2022 ${t.summaryChanges}: ${res.changed} \u2022 ${t.summaryErrors}: ${res.errors}`;

  // I5: link the batch summary to results - one click filters the list
  // down to changed pages.
  if (res.changed > 0) {
    showSummaryNodes([
      summaryText(`${text} \u2022 `),
      summaryButton(t.showChanged, async () => {
        changedOnly = true;
        await renderSites();
        showFilterSummary();
      })
    ], 'warn', SUMMARY_HIDE_MS * 3);
  } else {
    showSummary(text, res.changed > 0 || res.errors > 0 ? 'warn' : 'ok', SUMMARY_HIDE_MS);
  }
}

// I5: summary shown while the "changed only" filter is active.
function showFilterSummary() {
  const t = TRANSLATIONS[currentLang];
  showSummaryNodes([
    summaryText(`${t.filterChanged} \u2022 `),
    summaryButton(t.clearFilter, async () => {
      changedOnly = false;
      await renderSites();
      clearSummary();
    })
  ], 'warn', 0);
}

async function createBackup() {
  const data = await chrome.storage.local.get('sites');
  const sites = data.sites || [];

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sites: sites.map((s) => ({
      name: s.name,
      url: s.url,
      openUrl: s.openUrl || s.url,
      freqIndex: s.freqIndex,
      ignoreDates: Boolean(s.ignoreDates),
      requireCookies: Boolean(s.requireCookies),
      enableNotifications: Boolean(s.enableNotifications)
    }))
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `monitoring-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toggleSettingsPanel(false);
}

function skipReasonDetail(byReason, t) {
  if (!byReason) return '';
  const bits = [];
  if (byReason.duplicate) bits.push(`${t.skipReasonDuplicate}: ${byReason.duplicate}`);
  if (byReason.limit) bits.push(`${t.skipReasonLimit}: ${byReason.limit}`);
  if (byReason.invalid) bits.push(`${t.skipReasonInvalid}: ${byReason.invalid}`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

async function restoreBackup(e) {
  const file = e.target.files[0];
  if (!file) return;

  const t = TRANSLATIONS[currentLang];

  // Limit rozmiaru pliku kopii (2 MB) - zanim wczytamy caly plik do pamieci.
  if (file.size > 2 * 1024 * 1024) {
    showSummary(t.restoreTooBig, 'warn', SUMMARY_HIDE_MS);
    e.target.value = '';
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!parsed || !Array.isArray(parsed.sites)) {
      showSummary(t.restoreInvalid, 'warn', SUMMARY_HIDE_MS);
      return;
    }
    if (parsed.version !== undefined && parsed.version !== SUPPORTED_BACKUP_VERSION) {
      showSummary(t.restoreUnsupportedVersion, 'warn', SUMMARY_HIDE_MS);
      return;
    }
    if (parsed.sites.length === 0) {
      showSummary(t.restoreEmpty, 'warn', SUMMARY_HIDE_MS);
      return;
    }

    const res = await callBackground({ action: 'importSites', sites: parsed.sites });

    if (!res.ok) {
      showSummary(t.restoreInvalid, 'warn', SUMMARY_HIDE_MS);
      return;
    }

    let permissionPending = false;
    if (res.origins && res.origins.length > 0) {
      try {
        const granted = await chrome.permissions.request({ origins: res.origins });
        permissionPending = !granted;
      } catch (err) {
        permissionPending = true;
      }
    }

    await renderSites();

    const parts = [`${t.restoreAdded}: ${res.addedCount}`];
    if (res.skippedCount) parts.push(`${t.restoreSkipped}: ${res.skippedCount}${skipReasonDetail(res.skippedByReason, t)}`);
    let text2 = parts.join(' \u2022 ');
    if (permissionPending) text2 += ` \u2014 ${t.restorePermissionPending}`;
    showSummary(text2, permissionPending ? 'warn' : 'ok', SUMMARY_HIDE_MS * 2);

    if (!permissionPending && Array.isArray(res.addedIds) && res.addedIds.length > 0) {
      res.addedIds.forEach((id) => checkingIds.add(id));
      renderSites();
      callBackground({ action: 'checkSites', siteIds: res.addedIds }).finally(() => {
        res.addedIds.forEach((id) => checkingIds.delete(id));
        renderSites();
      });
    }
    toggleSettingsPanel(false);
  } catch (err) {
    showSummary(t.restoreInvalid, 'warn', SUMMARY_HIDE_MS);
  } finally {
    e.target.value = '';
  }
}

async function maybeOpenPendingAdd() {
  const data = await chrome.storage.local.get('pendingAdd');
  const pending = data.pendingAdd;
  if (!pending || !pending.url) return;

  await chrome.storage.local.remove('pendingAdd');

  if (Date.now() - (pending.ts || 0) > PENDING_ADD_MAX_AGE_MS) return;

  let suggestedName = '';
  try {
    suggestedName = new URL(pending.url).hostname.replace(/^www\./, '');
  } catch (e) {
    suggestedName = '';
  }

  showForm(null, { url: pending.url, name: suggestedName });
}

function showFormMessage(text, kind = 'error') {
  const box = document.getElementById('form-message');
  box.textContent = text;
  box.className = `form-message show${kind === 'warn' ? ' warn' : ''}`;
}

function clearFormMessage() {
  const box = document.getElementById('form-message');
  box.textContent = '';
  box.className = 'form-message';
}

function showForm(site = null, prefill = null) {
  const t = TRANSLATIONS[currentLang];

  pendingHttpConfirm = null;
  clearFormMessage();
  document.getElementById('view-list').style.display = 'none';
  document.getElementById('view-form').style.display = 'block';

  if (site) {
    document.getElementById('form-title').innerText = t.titleEdit;
    document.getElementById('site-id').value = site.id;
    document.getElementById('site-name').value = site.name;
    document.getElementById('site-url').value = site.url;
    // "Opened page": show only when it differs from the monitored URL
    // (no need to clutter the field with a URL copy during plain edits).
    document.getElementById('site-openurl').value =
      (site.openUrl && site.openUrl !== site.url) ? site.openUrl : '';
    document.getElementById('site-selector').value = site.selector || '';
    document.getElementById('site-freq').value = site.freqIndex;
    document.getElementById('site-ignore-dates').checked = site.ignoreDates !== false;
    document.getElementById('site-cookies').checked = site.requireCookies !== false;
    document.getElementById('site-notifications').checked = site.enableNotifications !== false;
    document.getElementById('site-rendered').checked = site.renderMode === 'rendered';
  } else {
    document.getElementById('form-title').innerText = t.titleAdd;
    document.getElementById('site-id').value = '';
    document.getElementById('site-name').value = prefill ? prefill.name || '' : '';
    document.getElementById('site-url').value = prefill ? prefill.url || '' : '';
    document.getElementById('site-openurl').value = '';
    document.getElementById('site-selector').value = '';
    document.getElementById('site-freq').value = DEFAULT_FREQ_INDEX;
    document.getElementById('site-ignore-dates').checked = true;
    document.getElementById('site-cookies').checked = false;
    document.getElementById('site-notifications').checked = true;
    document.getElementById('site-rendered').checked = false;
  }

  if (prefill) {
    const nameField = document.getElementById('site-name');
    nameField.focus();
    nameField.select();
  }
}

async function showList() {
  document.getElementById('view-form').style.display = 'none';
  document.getElementById('view-list').style.display = 'block';
  await renderSites();
}

function saveErrorMessage(res) {
  const t = TRANSLATIONS[currentLang];
  switch (res && res.error) {
    case 'duplicate': return t.errDuplicate;
    case 'limit': return t.errLimit;
    case 'invalid': return t.alertInvalidUrl;
    default: return t.errSave;
  }
}

async function saveSite() {
  const t = TRANSLATIONS[currentLang];
  clearFormMessage();

  const id = document.getElementById('site-id').value;
  const name = document.getElementById('site-name').value.trim();
  let url = document.getElementById('site-url').value.trim();
  const openUrl = document.getElementById('site-openurl').value.trim();
  const selector = document.getElementById('site-selector').value.trim();
  const freqIndex = parseInt(document.getElementById('site-freq').value, 10);
  const ignoreDates = document.getElementById('site-ignore-dates').checked;
  const renderMode = document.getElementById('site-rendered').checked ? 'rendered' : 'fast';
  const requireCookies = document.getElementById('site-cookies').checked || renderMode === 'rendered'; // rendered always uses the browser session
  const enableNotifications = document.getElementById('site-notifications').checked;

  if (!name || !url) {
    showFormMessage(t.alertFillFields);
    return;
  }

  if (!url.match(/^https?:\/\//i)) {
    url = 'https://' + url;
  }

  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (err) {
    showFormMessage(t.alertInvalidUrl);
    return;
  }

  if (urlObj.protocol === 'http:' && requireCookies) {
    showFormMessage(t.errHttpCookiesBlocked);
    return;
  }

  if (urlObj.protocol === 'http:' && pendingHttpConfirm !== url) {
    pendingHttpConfirm = url;
    showFormMessage(t.warnHttp, 'warn');
    return;
  }

  const res = await callBackground({
    action: 'saveSite',
    site: { id, name, url, openUrl, freqIndex, ignoreDates, requireCookies, enableNotifications, renderMode, selector }
  });

  if (!res.ok) {
    showFormMessage(saveErrorMessage(res));
    return;
  }

  try {
    const granted = await chrome.permissions.request({
      origins: [`${urlObj.protocol}//${urlObj.host}/*`]
    });

    if (!granted) {
      if (!id) await callBackground({ action: 'deleteSite', siteId: res.siteId });
      showFormMessage(t.alertPermissionReq);
      return;
    }
  } catch (err) {
    if (!id) await callBackground({ action: 'deleteSite', siteId: res.siteId });
    showFormMessage(t.alertInvalidUrl);
    return;
  }

  await showList();
  if (res.needsBaseline) triggerCheck(res.siteId);
}


// "Mark all as read": clears the unread-change flag on every card.
async function markAllRead() {
  await callBackground({ action: 'markAllRead' });
  changedOnly = false;
  await renderSites();
}
async function togglePause(siteId) {
  await callBackground({ action: 'toggleSite', siteId });
  renderSites();
}

async function deleteSite(siteId) {
  checkingIds.delete(siteId);

  // I2: keep the full record in RAM so the summary can offer UNDO.
  const data = await chrome.storage.local.get('sites');
  const idx = (data.sites || []).findIndex((s) => s.id === siteId);
  const site = idx !== -1 ? data.sites[idx] : null;

  await callBackground({ action: 'deleteSite', siteId });
  renderSites();
  if (site) showUndoSummary(site, idx);
}

// I2: "Deleted: <name> - [Undo]". Restore reuses the original record
// (with snapshots and change state) via the background 'undoDelete' action.
function showUndoSummary(site, index) {
  const t = TRANSLATIONS[currentLang];
  showSummaryNodes([
    summaryText(`${t.deletedSummary}: `),
    summaryText(site.name),
    summaryText(` \u2022 `),
    summaryButton(t.undoDelete, async () => {
      const res = await callBackground({ action: 'undoDelete', site, index });
      if (!res.ok) {
        showSummary(t.undoFailed, 'warn', SUMMARY_HIDE_MS);
        return;
      }
      if (res.origins && res.origins.length > 0) {
        try { await chrome.permissions.request({ origins: res.origins }); } catch (e) { /* best effort */ }
      }
      changedOnly = false;
      await renderSites();
      showSummary(t.undoDone, 'ok', SUMMARY_HIDE_MS);
    })
  ], 'warn', SUMMARY_HIDE_MS * 3);
}