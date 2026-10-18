// === POPUP.JS: wklej na gÃ³rze pliku (pod staÅymi) ===
// Potem w caÅym popup.js zamieÅ KAÅ»DE wywoÅanie
//     chrome.permissions.request(
// na
//     requestWithResume(
// (dotyczy teÅ¼ kreatora / startWizard, jeÅli prosi o uprawnienie).

const RESUME_FLAG = 'resumeAfterPermission';

// Zapisuje znacznik PRZED oknem zgody. Okno zgody zamyka popup, wiÄc kod po
// await moÅ¼e siÄ juÅ¼ nie wykonaÄ - dlatego znacznik czyta i usuwa tÅo
// (background.js, chrome.permissions.onAdded).
async function requestWithResume(details) {
  await chrome.storage.local.set({ [RESUME_FLAG]: Date.now() });
  try {
    const granted = await chrome.permissions.request(details);
    // Popup przeÅ¼yÅ (okno zgody go nie zamknÄÅo) - znacznik niepotrzebny.
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
const pendingDeleteConfirm = new Set(); // siteId z aktywnym potwierdzeniem usuniecia
// Czas auto-ukrywania podsumowan (pokazywanych przez showSummary z trzecim
// argumentem). Utracony przy przepisaniu pliku na bazie popup-3.js (bral
// sie z innej galezi pliku) - jego brak zrobil ReferenceError w KAZDYM
// podsumowaniu z auto-ukrywaniem (np. restoreBackup).
const SUMMARY_HIDE_MS = 4000;

// === Pelna migracja kreatora do KARTY (2026-10) ===
// Popup zostaje LISTA stron; dodawanie strony dziala w dedykowanej karcie
// popup.html?wizard=1. Karta - w przeciwienstwie do popupu - nie zamyka sie
// przy okienku zgody ani przy przelaczeniu na strone z pickerem, wiec cale
// "wskrzeszanie" draftow (wizardDraft/pickerDraft) zostaje jako bezpieczenstwo.
const IS_WIZARD_TAB = /[?&]wizard=1/.test(window.location.search);
const WIZARD_TAB_URL = chrome.runtime.getURL('popup.html') + '?wizard=1';
const IS_RESTORE_TAB = /[?&]restore=1/.test(window.location.search);

// Wersja dla strony rozszerzenia (popup/karta): tab.url czytamy po FILTRZE
// PREFIXU - tabs.query({url: wzorzec}) notorycznie zawodzi dla wlasnych stron
// chrome-extension i "nie widzial" karty kreatora.
async function focusWizardTab() {
  try {
    const base = chrome.runtime.getURL('popup.html');
    const all = await chrome.tabs.query({});
    const tab = (all || []).find((t) =>
      (t.url || '').split('#')[0].startsWith(base) && /[?&]wizard=1/.test(t.url || ''));
    if (!tab) return false;
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (err) { /* noop */ }
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (err) { /* noop */ }
    return true;
  } catch (err) {
    return false;
  }
}

// Otwiera karte kreatora (albo aktywuje juz istniejaca - nigdy drugiej).
// prefill do ZYWEJ karty idzie przez runtime message, do nowej - przez storage
// (wizardPrefill), bo nowa karta czyta go w swoim DOMContentLoaded.
async function openWizardTab(prefill) {
  try {
    const data = (prefill && (prefill.url || prefill.name)) ? prefill : null;
    if (await focusWizardTab()) {
      if (data) {
        try { await chrome.runtime.sendMessage({ action: 'wizardStart', prefill: data }); } catch (err) { /* noop */ }
      }
      return;
    }
    try { await chrome.storage.local.remove('wizardPrefill'); } catch (err) { /* noop */ }
    if (data) {
      try { await chrome.storage.local.set({ wizardPrefill: data }); } catch (err) { /* noop */ }
    }
    await chrome.tabs.create({ url: WIZARD_TAB_URL });
  } catch (err) {
    // Awaryjnie (brak tabs API): kreator w popupie - stare przeplywy wciaz dzialaja.
    startWizard(prefill || null);
  }
}

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

  // Karta kreatora / karta restore: od razu ustalamy wyglad (body.wizard-tab
  // rozszerza layout na cale okno) i chowamy liste - bez tego lista migala
  // by klatke zanim przelaczymy widoki.
  if (IS_WIZARD_TAB || IS_RESTORE_TAB) {
    document.body.classList.add('wizard-tab');
    const list = document.getElementById('view-list');
    if (list) list.style.display = 'none';
  }

  updateLangButtonsUI();
  applyTranslations();

  // Porzadki: marker zgody restore z popupu, ktory zginal zanim zdazyl go
  // usunac (tlo czyta go tylko przez 60 s po requestWithResume; starszy
  // jest martwy i tylko zasmiecalby storage).
  {
    const stale = await chrome.storage.local.get('pendingRestorePermission');
    const m = stale.pendingRestorePermission;
    if (m && Date.now() - (m.ts || 0) > 60_000) {
      try { await chrome.storage.local.remove('pendingRestorePermission'); } catch (err) { /* noop */ }
    }
  }
  await renderSites();

  if (IS_RESTORE_TAB) {
    // Karta nadania dostepu po restore: pokazuje tylko widok restore.
    document.getElementById('view-restore').style.display = 'block';
    await initRestoreTab();
    return;
  }

  if (IS_WIZARD_TAB) {
    // Karta kreatora: zawsze kreator - nowy, wznowiony po okienku zgody
    // (maybeRestoreWizard) albo z prefillem (przycisk "+", menu kontekstowe,
    // message z innego kontekstu). Lista stron tu nie wystepuje.
    const pre = await chrome.storage.local.get('wizardPrefill');
    const prefill = pre.wizardPrefill;
    if (prefill) {
      try { await chrome.storage.local.remove('wizardPrefill'); } catch (err) { /* noop */ }
    }
    const pickerRestored = await maybeRestorePicker();
    const wizardRestored = pickerRestored ? false : await maybeRestoreWizard();
    if (!pickerRestored && !wizardRestored) startWizard(prefill || null);

    // Zywotny odbior prefilla "+" z zywej karty (karta juz otwarta):
    // nie restartujemy kreatora w trakcie pracy - tylko gdy kreator nie dziala.
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.action !== 'wizardStart' || !msg.prefill) return;
      if (typeof wizardState !== 'undefined' && wizardState) return;
      startWizard(msg.prefill);
    });
  } else {
    await maybeOpenPendingAdd();
    const pickerRestored = await maybeRestorePicker();
    // Audit UX#2: edit/add form interrupted by the permission dialog: resume it
    // (lowest priority - pendingAdd and picker win). The WIZARD no longer
    // restores here: it lives in its own tab (its drafts are consumed by the
    // wizard tab on load; chrome.permissions.onAdded in the background opens
    // that tab after a grant).
    if (!pickerRestored) await maybeRestoreEditDraft();
    maybeShowChangedHint();
  }

  document.getElementById('btn-add-view').addEventListener('click', openAddForm);
  document.getElementById('btn-test').addEventListener('click', testSite);
  document.getElementById('btn-cancel').addEventListener('click', () => { clearEditDraft(); showList(); });
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

