// Shared helpers live in storage.js (also <script>-loaded by popup.html).
// The service worker needs isPrivateOrLocalUrl to flag local/private
// addresses in imported backups (Audit #4/P2).
importScripts('storage.js');

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
const WIZARD_DRAFT_MAX_AGE_MS = 15 * 60 * 1000; // must match wizard.js

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
  await cleanupAbandonedWizard();
});

chrome.runtime.onStartup.addListener(async () => {
  inFlight.clear();
  await setupAlarms();
  await updateContextMenu();
  await cleanupAbandonedWizard();
});

// Od\u015bwie\u017camy tytu\u0142 pozycji menu przy zmianie j\u0119zyka w popupie, \u017ceby by\u0142
// aktualny nawet bez ponownego uruchamiania rozszerzenia.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.language) {
    updateContextMenu();
  }
  // The wizard draft appeared/disappeared (or its origin marker changed):
  // check whether a wizard-granted host permission is now orphaned.
  if (changes.wizardDraft || changes.pendingWizardOrigin) {
    cleanupAbandonedWizard();
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
  checkSites: (msg) => checkSpecificSites(msg.siteIds),
  saveSite: (msg) => handleSaveSite(msg),
  toggleSite: (msg) => handleToggleSite(msg),
  deleteSite: (msg) => handleDeleteSite(msg),
  undoDelete: (msg) => handleUndoDelete(msg),
  markAllRead: async () => handleMarkAllRead(),
  reorderSites: (msg) => handleReorderSites(msg),
  updateGroup: (msg) => handleUpdateGroup(msg),
  markSitesRead: (msg) => handleMarkSitesRead(msg),
  checkAll: () => checkAllSites(),
  importSites: (msg) => handleImportSites(msg),
  previewSite: (msg) => handlePreviewSite(msg),
  startPicker: (msg, sender) => handleStartPicker(msg, sender),
  pickerPicked: (msg, sender) => handlePickerPicked(msg, sender),
  pickerCancelled: (msg, sender) => handlePickerCancelled(msg, sender),
  wipeAllData: () => handleWipeAllData()
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  // Audit #3: content scripts (the picker) share this extension id, but they
  // run in the PAGE's context, so sender.url is the page URL, never our
  // extension origin. Extension pages (popup, diff, wizard) always report
  // sender.url from chrome-extension://<id>. Only the picker* actions may
  // come from a content script; every other handler must come from an
  // extension page.
  const fromExtensionPage = Boolean(
    sender.url && sender.url.startsWith(chrome.runtime.getURL(''))
  );
  // Audit 2.0.0/P1: typeof always returns a non-empty STRING ("object"),
  // so the old "typeof msg &&" guard was always truthy and a null/undefined
  // msg threw on msg.action. Boolean(msg) is the real null check.
  const isPickerAction = Boolean(msg) && typeof msg.action === 'string' && msg.action.startsWith('picker');
  if (isPickerAction && !(sender.tab && sender.tab.id != null)) return;
  if (!isPickerAction && !fromExtensionPage) return;

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

  // Wizard origin sweeper (see cleanupAbandonedWizard): periodic safety net
  // for the case where the popup died without firing pagehide cleanup and
  // is never opened again.
  if (!existing.some((a) => a.name === 'wizard_cleanup')) {
    await chrome.alarms.create('wizard_cleanup', { periodInMinutes: 1, delayInMinutes: 1 });
  }

  await updateBadge();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'wizard_cleanup') {
    await cleanupAbandonedWizard();
    // Audyt C: przegl\u0105d retencji snapshot\u00f3w (sam tnie najwy\u017cej raz na godzin\u0119).
    await pruneSnapshots();
    return;
  }
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

// --- Linear-time HTML stripping -------------------------------------------
// The previous regexes (<!--[\s\S]*?-->, <(script|style)...[\s\S]*?</\1>,
// <[^>]+>) are QUADRATIC on markup with many unclosed tags: a hostile or broken
// page of ~0.6 MB of "<!--" froze the service worker for ~30 s. These helpers
// give byte-for-byte the same output on every input, in linear time: they cache
// the next ">" and remember that a closing marker is missing (once a search for
// it fails, no later start can succeed either).

// Removes <!-- ... --> (an unclosed "<!--" is left untouched, as before).
function removeComments(html) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = html.indexOf('<!--', i);
    if (start === -1) break;
    const end = html.indexOf('-->', start + 4);
    if (end === -1) break; // no later comment can close either
    out += html.slice(i, start);
    i = end + 3;
  }
  return out + html.slice(i);
}

// Removes <script|style|noscript ...> ... </same> blocks (case-insensitive).
function removeRawTextBlocks(html) {
  const re = /<(script|style|noscript)/gi;
  const missingEnd = new Set();
  let out = '';
  let i = 0;
  let gt = -2; // cached position of the next ">"
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[1].toLowerCase();
    if (missingEnd.has(name)) continue;
    const afterName = m.index + m[0].length;
    if (gt < afterName) {
      gt = html.indexOf('>', afterName);
      if (gt === -1) break; // no ">" left: no later start can match
    }
    const endRe = new RegExp('</' + name + '>', 'gi');
    endRe.lastIndex = gt + 1;
    const e = endRe.exec(html);
    if (!e) { missingEnd.add(name); continue; }
    out += html.slice(i, m.index);
    i = e.index + e[0].length;
    re.lastIndex = i;
  }
  return out + html.slice(i);
}

