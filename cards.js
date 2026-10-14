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
// web_accessible_resources w manifeście) — czyta z lokalnej pamięci
// podręcznej przeglądarki, bez żadnego zapytania do serwera strony czy
// zewnętrznego serwisu (np. Google favicon service).
function faviconUrl(pageUrl, size = 32) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

// Jednolity zestaw ikon liniowych (stroke = currentColor), dzięki czemu
// kolor ikon wynika wyłącznie z CSS i nie zależy od czcionki emoji systemu.
const SVG_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICONS = {
  refresh: `${SVG_OPEN}<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`,
  pause: `${SVG_OPEN}<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
  play: `${SVG_OPEN}<polygon points="6 3 20 12 6 21 6 3"/></svg>`,
  edit: `${SVG_OPEN}<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
  trash: `${SVG_OPEN}<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  warning: '<svg class="icon-inline" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
};

function formatLastCheck(timestamp) {
  const locale = currentLang === 'pl' ? 'pl-PL' : 'en-US';
  const date = new Date(timestamp);
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
  // U4: pauza widoczna też tekstowo, nie tylko przez opacity.
  const pausedBadge = site.isPaused ? `<span class="badge-paused">${t.badgePaused}</span>` : '';
  const badgeHtml = site.hasChanged ? `<span class="badge-changed">${t.badgeNew}</span>` : '';
  const lastCheck = site.lastCheckTime ? formatLastCheck(site.lastCheckTime) : '&mdash;';

  const errorHtml = site.lastError
    ? ` &bull; <span class="meta-error" title="${escapeHtml(site.lastError)}">${ICONS.warning} ${t.checkError}</span>`
    : '';
  const flashHtml = flash
    ? ` &bull; <span class="meta-flash ${flash.kind}" role="status" aria-live="polite">${escapeHtml(flash.text)}</span>`
    : '';
  // U1: link do podglądu zmian — widoczny tylko, gdy jest co pokazać.
  const diffHtml = site.hasChanged && site.prevSnapshot
    ? ` &bull; <a href="#" class="link-diff" title="${t.titleDiff}">${t.linkDiff}</a>`
    : '';

  const isChecking = checkingIds.has(site.id);
  const refreshDisabled = site.isPaused || isChecking;

  card.innerHTML = `
    <button type="button" class="drag-handle" title="${t.titleDrag}" aria-label="${t.titleDrag}"><svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7"/><circle cx="10" cy="3.5" r="1.7"/><circle cx="4" cy="9" r="1.7"/><circle cx="10" cy="9" r="1.7"/><circle cx="4" cy="14.5" r="1.7"/><circle cx="10" cy="14.5" r="1.7"/></svg></button>
    <div class="site-info">
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
    chrome.tabs.create({ url: site.url });
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

  return card;
}

function findCard(siteId) {
  return Array.from(document.querySelectorAll('.site-card')).find((c) => c.dataset.id === siteId) || null;
}

async function refreshCard(siteId, flash = null) {
  const data = await chrome.storage.local.get('sites');
  const site = (data.sites || []).find((s) => s.id === siteId);
  const card = findCard(siteId);
  if (!card || card.classList.contains('dragging')) return;

  if (!site) {
    card.remove();
    return;
  }
  card.replaceWith(buildCard(site, flash));
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
}

async function renderSites() {
  const container = document.getElementById('sites-container');
  const data = await chrome.storage.local.get('sites');
  const sites = data.sites || [];

  document.getElementById('site-count-badge').textContent = `(${sites.length}/${MAX_SITES})`;

  // Pusty stan (U6): zamiast pustego kontenera — wyraźne CTA.
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