// Wrapper na chrome.runtime.sendMessage â nigdy nie rzuca; bÅÄd kanaÅu
// zwracany jest jako { ok: false, error }, Å¼eby wywoÅujÄcy mÃ³gÅ go obsÅuÅ¼yÄ.
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

// Karta kreatora: picker zapisal selektor do storage (karta nie przeladowuje
// sie, wiec maybeRestorePicker nie odpali) - pobieramy go na zywo.
async function applyWizardPickFromStorage() {
  try {
    const data = await chrome.storage.local.get(['pendingPicker', 'pickerDraft']);
    const picked = data.pendingPicker;
    if (!picked || !picked.selector) return;
    if (!(data.pickerDraft && data.pickerDraft.wizard)) return;
    await chrome.storage.local.remove(['pendingPicker', 'pickerDraft']);
    restoreWizardWithSelector(picked, data.pickerDraft);
  } catch (err) { /* noop */ }
}

// Karta nadania dostepu po restore (popup.html?restore=1). Zgoda idzie z karty,
// nie z popupu - okienko Chrome zamyka popup, karta przezycje je bez problemu.
function originHost(o) {
  try { return new URL(o.replace(/\*$/, '')).host; } catch (e) { return o; }
}

async function initRestoreTab() {
  const t = TRANSLATIONS[currentLang];
  const data = await chrome.storage.local.get('pendingRestorePermission');
  const marker = data.pendingRestorePermission;
  const origins = (marker && Array.isArray(marker.origins)) ? marker.origins : [];

  const hostsEl = document.getElementById('restore-hosts');
  const msgEl = document.getElementById('restore-message');
  const btnGrant = document.getElementById('btn-restore-grant');
  const btnSkip = document.getElementById('btn-restore-skip');
  const btnDone = document.getElementById('btn-restore-done');

  const closeTab = async () => {
    await chrome.storage.local.remove('pendingRestorePermission');
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab && tab.id != null) { await chrome.tabs.remove(tab.id); return; }
    } catch (e) { /* not a tab */ }
    try { window.close(); } catch (e) { /* noop */ }
  };

  if (origins.length === 0) { await closeTab(); return; }

  const renderHosts = (missingSet) => {
    hostsEl.replaceChildren();
    for (const o of origins) {
      const li = document.createElement('li');
      li.textContent = originHost(o);
      if (!missingSet.has(o)) li.classList.add('granted');
      hostsEl.appendChild(li);
    }
  };
  renderHosts(new Set(origins));

  btnGrant.addEventListener('click', async () => {
    btnGrant.disabled = true;
    try {
      // Okienko zgody z wielu originami pozwala na CZASTKOWA zgode (checkboxy
      // domyslnie odznaczone) - po powrocie weryfikujemy kazdy origin osobno.
      await requestWithResume({ origins });
      const missing = [];
      for (const o of origins) {
        try {
          if (!(await chrome.permissions.contains({ origins: [o] }))) missing.push(o);
        } catch (err) { missing.push(o); }
      }
      if (missing.length === 0) {
        renderHosts(new Set());
        msgEl.textContent = t.restoreAccessGranted;
        msgEl.className = 'form-message ok';
        btnGrant.style.display = 'none';
        btnSkip.style.display = 'none';
        btnDone.style.display = '';
      } else {
        msgEl.textContent = t.restoreAccessMissing.replace('{hosts}', missing.map(originHost).join(', '));
        msgEl.className = 'form-message warn';
        btnGrant.disabled = false;
      }
    } catch (err) {
      msgEl.textContent = t.restoreAccessMissing.replace('{hosts}', origins.map(originHost).join(', '));
      msgEl.className = 'form-message warn';
      btnGrant.disabled = false;
    }
  });
  btnSkip.addEventListener('click', closeTab);
  btnDone.addEventListener('click', closeTab);
}

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (IS_WIZARD_TAB && changes.pendingPicker && typeof wizardState !== 'undefined' && wizardState) {
    applyWizardPickFromStorage();
  }
  if (!changes.sites || !refreshTracker) return;

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
    let missingOrigins = [];
    if (res.origins && res.origins.length > 0) {
      // Po restore NIE prosimy o zgode z popupu: okienko zgody (zwlaszcza z
      // WIELOMA originami) zamyka popup, zanim zgoda zostanie przyznana, i
      // dostep nigdy nie trafia do rozszerzenia. Zamiast tego: sprawdzamy,
      // ktore origins faktycznie brakuja, i otwieramy DEDYKOWANA KARTE
      // (popup.html?restore=1) z lista hostow i przyciskiem zgody - karta
      // nie umiera przy okienku. (Audyt #6: lista hostow PRZED zgoda.)
      for (const o of res.origins) {
        try {
          if (!(await chrome.permissions.contains({ origins: [o] }))) missingOrigins.push(o);
        } catch (err) {
          missingOrigins.push(o);
        }
      }
      if (missingOrigins.length > 0) {
        permissionPending = true;
        await chrome.storage.local.set({
          pendingRestorePermission: { ts: Date.now(), origins: missingOrigins }
        });
        try { await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '?restore=1' }); } catch (err) { /* noop */ }
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

  if (IS_WIZARD_TAB) {
    // Juz jestesmy w karcie kreatora: startujemy bezposrednio.
    startWizard({ url: pending.url, name: suggestedName });
    return;
  }
  // Popup: przekaz zadanie karcie kreatora.
  openWizardTab({ url: pending.url, name: suggestedName });
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
  // Kreator zyje w karcie - popup to tylko lista.
  openWizardTab(prefill);
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
  // Audit UX#2: the dialog may close this popup - snapshot the form first.
  const pattern = `${urlObj.protocol}//${urlObj.host}/*`;
  await saveEditDraftFromForm();
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