// Replaces every <...> (at least one char inside) with `repl`.
function replaceAllTags(html, repl) {
  let out = '';
  let i = 0;
  let p = 0;
  let gt = -2;
  for (;;) {
    const lt = html.indexOf('<', p);
    if (lt === -1) break;
    if (gt < lt + 1) {
      gt = html.indexOf('>', lt + 1);
      if (gt === -1) break;
    }
    if (gt === lt + 1) { p = lt + 1; continue; } // "<>" is not a tag
    out += html.slice(i, lt) + repl;
    i = gt + 1;
    p = i;
  }
  return out + html.slice(i);
}

// Replaces every opening block tag (<p ...>, <div ...> ...) with `repl`.
function replaceBlockTags(html, repl) {
  const re = new RegExp(`<(${SNAPSHOT_BLOCK_TAGS})`, 'gi');
  let out = '';
  let i = 0;
  let gt = -2;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (gt < m.index + 1) {
      gt = html.indexOf('>', m.index + 1);
      if (gt === -1) break;
    }
    out += html.slice(i, m.index) + repl;
    i = gt + 1;
    re.lastIndex = i;
  }
  return out + html.slice(i);
}

function cleanHtmlSimple(htmlText) {
  if (!htmlText) return '';
  let cleaned = removeComments(htmlText);
  cleaned = removeRawTextBlocks(cleaned);
  cleaned = replaceAllTags(cleaned, ' ');
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
  let cleaned = removeComments(htmlText);
  cleaned = removeRawTextBlocks(cleaned);
  cleaned = replaceBlockTags(cleaned, '\n');
  cleaned = replaceAllTags(cleaned, ' ');
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
  // Optymalizacja IPC: komentarze, <style> i <noscript> to elementy, ktorych
  // selektor nieledwowalnie nie wskazuje (picker nigdy ich nie wybiera), a
  // bywaja dziesiatkami procent objtosci strony. Zdejmujemy je LINIOWO
  // (istniejace funkcje) przed kopia strukturalna przez runtime.sendMessage -
  // <script> zostaje celowo, bo reczny selektor moze wskazywac np.
  // <script type="application/ld+json"> na monitorowanym endpointcie.
  const trimmed = removeRawTextBlocks(removeComments(html));
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'extractFragment', html: trimmed, selector });
  if (!res || !res.ok) throw new Error('Invalid selector');
  // Audyt#3/poprawka3: niepoprawny SK\u0141ADNIOWO selektor (querySelector rzuca)
  // to inny b\u0142\u0105d ni\u017c selektor poprawny, ale nic nie pasuj\u0105cy \u2014 karta
  // pokazuje "Invalid selector" (i18n errSelectorInvalid), nie myl\u0105c\u0105c
  // podpowiedzi\u0105 o stronach rysowanych JS-em.
  if (res.invalidSelector) throw new Error('Invalid selector');
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

// Wait until the tab reports status "complete" (or the timeout fires).
// Single cleanup path: removes the listener AND the timer whether the tab
// completes, the timeout fires, or the tab dies early.
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
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
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Smart wait instead of a fixed pause: poll the page until the text (of
// the selected fragment, or of <body>) is non-empty and has stopped
// changing for RENDER_STABLE_MS, with an upper cap. Fast pages finish in
// about a second; slow ones get up to the cap instead of a false error.
// A returned promise is awaited by executeScript.
// Default ISOLATED world is enough to read innerText and safer than MAIN.
function readRenderedText(tabId, selector) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, maxMs, stableMs) => new Promise((resolve, reject) => {
      // Audyt#3/poprawka3: niepoprawny sk\u0142adniowo selektor \u2014 od razu reject,
      // \u017ceby executeScript zwr\u00f3ci\u0142 "Invalid selector" (ta sama etykieta co
      // w trybie szybkim) zamiast surowego SyntaxError z document.querySelector.
      try { if (sel) document.querySelector(sel); } catch (e) { return reject(new Error('Invalid selector')); }
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
    args: [selector || null, selector ? RENDER_MAX_WAIT_SELECTOR_MS : RENDER_MAX_WAIT_BODY_MS, RENDER_STABLE_MS]
  });
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

    await waitForTabComplete(tabId, RENDER_LOAD_TIMEOUT_MS);
    // The tab may have been closed by the user or the browser meanwhile -
    // verify it still exists before injecting the script.
    try { await chrome.tabs.get(tabId); }
    catch (e) { throw new Error('Tab closed before reading'); }

    let results;
    try {
      results = await readRenderedText(tabId, selector);
    } catch (scriptErr) {
      // Chrome shows its own error page (no internet, DNS, server down) and
      // REFUSES scripting in such a tab with a cryptic internal message like
      // "Frame with ID 0 is showing error page". The site usually works fine
      // when opened normally - a hidden minimized tab just occasionally gets
      // a transient load failure (network blip, throttling, rate limit).
      // Retry ONCE: reload the tab, wait for it to settle, read again.
      const raw = String((scriptErr && scriptErr.message) || scriptErr);
      if (/showing error page|ERR_|cannot access contents/i.test(raw)) {
        try {
          await chrome.tabs.reload(tabId);
          await waitForTabComplete(tabId, RENDER_LOAD_TIMEOUT_MS);
          results = await readRenderedText(tabId, selector);
          const text2 = (results && results[0] && results[0].result) || '';
          if (text2.trim()) {
            return { notModified: false, text: text2, etag: null, lastModified: null };
          }
        } catch (retryErr) { /* fall through to the readable error below */ }
        throw new Error('Site unreachable (browser error page)');
      }
      throw scriptErr;
    }
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
      prevSnapshotTs: changed ? Date.now() : (cur.prevSnapshotTs || null),
      lastSnapshotTs: Date.now(),
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

