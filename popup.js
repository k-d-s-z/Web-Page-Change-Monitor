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
let summaryTimer = null;

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
  document.getElementById('btn-backup').addEventListener('click', createBackup);
  document.getElementById('btn-restore').addEventListener('click', () => document.getElementById('restore-file-input').click());
  document.getElementById('restore-file-input').addEventListener('change', restoreBackup);

  chrome.storage.onChanged.addListener(onStorageChanged);

  document.getElementById('site-url').addEventListener('input', () => {
    pendingHttpConfirm = null;
    clearFormMessage();
  });

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      currentLang = e.target.getAttribute('data-lang');
      await chrome.storage.local.set({ language: currentLang });
      updateLangButtonsUI();
      applyTranslations();
      renderSites();
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

function updateRefreshAllButton() {
  const btn = document.getElementById('btn-refresh-all');
  if (!btn) return;

  const t = TRANSLATIONS[currentLang];
  btn.textContent = isRefreshingAll ? t.btnRefreshAllBusy : t.btnRefreshAll;
  btn.disabled = isRefreshingAll || activeSiteCount === 0;
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

function progressText() {
  const t = TRANSLATIONS[currentLang];
  const done = refreshTracker.total - refreshTracker.pending.size;
  return `${t.summaryProgress} ${done}/${refreshTracker.total}…`;
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
  const text = `${t.summaryRefreshed}: ${checked} • ${t.summaryChanges}: ${res.changed} • ${t.summaryErrors}: ${res.errors}`;
  showSummary(text, res.changed > 0 || res.errors > 0 ? 'warn' : 'ok', SUMMARY_HIDE_MS);
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

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!parsed || !Array.isArray(parsed.sites)) {
      showSummary(t.restoreInvalid, 'warn', SUMMARY_HIDE_MS);
      return;
    }
    // Pole "version" pojawiło się razem z pierwszym formatem eksportu, więc
    // brak pola (starsze/ręcznie złożone pliki) traktujemy jako kompatybilne.
    // Nieznana/nowsza wersja oznacza format, którego ten kod jeszcze nie zna
    // — lepiej odmówić niż zgadywać, jak interpretować pola.
    if (parsed.version !== undefined && parsed.version !== SUPPORTED_BACKUP_VERSION) {
      showSummary(t.restoreUnsupportedVersion, 'warn', SUMMARY_HIDE_MS);
      return;
    }
    if (parsed.sites.length === 0) {
      showSummary(t.restoreEmpty, 'warn', SUMMARY_HIDE_MS);
      return;
    }

    // Zapisujemy PRZED prośbą o uprawnienia (patrz komentarz w saveSite) —
    // tak samo jak przy dodawaniu pojedynczej strony, żeby utrata popupu
    // podczas natywnego dymka Chrome nie skasowała przywracanych danych.
    const res = await callBackground({ action: 'importSites', sites: parsed.sites });

    if (!res.ok) {
      showSummary(t.restoreInvalid, 'warn', SUMMARY_HIDE_MS);
      return;
    }

    let permissionPending = false;
    if (res.origins && res.origins.length > 0) {
      try {
        // Jedno, zbiorcze zapytanie o uprawnienia dla wszystkich nowych
        // originów naraz — zamiast osobnego dymka na każdą stronę.
        const granted = await chrome.permissions.request({ origins: res.origins });
        permissionPending = !granted;
      } catch (err) {
        permissionPending = true;
      }
    }

    await renderSites();

    const parts = [`${t.restoreAdded}: ${res.addedCount}`];
    if (res.skippedCount) parts.push(`${t.restoreSkipped}: ${res.skippedCount}${skipReasonDetail(res.skippedByReason, t)}`);
    let text2 = parts.join(' • ');
    if (permissionPending) text2 += ` — ${t.restorePermissionPending}`;
    showSummary(text2, permissionPending ? 'warn' : 'ok', SUMMARY_HIDE_MS * 2);

    // Bez uprawnień sprawdzenie i tak zakończy się błędem sieciowym, więc
    // odpalamy je tylko gdy dostęp faktycznie został przyznany. Nie czekamy
    // na wynik (jak przy triggerCheck po dodaniu pojedynczej strony) — po
    // zakończeniu wsadu po prostu odświeżamy listę, żeby pokazać wyniki.
    if (!permissionPending && Array.isArray(res.addedIds) && res.addedIds.length > 0) {
      res.addedIds.forEach((id) => checkingIds.add(id));
      renderSites();
      callBackground({ action: 'checkSites', siteIds: res.addedIds }).finally(() => {
        res.addedIds.forEach((id) => checkingIds.delete(id));
        renderSites();
      });
    }
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

  // Wpis starszy niż 10 minut ignorujemy — np. gdy użytkownik kliknął w menu
  // kontekstowe, ale otworzył popup dopiero dużo później; nie chcemy, żeby
  // formularz "wyskoczył" ze starym, zaskakującym URL-em.
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
    document.getElementById('site-freq').value = site.freqIndex;
    document.getElementById('site-ignore-dates').checked = site.ignoreDates !== false;
    document.getElementById('site-cookies').checked = site.requireCookies !== false;
    document.getElementById('site-notifications').checked = site.enableNotifications !== false;
  } else {
    document.getElementById('form-title').innerText = t.titleAdd;
    document.getElementById('site-id').value = '';
    document.getElementById('site-name').value = prefill ? prefill.name || '' : '';
    document.getElementById('site-url').value = prefill ? prefill.url || '' : '';
    document.getElementById('site-freq').value = DEFAULT_FREQ_INDEX;
    document.getElementById('site-ignore-dates').checked = true;
    document.getElementById('site-cookies').checked = false;
    document.getElementById('site-notifications').checked = true;
  }

  if (prefill) {
    // Nazwa jest tylko podpowiedzią z nazwy hosta — to najbardziej
    // prawdopodobne miejsce, które użytkownik zechce poprawić przed zapisem.
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
  const freqIndex = parseInt(document.getElementById('site-freq').value, 10);
  const ignoreDates = document.getElementById('site-ignore-dates').checked;
  const requireCookies = document.getElementById('site-cookies').checked;
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

  // TWARDA BLOKADA BEZPIECZEŃSTWA: http:// + ciasteczka sesyjne
  if (urlObj.protocol === 'http:' && requireCookies) {
    showFormMessage(t.errHttpCookiesBlocked);
    return;
  }

  // OSTRZEŻENIE: Zwykłe http:// bez ciasteczek (wymaga dwukrotnego kliknięcia Zapisz)
  if (urlObj.protocol === 'http:' && pendingHttpConfirm !== url) {
    pendingHttpConfirm = url;
    showFormMessage(t.warnHttp, 'warn');
    return;
  }

  // Zapisujemy stronę PRZED prośbą o uprawnienia. chrome.permissions.request()
  // pokazuje natywny dymek Chrome, który kradnie fokus oknu popupu — a popup
  // akcji rozszerzenia zamyka się automatycznie przy utracie fokusu, ubijając
  // w locie zawieszoną funkcję saveSite razem z resztą kodu po await. Jeśli
  // najpierw zapiszemy dane (samo storage.local nie wymaga host_permissions,
  // więc nie pokazuje żadnego UI i nie zamyka popupu), utrata popupu podczas
  // dymka uprawnień przestaje gubić dane — w najgorszym razie trzeba będzie
  // później nadać uprawnienie ręcznie przy edycji.
  const res = await callBackground({
    action: 'saveSite',
    site: { id, name, url, freqIndex, ignoreDates, requireCookies, enableNotifications }
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
      // Nowo dodana strona bez uprawnień jest bezużyteczna (nigdy się nie
      // sprawdzi) — wycofujemy wpis, żeby nie zostawiać martwej pozycji.
      // Przy edycji istniejącej strony zostawiamy ją (dane wcześniej działały).
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

async function togglePause(siteId) {
  await callBackground({ action: 'toggleSite', siteId });
  renderSites();
}

async function deleteSite(siteId) {
  checkingIds.delete(siteId);
  await callBackground({ action: 'deleteSite', siteId });
  renderSites();
}