// --- âWybierz element na stronieâ¦â (element picker) ----------------------
// Otwiera monitorowany URL w nowej karcie z wstrzykniÄtym pickerem
// (patrz picker.js): najechanie podÅwietla fragment, klik wybiera element
// i generuje selektor. Popup w tym czasie siÄ zamknie (karta przejmuje
// focus), wiÄc wynik wraca przez storage (pendingPicker), a przy
// kolejnym otwarciu popupu przywracamy formularz z uzupeÅnionym polem.
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

  // chrome.scripting w karcie wymaga uprawnienia hosta â tego samego,
  // ktÃ³re i tak wymaga samo monitorowanie. ProÅba musi nastÄpiÄ w geÅcie
  // uÅ¼ytkownika (klik), dlatego jest tutaj, a nie w tle.
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
  // StÄd popup zamknie siÄ sam, gdy karta przejmie focus; wynik odbierze
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
  const data = await chrome.storage.local.get(['pendingPicker', 'pickerDraft']);  const picked = data.pendingPicker;
  if (!picked || !picked.selector) return false;

  // Podzial kontekstow (karta kreatora vs popup-lista):
  // - popup: wybor z KREATORA oddajemy karcie (ta go konsumuje przy ladowaniu
  //   albo na zywo przez onStorageChanged); wybor z formularza edycji
  //   przywracamy tu jak dotychczas. Rekordu nie ruszamy - karta go zje.
  // - karta kreatora: konsumujemy TYLKO wybory z kreatora; wybor edycyjny
  //   zostawiamy w spokoju dla popupu.
  if (data.pickerDraft && data.pickerDraft.wizard) {
    if (!IS_WIZARD_TAB) {
      await openWizardTab(null);
      return true;
    }
  } else {
    if (IS_WIZARD_TAB) return false;
  }

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