// Audyt C \u2014 retencja snapshot\u00f3w: stare wersje stron (prevSnapshot) i
// snapshoty stron dawno niesprawdzanych (np. wstrzymanych) nie siedz\u0105 w
// storage bezterminowo. Ustawienie snapshotRetentionDays (popup: Settings
// \u2192 Privacy and data): presety 7/30/90 dni lub warto\u015b\u0107 w\u0142asna
// (1..3650); DOMY\u015bLNIE 7 DNI (feedback t.4/t.5). Legacy 0 ("bez
// limitu") traktowane jak domy\u015blne 7 dni - opcja znikn\u0119\u0142a z menu, a
// samoczynnie pokazuj\u0105ce si\u0119 pole "w\u0142asne" wygl\u0105da\u0142o \u017ale.
const SNAPSHOT_PRUNE_CHECK_MS = 60 * 60 * 1000; // przegl\u0105d co godzin\u0119
const SNAPSHOT_RETENTION_MAX_DAYS = 3650; // rozs\u0105dny sufit dla "w\u0142asnych" warto\u015bci

// Czysta funkcja planowania retencji: zwraca NOW\u0105 tablic\u0119 (bez mutacji
// wej\u015bcia) i flag\u0119 touched. Wydzielona pod Audyt 2.0.0 (2)/P1, \u017ceby
// regu\u0142y ci\u0119cia da\u0142o si\u0119 testowa\u0107 wprost (test/prune.test.js, npm test).
function planSnapshotPrune(sites, days, now) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  // Rekord sprzed aktualizacji nie ma znacznik\u00f3w czasu snapshot\u00f3w:
  // timing bierzemy z changedAt/lastCheckTime, \u017ceby upgrade nie
  // skasowa\u0142 nikomu wersji "w dniu zero".
  const out = sites.map((site) => {
    if (!site) return site;
    const prevTs = site.prevSnapshotTs || site.changedAt || site.lastCheckTime || now;
    const lastTs = site.lastSnapshotTs || site.lastCheckTime || now;
    const dropPrev = Boolean(site.prevSnapshot) && prevTs < cutoff;
    const dropLast = Boolean(site.lastSnapshot) && lastTs < cutoff;
    if (!dropPrev && !dropLast) return site;
    return {
      ...site,
      prevSnapshot: dropPrev ? '' : site.prevSnapshot,
      prevSnapshotTs: dropPrev ? null : site.prevSnapshotTs,
      lastSnapshot: dropLast ? '' : site.lastSnapshot,
      lastSnapshotTs: dropLast ? null : site.lastSnapshotTs,
    };
  });
  const touched = out.some((s, i) => s !== sites[i]);
  return { sites: out, touched };
}

async function pruneSnapshots() {
  // Audyt 2.0.0 (2)/P1: odczyt-modyfikacja-zapis "sites" przebiega pod
  // withStorageLock \u2014 bez tego sprz\u0105tanie mog\u0142o nadpisa\u0107 nowszy stan
  // zapisany w mi\u0119dyczasie przez trwaj\u0105cy check albo edycj\u0119 listy
  // (read-modify-write poza kolejk\u0105 gubi\u0142 r\u00f3wnoleg\u0142e aktualizacje).
  // Test modelowy blokady: test/prune.test.js.
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get(['sites', 'snapshotRetentionDays', 'snapshotPruneTime']);
    const now = Date.now();
    // Throttling: alarm wizard_cleanup odpala nas co minut\u0119 \u2014 realne
    // kasowanie sprawdzamy najwy\u017cej raz na godzin\u0119.
    if (data.snapshotPruneTime && now - data.snapshotPruneTime < SNAPSHOT_PRUNE_CHECK_MS) return;
    const raw = data.snapshotRetentionDays;
    // Brak zapisu, 0 (legacy "bez limitu") albo warto\u015b\u0107 niepoprawna =
    // domy\u015blne 7 dni (feedback t.5); liczba dodatnia = limit w dniach,
    // docinany do 3650, \u017ceby liter\u00f3wka/hand-edit nie zrobi\u0142
    // "limitu na 1000 lat".
    const days = Number(raw) > 0 ? Math.min(Number(raw), SNAPSHOT_RETENTION_MAX_DAYS) : 7;
    if (days > 0) {
      const plan = planSnapshotPrune(data.sites || [], days, now);
      if (plan.touched) await chrome.storage.local.set({ sites: plan.sites });
    }
    await chrome.storage.local.set({ snapshotPruneTime: now });
  }).catch(() => { /* best-effort: nast\u0119pny alarm spr\u00f3buje ponownie */ });
}

