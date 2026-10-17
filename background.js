const FREQ_MAP = [1, 5, 10, 60, 1440];
const FETCH_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SITES = 50;
const CHECK_ALL_CONCURRENCY = 3;
const NOTIFICATION_PREFIX = 'change_';
const HASH_MODE = 'v4';
const SNAPSHOT_MAX_CHARS = 150000;
const RENDER_LOAD_TIMEOUT_MS = 30000;
const RENDER_GRACE_MS = 2500;
const RENDER_MAX_WAIT_SELECTOR_MS = 10000; // wait for the selected element to appear
const RENDER_MAX_WAIT_BODY_MS = 5000;     // whole page: cap for pages whose text never settles
const RENDER_STABLE_MS = 600;             // text unchanged this long = rendering finished

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

// Od\u015bwie\u017camy tytu\u0142 pozycji menu przy zmianie j\u0119zyka w popupie, \u017ceby by\u0142
// aktualny nawet bez ponownego uruchamiania rozszerzenia.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.language) {
    updateContextMenu();
  }
});

const CONTEXT_MENU_MONITOR_ID = 'monitor-this-page';

function contextMenuTitle(lang) {
  return lang === 'pl' ? 'Monitoruj stron\u0119' : 'Monitor this page';
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
          // Ukrywa pozycj\u0119 na stronach chrome://, plikach lokalnych itp.
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_MONITOR_ID || !info.pageUrl) return;

  // Zapisujemy tylko URL (z timestampem do wygaszenia po czasie) \u2014 nazw\u0119
  // strony popup zaproponuje sam na podstawie hosta.
  await chrome.storage.local.set({
    pendingAdd: { url: info.pageUrl, title: String((tab && tab.title) || '').slice(0, 200), ts: Date.now() }
  });

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
    const data = await chrome.storage.local.get('language');
    const lang = data.language || detectLanguage();
    chrome.notifications.create(`pendingadd_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: lang === 'pl' ? 'Gotowe do dodania' : 'Ready to add',
      message: lang === 'pl'
        ? 'Kliknij ikon\u0119 rozszerzenia, aby doko\u0144czy\u0107 dodawanie strony.'
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
  // Pojedynczy check: aktualizujemy badge od razu, bo u\u017cytkownik patrzy
  // na wynik tej konkretnej strony. W batchu badge liczony jest raz na
  // ko\u0144cu \u2014 patrz runBatch().
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
  undoDelete: (msg) => handleUndoDelete(msg),
  markAllRead: async () => handleMarkAllRead(),
  reorderSites: (msg) => handleReorderSites(msg),
  updateGroup: (msg) => handleUpdateGroup(msg),
  ungroup: (msg) => handleUngroup(msg),
  markSitesRead: (msg) => handleMarkSitesRead(msg),
  checkAll: () => checkAllSites(),
  importSites: (msg) => handleImportSites(msg),
  previewSite: (msg) => handlePreviewSite(msg),
  grantDone: (msg, sender) => handleGrantDone(msg, sender),
  startPicker: (msg) => handleStartPicker(msg),
  pickerPicked: (msg, sender) => handlePickerPicked(msg, sender),
  pickerCancelled: (msg, sender) => handlePickerCancelled(msg, sender)
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  const handler = msg && Object.hasOwn(HANDLERS, msg.action) ? HANDLERS[msg.action] : null;
  if (!handler) return;

  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[Monitor] Handler error:', err);
      sendResponse({ ok: false, status: 'error', error: String((err && err.message) || err) });
    });
  return true;
});

const MAX_CUSTOM_MINUTES = 10080; // 7 days
const MIN_RENDERED_MINUTES = 5;

// Effective check interval: a custom value typed by the user wins over the preset.
function siteIntervalMinutes(site) {
  const custom = Number(site.freqMinutes);
  if (Number.isInteger(custom) && custom >= 1 && custom <= MAX_CUSTOM_MINUTES) return custom;
  return FREQ_MAP[site.freqIndex] || 1;
}

async function setupAlarms() {
  const [data, existing] = await Promise.all([
    chrome.storage.local.get('sites'),
    chrome.alarms.getAll()
  ]);
  const sites = data.sites || [];

  const wanted = new Map();
  for (const site of sites) {
    if (site.isPaused) continue;
    wanted.set(`check_${site.id}`, siteIntervalMinutes(site));
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

  // Je\u015bli zmiana jest nieodczytana \u2014 otwieramy podgl\u0105d diffa zamiast samej
  // strony; po zamkni\u0119ciu diffa / przy odczycie otwieramy "otwieran\u0105 stron\u0119"
  // (site.openUrl), nie surowy URL monitorowany (mo\u017ce by\u0107 endpointem JSON).
  const url = site.hasChanged
    ? chrome.runtime.getURL('diff.html') + '#' + site.id
    : (site.openUrl || site.url);

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

// Wersja do PODGL\u0104DU ZMIAN (U1): w przeciwie\u0144stwie do cleanHtmlSimple
// zachowuje struktur\u0119 linii \u2014 tagi blokowe staj\u0105 si\u0119 separatorami \n.
// Dzi\u0119ki temu diff por\u00f3wnuje akapity/kom\u00f3rki jako linie, a nie jeden
// zwini\u0119ty ci\u0105g tekstu. Snapshot jest trzymany ODR\u0118BNIE od hasha
// (lastHash liczony jest nadal z cleanHtmlSimple, wi\u0119c baseline si\u0119
// nie psuje przy aktualizacji rozszerzenia).
const SNAPSHOT_BLOCK_TAGS = 'p|div|br|li|tr|td|th|section|article|header|footer|nav|aside|h[1-6]|blockquote|ul|ol|table|figure|figcaption|dt|dd|hr|form|main';

function cleanHtmlStructured(htmlText) {
  if (!htmlText) return '';

  // B1: odpowiedzi JSON (monitorowane endpointy XHR) to jedna minifikowana
  // linia \u2014 diff z niej by\u0142by \u201e\u015bcian\u0105 tekstu". Pretty-print rozbija ka\u017cdy
  // klucz i warto\u015b\u0107 na osobn\u0105 lini\u0119, dzi\u0119ki czemu LCS ma co por\u00f3wnywa\u0107.
  // Niepoprawny JSON spada do \u015bcie\u017cki HTML poni\u017cej.
  const trimmed = htmlText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
        .slice(0, SNAPSHOT_MAX_CHARS)
        .trim();
    } catch (e) {
      // niepoprawny JSON \u2014 traktuj jak HTML
    }
  }
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
  out = out.replace(/\b(\d{1,2}\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Sty|Lut|Kwi|Maj|Cze|Lip|Sie|Wrz|Pa\u017A|Paz|Lis|Gru)[\p{L}]*(\s+\d{2,4})?\b/giu, ' ');

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
  // selector is part of the key: changing it changes what is hashed, so the
  // baseline must be reset (otherwise the first check reports a false change).
  return JSON.stringify([site.url, site.requireCookies !== false, site.ignoreDates !== false, site.renderMode === 'rendered', site.selector || '']);
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

// --- Fast mode + CSS selector ---
// The service worker has no DOMParser, so the fetched HTML is parsed in an
// offscreen document (offscreen.js), which returns only the matched fragment.
let offscreenCreating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Extract the monitored fragment (CSS selector) from fetched HTML'
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function extractFragment(html, selector) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'extractFragment', html, selector });
  if (!res || !res.ok) throw new Error('Invalid selector');
  if (!res.found) throw new Error('Selector not found in page source (JS-drawn content? enable rendered mode)');
  return res.html;
}

async function fetchHtml(url, requireCookies, signal, conditional) {
  const headers = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  // Warunkowe \u017c\u0105danie (ETag / Last-Modified): je\u015bli serwer to wspiera i
  // potwierdzi brak zmian odpowiedzi\u0105 304, oszcz\u0119dzamy transfer i czas.
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

// --- Rendered-page mode (JS-rendered sites) ---
// Opens the page in a hidden tab, lets its JavaScript run, then reads
// document.body.innerText. This is the only reliable way to monitor
// content that XHR draws client-side (e.g. tournamentsoftware draws).
// One hidden tab at a time (rendererBusy) to cap memory/CPU usage.

let rendererBusy = Promise.resolve();

// Note: rendered mode ALWAYS uses the browser session (cookies included) -
// chrome.tabs.create cannot open an isolated/cookieless context. The UI
// communicates this and saveSite forces requireCookies=true for this mode.
function fetchRendered(url, requireCookies, selector) {
  // Serialize: every rendered check waits for the previous one.
  const run = rendererBusy.then(() => fetchRenderedInner(url, requireCookies, selector));
  // Keep the queue alive even if one check fails.
  rendererBusy = run.then(() => undefined, () => undefined);
  return run;
}

async function fetchRenderedInner(url, requireCookies, selector) {
  let tabId = null;
  let windowId = null;
  try {
    // Preferred: a separate MINIMIZED window, so nothing appears in the tab
    // strip of the user's current window and no focus is stolen. Fallback
    // (window creation refused): a background tab, as before.
    try {
      const win = await chrome.windows.create({ url, state: 'minimized', focused: false });
      windowId = win.id;
      tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
      if (tabId == null) {
        const tabs = await chrome.tabs.query({ windowId });
        tabId = tabs[0] ? tabs[0].id : null;
      }
    } catch (e) {
      windowId = null;
      tabId = null;
    }
    if (tabId == null) {
      tabId = (await chrome.tabs.create({ url, active: false })).id;
    }

    // P1 (audit): single cleanup path - removes the listener AND the timer
    // whether the tab completes, the timeout fires, or the tab dies early.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (tabId_, info) => {
        if (tabId_ === tabId && info.status === 'complete') finish();
      };
      const timer = setTimeout(finish, RENDER_LOAD_TIMEOUT_MS);
      chrome.tabs.onUpdated.addListener(listener);
    });
    // The tab may have been closed by the user or the browser meanwhile -
    // verify it still exists before injecting the script.
    try { await chrome.tabs.get(tabId); }
    catch (e) { throw new Error('Tab closed before reading'); }

    // Smart wait instead of a fixed pause: poll the page until the text (of
    // the selected fragment, or of <body>) is non-empty and has stopped
    // changing for RENDER_STABLE_MS, with an upper cap. Fast pages finish in
    // about a second; slow ones get up to the cap instead of a false error.
    // A returned promise is awaited by executeScript.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, maxMs, stableMs) => new Promise((resolve) => {
        const start = Date.now();
        let last = null;
        let lastChange = start;
        const read = () => {
          const root = sel ? document.querySelector(sel) : document.body;
          return root ? (root.innerText || '') : null;
        };
        const tick = () => {
          const cur = read();
          const now = Date.now();
          if (cur !== last) { last = cur; lastChange = now; }
          if (cur !== null && cur.trim() !== '' && now - lastChange >= stableMs) return resolve(cur);
          if (now - start >= maxMs) return resolve(cur); // null = selector never appeared
          setTimeout(tick, 200);
        };
        tick();
      }),
      args: [selector || null, selector ? RENDER_MAX_WAIT_SELECTOR_MS : RENDER_MAX_WAIT_BODY_MS, RENDER_STABLE_MS],
      // Default ISOLATED world is enough to read innerText and safer than MAIN.
    });
    // null = selector matched nothing: an error, never an empty snapshot
    // (never commit a bogus "change").
    const text = (results && results[0] && results[0].result) || '';
    if (selector && results && results[0] && results[0].result === null) {
      throw new Error('Selector not found on page');
    }
    if (!text.trim()) throw new Error('Rendered page produced no text');
    return { notModified: false, text, etag: null, lastModified: null };
  } finally {
    if (windowId !== null) {
      try { await chrome.windows.remove(windowId); } catch (e) { /* already gone */ }
    } else if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (e) { /* already gone */ }
    }
  }
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
    ? `Strona "${site.name}" zosta\u0142a zaktualizowana.`
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
    // prevSnapshot \u2014 diff.html por\u00f3wna te dwie wersje. Przy 'unchanged'
    // po prostu od\u015bwie\u017camy bie\u017c\u0105cy snapshot.
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
      suggestRendered: Boolean(fetchResult && fetchResult.suggestRendered),
      prevSnapshot: changed ? (cur.lastSnapshot || cur.prevSnapshot || '') : (cur.prevSnapshot || ''),
      lastSnapshot: snapshotText,
      changedAt: changed ? Date.now() : (cur.changedAt || null)
    };
    await chrome.storage.local.set({ sites });
    return { status, site: sites[idx] };
  });
}

// Serwer potwierdzi\u0142 odpowiedzi\u0105 304, \u017ce tre\u015b\u0107 si\u0119 nie zmieni\u0142a \u2014 nie by\u0142o
// wi\u0119c czego haszowa\u0107 ani snapshotowa\u0107. Od\u015bwie\u017camy tylko znaczniki czasu
// i \u015bwie\u017ce warto\u015bci ETag/Last-Modified.
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
    const canUseConditional = site.hashMode === HASH_MODE && Boolean(site.lastHash);
    const conditional = canUseConditional
      ? { etag: site.etag || null, lastModified: site.lastModified || null }
      : null;

    // Rendered mode: read the page as the user SEES it (hidden tab + JS).
    // Fast mode (default): plain fetch of the server response.
    const fetchResult = site.renderMode === 'rendered'
      ? await fetchRendered(site.url, site.requireCookies, site.selector)
      : await fetchHtml(site.url, site.requireCookies, controller.signal, conditional);

    // Fast mode + selector: keep only the matched fragment of the fetched HTML.
    if (site.renderMode !== 'rendered' && site.selector && !fetchResult.notModified) {
      fetchResult.text = await extractFragment(fetchResult.text, site.selector);
    }

    // Snapshot do podgl\u0105du zmian (U1) \u2014 liczony tylko przy pe\u0142nym pobraniu;
    // przy 304 tre\u015b\u0107 jest z definicji niezmieniona, snapshot zostaje stary.
    if (!fetchResult.notModified) {
      fetchResult.snapshotText = site.renderMode === 'rendered' ? fetchResult.text : cleanHtmlStructured(fetchResult.text);
    }

    let result;
    // Heuristic: readable text is nearly empty (short nav is fine) while the
    // raw HTML is not a stub. A JS-rendered page returns a shell whose cleaned
    // text is a tiny fraction of the markup. Measured on a real SPA: 33 chars
    // of text from >500 chars of raw HTML.
    const rawLen = (fetchResult.text || '').length;
    const textLen = (fetchResult.snapshotText || '').length;
    fetchResult.suggestRendered =
      fetchResult.notModified === false &&
      site.renderMode !== 'rendered' &&
      !site.selector &&
      rawLen > 500 &&
      textLen < 500;
    if (fetchResult.notModified) {
      result = await commitNotModified(siteId, site, fetchResult);
    } else {
      const normalized = site.renderMode === 'rendered' ? (site.ignoreDates !== false ? filterOutDatesAndTimes(fetchResult.text) : fetchResult.text) : normalizeContent(fetchResult.text, site.ignoreDates);
      const hash = await sha256(normalized);
      result = await commitCheck(siteId, site, hash, fetchResult);
    }

    if (!result) return { status: 'skipped' };

    if (result.status === 'changed' && result.site.enableNotifications !== false) {
      try {
        await notifyChange(site, lang);
      } catch (notifyErr) {
        console.warn('[Monitor] Could not show notification:', notifyErr);
      }
    }

    // Badge celowo NIE jest tu aktualizowany \u2014 robi to wywo\u0142uj\u0105cy
    // (checkNow / alarm / runBatch), \u017ceby batch nie robi\u0142 50 zb\u0119dnych
    // odczyt\u00f3w storage.
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

  // Badge raz na ca\u0142y batch, a nie po ka\u017cdym checku.
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
  // Zabezpieczenie tak\u017ce po stronie t\u0142a: blokada http:// + ciasteczka
  // egzekwowana te\u017c tutaj (import z backupu omija popup.js).
  if (parsed.protocol === 'http:' && requireCookies) return null;

  let freqIndex = parseInt(s.freqIndex, 10);
  if (!(freqIndex >= 0 && freqIndex < FREQ_MAP.length)) freqIndex = 2;

  // "Otwierana strona": URL otwierany po klikni\u0119ciu karty/powiadomienia.
  // Pozwala monitorowa\u0107 endpoint API (JSON/XHR), a otwiera\u0107 czytelny
  // widok dla cz\u0142owieka. Puste lub nieprawid\u0142owe -> fallback na URL
  // monitorowany. Celowo NIE wchodzi do targetKey (nie wp\u0142ywa na hasz).
  let openUrl = String(s.openUrl || '').trim().slice(0, 2000);
  if (openUrl) {
    try {
      const p = new URL(openUrl);
      if (p.protocol !== 'http:' && p.protocol !== 'https:') openUrl = '';
    } catch (e) {
      openUrl = '';
    }
  }

  // Optional CSS selector: monitor only a fragment of the page (e.g. the
  // results table), not the whole body incl. navigation. Works in both
  // modes (fast mode parses the fetched HTML in an offscreen document).
  let selector = String(s.selector || '').trim().slice(0, 200);
  if (selector && !/^[a-zA-Z0-9 #.\[\]:\-_>"'=()~*,+|^$\\\/]+$/.test(selector)) {
    selector = '';
  }

  // Custom interval (minutes): whole number 1..7 days, else ignored (preset used).
  const renderMode = s.renderMode === 'rendered' ? 'rendered' : 'fast';
  const minMinutes = renderMode === 'rendered' ? MIN_RENDERED_MINUTES : 1;
  let freqMinutes = Number(s.freqMinutes);
  freqMinutes = Number.isInteger(freqMinutes) && freqMinutes >= 1 && freqMinutes <= MAX_CUSTOM_MINUTES
    ? Math.max(freqMinutes, minMinutes)
    : null;
  // Rendered mode opens a real window: no 1-minute preset either.
  if (renderMode === 'rendered' && !freqMinutes && FREQ_MAP[freqIndex] < MIN_RENDERED_MINUTES) freqIndex = 1;

  return {
    name,
    url,
    freqIndex,
    freqMinutes,
    ignoreDates: Boolean(s.ignoreDates),
    requireCookies,
    enableNotifications: Boolean(s.enableNotifications),
    renderMode,
    group: String(s.group || '').trim().slice(0, 60),
    selector,
    openUrl: openUrl || url
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
      freqMinutes: input.freqMinutes,
      ignoreDates: input.ignoreDates,
      requireCookies: input.requireCookies,
      enableNotifications: input.enableNotifications,
      // P1 (audit): rendered mode opens the page in a real tab, which always
      // uses the browser session/cookies - "omit cookies" cannot be honored.
      // Force the flag so no code path promises cookie-free monitoring here.
      requireCookies: input.renderMode === 'rendered' ? true : input.requireCookies,
      renderMode: input.renderMode,
      selector: input.selector,
      openUrl: input.openUrl
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
    const data = await chrome.storage.local.get(['sites', 'groups']);
    const sites = data.sites || [];
    const groups = data.groups || [];
    const seen = new Set(sites.map((s) => siteIdentity(s.url)));

    const addedOrigins = [];
    const addedIds = [];
    const skippedByReason = { limit: 0, invalid: 0, duplicate: 0 };

    for (const raw of incoming) {
      if (sites.length >= MAX_SITES) { skippedByReason.limit++; continue; }

      const input = sanitizeSiteInput(raw);
      if (!input) { skippedByReason.invalid++; continue; }

      const identity = siteIdentity(input.url);
      if (seen.has(identity)) { skippedByReason.duplicate++; continue; }
      seen.add(identity);

      const siteId = newSiteId();
      // Group by NAME (backups carry names): reuse a group with the same name or create one.
      const { group: groupName, ...fieldsOnly } = input;
      let groupId = null;
      if (groupName) {
        let g = groups.find((x) => x.name.toLowerCase() === groupName.toLowerCase());
        if (!g) {
          g = { id: newSiteId(), name: cleanGroupName(groupName), collapsed: false };
          groups.push(g);
        }
        groupId = g.id;
      }
      const record = {
        id: siteId,
        ...fieldsOnly,
        groupId,
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
      };
      // keep the group contiguous: insert after its last member
      let lastIdx = -1;
      if (groupId) sites.forEach((s, i) => { if (s.groupId === groupId) lastIdx = i; });
      if (lastIdx >= 0) sites.splice(lastIdx + 1, 0, record); else sites.push(record);

      let urlObj;
      try { urlObj = new URL(input.url); } catch (e) { urlObj = null; }
      if (urlObj) addedOrigins.push(`${urlObj.protocol}//${urlObj.host}/*`);
      addedIds.push(siteId);
    }

    const skippedCount = skippedByReason.limit + skippedByReason.invalid + skippedByReason.duplicate;
    await chrome.storage.local.set({ sites, groups });
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
    const data = await chrome.storage.local.get(['sites', 'groups']);
    const sites = data.sites || [];
    const site = sites.find((s) => s.id === siteId);
    if (!site) return null;
    const rest = sites.filter((s) => s.id !== siteId);
    const groups = pruneGroups(rest, data.groups || []); // a group left empty disappears
    await chrome.storage.local.set({ sites: rest, groups });
    return site.url;
  });

  if (removedUrl) await releaseUnusedOrigins([removedUrl]);
  await setupAlarms();
  return { ok: removedUrl !== null };
}

