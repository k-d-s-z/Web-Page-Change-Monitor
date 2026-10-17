// === POPUP.JS: wklej na górze pliku (pod stałymi) ===
// Potem w całym popup.js zamień KAŻDE wywołanie
//     chrome.permissions.request(
// na
//     requestWithResume(
// (dotyczy też kreatora / startWizard, jeśli prosi o uprawnienie).

const RESUME_FLAG = 'resumeAfterPermission';

// Zapisuje znacznik PRZED oknem zgody. Okno zgody zamyka popup, więc kod po
// await może się już nie wykonać - dlatego znacznik czyta i usuwa tło
// (background.js, chrome.permissions.onAdded).
async function requestWithResume(details) {
  await chrome.storage.local.set({ [RESUME_FLAG]: Date.now() });
  try {
    const granted = await chrome.permissions.request(details);
    // Popup przeżył (okno zgody go nie zamknęło) - znacznik niepotrzebny.
    await chrome.storage.local.remove(RESUME_FLAG);
    return granted;
  } catch (err) {
    await chrome.storage.local.remove(RESUME_FLAG);
    throw err;
  }
}
const DRAG_THRESHOLD_PX = 3;
const AUTOSCROLL_ZONE_PX = 40;
const AUTOSCROLL_SPEED_PX = 12;
const DEFAULT_FREQ_INDEX = '2';
const MAX_SITES = 50;
const PENDING_ADD_MAX_AGE_MS = 10 * 60 * 1000;
const SUPPORTED_BACKUP_VERSION = 1;
const SUMMARY_HIDE_MS = 4000;

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
  await renderSites();

  await maybeOpenPendingAdd();
  const pickerRestored = await maybeRestorePicker();
  // Wizard interrupted (e.g. popup closed by the permission dialog): resume it.
  if (!pickerRestored) await maybeRestoreWizard();
  maybeShowChangedHint();

  document.getElementById('btn-add-view').addEventListener('click', openAddForm);
  document.getElementById('btn-test').addEventListener('click', testSite);
  document.getElementById('btn-cancel').addEventListener('click', () => showList());
  document.getElementById('btn-save').addEventListener('click', saveSite);
  document.getElementById('btn-pick').addEventListener('click', startPicker);
  document.getElementById('site-rendered').addEventListener('change', syncRenderedUI);
  document.getElementById('site-freq').addEventListener('change', toggleCustomFreq);
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

