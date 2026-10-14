const FREQ_MAP = [1, 5, 10, 60, 1440];
const FETCH_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SITES = 50;
const CHECK_ALL_CONCURRENCY = 3;
const NOTIFICATION_PREFIX = 'change_';
const HASH_MODE = 'v4';
const SNAPSHOT_MAX_CHARS = 150000;

let storageQueue = Promise.resolve();
function withStorageLock(task) {
  const run = storageQueue.then(task);
  storageQueue = run.catch(() => {});
  return run;
}

const inFlight = new Set();

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarms();
  await updateContextMenu();
});

chrome.runtime.onStartup.addListener(async () => {
  inFlight.clear();
  await setupAlarms();
  await updateContextMenu();
});

// Odświeżamy tytuł pozycji menu przy zmianie języka w popupie, żeby był
// aktualny nawet bez ponownego uruchamiania rozszerzenia.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.language) {
    updateContextMenu();
  }
});

const CONTEXT_MENU_MONITOR_ID = 'monitor-this-page';

function contextMenuTitle(lang) {
  return lang === 'pl' ? 'Monitoruj stronę' : 'Monitor this page';
}

async function updateContextMenu() {
  const data = await chrome.storage.local.get('language');
  const lang = data.language || detectLanguage();

  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create(
        {
          id: CONTEXT_MENU_MONITOR_ID,
          title: contextMenuTitle(lang),
          contexts: ['page'],
          // Ukrywa pozycję na stronach chrome://, plikach lokalnych itp.,
          // dla których i tak nie da się dodać monitorowania (wymóg http/https
          // egzekwowany też w sanitizeSiteInput).
          documentUrlPatterns: ['http://*/*', 'https://*/*']
        },
        () => {
          if (chrome.runtime.lastError) {
            console.warn('[Monitor] contextMenus.create:', chrome.runtime.lastError.message);
          }
          resolve();
        }
      );
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== CONTEXT_MENU_MONITOR_ID || !info.pageUrl) return;

  // Zapisujemy tylko URL (z timestampem do wygaszenia po czasie) — nazwę
  // strony popup zaproponuje sam na podstawie hosta, bez potrzeby
  // uprawnienia "tabs" tylko po to, by odczytać tytuł karty.
  await chrome.storage.local.set({ pendingAdd: { url: info.pageUrl, ts: Date.now() } });

  let opened = false;
  try {
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      opened = true;
    }
  } catch (e) {
    opened = false;
  }

  if (!opened) {
    // action.openPopup() jest ogólnie dostępne dopiero od Chrome 127
    // (wcześniej tylko dla rozszerzeń wdrażanych przez politykę). Na
    // starszych wersjach informujemy użytkownika, żeby kliknął ikonę —
    // formularz i tak otworzy się od razu wypełniony, bo pendingAdd
    // zostaje w storage.
    const data = await chrome.storage.local.get('language');
    const lang = data.language || detectLanguage();
    chrome.notifications.create(`pendingadd_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: lang === 'pl' ? 'Gotowe do dodania' : 'Ready to add',
      message: lang === 'pl'
        ? 'Kliknij ikonę rozszerzenia, aby dokończyć dodawanie strony.'
        : 'Click the extension icon to finish adding this page.'
    });
  }
});

const HANDLERS = {
  updateAlarms: async () => {
    await setupAlarms();
    return { status: 'ok' };
  },
  updateBadge: async () => {
    await updateBadge();
    return { status: 'ok' };
  },
  refreshSiteContent: async (msg) => {
    if (msg.siteId) await refreshSiteSilently(String(msg.siteId));
    return { status: 'ok' };
  },
  // Pojedynczy check: aktualizujemy badge od razu, bo użytkownik patrzy
  // na wynik tej konkretnej strony. W batchu (checkAll/checkSites) badge
  // liczony jest raz na końcu — patrz runBatch().
  checkNow: async (msg) => {
    if (!msg.siteId) return { status: 'skipped' };
    const result = await checkSite(String(msg.siteId));
    if (result.status !== 'busy') await updateBadge();
    return result;
  },
  checkSites: async (msg) => checkSpecificSites(msg.siteIds),
  saveSite: (msg) => handleSaveSite(msg),
  toggleSite: (msg) => handleToggleSite(msg),
  deleteSite: (msg) => handleDeleteSite(msg),
  reorderSites: (msg) => handleReorderSites(msg),
  checkAll: () => checkAllSites(),
  importSites: (msg) => handleImportSites(msg)
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  const handler = msg && Object.hasOwn(HANDLERS, msg.action) ? HANDLERS[msg.action] : null;
  if (!handler) return;

  handler(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error('[Monitor] Handler error:', err);
      sendResponse({ ok: false, status: 'error', error: String((err && err.message) || err) });
    });
  return true;
});

async function setupAlarms() {
  const [data, existing] = await Promise.all([
    chrome.storage.local.get('sites'),
    chrome.alarms.getAll()
  ]);
  const sites = data.sites || [];

  const wanted = new Map();
  for (const site of sites) {
    if (site.isPaused) continue;
    wanted.set(`check_${site.id}`, FREQ_MAP[site.freqIndex] || 1);
  }

  const kept = new Set();
  for (const alarm of existing) {
    if (!alarm.name.startsWith('check_')) continue;

    if (wanted.get(alarm.name) === alarm.periodInMinutes) {
      kept.add(alarm.name);
    } else {
      await chrome.alarms.clear(alarm.name);
    }
  }

  for (const [name, minutes] of wanted) {
    if (kept.has(name)) continue;
    const jitter = Math.random() * Math.min(minutes * 0.1, 2);
    await chrome.alarms.create(name, {
      periodInMinutes: minutes,
      delayInMinutes: minutes + jitter
    });
  }

  await updateBadge();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('check_')) {
    const siteId = alarm.name.replace('check_', '');
    const result = await checkSite(siteId);
    // Badge aktualizujemy tylko wtedy, gdy check faktycznie się wykonał
    // (status 'busy' = inny check tej strony już leci).
    if (result.status !== 'busy') await updateBadge();
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;

  const parts = notificationId.slice(NOTIFICATION_PREFIX.length).split('_');
  const siteId = parts[0];

  chrome.notifications.clear(notificationId);
  const data = await chrome.storage.local.get('sites');
  const site = (data.sites || []).find((s) => s.id === siteId);
  if (!site) return;

  // Jeśli zmiana jest nieodczytana — otwieramy podgląd diffa zamiast samej
  // strony, bo to właśnie po to użytkownik klika powiadomienie.
  const url = site.hasChanged
    ? chrome.runtime.getURL('diff.html') + '#' + site.id
    : site.url;

  await chrome.tabs.create({ url });
  await refreshSiteSilently(siteId);
});

function detectLanguage() {
  try {
    return (chrome.i18n.getUILanguage() || '').toLowerCase().startsWith('pl') ? 'pl' : 'en';
  } catch (e) {
    return 'en';
  }
}

function cleanHtmlSimple(htmlText) {
  if (!htmlText) return '';
  let cleaned = htmlText.replace(/<!--[\s\S]*?-->/g, '');
  cleaned = cleaned.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  return cleaned.replace(/\s+/g, ' ').trim();
}

// Wersja do PODGLĄDU ZMIAN (U1): w przeciwieństwie do cleanHtmlSimple
// zachowuje strukturę linii — tagi blokowe stają się separatorami \n.
// Dzięki temu diff porównuje akapity/komórki jako linie, a nie jeden
// zwinięty ciąg tekstu. Snapshot jest trzymany ODRĘBNIE od hasha
// (lastHash liczony jest nadal z cleanHtmlSimple, więc baseline się
// nie psuje przy aktualizacji rozszerzenia).
const SNAPSHOT_BLOCK_TAGS = 'p|div|br|li|tr|td|th|section|article|header|footer|nav|aside|h[1-6]|blockquote|ul|ol|table|figure|figcaption|dt|dd|hr|form|main';

function cleanHtmlStructured(htmlText) {
  if (!htmlText) return '';
  let cleaned = htmlText.replace(/<!--[\s\S]*?-->/g, '');
  cleaned = cleaned.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  cleaned = cleaned.replace(new RegExp(`<(${SNAPSHOT_BLOCK_TAGS})[^>]*>`, 'gi'), '\n');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  return cleaned
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, SNAPSHOT_MAX_CHARS)
    .trim();
}

function filterOutDatesAndTimes(text) {
  if (!text) return '';
  let out = text;

  out = out.replace(/\b\d{1,2}:\d{2}(:\d{2})?(\s*([AP]\.?M\.?))?\b/gi, ' ');
  out = out.replace(/\b\d{4}[-/. ]\d{1,2}[-/. ]\d{1,2}\b/g, ' ');
  out = out.replace(/\b\d{1,2}[-/. ]\d{1,2}[-/. ]\d{2,4}\b/g, ' ');
  // Pelne wsparcie dla polskich znakow i nazewnictwa Unicode
  out = out.replace(/\b(\d{1,2}\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Sty|Lut|Mar|Kwi|Maj|Cze|Lip|Sie|Wrz|Pa\u017A|Paz|Lis|Gru)[\p{L}]*((\s+\d{2,4})|\b(\s+\d{2,4})?)/giu, ' ');

  return out.replace(/\s+/g, ' ').trim();
}

function looksLikeLoginRedirect(originalUrl, finalUrl) {
  const re = /(^|[\/._-])(log-?in|sign-?in|sso|auth|logowanie|zaloguj)([\/._-]|$)/i;
  try {
    const o = new URL(originalUrl);
    const f = new URL(finalUrl);
    if (o.href === f.href) return false;
    if (re.test(o.hostname + o.pathname)) return false;
    return re.test(f.hostname + f.pathname);
  } catch (e) {
    return false;
  }
}

async function readTextLimited(response) {
  const tooLarge = () => new Error(`Response too large (over ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB)`);

  const declared = Number(response.headers && response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) throw tooLarge();

  if (!response.body || !response.body.getReader) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw tooLarge();
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function targetKey(site) {
  return JSON.stringify([site.url, site.requireCookies !== false, site.ignoreDates !== false]);
}

function patchSite(siteId, patch) {
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const idx = sites.findIndex((s) => s.id === siteId);
    if (idx === -1) return false;
    sites[idx] = { ...sites[idx], ...patch };
    await chrome.storage.local.set({ sites });
    return true;
  });
}

async function fetchHtml(url, requireCookies, signal, conditional) {
  const headers = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  // Warunkowe żądanie (ETag / Last-Modified): jeśli serwer to wspiera i
  // potwierdzi brak zmian odpowiedzią 304, oszczędzamy transfer i czas.
  if (conditional && conditional.etag) headers['If-None-Match'] = conditional.etag;
  if (conditional && conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified;

  const response = await fetch(url, {
    method: 'GET',
    headers,
    cache: 'no-cache',
    credentials: requireCookies !== false ? 'include' : 'omit',
    signal
  });

  const etag = (response.headers && response.headers.get('etag')) || null;
  const lastModified = (response.headers && response.headers.get('last-modified')) || null;

  if (response.status === 304) {
    return { notModified: true, etag, lastModified };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (response.redirected && looksLikeLoginRedirect(url, response.url)) {
    throw new Error('Redirected to a login page (session expired?)');
  }

  const text = await readTextLimited(response);
  return { notModified: false, text, etag, lastModified };
}

function normalizeContent(htmlText, ignoreDates) {
  let content = cleanHtmlSimple(htmlText);
  if (ignoreDates !== false) {
    content = filterOutDatesAndTimes(content);
  }
  return content;
}

async function notifyChange(site, lang) {
  const notifTitle = lang === 'pl' ? 'Zmiana wykryta!' : 'Change detected!';
  const notifMsg = lang === 'pl'
    ? `Strona "${site.name}" została zaktualizowana.`
    : `Web page "${site.name}" has been updated.`;

  const uniqueNotifId = `${NOTIFICATION_PREFIX}${site.id}_${Date.now()}`;

  await chrome.notifications.create(uniqueNotifId, {
    type: 'basic',
    iconUrl: 'icon48.png',
    title: notifTitle,
    message: notifMsg
  });
}

function commitCheck(siteId, expected, newHash, fetchResult) {
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const idx = sites.findIndex((s) => s.id === siteId);
    if (idx === -1) return null;

    const cur = sites[idx];
    if (targetKey(cur) !== targetKey(expected)) return null;

    let status = 'baseline';
    if (cur.hashMode === HASH_MODE && cur.lastHash) {
      status = cur.lastHash === newHash ? 'unchanged' : 'changed';
    }

    // U1: przy wykrytej zmianie przesuwamy dotychczasowy lastSnapshot do
    // prevSnapshot — diff.html porówna te dwie wersje. Przy 'unchanged'
    // po prostu odświeżamy bieżący snapshot (treść jest identyczna lub
    // zmieniła się tylko w sposobie renderowania, a hasz odpowiada).
    const snapshotText = (fetchResult && fetchResult.snapshotText) || '';
    const changed = status === 'changed';

    sites[idx] = {
      ...cur,
      lastHash: newHash,
      hashMode: HASH_MODE,
      etag: (fetchResult && fetchResult.etag) || null,
      lastModified: (fetchResult && fetchResult.lastModified) || null,
      lastCheckTime: Date.now(),
      lastAttemptTime: Date.now(),
      lastError: null,
      hasChanged: cur.hasChanged || changed,
      prevSnapshot: changed ? (cur.lastSnapshot || cur.prevSnapshot || '') : (cur.prevSnapshot || ''),
      lastSnapshot: snapshotText,
      changedAt: changed ? Date.now() : (cur.changedAt || null)
    };
    await chrome.storage.local.set({ sites });
    return { status, site: sites[idx] };
  });
}

// Serwer potwierdził odpowiedzią 304, że treść się nie zmieniła — nie było
// więc czego haszować ani snapshotować. Odświeżamy tylko znaczniki czasu
// i (jeśli serwer je odesłał) świeże wartości ETag/Last-Modified.
function commitNotModified(siteId, expected, fetchResult) {
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const idx = sites.findIndex((s) => s.id === siteId);
    if (idx === -1) return null;

    const cur = sites[idx];
    if (targetKey(cur) !== targetKey(expected)) return null;

    sites[idx] = {
      ...cur,
      etag: fetchResult.etag || cur.etag || null,
      lastModified: fetchResult.lastModified || cur.lastModified || null,
      lastCheckTime: Date.now(),
      lastAttemptTime: Date.now(),
      lastError: null
    };
    await chrome.storage.local.set({ sites });
    return { status: 'unchanged', site: sites[idx] };
  });
}

async function checkSite(siteId) {
  if (inFlight.has(siteId)) return { status: 'busy' };
  inFlight.add(siteId);
  try {
    return await runCheck(siteId);
  } finally {
    inFlight.delete(siteId);
  }
}

async function runCheck(siteId) {
  const data = await chrome.storage.local.get(['sites', 'language']);
  const lang = data.language || detectLanguage();
  const site = (data.sites || []).find((s) => s.id === siteId);

  if (!site || site.isPaused) return { status: 'skipped' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Warunkowe nagłówki (ETag / Last-Modified) wysyłamy tylko, gdy mamy już
    // ustaloną bazę porównania (lastHash z aktualnego trybu haszowania) —
    // inaczej odpowiedź 304 nie miałaby się do czego "unchanged" odnieść.
    const canUseConditional = site.hashMode === HASH_MODE && Boolean(site.lastHash);
    const conditional = canUseConditional
      ? { etag: site.etag || null, lastModified: site.lastModified || null }
      : null;

    const fetchResult = await fetchHtml(site.url, site.requireCookies, controller.signal, conditional);

    // Snapshot do podglądu zmian (U1) — liczony tylko przy pełnym pobraniu;
    // przy 304 treść jest z definicji niezmieniona, snapshot zostaje stary.
    if (!fetchResult.notModified) {
      fetchResult.snapshotText = cleanHtmlStructured(fetchResult.text);
    }

    let result;
    if (fetchResult.notModified) {
      result = await commitNotModified(siteId, site, fetchResult);
    } else {
      const normalized = normalizeContent(fetchResult.text, site.ignoreDates);
      const hash = await sha256(normalized);
      result = await commitCheck(siteId, site, hash, fetchResult);
    }

    if (!result) return { status: 'skipped' };

    if (result.status === 'changed' && result.site.enableNotifications !== false) {
      // Błąd samego API powiadomień nie powinien zamieniać poprawnie
      // wykrytej zmiany w status "error" całego sprawdzenia.
      try {
        await notifyChange(site, lang);
      } catch (notifyErr) {
        console.warn('[Monitor] Could not show notification:', notifyErr);
      }
    }

    // Badge celowo NIE jest tu aktualizowany — robi to wywołujący
    // (checkNow / alarm / runBatch), żeby batch nie robił 50 zbędnych
    // odczytów storage.
    return { status: result.status };
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'Timeout'
      : (error && error.message) || String(error);
    console.error(`[Monitor] Error fetching ${site.name}:`, error);
    await patchSite(siteId, { lastError: message, lastAttemptTime: Date.now() });
    return { status: 'error', error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function runBatch(ids) {
  const summary = { total: ids.length, changed: 0, unchanged: 0, baseline: 0, errors: 0, skipped: 0 };

  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      let result;
      try {
        result = await checkSite(id);
      } catch (e) {
        result = { status: 'error' };
      }
      switch (result && result.status) {
        case 'changed': summary.changed++; break;
        case 'unchanged': summary.unchanged++; break;
        case 'baseline': summary.baseline++; break;
        case 'error': summary.errors++; break;
        default: summary.skipped++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_ALL_CONCURRENCY, ids.length) }, worker));

  // Badge raz na cały batch, a nie po każdym checku.
  await updateBadge();
  return summary;
}

let checkAllPromise = null;

function checkAllSites() {
  if (checkAllPromise) return checkAllPromise;

  checkAllPromise = (async () => {
    const data = await chrome.storage.local.get('sites');
    const ids = (data.sites || []).filter((s) => !s.isPaused).map((s) => s.id);
    const summary = await runBatch(ids);
    return { ok: true, ...summary };
  })().finally(() => { checkAllPromise = null; });

  return checkAllPromise;
}

// Sprawdza tylko podany zestaw stron (np. świeżo zaimportowanych z kopii
// zapasowej), zamiast całej listy — żeby po przywróceniu backupu nie trzeba
// było czekać do pierwszego alarmu (do 24h) na pierwszy realny wynik.
async function checkSpecificSites(siteIds) {
  const ids = Array.isArray(siteIds) ? siteIds.map(String) : [];
  if (ids.length === 0) return { ok: true, total: 0, changed: 0, unchanged: 0, baseline: 0, errors: 0, skipped: 0 };
  const summary = await runBatch(ids);
  return { ok: true, ...summary };
}

async function refreshSiteSilently(siteId) {
  await patchSite(siteId, { hasChanged: false });
  await updateBadge();
}

async function updateBadge() {
  const data = await chrome.storage.local.get('sites');
  const sites = data.sites || [];
  const changedCount = sites.filter((s) => s.hasChanged && !s.isPaused).length;

  if (changedCount > 0) {
    chrome.action.setBadgeText({ text: changedCount.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch (e) {
    return null;
  }
}

function siteIdentity(url) {
  try {
    return new URL(url).href;
  } catch (e) {
    return url;
  }
}

async function releaseUnusedOrigins(urls) {
  const data = await chrome.storage.local.get('sites');
  const inUse = new Set((data.sites || []).map((s) => originPattern(s.url)).filter(Boolean));

  for (const pattern of new Set(urls.map(originPattern).filter(Boolean))) {
    if (inUse.has(pattern)) continue;
    try {
      await chrome.permissions.remove({ origins: [pattern] });
    } catch (e) {
      console.warn('[Monitor] Could not remove permission', pattern, e);
    }
  }
}

function newSiteId() {
  // crypto.randomUUID() zamiast Date.now()+random: brak kolizji nawet przy
  // imporcie wielu stron w tej samej milisekundzie.
  return crypto.randomUUID();
}

function sanitizeSiteInput(raw) {
  const s = raw || {};
  const name = String(s.name || '').trim().slice(0, 100);
  const url = String(s.url || '').trim().slice(0, 2000);

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  if (!name || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;

  const requireCookies = Boolean(s.requireCookies);
  // Zabezpieczenie także po stronie tła: dotąd blokadę http:// + ciasteczka
  // egzekwował wyłącznie popup.js. Import z kopii zapasowej (starej lub
  // spreparowanej) omijał tę ścieżkę, więc powtarzamy sprawdzenie tutaj.
  if (parsed.protocol === 'http:' && requireCookies) return null;

  let freqIndex = parseInt(s.freqIndex, 10);
  if (!(freqIndex >= 0 && freqIndex < FREQ_MAP.length)) freqIndex = 2;

  return {
    name,
    url,
    freqIndex,
    ignoreDates: Boolean(s.ignoreDates),
    requireCookies,
    enableNotifications: Boolean(s.enableNotifications)
  };
}

async function handleSaveSite(msg) {
  const raw = (msg && msg.site) || {};
  const input = sanitizeSiteInput(raw);
  if (!input) return { ok: false, error: 'invalid' };

  const id = raw.id ? String(raw.id) : '';

  const outcome = await withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const idx = id ? sites.findIndex((s) => s.id === id) : -1;

    if (id && idx === -1) return { ok: false, error: 'notFound' };

    const identity = siteIdentity(input.url);
    if (sites.some((s, i) => i !== idx && siteIdentity(s.url) === identity)) {
      return { ok: false, error: 'duplicate' };
    }
    if (idx === -1 && sites.length >= MAX_SITES) {
      return { ok: false, error: 'limit' };
    }

    const fields = {
      name: input.name,
      url: input.url,
      freqIndex: input.freqIndex,
      ignoreDates: input.ignoreDates,
      requireCookies: input.requireCookies,
      enableNotifications: input.enableNotifications
    };

    let siteId;
    let needsBaseline = false;
    let oldUrl = null;

    if (idx !== -1) {
      const cur = sites[idx];
      const before = targetKey(cur);
      oldUrl = cur.url;
      Object.assign(cur, fields);

      if (targetKey(cur) !== before) {
        Object.assign(cur, {
          lastHash: '',
          hashMode: '',
          etag: null,
          lastModified: null,
          lastCheckTime: null,
          lastError: null,
          hasChanged: false,
          prevSnapshot: '',
          lastSnapshot: '',
          changedAt: null
        });
        needsBaseline = !cur.isPaused;
      }
      siteId = cur.id;
    } else {
      siteId = newSiteId();
      sites.push({
        id: siteId,
        ...fields,
        isPaused: false,
        hasChanged: false,
        lastHash: '',
        hashMode: '',
        etag: null,
        lastModified: null,
        lastError: null,
        lastCheckTime: null,
        prevSnapshot: '',
        lastSnapshot: '',
        changedAt: null
      });
      needsBaseline = true;
    }

    await chrome.storage.local.set({ sites });
    return { ok: true, siteId, needsBaseline, oldUrl };
  });

  if (!outcome.ok) {
    await releaseUnusedOrigins([input.url]);
    return outcome;
  }

  if (outcome.oldUrl && outcome.oldUrl !== input.url) {
    await releaseUnusedOrigins([outcome.oldUrl]);
  }
  await setupAlarms();
  return { ok: true, siteId: outcome.siteId, needsBaseline: outcome.needsBaseline };
}

async function handleImportSites(msg) {
  const incoming = Array.isArray(msg && msg.sites) ? msg.sites : [];
  if (incoming.length === 0) return { ok: false };

  const outcome = await withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const seen = new Set(sites.map((s) => siteIdentity(s.url)));

    const addedOrigins = [];
    const addedIds = [];
    // Zliczamy pominięte wpisy z podziałem na przyczynę, żeby UI mogło
    // pokazać coś bardziej użytecznego niż gołą liczbę "pominięto: 7".
    const skippedByReason = { limit: 0, invalid: 0, duplicate: 0 };

    for (const raw of incoming) {
      if (sites.length >= MAX_SITES) { skippedByReason.limit++; continue; }

      const input = sanitizeSiteInput(raw);
      if (!input) { skippedByReason.invalid++; continue; }

      const identity = siteIdentity(input.url);
      if (seen.has(identity)) { skippedByReason.duplicate++; continue; }
      seen.add(identity);

      const siteId = newSiteId();
      sites.push({
        id: siteId,
        ...input,
        isPaused: false,
        hasChanged: false,
        lastHash: '',
        hashMode: '',
        etag: null,
        lastModified: null,
        lastError: null,
        lastCheckTime: null,
        prevSnapshot: '',
        lastSnapshot: '',
        changedAt: null
      });

      let urlObj;
      try { urlObj = new URL(input.url); } catch (e) { urlObj = null; }
      if (urlObj) addedOrigins.push(`${urlObj.protocol}//${urlObj.host}/*`);
      addedIds.push(siteId);
    }

    const skippedCount = skippedByReason.limit + skippedByReason.invalid + skippedByReason.duplicate;
    await chrome.storage.local.set({ sites });
    return { addedCount: addedIds.length, skippedCount, skippedByReason, origins: [...new Set(addedOrigins)], addedIds };
  });

  await setupAlarms();
  return { ok: true, ...outcome };
}