// I2: restores a site deleted moments ago (the popup keeps the full record
// in RAM until the user lets the summary hide). Reinserts the original object
// (with snapshots and change state) at the original list position.
async function handleUndoDelete(msg) {
  const site = msg && msg.site;
  if (!site || typeof site !== 'object' || !site.id || !site.url) {
    return { ok: false, error: 'invalid' };
  }
  const index = Number.isInteger(msg.index) ? msg.index : -1;

  const outcome = await withStorageLock(async () => {
    const data = await chrome.storage.local.get(['sites', 'groups']);
    const sites = data.sites || [];

    // Undo is best-effort: if the record reappeared meanwhile, treat as done.
    if (sites.some((s) => s.id === site.id)) return { ok: true, origins: [] };

    if (sites.some((s) => siteIdentity(s.url) === siteIdentity(site.url))) {
      return { ok: false, error: 'duplicate' };
    }
    if (sites.length >= MAX_SITES) return { ok: false, error: 'limit' };

    // Basic sanitation of text fields; the record comes from this extension's
    // own storage, so full sanitizeSiteInput (which would drop snapshots) is
    // deliberately not applied here.
    const copy = { ...site };
    copy.name = String(copy.name || '').slice(0, 100);
    copy.url = String(copy.url || '').slice(0, 2000);

    const inserted = [...sites];
    if (index >= 0 && index <= inserted.length) inserted.splice(index, 0, copy);
    else inserted.push(copy);

    // Restore the page into its group; recreate the group if it vanished
    // together with its last page (the popup sends the group record).
    let groups = data.groups || [];
    if (copy.groupId && !groups.some((g) => g.id === copy.groupId)) {
      const g = msg.group;
      if (g && g.id === copy.groupId) {
        groups = [...groups, { id: String(g.id), name: cleanGroupName(g.name), collapsed: Boolean(g.collapsed) }];
      } else {
        copy.groupId = null;
      }
    }
    await chrome.storage.local.set({ sites: inserted, groups });
    return { ok: true, origins: [originPattern(copy.url)].filter(Boolean) };
  });

  await setupAlarms();
  await updateBadge(); // keep the badge in sync right after the restore
  return outcome;
}
// "Mark all as read": clears hasChanged on every site at once.
async function handleMarkAllRead() {
  await withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    let touched = false;
    for (const s of sites) {
      if (s.hasChanged) {
        s.hasChanged = false;
        touched = true;
      }
    }
    if (touched) await chrome.storage.local.set({ sites });
  });
  await updateBadge();
  return { ok: true };
}
// --- Groups ---
// storage.groups = [{ id, name, collapsed }]; site.groupId points into it.
// The sites array stays flat (its order is the display order).