// Audyt C \u2014 globalne czyszczenie danych (Settings \u2192 Delete all data).
// Nieodwracalne: kasuje strony, snapshoty, grupy, szkice kreatora/pickera
// i znaczniki tymczasowe. Zostaj\u0105 tylko preferencje interfejsu (j\u0119zyk,
// motyw, retencja) \u2014 to nie s\u0105 dane monitorowania. Pod withStorageLock,
// \u017ceby \u017caden trwaj\u0105cy check nie nadpisa\u0142 czystego storage star\u0105 tablic\u0105.
async function handleWipeAllData() {
  const outcome = await withStorageLock(async () => {
    const prefs = await chrome.storage.local.get(['language', 'theme', 'snapshotRetentionDays']);
    await chrome.alarms.clearAll();
    await chrome.storage.local.clear();
    if (prefs && Object.keys(prefs).length) await chrome.storage.local.set(prefs);
    // Privacy-first: with no monitored pages the extension must not keep
    // ACCESS to any page either. Single deletes release their origin
    // (releaseUnusedOrigins), but this button used to leave every granted
    // origin behind - user-reported recurring regression: access to removed
    // pages persisted after the wipe. Best-effort: failures only warn.
    try {
      const all = await chrome.permissions.getAll();
      const origins = (all && all.origins) || [];
      if (origins.length) await chrome.permissions.remove({ origins });
    } catch (e) {
      console.warn('[Monitor] Could not release origins after wipe', e);
    }
    // Bez stron: setupAlarms odtwarza tylko wizard_cleanup i zeruje badge.
    await setupAlarms();
    return { ok: true };
  });
  return outcome;
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
    // Audyt#3/poprawka2: tryb RENDEROWANY nie przechodzi przez
    // cleanHtmlStructured (kt\u00f3re tnie do SNAPSHOT_MAX_CHARS), wi\u0119c surowy
    // innerText bywa\u0142 wielomegabajtowy (np. niesko\u0144czony scroll). Hasz nadal
    // liczy z PE\u0141NEGO tekstu (fetchResult.text u\u017cyty poni\u017cej) \u2014 przycinamy
    // tylko snapshot przechowywany do podgl\u0105du diffu.
    if (!fetchResult.notModified) {
      fetchResult.snapshotText = site.renderMode === 'rendered'
        ? fetchResult.text.slice(0, SNAPSHOT_MAX_CHARS)
        : cleanHtmlStructured(fetchResult.text);
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

// --- Wizard origin sweeper ------------------------------------------------
// A host permission granted by the add-page wizard must not outlive the
// wizard itself. The popup releases it on Cancel and on the pagehide close
// ("click outside"), but neither is guaranteed to complete while the popup
// is being torn down, and the popup may never be opened again. wizard.js
// therefore records every NEW grant in `pendingWizardOrigin`; whenever the
// wizard draft disappears (or is stale) and no saved page uses the origin,
// the background releases it. Triggered by storage.onChanged and a 1-minute
// safety-net alarm.
async function cleanupAbandonedWizard() {
  const data = await chrome.storage.local.get(['pendingWizardOrigin', 'wizardDraft', 'sites']);
  const origin = data.pendingWizardOrigin;
  if (!origin) return;

  const draft = data.wizardDraft;
  const wizardAlive = Boolean(draft && draft.url && Date.now() - (draft.ts || 0) <= WIZARD_DRAFT_MAX_AGE_MS);
  if (wizardAlive) return;

  const inUse = (data.sites || []).some((s) => originPattern(s.url) === origin);
  if (!inUse) {
    try {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      const still = await chrome.permissions.contains({ origins: [origin] });
      console.info('[Monitor] wizard abandoned - released origin:', origin, 'removed =', removed, 'still granted =', still);
    } catch (e) {
      console.warn('[Monitor] Could not release wizard origin', origin, e);
    }
  }
  await chrome.storage.local.remove('pendingWizardOrigin');
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

  // Audit #4/P1: URLs with embedded credentials (user:pass@host) are rejected.
  // fetch() never sends them as auth, so they only leak - into backups, logs
  // and the UI. Wizard/edit/import show errUrlCredentials / skip the row.
  if (parsed.username || parsed.password) return { invalidCredentials: true };

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
      // Audit #4/P1: same rule as the monitored URL - no embedded
      // user:pass@; fall back to the monitored URL instead.
      else if (p.username || p.password) openUrl = '';
    } catch (e) {
      openUrl = '';
    }
  }

  // Optional CSS selector: monitor only a fragment of the page (e.g. the
  // results table), not the whole body incl. navigation. Works in both
  // modes (fast mode parses the fetched HTML in an offscreen document).
  // Audit 2.0.0/P1: a bad or over-long selector must FAIL LOUDLY. The old
  // code silently blanked it (=> whole-page monitoring) and silently
  // truncated >200 chars. Unicode letters/digits (\p{L}\p{N}) are now
  // allowed so class names in any alphabet pass; the offscreen
  // querySelector stays the final runtime judge of CSS syntax.
  const selector = String(s.selector || '').trim();
  if (selector.length > 200) return { invalidSelector: true };
  if (selector && !/^[\p{L}\p{N} #.\[\]:_>"'=()~*,+|^$\\\/-]+$/u.test(selector)) {
    return { invalidSelector: true };
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
    openUrl: openUrl || url,
    // Audyt#3/poprawka1: czy "otwierana strona" byla w ogole podana? Formularz
    // edycji nie ma pola openUrl, wiec bez tej flagi nie odr\u00f3\u017cnimy "u\u017cytkownik
    // wyczy\u015bci\u0142/zmieni\u0142" od "formularz w og\u00f3le go nie przys\u0142a\u0142" \u2014 a to
    // drugie musi ZACHOWA\u0106 dotychczasow\u0105 warto\u015b\u0107 przy edycji (patrz
    // handleSaveSite). Flaga jest wy\u0142\u0105czona z zapisu rekordu (handleImportSites).
    openUrlCustom: Boolean(openUrl)
  };
}

async function handleSaveSite(msg) {
  const raw = (msg && msg.site) || {};
  const input = sanitizeSiteInput(raw);
  // Audit 2.0.0/P1: bad selector -> explicit error (popup shows
  // errSelectorInvalid), never a silent whole-page fallback.
  if (input && input.invalidSelector) return { ok: false, error: 'invalidSelector' };
  // Audit #4/P1: explicit error for user:pass@ URLs (popup/wizard show
  // errUrlCredentials).
  if (input && input.invalidCredentials) return { ok: false, error: 'invalidCredentials' };
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
      // Audyt#3/poprawka1: formularz edycji nie wysy\u0142a pola "Otwierana
      // strona" (openUrl), a sanitizeSiteInput domy\u015blnie podstawa\u0142 url
      // monitorowany \u2014 ka\u017cda edycja cicho zerowa\u0142a customowy openUrl
      // (dost\u0119pny w\u0142a\u015bciwie przez import backupu). Edycja bez podanego
      // openUrl zachowuje dotychczasow\u0105 warto\u015b\u0107 rekordu; nowa strona
      // i import dzia\u0142aj\u0105 jak dotychczas. openUrl nie wchodzi do
      // targetKey, wi\u0119c nie psuje baseline'u.
      if (!input.openUrlCustom && cur.openUrl && cur.openUrl !== cur.url) {
        fields.openUrl = cur.openUrl;
      }
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
    const skippedByReason = { limit: 0, invalid: 0, credentials: 0, duplicate: 0 };
    // Audit #4/P2: how many of the ADDED pages point at local/private
    // addresses (e.g. a router). The popup shows a heads-up note for those.
    let localCount = 0;

    for (const raw of incoming) {
      if (sites.length >= MAX_SITES) { skippedByReason.limit++; continue; }

      const input = sanitizeSiteInput(raw);
      // Audit 2.0.0/P1: an invalid selector counts as "invalid" (row skipped,
      // reported in the import summary) instead of silently dropping the
      // selector and importing a whole-page monitor.
      // Audit #4/P1: user:pass@ URLs get their own skip reason so the
      // summary can say why the row was dropped.
      if (input && input.invalidCredentials) { skippedByReason.credentials++; continue; }
      if (!input || input.invalidSelector) { skippedByReason.invalid++; continue; }

      const identity = siteIdentity(input.url);
      if (seen.has(identity)) { skippedByReason.duplicate++; continue; }
      seen.add(identity);

      const siteId = newSiteId();
      // Group by NAME (backups carry names): reuse a group with the same name or create one.
      // Audyt#3/poprawka1: openUrlCustom to flaga helper sanitizeSiteInput \u2014
      // celowo NIE wchodzi do zapisywanego rekordu (schemat sites ma zosta\u0107
      // czysty; czyta j\u0105 tylko handleSaveSite).
      const { group: groupName, openUrlCustom, ...fieldsOnly } = input;
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
      if (isPrivateOrLocalUrl(input.url)) localCount++;
      addedIds.push(siteId);
    }

    const skippedCount = skippedByReason.limit + skippedByReason.invalid + skippedByReason.credentials + skippedByReason.duplicate;
    await chrome.storage.local.set({ sites, groups });
    return { addedCount: addedIds.length, skippedCount, skippedByReason, localCount, origins: [...new Set(addedOrigins)], addedIds };
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
    // deliberately not applied here. Audit #7: openUrl gets the same checks
    // as in sanitizeSiteInput - invalid or non-http(s) openUrl falls back to
    // the (already sanitized) monitored url.
    const copy = { ...site };
    copy.name = String(copy.name || '').slice(0, 100);
    copy.url = String(copy.url || '').slice(0, 2000);
    let openUrl = String(copy.openUrl || '').trim().slice(0, 2000);
    if (openUrl) {
      try {
        const p = new URL(openUrl);
        if (p.protocol !== 'http:' && p.protocol !== 'https:') openUrl = '';
      } catch (e) {
        openUrl = '';
      }
    }
    copy.openUrl = openUrl || copy.url;

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
    ? 'Kliknij fragment strony, kt\u00f3ry chcesz monitorowa\u0107 (tylko elementy z klas\u0105 lub id). Esc anuluje.'
    : 'Click the part of the page you want to watch (only elements with a class or id). Esc cancels.';
}

// "Test check" in the form: one throw-away check (nothing is stored) that shows
// what would actually be monitored, so mode/selector problems surface BEFORE saving.
async function handlePreviewSite(msg) {
  const input = sanitizeSiteInput({ name: 'preview', ...((msg && msg.site) || {}) });
  // Audit 2.0.0/P1: surface a bad selector in the "Test" result too.
  if (input && input.invalidSelector) return { ok: false, error: 'invalidSelector' };
  // Audit #4/P1: user:pass@ URLs are rejected here as well.
  if (input && input.invalidCredentials) return { ok: false, error: 'invalidCredentials' };
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

async function handleStartPicker(msg, sender) {
  const url = String((msg && msg.url) || '');
  const siteId = msg && msg.siteId ? String(msg.siteId) : null;
  const wizardTabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : null;

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

  // Zapamietaj karte pickera (zamykana po picku) + skad przyszla prosba
  // (kreator vs formularz edycji). Flage wizard czytamy z pickerDraft TERAZ
  // - po picku karta kreatora konsumuje draft na storage.onChanged i pozniej
  // bylby to juz wyscig.
  let isWizardPick = false;
  try {
    const draft = (await chrome.storage.local.get('pickerDraft')).pickerDraft;
    isWizardPick = Boolean(draft && draft.wizard);
  } catch (e) { /* noop */ }
  await setPickerTab({ tabId, wizard: isWizardPick, wizardTabId, ts: Date.now() });

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

// Przywraca UI rozszerzenia po zamknieciu popupu (pick elementu, okienko
// zgody kreatora, zgoda z restore backupu): najpierw chrome.action.openPopup
// (Chrome 127+; wymaga sfokusowanego okna przegladarki, wiec wywolujacy
// odczekuje chwile przed nim), potem popup.html jako male okno (ta sama
// strona rozszerzenia - kreator/popup wznawia sie w nim tak samo), a na
// koniec powiadomienie proszace o klikniecie ikony.
// Znajduje karte kreatora (popup.html?wizard=1). UWAGA: tabs.query z filtrem
// url (match pattern) notorycznie zawodzi dla wlasnych stron chrome-extension,
// dlatego: (1) chrome.runtime.getContexts (contextId JEST tabId karty), (2)
// fallback tabs.query({}) + porownanie PREFIXU url. Wczesniejsze wersje
// "nie widzialy" karty, przez co chrome.action.openPopup() otwieral popup
// NASUWAJACY sie na zywa karte kreatora.
async function findWizardTabId() {
  const base = chrome.runtime.getURL('popup.html');
  try {
    const views = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const v = (views || []).find((x) =>
      x.documentUrl && x.documentUrl.split('#')[0].startsWith(base) && /[?&]wizard=1/.test(x.documentUrl));
    if (v && v.contextId != null) return v.contextId;
  } catch (e) { /* getContexts unavailable: fall through */ }
  try {
    const all = await chrome.tabs.query({});
    const tab = (all || []).find((t) =>
      (t.url || '').split('#')[0].startsWith(base) && /[?&]wizard=1/.test(t.url || ''));
    if (tab) return tab.id;
  } catch (e) { /* noop */ }
  return null;
}

// Aktywuje karte kreatora (popup.html?wizard=1), jesli istnieje. Pelna
// migracja kreatora do karty (2026-10): po picku/zgodzie wracamy do ZYWEJ
// karty zamiast otwierac nowe okno/popup.
async function focusWizardTab() {
  const tabId = await findWizardTabId();
  if (tabId == null) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { /* noop */ }
  } catch (e) { /* tab gone */ }
  try { await chrome.tabs.update(tabId, { active: true }); } catch (e) { return false; }
  return true;
}

// Otwiera karte kreatora: najpierw aktywuje istniejaca (nigdy drugiej obok
// drugiej), dopiero gdy jej nie ma tworzy nowa. NIGDY nie wywoluje tu
// chrome.action.openPopup() - popup otwierany z tla nasuwa sie na karte.
async function ensureWizardTab() {
  if (await focusWizardTab()) return true;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '?wizard=1' });
    return true;
  } catch (e) {
    return false;
  }
}

