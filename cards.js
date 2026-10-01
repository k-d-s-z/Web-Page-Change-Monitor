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
// zewnętrznego serwisu (np. Google favicon service), co złamałoby model
// prywatności reszty rozszerzenia.
function faviconUrl(pageUrl, size = 32) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

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
  const badgeHtml = site.hasChanged ? `<span class="badge-changed">${t.badgeNew}</span>` : '';
  const lastCheck = site.lastCheckTime ? formatLastCheck(site.lastCheckTime) : '&mdash;';

  const errorHtml = site.lastError
    ? ` &bull; <span class="meta-error" title="${escapeHtml(site.lastError)}">&#x26A0; ${t.checkError}</span>`
    : '';
  const flashHtml = flash
    ? ` &bull; <span class="meta-flash ${flash.kind}" role="status" aria-live="polite">${escapeHtml(flash.text)}</span>`
    : '';

  const isChecking = checkingIds.has(site.id);
  const refreshDisabled = site.isPaused || isChecking;

  card.innerHTML = `
    <button type="button" class="drag-handle" title="${t.titleDrag}" aria-label="${t.titleDrag}"><svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7"/><circle cx="10" cy="3.5" r="1.7"/><circle cx="4" cy="9" r="1.7"/><circle cx="10" cy="9" r="1.7"/><circle cx="4" cy="14.5" r="1.7"/><circle cx="10" cy="14.5" r="1.7"/></svg></button>
    <div class="site-info">
      <div class="site-name"><img class="site-favicon" src="${faviconUrl(site.url, 32)}" width="14" height="14" alt="" aria-hidden="true">${escapeHtml(site.name)}${badgeHtml}</div>
      <div class="site-meta">${labelFreq} &bull; ${t.lastCheck}: ${lastCheck}${errorHtml}${flashHtml}</div>
    </div>
    <div class="actions">
      <button class="btn-icon btn-refresh${isChecking ? ' spinning' : ''}" title="${t.titleRefresh}" aria-label="${t.titleRefresh}"${refreshDisabled ? ' disabled' : ''}><span class="icon">&#x1F504;</span></button>
      <button class="btn-icon btn-toggle" title="${t.titleToggle}" aria-label="${t.titleToggle}">${site.isPaused ? '&#x25B6;' : '&#x275A;&#x275A;'}</button>
      <button class="btn-icon btn-edit" title="${t.titleEditBtn}" aria-label="${t.titleEditBtn}">&#x270F;&#xFE0F;</button>
      <button class="btn-icon btn-delete" title="${t.titleDeleteBtn}" aria-label="${t.titleDeleteBtn}">&#x1F5D1;&#xFE0F;</button>
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

  container.replaceChildren(...sites.map((site) => buildCard(site)));
  document.getElementById('site-count-badge').textContent = `(${sites.length}/${MAX_SITES})`;
  
  activeSiteCount = sites.filter((s) => !s.isPaused).length;
  updateRefreshAllButton();

  sendToBackground({ action: 'updateBadge' });
}