function cleanGroupName(name) {
  return String(name || '').trim().slice(0, 60) || 'Group';
}

// Drops groups without members and clears dangling groupId references.
function pruneGroups(sites, groups) {
  const used = new Set(sites.map((s) => s.groupId).filter(Boolean));
  const kept = groups.filter((g) => used.has(g.id));
  const keptIds = new Set(kept.map((g) => g.id));
  sites.forEach((s) => {
    if (s.groupId && !keptIds.has(s.groupId)) s.groupId = null;
  });
  return kept;
}

// Accepts the new "layout" (ungrouped pages + groups in display order) or the
// legacy flat "order" list.
async function handleReorderSites(msg) {
  const layout = Array.isArray(msg && msg.layout) ? msg.layout : null;
  const order = Array.isArray(msg && msg.order) ? msg.order.map(String) : [];

  await withStorageLock(async () => {
    const data = await chrome.storage.local.get(['sites', 'groups']);
    const sites = data.sites || [];
    const byId = new Map(sites.map((s) => [s.id, s]));

    if (!layout) {
      const reordered = order.map((id) => byId.get(id)).filter(Boolean);
      const listed = new Set(reordered.map((s) => s.id));
      sites.forEach((s) => {
        if (!listed.has(s.id)) reordered.push(s);
      });
      await chrome.storage.local.set({ sites: reordered });
      return;
    }

    const oldGroups = new Map((data.groups || []).map((g) => [g.id, g]));
    const seen = new Set();
    const ordered = [];
    const groupList = [];

    const take = (id, groupId) => {
      const s = byId.get(String(id));
      if (!s || seen.has(s.id)) return false;
      seen.add(s.id);
      s.groupId = groupId;
      ordered.push(s);
      return true;
    };

    for (const item of layout) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'group' && Array.isArray(item.siteIds)) {
        const gid = String(item.id || '').slice(0, 64);
        if (!gid) continue;
        let any = false;
        for (const id of item.siteIds) any = take(id, gid) || any;
        if (any && !groupList.some((g) => g.id === gid)) {
          groupList.push(oldGroups.get(gid) || { id: gid, name: cleanGroupName(item.name), collapsed: false });
        }
      } else if (item.type === 'site') {
        take(item.id, null);
      }
    }

    // Pages missing from the layout keep their place at the end and their group.
    sites.forEach((s) => {
      if (!seen.has(s.id)) ordered.push(s);
    });
    const known = new Set(groupList.map((g) => g.id));
    ordered.forEach((s) => {
      if (s.groupId && !known.has(s.groupId) && oldGroups.has(s.groupId)) {
        groupList.push(oldGroups.get(s.groupId));
        known.add(s.groupId);
      }
    });

    const groups = pruneGroups(ordered, groupList);
    await chrome.storage.local.set({ sites: ordered, groups });
  });
  return { ok: true };
}