// --- Audit UX#2: edit/add form survives the permission dialog -----------
// saveSite/testSite ask for a host permission when the URL's origin changes;
// Chrome's dialog CLOSES this popup, so an unsaved form used to be lost.
// Same draft pattern as pickerDraft: the whole form is stored BEFORE the
// permission request and restored on the next popup open.
const EDIT_DRAFT_MAX_AGE_MS = 15 * 60 * 1000;

async function saveEditDraftFromForm() {
  const freqSelect = document.getElementById('site-freq').value;
  try {
    await chrome.storage.local.set({
      editDraft: {
        ts: Date.now(),
        id: document.getElementById('site-id').value,
        name: document.getElementById('site-name').value,
        url: document.getElementById('site-url').value,
        selector: document.getElementById('site-selector').value,
        freqSelect,
        freqCustom: document.getElementById('site-freq-custom').value,
        ignoreDates: document.getElementById('site-ignore-dates').checked,
        requireCookies: document.getElementById('site-cookies').checked,
        enableNotifications: document.getElementById('site-notifications').checked,
        rendered: document.getElementById('site-rendered').checked
      }
    });
  } catch (err) { /* best-effort */ }
}

async function clearEditDraft() {
  try { await chrome.storage.local.remove('editDraft'); } catch (err) { /* noop */ }
}