// Wrapper na chrome.runtime.sendMessage ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ nigdy nie rzuca; bÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂd kanaÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂu
// zwracany jest jako { ok: false, error }, ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼eby wywoÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂujÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂcy mÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ³gÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ go obsÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂuÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼yÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ.
async function callBackground(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

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
  const data = await chrome.storage.local.get(['sites', 'groups']);
  const sites = data.sites || [];
  const groupNames = new Map((data.groups || []).map((g) => [g.id, g.name]));

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sites: sites.map((s) => ({
      name: s.name,
      url: s.url,
      openUrl: s.openUrl || s.url,
      group: s.groupId ? (groupNames.get(s.groupId) || '') : '',
      freqIndex: s.freqIndex,
      freqMinutes: s.freqMinutes || null,
      ignoreDates: Boolean(s.ignoreDates),
      requireCookies: Boolean(s.requireCookies),
      enableNotifications: Boolean(s.enableNotifications),
      renderMode: s.renderMode === 'rendered' ? 'rendered' : 'fast',
      selector: s.selector || ''
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

  let suggestedName = cleanTitle(pending.title);
  if (!suggestedName) {
    try {
      suggestedName = new URL(pending.url).hostname.replace(/^www\./, '');
    } catch (e) {
      suggestedName = '';
    }
  }

  startWizard({ url: pending.url, name: suggestedName });
}

// Unread changes: remind the user right after opening the popup and offer the
// "changed only" filter (same one the batch summary uses).
async function maybeShowChangedHint() {
  const t = TRANSLATIONS[currentLang];
  const data = await chrome.storage.local.get('sites');
  const n = (data.sites || []).filter((s) => s.hasChanged && !s.isPaused).length;
  if (n === 0 || changedOnly) return;
  showSummaryNodes([
    summaryText(`${t.unreadChanges}: ${n} \u2022 `),
    summaryButton(t.showChanged, async () => {
      changedOnly = true;
      await renderSites();
      showFilterSummary();
    })
  ], 'warn', 0);
}

// Rendered mode opens a real tab and always uses the browser session, so the
// form reflects that: cookies ticked and locked, 1-minute interval unavailable.
// Shows the minutes field only for the "Custom..." interval.
function toggleCustomFreq() {
  const custom = document.getElementById('site-freq').value === 'custom';
  document.getElementById('freq-custom').style.display = custom ? 'flex' : 'none';
  if (custom) {
    const input = document.getElementById('site-freq-custom');
    if (document.activeElement === document.getElementById('site-freq')) input.focus();
  }
}

function syncRenderedUI() {
  const rendered = document.getElementById('site-rendered').checked;
  const cookies = document.getElementById('site-cookies');
  const freq = document.getElementById('site-freq');
  if (rendered) cookies.checked = true;
  cookies.disabled = rendered;
  const oneMin = freq.querySelector('option[value="0"]');
  if (oneMin) oneMin.disabled = rendered;
  if (rendered && freq.value === '0') freq.value = '1';
  const customInput = document.getElementById('site-freq-custom');
  customInput.min = rendered ? '5' : '1';
  if (rendered && freq.value === 'custom' && customInput.value !== '' && Number(customInput.value) < 5) {
    customInput.value = '5';
  }
}

function cleanTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// "Add" opens the form pre-filled with the active tab (URL + title) - unless
// that page is not http(s) or is already on the list.
async function openAddForm() {
  let prefill = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && /^https?:\/\//i.test(tab.url || '')) {
      const data = await chrome.storage.local.get('sites');
      const identity = new URL(tab.url).href;
      const known = (data.sites || []).some((s) => {
        try { return new URL(s.url).href === identity; } catch (e) { return false; }
      });
      if (!known) {
        let name = cleanTitle(tab.title);
        if (!name) name = new URL(tab.url).hostname.replace(/^www\./, '');
        prefill = { url: tab.url, name };
      }
    }
  } catch (e) {
    prefill = null;
  }
  startWizard(prefill);
}

function hideTestResult() {
  const box = document.getElementById('test-result');
  box.className = 'test-result';
  box.replaceChildren();
}

function showTestResult(res, t) {
  const box = document.getElementById('test-result');
  const head = document.createElement('div');
  head.className = 'tr-head';
  head.textContent = `${t.testHead}: ${res.chars} ${t.testChars}, ${res.lines} ${t.testLines}`;
  box.replaceChildren(head, document.createTextNode(res.chars > 0 ? res.preview : t.testEmpty));
  box.className = `test-result show${res.chars > 0 ? '' : ' warn'}`;
}

// "Test check": one throw-away check with the CURRENT form values, so a wrong
// mode or selector shows up before saving.
async function testSite() {
  const t = TRANSLATIONS[currentLang];
  clearFormMessage();
  hideTestResult();

  let url = document.getElementById('site-url').value.trim();
  if (!url) {
    showFormMessage(t.alertFillFields);
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let urlObj;
  try { urlObj = new URL(url); } catch (err) {
    showFormMessage(t.alertInvalidUrl);
    return;
  }

  // Host permission first (inside the click gesture), same as saving.
  const pattern = `${urlObj.protocol}//${urlObj.host}/*`;
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [pattern] })
      || await chrome.permissions.request({ origins: [pattern] });
  } catch (err) {
    granted = false;
  }
  if (!granted) {
    showFormMessage(t.alertPermissionReq);
    return;
  }

  const rendered = document.getElementById('site-rendered').checked;
  const btn = document.getElementById('btn-test');
  btn.disabled = true;
  btn.textContent = t.btnTestBusy;

  let res;
  try {
    res = await callBackground({
      action: 'previewSite',
      site: {
        url,
        freqIndex: 2,
        ignoreDates: document.getElementById('site-ignore-dates').checked,
        requireCookies: document.getElementById('site-cookies').checked || rendered,
        enableNotifications: true,
        renderMode: rendered ? 'rendered' : 'fast',
        selector: document.getElementById('site-selector').value.trim()
      }
    });
  } finally {
    btn.disabled = false;
    btn.textContent = t.btnTest;
  }

  if (!res || !res.ok) {
    const raw = (res && res.error) || '';
    if (raw === 'invalid') {
      showFormMessage(urlObj.protocol === 'http:' ? t.errHttpCookiesBlocked : t.alertInvalidUrl);
    } else if (!rendered && /^Selector not found/i.test(raw)) {
      document.getElementById('site-rendered').checked = true;
      syncRenderedUI();
      showFormMessage(t.testSelectorMissing, 'warn');
    } else {
      showFormMessage(`${t.checkError}: ${errorLabel(raw, t)}`);
    }
    return;
  }

  showTestResult(res, t);
  if (!rendered && res.suggestRendered) {
    document.getElementById('site-rendered').checked = true;
    syncRenderedUI();
    showFormMessage(t.testSuggestRendered, 'warn');
  }
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
  hideTestResult();
  document.getElementById('view-list').style.display = 'none';
  document.getElementById('view-wizard').style.display = 'none';
  document.getElementById('view-form').style.display = 'block';

  if (site) {
    document.getElementById('form-title').innerText = t.titleEdit;
    document.getElementById('site-id').value = site.id;
    document.getElementById('site-name').value = site.name;
    document.getElementById('site-url').value = site.url;
    document.getElementById('site-selector').value = site.selector || '';
    if (site.freqMinutes) {
      document.getElementById('site-freq').value = 'custom';
      document.getElementById('site-freq-custom').value = site.freqMinutes;
    } else {
      document.getElementById('site-freq').value = site.freqIndex;
      document.getElementById('site-freq-custom').value = '';
    }
    document.getElementById('site-ignore-dates').checked = site.ignoreDates !== false;
    document.getElementById('site-cookies').checked = site.requireCookies !== false;
    document.getElementById('site-notifications').checked = site.enableNotifications !== false;
    document.getElementById('site-rendered').checked = site.renderMode === 'rendered';
  } else {
    document.getElementById('form-title').innerText = t.titleAdd;
    document.getElementById('site-id').value = '';
    document.getElementById('site-name').value = prefill ? prefill.name || '' : '';
    document.getElementById('site-url').value = prefill ? prefill.url || '' : '';
    document.getElementById('site-selector').value = '';
    document.getElementById('site-freq').value = DEFAULT_FREQ_INDEX;
    document.getElementById('site-freq-custom').value = '';
    document.getElementById('site-ignore-dates').checked = true;
    document.getElementById('site-cookies').checked = false;
    document.getElementById('site-notifications').checked = true;
    document.getElementById('site-rendered').checked = false;
  }

  toggleCustomFreq();
  syncRenderedUI();

  if (prefill) {
    const nameField = document.getElementById('site-name');
    nameField.focus();
    nameField.select();
  }
}