async function handleUpdateGroup(msg) {
  const id = String((msg && msg.id) || '');
  await withStorageLock(async () => {
    const data = await chrome.storage.local.get('groups');
    const groups = data.groups || [];
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    if (typeof msg.name === 'string' && msg.name.trim()) g.name = cleanGroupName(msg.name);
    if (typeof msg.collapsed === 'boolean') g.collapsed = msg.collapsed;
    await chrome.storage.local.set({ groups });
  });
  return { ok: true };
}

// Removes the group only; its pages stay in place on the list.
async function handleUngroup(msg) {
  const id = String((msg && msg.id) || '');
  await withStorageLock(async () => {
    const data = await chrome.storage.local.get(['sites', 'groups']);
    const sites = data.sites || [];
    sites.forEach((s) => { if (s.groupId === id) s.groupId = null; });
    const groups = (data.groups || []).filter((g) => g.id !== id);
    await chrome.storage.local.set({ sites, groups });
  });
  return { ok: true };
}

async function handleMarkSitesRead(msg) {
  const ids = new Set(Array.isArray(msg && msg.siteIds) ? msg.siteIds.map(String) : []);
  await withStorageLock(async () => {
    const data = await chrome.storage.local.get('sites');
    const sites = data.sites || [];
    let touched = false;
    sites.forEach((s) => {
      if (ids.has(s.id) && s.hasChanged) { s.hasChanged = false; touched = true; }
    });
    if (touched) await chrome.storage.local.set({ sites });
  });
  await updateBadge();
  return { ok: true };
}