async function restoreExtensionUi(note) {
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
  if (!opened) {
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 580,
        height: 700
      });
      opened = true;
    } catch (e) { opened = false; }
  }
  if (!opened && note) {
    const lang = (await chrome.storage.local.get('language')).language || detectLanguage();
    chrome.notifications.create(`pendingadd_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: note.title[lang === 'pl' ? 'pl' : 'en'],
      message: note.message[lang === 'pl' ? 'pl' : 'en']
    });
  }
  return opened;
}

// Karta pickera: tBo samo ja otworzylo (handleStartPicker), wiec zna jej id.
// Zapisujemy je w chrome.storage.session (przezywa uspienie SW; znika przy
// restarcie przegladarki). Dzieki temu zamkniecie karty po picku NIE ZALEZY
// od wiadomosci pickerPicked (ktora mogloby nie dotrzec) - wystarczy
// zapis selektora do storage. Wewnetrzna zmienna to lustrzany fallback.
let pickerTabMem = null;
const PICKER_TAB_KEY = 'pickerTab';

async function setPickerTab(info) {
  pickerTabMem = info;
  try { await chrome.storage.session.set({ [PICKER_TAB_KEY]: info }); } catch (e) { /* noop */ }
}

// Atomowe "przejecie" zadania: ktory kontekst pierwszy usunie rekord, ten
// zamyka karte i routinguje powrot (wiadomosc i storage.onChanged moga
// odpalic oba - tylko jeden ma zadzialac).
async function claimPickerTab() {
  let info = null;
  try {
    const data = await chrome.storage.session.get(PICKER_TAB_KEY);
    info = data && data[PICKER_TAB_KEY];
    if (info) await chrome.storage.session.remove(PICKER_TAB_KEY);
  } catch (e) { /* session unavailable */ }
  if (!info && pickerTabMem) { info = pickerTabMem; }
  pickerTabMem = null;
  return info || null;
}

// Zamkniecie karty pickera + powrot do wlasciwego UI:
// - pick z KREATORA -> DOKLADNIE ta karta, ktora uruchomila picker
//   (wizardTabId z wiadomosci startPicker; wyszukiwanie kart moze wskazac
//   zla/pusta karte, jesli w oknie zostala inna karta kreatora),
// - pick z FORMULARZA EDYCJI -> popup/okno/notyfikacja (edycja zyje w popupie).
async function finishPickerFlow(pickerTab, senderTabId) {
  const tabId = (senderTabId != null) ? senderTabId : (pickerTab && pickerTab.tabId);
  if (tabId != null) {
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (pickerTab && pickerTab.wizard) {
    // Punktowano: wracamy do DOKLADNIE tej karty kreatora, ktora prosila
    // o picker. Dopiero gdy ta karta zniknela (np. uzytkownik ja zamknal),
    // ensureWizardTab znajdzie/stworzy karte i wznowi szkic z draftu.
    const wizardTabId = pickerTab.wizardTabId;
    if (wizardTabId != null) {
      try {
        const tab = await chrome.tabs.get(wizardTabId);
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { /* noop */ }
        await chrome.tabs.update(wizardTabId, { active: true });
        return;
      } catch (e) { /* wizard tab gone: fall through to ensureWizardTab */ }
    }
    await ensureWizardTab();
  } else {
    await restoreExtensionUi({
      title: { pl: 'Fragment wybrany', en: 'Fragment selected' },
      message: {
        pl: 'Doko\u0144cz dodawanie/edycj\u0119 strony w otwartym oknie rozszerzenia.',
        en: 'Finish editing this page in the opened extension window.'
      }
    });
  }
}

async function handlePickerPicked(msg, sender) {
  // Selektor picker zapisal juz SAM do storage (pendingPicker) - tu nie
  // ruszamy storage (stary zapis powodowal wyscig z karta kreatora, ktora
  // konsumuje draft na storage.onChanged). Zamykamy karte i wracamy do UI.
  const pickerTab = await claimPickerTab();
  await finishPickerFlow(pickerTab, sender && sender.tab ? sender.tab.id : null);
  return { ok: true };
}

async function handlePickerCancelled() {
  // Esc: drop only the hanging pendingPicker record. The tab stays open (the
  // user may want to browse it); the picker UI removes itself.
  await chrome.storage.local.remove(['pendingPicker', 'pickerDraft']);
  pickerTabMem = null;
  try { await chrome.storage.session.remove(PICKER_TAB_KEY); } catch (e) { /* noop */ }
  return { ok: true };
}

// Niezawodny fallback zamkniecia karty pickera: picker-2.js zapisuje selektor
// do storage PRZED wyslaniem wiadomosci - jesli wiadomosc nie dotrze ( martwy
// SW, uniewazniony kontekst), ten listener i tak zamknie karte i wrzuci
// uzytkownika z powrotem do kreatora. claimPickerTab gwarantuje, ze wykona sie
// tylko raz (wiadomosc i listener moga odpalic oba).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.pendingPicker) return;
  const nv = changes.pendingPicker.newValue;
  if (!nv || !nv.selector) return;
  const pickerTab = await claimPickerTab();
  if (!pickerTab) return; // wiadomosc pickerPicked juz to obsluzyla
  await finishPickerFlow(pickerTab, null);
});

// --- Wznowienie kreatora po natywnym okienku zgody (bez karty grant.html) ---
// wizard.js prosi o uprawnienie hosta BEPOSREDNIO (wlasne okienko Chrome).
// Okienko zamyka popup, wiec nikt po stronie popupu nie moze go otworzyc
// z powrotem. chrome.permissions.onAdded odpala sie w tle zaraz po kliknieciu
// "Zezwol": oznaczamy szkic i przywracamy UI dokladnie tym samym wzorcem,
// ktorego uzywa handlePickerPicked (openPopup -> male okno popup.html ->
// powiadomienie). maybeRestoreWizard w przywroconym popupie widzi
// pendingPermission + przyznany origin i sam przechodzi do kroku 2.
chrome.permissions.onAdded.addListener(async (permissions) => {
  const data = await chrome.storage.local.get(['resumeAfterPermission', 'wizardDraft']);
  const flag = data.resumeAfterPermission || 0;
  const draft = data.wizardDraft;
  // Tylko swieza prosba z kreatora (requestWithResume ustawia znacznik
  // bezposrednio przed okienkiem) - inne nadania uprawnien ignorujemy.
  if (!flag || Date.now() - flag > 60_000) return;

  // Przywracanie kopii zapasowej (popup.js restoreBackup): brak szkicu
  // kreatora, ale jest marker pendingRestorePermission. Strony sa juz
  // zaimportowane, wiec po przyznaniu dostepu wystarczy otworzyc popup/okno,
  // aby uzytkownik zobaczyl przywrocona liste (bez tego zgoda zamarwiala
  // razem z zamknietym popupem i nikt nie informowal o wyniku).
  if (!draft || !draft.url || !draft.pendingPermission) {
    const restore = (await chrome.storage.local.get('pendingRestorePermission')).pendingRestorePermission;
    if (!restore || !Array.isArray(restore.origins) || !restore.origins.length) return;
    const grantedAny = Array.isArray(permissions.origins)
      && permissions.origins.some((o) => restore.origins.includes(o));
    if (!grantedAny) return;
    await chrome.storage.local.remove(['resumeAfterPermission', 'pendingRestorePermission']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Karta restore (popup.html?restore=1) pokazuje wynik sama (zgoda po
    // restore idzie z karty, nie z popupu); zywy popup (np. Brave) tez.
    try {
      const popupUrl = chrome.runtime.getURL('popup.html');
      const views = await chrome.runtime.getContexts({ contextTypes: ['POPUP', 'TAB'] });
      if (views.some((v) => v.documentUrl && v.documentUrl.split('#')[0].startsWith(popupUrl))) return;
    } catch (e) { /* getContexts unavailable: fall through and restore */ }
    await restoreExtensionUi({
      title: { pl: 'Dost\u0119p przyznany', en: 'Access granted' },
      message: {
        pl: 'Kliknij ikon\u0119 rozszerzenia, aby zobaczy\u0107 przywr\u00f3cone strony.',
        en: 'Click the extension icon to see the restored pages.'
      }
    });
    return;
  }
  if (Date.now() - (draft.ts || 0) > 15 * 60 * 1000) return;
  // Tylko origin, o ktory prosil kreator (nie np. przywracanie backupu).
  const want = originPattern(draft.url);
  if (!want || !Array.isArray(permissions.origins) || !permissions.origins.includes(want)) return;

  await chrome.storage.local.remove('resumeAfterPermission');

  // Regresja "zgoda po Anuluj": ten listener czyta draft na starcie i po
  // kilku awaitach zapisuje go z powrotem. Jesli uzytkownik zdazyl kliknac
  // "Anuluj" w miedzyczasie (wizard usunal draft i zwolnil zgode), ten
  // zapis by go WSKRZESIL ze swiezym ts - zamiatacz widzialby "zywy"
  // kreator i trzymal zgode. Przed zapisem sprawdzamy draft NA NOWO:
  // zniknal = kreator skonczone/anulowane, nie wskrzeszamy.
  const cur = (await chrome.storage.local.get('wizardDraft')).wizardDraft;
  if (!cur || !cur.url || !cur.pendingPermission) return;

  draft.permissionGranted = true;
  draft.ts = Date.now();
  await chrome.storage.local.set({ wizardDraft: draft });

  // Dajemy okienku czasu na zamkniecie, a oknu przegladarki na odzyskanie
  // fokusu (openPopup wymaga fokusu - ten sam wzorzec co handlePickerPicked).
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Pelna migracja kreatora do karty (2026-10): karta kreatora NIE zamyka
  // sie przy okienku zgody, wiec zwykle wystarczy ja AKTYWOWAC (wizard.js
  // sam kontynuuje po powrocie permissions.request).
  if (await focusWizardTab()) return;

  // Some browsers (e.g. Brave) do NOT close the POPUP when the permission
  // dialog shows - the popup itself continues the wizard after
  // permissions.request() resolves. Opening anything here would show the
  // wizard twice. Only restore if NO popup.html view is alive (PREFIX match:
  // karta kreatora to popup.html?wizard=1 - dokladna rownosc URL-a nigdy
  // by nie pasowala i otwierala DRUGA karte).
  try {
    const popupUrl = chrome.runtime.getURL('popup.html');
    const views = await chrome.runtime.getContexts({ contextTypes: ['POPUP', 'TAB'] });
    if (views.some((v) => v.documentUrl && v.documentUrl.split('#')[0].startsWith(popupUrl))) return;
  } catch (e) { /* getContexts unavailable: fall through and restore */ }

  // Brak zywej karty/popupu (np. karta zamknieta w trakcie okienka):
  // nowa karta kreatora przywraca szkic (pendingPermission + przyznany
  // origin) na starcie przez maybeRestoreWizard.
  await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '?wizard=1' });
});