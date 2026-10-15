function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[m]);
}

// Favicona przez wbudowane API chrome://favicon (uprawnienie "favicon" +
// web_accessible_resources w manife\u015bcie) \u2014 czyta z lokalnej pami\u0119ci
// podr\u0119cznej przegl\u0105darki, bez \u017cadnego zapytania do serwera strony czy
// zewn\u0119trznego serwisu (np. Google favicon service).
function faviconUrl(pageUrl, size = 32) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

// Jednolity zestaw ikon liniowych (stroke = currentColor), dzi\u0119ki czemu
// kolor ikon wynika wy\u0142\u0105cznie z CSS i nie zale\u017cy od czcionki emoji systemu.
const SVG_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICONS = {
  refresh: `${SVG_OPEN}<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`,
  pause: `${SVG_OPEN}<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
  play: `${SVG_OPEN}<polygon points="6 3 20 12 6 21 6 3"/></svg>`,
  edit: `${SVG_OPEN}<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
  trash: `${SVG_OPEN}<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  warning: '<svg class="icon-inline" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
};

// I3: czas wzgl\u0119dny dla \u015bwie\u017cych sprawdze\u0144 (\u201eX min temu"), dok\u0142adna data
// tylko dla starszych ni\u017c 24 h \u2014 u\u017cytkownik od razu widzi, jak \u201e\u015bwie\u017ce"
// jest ostatnie sprawdzenie, bez por\u00f3wnywania zegarka z etykiet\u0105.
function formatLastCheck(timestamp) {
  const locale = currentLang === 'pl' ? 'pl-PL' : 'en-US';
  const pl = currentLang === 'pl';
  const date = new Date(timestamp);
  const diffMs = Date.now() - timestamp;

  if (diffMs < 60_000) return pl ? 'w\u0142a\u015bnie teraz' : 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return pl ? `${mins} min temu` : `${mins} min ago`;
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    return pl ? `${h} godz. temu` : (h === 1 ? '1 hour ago' : `${h} hours ago`);
  }

  const sameDay = date.toDateString() === new Date().toDateString();

  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function buildCard(site, flash = null) {
  const t = TRANSLATIONS[currentLang];
  const card = document.createElement('div');
  card.className = `site-card ${site.isPaused ? 'paused' : ''}`;
  card.dataset.id = site.id;
  card.tabIndex = 0;

  const labelFreq = t.freqLabels[site.freqIndex] || t.freqLabels[0];
  // U4: pauza widoczna te\u017c tekstowo, nie tylko przez opacity.
  const pausedBadge = site.isPaused ? `<span class="badge-paused">${t.badgePaused}</span>` : '';
  const badgeHtml = site.hasChanged ? `<span class="badge-changed">${t.badgeNew}</span>` : '';
  const lastCheck = site.lastCheckTime ? formatLastCheck(site.lastCheckTime) : '&mdash;';

  const errorHtml = site.lastError
    ? ` &bull; <span class="meta-error" title="${escapeHtml(site.lastError)}">${ICONS.warning} ${t.checkError}</span>`
    : '';
  const flashHtml = flash
    ? ` &bull; <span class="meta-flash ${flash.kind}" role="status" aria-live="polite">${escapeHtml(flash.text)}</span>`
    : '';
  // U1: link do podgl\u0105du zmian \u2014 widoczny tylko przy NIEODCZYTANEJ zmianie.
  // Klikni\u0119cie otwiera diff i czy\u015bci hasChanged (refreshSiteContent),
  // wi\u0119c po obejrzeniu zmian przycisk znika.
  const diffHtml = site.hasChanged && site.prevSnapshot
    ? ` &bull; <a href="#" class="link-diff" title="${t.titleDiff}">${t.linkDiff}</a>`
    : '';

  const isChecking = checkingIds.has(site.id);
  const refreshDisabled = site.isPaused || isChecking;

  card.innerHTML = `
    <button type="button" class="drag-handle" title="${t.titleDrag}" aria-label="${t.titleDrag}"><svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7"/><circle cx="10" cy="3.5" r="1.7"/><circle cx="4" cy="9" r="1.7"/><circle cx="10" cy="9" r="1.7"/><circle cx="4" cy="14.5" r="1.7"/><circle cx="10" cy="14.5" r="1.7"/></svg></button>
    <div class="site-info" tabindex="0" role="button" aria-label="${escapeHtml(site.name)}">
      <div class="site-name" title="${escapeHtml(site.name)}"><img class="site-favicon" src="${faviconUrl(site.url, 32)}" width="18" height="18" alt="" aria-hidden="true">${escapeHtml(site.name)}${pausedBadge}${badgeHtml}</div>
      <div class="site-meta">${labelFreq} &bull; ${t.lastCheck}: ${lastCheck}${errorHtml}${flashHtml}${diffHtml}</div>
    </div>
    <div class="actions">
      <button class="btn-icon btn-refresh${isChecking ? ' spinning' : ''}" title="${t.titleRefresh}" aria-label="${t.titleRefresh}"${refreshDisabled ? ' disabled' : ''}><span class="icon">${ICONS.refresh}</span></button>
      <button class="btn-icon btn-toggle" title="${t.titleToggle}" aria-label="${t.titleToggle}">${site.isPaused ? ICONS.play : ICONS.pause}</button>
      <button class="btn-icon btn-edit" title="${t.titleEditBtn}" aria-label="${t.titleEditBtn}">${ICONS.edit}</button>
      <button class="btn-icon btn-delete" title="${t.titleDeleteBtn}" aria-label="${t.titleDeleteBtn}">${ICONS.trash}</button>
    </div>
  `;

  if (flash) {
    setTimeout(() => {
      const flashEl = card.querySelector('.meta-flash');
      if (flashEl) flashEl.remove();
    }, 3500);
  }

  const favIcon = card.querySelector('.site-favicon');
  if (favIcon) {
    favIcon.addEventListener('error', () => { favIcon.style.visibility = 'hidden'; }, { once: true });
  }

  card.querySelector('.site-info').addEventListener('click', async () => {
    chrome.tabs.create({ url: site.openUrl || site.url });
    sendToBackground({ action: 'refreshSiteContent', siteId: site.id });
    window.close();
  });

  card.querySelector('.btn-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    triggerCheck(site.id);
  });

  card.querySelector('.btn-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePause(site.id);
  });

  card.querySelector('.btn-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    showForm(site);
  });

  card.querySelector('.btn-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    enterDeleteConfirm(card, site);
  });

  const diffEl = card.querySelector('.link-diff');
  if (diffEl) diffEl.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('diff.html') + '#' + site.id });
    sendToBackground({ action: 'refreshSiteContent', siteId: site.id });
    window.close();
  });

  card.addEventListener('keydown', onCardKeyDown);

  // A1: Enter/Spacja na karcie (na .site-info) otwiera \u201eotwieran\u0105 stron\u0119"
  // \u2014 dot\u0105d obs\u0142uga klawiatury ko\u0144czy\u0142a si\u0119 na strza\u0142kach z drag.js.
  // Nie przechwytujemy klawisza, gdy fokus jest na przycisku/linku wewn\u0105trz.
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    e.preventDefault();
    chrome.tabs.create({ url: site.openUrl || site.url });
    sendToBackground({ action: 'refreshSiteContent', siteId: site.id });
    window.close();
  });

  return card;
}

function findCard(siteId) {
  return Array.from(document.querySelectorAll('.site-card')).find((c) => c.dataset.id === siteId) || null;
}

// Screen-reader announcements: buildCard() replaces the whole card node,
// so per-card aria-live regions are recreated with content (SRs do not
// announce those). Announce status changes in ONE persistent live region.
function announce(text) {
  const live = document.getElementById("sr-live");
  if (!live || !text) return;
  live.textContent = "";
  requestAnimationFrame(() => { live.textContent = text; });
}

async function refreshCard(siteId, flash = null) {
  const data = await chrome.storage.local.get('sites');
  const site = (data.sites || []).find((s) => s.id === siteId);
  const card = findCard(siteId);
  if (!card || card.classList.contains('dragging')) return;

  card.replaceWith(buildCard(site, flash));
  if (flash && flash.text) announce(flash.text);
}

function enterDeleteConfirm(card, site) {
  const t = TRANSLATIONS[currentLang];

  document.querySelectorAll('.site-card.confirming').forEach((c) => {
    if (c !== card) refreshCard(c.dataset.id);
  });

  card.classList.add('confirming');
  card.innerHTML = `
    <div class="confirm-text">
      <div class="confirm-name">${escapeHtml(site.name)}</div>
      <div>${t.confirmDelete}</div>
    </div>
    <div class="actions">
      <button class="btn-icon btn-confirm-yes">${t.btnYes}</button>
      <button class="btn-icon btn-confirm-no">${t.btnNo}</button>
    </div>
  `;

  card.querySelector('.btn-confirm-yes').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSite(site.id);
  });

  const noBtn = card.querySelector('.btn-confirm-no');
  noBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshCard(site.id);
  });
  noBtn.focus();

  // A3: Escape anuluje potwierdzenie usuwania (karta i tak jest
  // przebudowywana przez refreshCard, wi\u0119c listener znika razem z ni\u0105).
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    refreshCard(site.id);
  });
}

async function renderSites() {
  const container = document.getElementById('sites-container');
  const data = await chrome.storage.local.get('sites');
  const sites = data.sites || [];

  document.getElementById('site-count-badge').textContent = `(${sites.length}/${MAX_SITES})`;

  // Pusty stan (U6): zamiast pustego kontenera \u2014 wyra\u017ane CTA.
  if (sites.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state';
    emptyEl.textContent = TRANSLATIONS[currentLang].emptyState;
    container.replaceChildren(emptyEl);
    activeSiteCount = 0;
    updateRefreshAllButton();
    sendToBackground({ action: 'updateBadge' });
    return;
  }

  container.replaceChildren(...sites.map((site) => buildCard(site)));

  activeSiteCount = sites.filter((s) => !s.isPaused).length;
  updateRefreshAllButton();

  sendToBackground({ action: 'updateBadge' });
}