// --- Element picker ("Pick element on the page...") ---
// The popup saves a pendingPicker record (url + siteId) and asks the
// background to open the page with the picker injected (the popup already
// requested the host permission - chrome.scripting needs it too). When the
// user clicks a fragment, the content script sends back the generated CSS
// selector; the background stores it in pendingPicker and closes the tab.
// The popup is closed at that point (the tab took focus), so on the next
// open it reads pendingPicker and re-opens the form with the selector filled.

function pickerHintText(lang) {
  return lang === 'pl'
    ? 'Kliknij fragment strony, kt\u00f3ry chcesz monitorowa\u0107. Esc anuluje.'
    : 'Click the part of the page you want to watch. Esc cancels.';
}

// "Test check" in the form: one throw-away check (nothing is stored) that shows
// what would actually be monitored, so mode/selector problems surface BEFORE saving.
async function handlePreviewSite(msg) {
  const input = sanitizeSiteInput({ name: 'preview', ...((msg && msg.site) || {}) });
  if (!input) return { ok: false, error: 'invalid' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const rendered = input.renderMode === 'rendered';
    let text;
    let suggestRendered = false;

    if (rendered) {
      text = (await fetchRendered(input.url, true, input.selector)).text || '';
    } else {
      const res = await fetchHtml(input.url, input.requireCookies, controller.signal, null);
      const rawLen = (res.text || '').length;
      const html = input.selector ? await extractFragment(res.text, input.selector) : res.text;
      text = cleanHtmlStructured(html);
      suggestRendered = !input.selector && rawLen > 500 && text.length < 500;
    }

    const lines = text ? text.split('\n') : [];
    const preview = lines.slice(0, 12)
      .map((l) => (l.length > 140 ? l.slice(0, 140) + '\u2026' : l))
      .join('\n');
    return { ok: true, chars: text.length, lines: lines.length, preview, suggestRendered };
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'Timeout'
      : (error && error.message) || String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function handleStartPicker(msg) {
  const url = String((msg && msg.url) || '');
  const siteId = msg && msg.siteId ? String(msg.siteId) : null;

  let parsed;
  try { parsed = new URL(url); } catch (e) { return { ok: false, error: 'invalid' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'invalid' };

  const pattern = originPattern(url);
  const granted = Boolean(pattern) && await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) return { ok: false, error: 'permission' };

  const tab = await chrome.tabs.create({ url, active: true });
  const tabId = tab.id;

  // Wait for a full load (same pattern as the rendered mode), with a timeout
  // fallback so a hung page still gets the picker.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (tabId_, info) => {
      if (tabId_ === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, RENDER_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
  });
  await new Promise((resolve) => setTimeout(resolve, RENDER_GRACE_MS));

  // The user may have closed the tab meanwhile - do not inject into a ghost.
  try { await chrome.tabs.get(tabId); }
  catch (e) { return { ok: false, error: 'tabClosed' }; }

  await chrome.scripting.insertCSS({ target: { tabId }, files: ['picker.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });

  const data = await chrome.storage.local.get('language');
  const lang = data.language || detectLanguage();
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'pickerStart',
      hint: pickerHintText(lang),
      url,
      siteId,
      requireCookies: Boolean(msg && msg.requireCookies),
      rendered: Boolean(msg && msg.rendered)
    });
  } catch (e) {
    return { ok: false, error: 'injectFailed' };
  }
  return { ok: true };
}

async function handlePickerPicked(msg, sender) {
  const selector = String((msg && msg.selector) || '').slice(0, 200);
  const data = await chrome.storage.local.get('pendingPicker');
  const info = data.pendingPicker || {};
  info.selector = selector;
  await chrome.storage.local.set({ pendingPicker: info });

  if (sender && sender.tab && sender.tab.id != null) {
    try { await chrome.tabs.remove(sender.tab.id); } catch (e) { /* already gone */ }
  }

  // Bring the form back: reopen the popup (it restores the form from
  // pendingPicker). openPopup needs a focused browser window, so wait briefly
  // after the picker tab closes. Fallback: a notification asking to click the icon.
  await new Promise((resolve) => setTimeout(resolve, 200));
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
    const lang = (await chrome.storage.local.get('language')).language || detectLanguage();
    chrome.notifications.create(`pendingadd_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: lang === 'pl' ? 'Fragment wybrany' : 'Fragment selected',
      message: lang === 'pl'
        ? 'Kliknij ikon\u0119 rozszerzenia, aby doko\u0144czy\u0107 dodawanie strony.'
        : 'Click the extension icon to finish adding this page.'
    });
  }
  return { ok: true };
}

// --- Karta zgody (grant.html) ---
// Po przyznaniu uprawnienia karta prosi tlo o: zamkniecie tej karty,
// poczekanie az fokus wroci do okna przegladarki i otwarcie popupu (kreator
// wznawia sie sam - maybeRestoreWizard widzi pendingPermission + granted).
// Otwarcie popupu z samej karty + natychmiastowe window.close() nie dzialalo:
// zamkniecie aktywnej karty zamykalo swiezo otwarty popup. Ten sam wzorzec
// jest w handlePickerPicked.
async function handleGrantDone(msg, sender) {
  const tabId = sender && sender.tab && sender.tab.id;

  (async () => {
    if (tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch (e) { /* already gone */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    let opened = false;
    try {
      if (chrome.action && typeof chrome.action.openPopup === 'function') {
        await chrome.action.openPopup();
        opened = true;
      }
    } catch (e) {
      console.warn('[Monitor] openPopup failed:', e);
      opened = false;
    }

    // Fallback: popup.html jako male okno - ta sama strona rozszerzenia,
    // kreator wznawia sie w nim tak samo.
    if (!opened) {
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL('popup.html'),
          type: 'popup',
          width: 580,
          height: 700
        });
        opened = true;
      } catch (e) {
        opened = false;
      }
    }

    if (!opened) {
      const lang = (await chrome.storage.local.get('language')).language || detectLanguage();
      chrome.notifications.create(`pendingadd_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icon48.png',
        title: lang === 'pl' ? 'Zgoda przyznana' : 'Access granted',
        message: lang === 'pl'
          ? 'Kliknij ikonę rozszerzenia, aby dokończyć dodawanie strony.'
          : 'Click the extension icon to finish adding this page.'
      });
    }
  })();

  return { ok: true };
}

async function handlePickerCancelled() {
  // Esc: drop only the hanging pendingPicker record. The tab stays open (the
  // user may want to browse it); the picker UI removes itself.
  await chrome.storage.local.remove(['pendingPicker', 'pickerDraft']);
  return { ok: true };
}