// --- ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂWybierz element na stronieÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ (element picker) ----------------------
// Otwiera monitorowany URL w nowej karcie z wstrzykniÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂtym pickerem
// (patrz picker.js): najechanie podÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂwietla fragment, klik wybiera element
// i generuje selektor. Popup w tym czasie siÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ zamknie (karta przejmuje
// focus), wiÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂc wynik wraca przez storage (pendingPicker), a przy
// kolejnym otwarciu popupu przywracamy formularz z uzupeÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂnionym polem.
async function startPicker() {
  const t = TRANSLATIONS[currentLang];
  clearFormMessage();

  let url = document.getElementById('site-url').value.trim();
  if (!url) {
    showFormMessage(t.alertFillFields);
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch (err) {
    showFormMessage(t.alertInvalidUrl);
    return;
  }

  // chrome.scripting w karcie wymaga uprawnienia hosta ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ tego samego,
  // ktÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ³re i tak wymaga samo monitorowanie. ProÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂba musi nastÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂpiÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ w geÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂcie
  // uÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼ytkownika (klik), dlatego jest tutaj, a nie w tle.
  const pattern = `${new URL(url).origin}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [pattern] });
  if (!hasPermission) {
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); }
    catch (err) { granted = false; }
    if (!granted) {
      showFormMessage(t.pickerPermission);
      return;
    }
  }

  const siteId = document.getElementById('site-id').value || null;
  // Form draft is kept under a separate key: picker.js overwrites pendingPicker
  // when the user picks, so the other fields would be lost there.
  const draft = {
    name: document.getElementById('site-name').value,
    freqIndex: document.getElementById('site-freq').value,
    freqCustom: document.getElementById('site-freq-custom').value,
    ignoreDates: document.getElementById('site-ignore-dates').checked,
    requireCookies: document.getElementById('site-cookies').checked,
    enableNotifications: document.getElementById('site-notifications').checked,
    renderMode: document.getElementById('site-rendered').checked
  };
  await chrome.storage.local.set({ pendingPicker: { url, siteId }, pickerDraft: draft });
  const res = await callBackground({
    action: 'startPicker',
    url,
    siteId,
    requireCookies: document.getElementById('site-cookies').checked,
    rendered: document.getElementById('site-rendered').checked
  });
  if (!res || !res.ok) {
    await chrome.storage.local.remove(['pendingPicker', 'pickerDraft']);
    showFormMessage(res && res.error === 'permission' ? t.pickerPermission : t.errSave);
    return;
  }
  // StÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂd popup zamknie siÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ sam, gdy karta przejmie focus; wynik odbierze
  // maybeRestorePicker() przy kolejnym otwarciu.
}

function applyPickerDraft(draft) {
  if (!draft) return;
  document.getElementById('site-name').value = draft.name || '';
  document.getElementById('site-freq').value = draft.freqIndex;
  document.getElementById('site-freq-custom').value = draft.freqCustom || '';
  toggleCustomFreq();
  document.getElementById('site-ignore-dates').checked = draft.ignoreDates !== false;
  document.getElementById('site-cookies').checked = Boolean(draft.requireCookies);
  document.getElementById('site-notifications').checked = draft.enableNotifications !== false;
  document.getElementById('site-rendered').checked = Boolean(draft.renderMode);
  syncRenderedUI();
}

// The picked element is drawn by scripts (absent from the server HTML): the
// fast mode could never find it, so switch the form to the rendered mode.
function applyNeedsRendered(picked) {
  if (!picked.needsRendered) return false;
  document.getElementById('site-rendered').checked = true;
  document.getElementById('site-cookies').checked = true; // rendered mode always uses the session
  syncRenderedUI();
  return true;
}

async function maybeRestorePicker() {
  const data = await chrome.storage.local.get(['pendingPicker', 'pickerDraft']);
  const picked = data.pendingPicker;
  if (!picked || !picked.selector) return false;

  if (data.pickerDraft && data.pickerDraft.wizard) {
    await chrome.storage.local.remove(['pendingPicker', 'pickerDraft']);
    // Stale wizard picker draft (abandoned >15 min ago): do not resurrect
    // the wizard - that hijacked every popup open. Just drop everything.
    if (Date.now() - (data.pickerDraft.ts || 0) <= 15 * 60 * 1000) {
      restoreWizardWithSelector(picked, data.pickerDraft);
    }
    return true;
  }

  await chrome.storage.local.remove(['pendingPicker', 'pickerDraft']);
  const t = TRANSLATIONS[currentLang];

  if (picked.siteId) {
    const all = await chrome.storage.local.get('sites');
    const site = (all.sites || []).find((s) => s.id === picked.siteId);
    if (site) {
      showForm(site);
      applyPickerDraft(data.pickerDraft);
      document.getElementById('site-selector').value = picked.selector;
      showFormMessage(applyNeedsRendered(picked) ? t.pickerDoneRendered : t.pickerDone);
    }
  } else {
    showForm(null, { url: picked.url });
    applyPickerDraft(data.pickerDraft);
    document.getElementById('site-selector').value = picked.selector;
    showFormMessage(applyNeedsRendered(picked) ? t.pickerDoneRendered : t.pickerDone);
  }
  return true;
}

// --- SpÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ³jny system popoverÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ³w ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂiÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ (dodatkowe wyjaÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂnienia opcji) -----------
// Jeden wspÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ³ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂdzielony element #popover; treÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ brana w chwili otwarcia z
// TRANSLATIONS[data-popover], wiÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂc zmiana jÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂzyka nie wymaga odÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂwieÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼ania.
const POPOVER_EL = document.getElementById('popover');
let popoverOwner = null;

function positionPopover(btn) {
  POPOVER_EL.style.left = '0px';
  POPOVER_EL.style.top = '0px';
  POPOVER_EL.classList.add('show');
  const btnRect = btn.getBoundingClientRect();
  const popRect = POPOVER_EL.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = btnRect.right + 8;
  if (left + popRect.width > vw - 8) {
    left = Math.max(8, btnRect.left - popRect.width - 8);
  }
  let top = btnRect.top - 4;
  if (top + popRect.height > vh - 8) {
    top = Math.max(8, vh - popRect.height - 8);
  }
  POPOVER_EL.style.left = `${Math.round(left)}px`;
  POPOVER_EL.style.top = `${Math.round(top)}px`;
}

function hidePopover() {
  if (!popoverOwner) return;
  popoverOwner.setAttribute('aria-expanded', 'false');
  popoverOwner = null;
  POPOVER_EL.classList.remove('show');
  POPOVER_EL.setAttribute('aria-hidden', 'true');
  POPOVER_EL.textContent = '';
}

function togglePopover(btn) {
  if (popoverOwner === btn) {
    hidePopover();
    return;
  }
  hidePopover();
  const key = btn.getAttribute('data-popover');
  const text = TRANSLATIONS[currentLang][key];
  if (!text) return;
  popoverOwner = btn;
  POPOVER_EL.textContent = text;
  POPOVER_EL.setAttribute('aria-hidden', 'false');
  btn.setAttribute('aria-expanded', 'true');
  positionPopover(btn);
}

document.querySelectorAll('.info-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover(btn);
  });
});

// Klik poza popoverem i Escape go zamykajÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ (jak panel ustawieÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ).
document.addEventListener('click', (e) => {
  if (!popoverOwner) return;
  if (popoverOwner.contains(e.target) || POPOVER_EL.contains(e.target)) return;
  hidePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popoverOwner) {
    e.stopPropagation();
    hidePopover();
  }
});

async function showList() {
  document.getElementById('view-form').style.display = 'none';
  const wv = document.getElementById('view-wizard'); if (wv) wv.style.display = 'none';
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
  const selector = document.getElementById('site-selector').value.trim();
  const freqSelect = document.getElementById('site-freq').value;
  const isCustomFreq = freqSelect === 'custom';
  const freqIndex = isCustomFreq ? parseInt(DEFAULT_FREQ_INDEX, 10) : parseInt(freqSelect, 10);
  const freqMinutes = isCustomFreq ? Number(document.getElementById('site-freq-custom').value.trim()) : null;
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

  if (isCustomFreq) {
    const minAllowed = renderMode === 'rendered' ? 5 : 1;
    const valid = Number.isInteger(freqMinutes) && freqMinutes >= 1 && freqMinutes <= 10080;
    if (!valid) {
      showFormMessage(t.errFreqRange);
      return;
    }
    if (freqMinutes < minAllowed) {
      showFormMessage(t.errFreqRangeRendered);
      return;
    }
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

  // Ask for the host permission FIRST (still inside the click's user gesture)
  // so a refusal never leaves a half-saved page behind.
  // contains() first: with install-time host_permissions it is always true,
  // so the request dialog (which closes this popup) never triggers.
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [`${urlObj.protocol}//${urlObj.host}/*`] })
      || await chrome.permissions.request({
        origins: [`${urlObj.protocol}//${urlObj.host}/*`]
      });
  } catch (err) {
    showFormMessage(t.alertInvalidUrl);
    return;
  }
  if (!granted) {
    showFormMessage(t.alertPermissionReq);
    return;
  }

  const res = await callBackground({
    action: 'saveSite',
    site: { id, name, url, freqIndex, freqMinutes, ignoreDates, requireCookies, enableNotifications, renderMode, selector }
  });

  if (!res.ok) {
    showFormMessage(saveErrorMessage(res));
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
  const data = await chrome.storage.local.get(['sites', 'groups']);
  const idx = (data.sites || []).findIndex((s) => s.id === siteId);
  const site = idx !== -1 ? data.sites[idx] : null;
  const group = site && site.groupId ? ((data.groups || []).find((g) => g.id === site.groupId) || null) : null;

  await callBackground({ action: 'deleteSite', siteId });
  renderSites();
  if (site) showUndoSummary(site, idx, group);
}

// I2: "Deleted: <name> - [Undo]". Restore reuses the original record
// (with snapshots and change state) via the background 'undoDelete' action.
function showUndoSummary(site, index, group = null) {
  const t = TRANSLATIONS[currentLang];
  showSummaryNodes([
    summaryText(`${t.deletedSummary}: `),
    summaryText(site.name),
    summaryText(` \u2022 `),
    summaryButton(t.undoDelete, async () => {
      const res = await callBackground({ action: 'undoDelete', site, index, group });
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