async function maybeRestoreEditDraft() {
  const data = await chrome.storage.local.get('editDraft');
  const d = data.editDraft;
  if (!d || typeof d !== 'object') return false;

  // Stale (the user moved on long ago): drop silently instead of hijacking.
  if (!d.ts || Date.now() - d.ts > EDIT_DRAFT_MAX_AGE_MS) {
    await clearEditDraft();
    return false;
  }

  await clearEditDraft();
  const t = TRANSLATIONS[currentLang];

  if (d.id) {
    const all = await chrome.storage.local.get('sites');
    const site = (all.sites || []).find((s) => s.id === d.id);
    showForm(site || null, site ? null : { url: d.url, name: d.name });
  } else {
    showForm(null, { url: d.url, name: d.name });
  }

  // Overlay the (possibly edited) values from the draft over the form that
  // showForm just populated from the stored site.
  document.getElementById('site-name').value = d.name || '';
  document.getElementById('site-url').value = d.url || '';
  document.getElementById('site-selector').value = d.selector || '';
  document.getElementById('site-freq').value = d.freqSelect || DEFAULT_FREQ_INDEX;
  document.getElementById('site-freq-custom').value = d.freqCustom || '';
  document.getElementById('site-ignore-dates').checked = d.ignoreDates !== false;
  document.getElementById('site-cookies').checked = Boolean(d.requireCookies);
  document.getElementById('site-notifications').checked = d.enableNotifications !== false;
  document.getElementById('site-rendered').checked = Boolean(d.rendered);
  syncRenderedUI();
  toggleCustomFreq();
  showFormMessage(t.editRestored, 'warn');
  return true;
}

// --- SpÃ³jny system popoverÃ³w âiâ (dodatkowe wyjaÅnienia opcji) -----------
// Jeden wspÃ³Ådzielony element #popover; treÅÄ brana w chwili otwarcia z
// TRANSLATIONS[data-popover], wiÄc zmiana jÄzyka nie wymaga odÅwieÅ¼ania.
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

// Klik poza popoverem i Escape go zamykajÄ (jak panel ustawieÅ).
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
  // Audit UX#2: the dialog may close this popup - snapshot the form first,
  // maybeRestoreEditDraft() brings the user back to it on the next open.
  await saveEditDraftFromForm();
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

  await clearEditDraft(); // saved: the draft snapshot is no longer needed
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

// Usuniecie strony wymaga POTWIERDZENIA: klik na koszu pokazuje ostrzezenie
// "Usunac te strone? [Usun] [Anuluj]". Kazdy z przyciskow NAJPIERW zamyka
// ostrzezenie (clearSummary), dopiero potem dziala - pasek podsumowania nie
// moze "wisiec" po potwierdzeniu (poprzednia wersja opierala sie na tym, ze
// podsumowanie Undo samo nadpisze ostrzezenie, i przy bledzie w srodku
// sciezki usuwania ostrzezenie zostawalo na ekranie).
async function deleteSite(siteId) {
  const t = TRANSLATIONS[currentLang];
  const data0 = await chrome.storage.local.get('sites');
  const site0 = (data0.sites || []).find((s) => s.id === siteId);
  if (!site0) return;
  if (pendingDeleteConfirm.has(siteId)) {
    // Potwierdzone: wykonaj usuwanie.
    pendingDeleteConfirm.delete(siteId);
  } else {
    // Pierwsze klikniecie: pokaz ostrzezenie.
    showSummaryNodes([
      summaryText(`${t.deleteConfirmTitle} `),
      summaryText(site0.name),
      summaryText(` \u2022 `),
      summaryButton(t.btnDeleteYes, () => {
        clearSummary();
        pendingDeleteConfirm.add(siteId);
        deleteSite(siteId);
      }),
      summaryText(` \u2022 `),
      summaryButton(t.btnCancel, () => { clearSummary(); })
    ], 'warn', 0);
    return;
  }

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