async function handleToggleSite(msg) {
  const siteId = String((msg && msg.siteId) || '');
  const ok = await withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const idx = sites.findIndex((s) => s.id === siteId);
    if (idx === -1) return false;
    sites[idx].isPaused = !sites[idx].isPaused;
    await chrome.storage.local.set({ sites });
    return true;
  });
  await setupAlarms();
  return { ok };
}

async function handleDeleteSite(msg) {
  const siteId = String((msg && msg.siteId) || '');
  const removedUrl = await withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const site = sites.find((s) => s.id === siteId);
    if (!site) return null;
    await chrome.storage.local.set({ sites: sites.filter((s) => s.id !== siteId) });
    return site.url;
  });

  if (removedUrl) await releaseUnusedOrigins([removedUrl]);
  await setupAlarms();
  return { ok: removedUrl !== null };
}

async function handleReorderSites(msg) {
  const order = Array.isArray(msg && msg.order) ? msg.order.map(String) : [];
  await withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    const byId = new Map(sites.map((s) => [s.id, s]));

    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    const listed = new Set(reordered.map((s) => s.id));
    sites.forEach((s) => {
      if (!listed.has(s.id)) reordered.push(s);
    });

    await chrome.storage.local.set({ sites: reordered });
  });
  return { ok: true };
}