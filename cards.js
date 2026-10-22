function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[m]);
}

// Favicona przez wbudowane API chrome://favicon (uprawnienie "favicon";
// działa na stronach własnych rozszerzenia bez web_accessible_resources)
// — czyta z lokalnej pamięci podręcznej przeglądarki, bez żadnego
// zapytania do serwera strony czy zewnętrznego serwisu (np. Google
// favicon service).
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

// I3: czas względny dla świeżych sprawdzeń („X min temu"), dokładna data
// tylko dla starszych niż 24 h — użytkownik od razu widzi, jak „świeże"
// jest ostatnie sprawdzenie, bez porównywania zegarka z etykietą.
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

// Maps raw error messages from background.js to short, translated labels.
function errorLabel(raw, t) {
  const msg = String(raw || '');
  const http = msg.match(/^HTTP (\d{3})/);
  if (http) return `HTTP ${http[1]}`;
  if (/^Timeout/i.test(msg)) return t.errTimeout;
  if (/^Selector not found/i.test(msg)) return t.errSelectorNotFound;
  if (/^Invalid selector/i.test(msg)) return t.errSelectorInvalid;
  if (/login page/i.test(msg)) return t.errLoginRequired;
  if (/too large/i.test(msg)) return t.errTooLarge;
  if (/produced no text/i.test(msg)) return t.errNoText;
  if (/Tab closed/i.test(msg)) return t.errTabClosed;
  if (/Failed to fetch|NetworkError|Load failed|Page failed to load|could not load/i.test(msg)) return t.errNetwork;
  if (/Site unreachable/i.test(msg)) return t.errUnreachable;
  return msg.length > 40 ? msg.slice(0, 40) + '\u2026' : (msg || t.checkError);
}

// Custom interval label: "15 min", "3 hr", "2 d" (PL: "3 godz.", "2 dn.").
// Audyt: jednolita forma "godz." (z kropka) tez na karcie; EN "hr"/"hrs".
function formatInterval(minutes) {
  const pl = currentLang === 'pl';
  if (minutes % 1440 === 0) return `${minutes / 1440} ${pl ? 'dn.' : 'd'}`;
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    if (pl) return `${h} godz.`;
    return h === 1 ? '1 hr' : `${h} hrs`;
  }
  return `${minutes} min`;
}

function buildCard(site, flash = null) {
  const t = TRANSLATIONS[currentLang];
  const card = document.createElement('div');
  card.className = `site-card ${site.isPaused ? 'paused' : ''}`;
  card.dataset.id = site.id;
  card.dataset.name = site.name;
  // Audyt#2/ust.8: JEDEN przystanek Tab na karte (.site-info).
  // Przyciski (uchwyt + 4 ikony) wychodza z kolejnosci Tab (tabindex="-1");
  // strzalki <-/-> wchodza w rzad przyciskow i po nim wedruja, Esc wraca
  // na karte. Bez tego 8 stron = 75 przystankow Tab. ↑/↓ (drag.js) bez zmian.
  const ROVING_OFF = ' tabindex="-1"';

  const labelFreq = site.freqMinutes ? formatInterval(site.freqMinutes) : (t.freqLabels[site.freqIndex] || t.freqLabels[0]);
  // U4: pauza widoczna też tekstowo, nie tylko przez opacity.
  const pausedBadge = site.isPaused ? `<span class="badge-paused">${t.badgePaused}</span>` : '';
  const badgeHtml = site.hasChanged ? `<span class="badge-changed">${t.badgeNew}</span>` : '';
  const lastCheck = site.lastCheckTime ? formatLastCheck(site.lastCheckTime) : '&mdash;';

  // Audyt#2/drobiazgi: blad w OSOBNEJ linii pod meta (przy bladzie +
  // podpowiedzi JS meta zawijala sie do 3 linii i zmieniala wysokosc
  // karty). Krotki, czytelny powod; surowa tresc w tooltipie.
  const errorHtml = site.lastError
    ? `<div class="site-error-line"><span class="meta-error" title="${escapeHtml(site.lastError)}">${ICONS.warning} ${escapeHtml(errorLabel(site.lastError, t))}</span></div>`
    : '';
  const flashHtml = flash
    ? ` &bull; <span class="meta-flash ${flash.kind}" role="status" aria-live="polite">${escapeHtml(flash.text)}</span>`
    : '';
  // U1: link do podglądu zmian — widoczny tylko przy NIEODCZYTANEJ zmianie.
  // Kliknięcie otwiera diff i czyści hasChanged (refreshSiteContent),
  // więc po obejrzeniu zmian przycisk znika.
  // Heuristic flag: the page shell is large but readable text is tiny ->
  // suggest switching to rendered mode (JS draws the content).
  const suggestHtml = site.suggestRendered
    ? ` &bull; <span class="badge-suggest" title="${escapeHtml(t.suggestRendered)}">${t.suggestRenderedShort}</span>`
    : '';
  // The link stays as long as a stored previous version exists (not only while
  // the change is unread) - opening the page must not remove access to the diff.
  // Link only for an UNREAD change (cleared once the page/diff is opened).
  const diffHtml = site.hasChanged && site.prevSnapshot
    ? ` &bull; <a href="#" class="link-diff" title="${t.titleDiff}">${t.linkDiff}</a>`
    : '';

  const isChecking = checkingIds.has(site.id);
  const refreshDisabled = site.isPaused || isChecking;

  // Audyt a11y: aria-label karty oglaszal tylko nazwe - czytnik ekranu nie
  // slyszal mety (odstep, ostatnie sprawdzenie, NOWE, bledu). Label =
  // nazwa + te same informacje, ktore widza widzacy.
  const ariaParts = [labelFreq];
  if (site.isPaused) ariaParts.push(t.badgePaused);
  if (site.hasChanged) ariaParts.push(t.badgeNew);
  if (site.lastError) ariaParts.push(errorLabel(site.lastError, t));
  if (site.suggestRendered) ariaParts.push(t.suggestRendered);
  ariaParts.push(`${t.lastCheck}: ${lastCheck}`);
  const ariaLabel = `${escapeHtml(site.name)}. ${escapeHtml(ariaParts.join(', '))}`;

  card.innerHTML = `
    <button type="button" class="drag-handle"${ROVING_OFF} title="${t.titleDrag}" aria-label="${t.titleDrag}"><svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7"/><circle cx="10" cy="3.5" r="1.7"/><circle cx="4" cy="9" r="1.7"/><circle cx="10" cy="9" r="1.7"/><circle cx="4" cy="14.5" r="1.7"/><circle cx="10" cy="14.5" r="1.7"/></svg></button>
    <div class="site-info" tabindex="0" role="button" aria-label="${ariaLabel}">
      <div class="site-name" title="${escapeHtml(site.name)}"><img class="site-favicon" src="${faviconUrl(site.url, 32)}" width="18" height="18" alt="" aria-hidden="true">${escapeHtml(site.name)}${pausedBadge}${badgeHtml}</div>
      <div class="site-meta">${labelFreq} &bull; ${t.lastCheck}: ${lastCheck}${flashHtml}${suggestHtml}${diffHtml}</div>
      ${errorHtml}
    </div>
    <div class="actions">
      <button class="btn-icon btn-refresh${isChecking ? ' spinning' : ''}"${ROVING_OFF} title="${t.titleRefresh}" aria-label="${t.titleRefresh}"${refreshDisabled ? ' disabled' : ''}><span class="icon">${ICONS.refresh}</span></button>
      <button class="btn-icon btn-toggle"${ROVING_OFF} title="${site.isPaused ? t.titleResume : t.titlePause}" aria-label="${site.isPaused ? t.titleResume : t.titlePause}">${site.isPaused ? ICONS.play : ICONS.pause}</button>
      <button class="btn-icon btn-edit"${ROVING_OFF} title="${t.titleEditBtn}" aria-label="${t.titleEditBtn}">${ICONS.edit}</button>
      <button class="btn-icon btn-delete"${ROVING_OFF} title="${t.titleDeleteBtn}" aria-label="${t.titleDeleteBtn}">${ICONS.trash}</button>
    </div>
    <div class="delete-confirm" hidden>
      <span class="dc-title">${t.deleteConfirmTitle}</span>
      <button type="button" class="btn-danger dc-yes" data-i18n="btnDeleteYes">${t.btnDeleteYes}</button>
      <button type="button" class="btn-secondary dc-no" data-i18n="btnCancel">${t.btnCancel}</button>
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
    favIcon.addEventListener('error', () => { favIcon.style.display = 'none'; }, { once: true });
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
    // Audyt UX#2: edycja otwiera sie w karcie przegladarki (formularz
    // nie miescil sie w popupie), nie w widoku popupu.
    openEditTab(site.id);
  });

  card.querySelector('.btn-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    // Audyt: potwierdzenie usuwania NA SAMEJ KARCIE - poprzednio pojawialo
    // sie w stopce (daleko od kafelka), a "Usun" i "Anuluj" wygladaly
    // identycznie. Czerwony "Usun" + neutralne "Anuluj"; Cofnij w
    // podsumowaniu pokrywa omylkowe potwierdzenie.
    card.classList.add('confirming');
    const actionsRow = card.querySelector('.actions');
    const confirmRow = card.querySelector('.delete-confirm');
    if (actionsRow) actionsRow.hidden = true;
    if (confirmRow) {
      confirmRow.hidden = false;
      const yes = confirmRow.querySelector('.dc-yes');
      if (yes) yes.focus();
    }
  });
  card.querySelector('.dc-yes').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSite(site.id);
  });
  card.querySelector('.dc-no').addEventListener('click', (e) => {
    e.stopPropagation();
    card.classList.remove('confirming');
    const confirmRow = card.querySelector('.delete-confirm');
    const actionsRow = card.querySelector('.actions');
    if (confirmRow) confirmRow.hidden = true;
    if (actionsRow) actionsRow.hidden = false;
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

  // Audyt#2/ust.8: roaming po przyciskach karty. Tab ląduje tylko na
  // .site-info; ←/→ wchodzą w rząd przycisków (uchwyt + 4 ikony) i po nim
  // krążą (pomijając disabled), Esc wraca na kartę. Potwierdzenie usuwania
  // (dc-yes/dc-no) zostaje w naturalnej kolejności — fokus i tak trafia
  // tam programowo, a akcje Usuń/Anuluj muszą być dostepne klawiszem.
  const infoEl = card.querySelector('.site-info');
  const rovingBtns = () => Array.from(
    card.querySelectorAll('.drag-handle, .actions .btn-icon')
  ).filter((b) => !b.disabled && b.offsetParent !== null);
  const focusInfo = () => infoEl.focus();

  card.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Escape') return;
    // Nie wchodzimy w rząd, gdy otwarte jest potwierdzenie usuwania
    // (wtedy klawiatura obsługuję wyłącznie Usuń/Anuluj).
    if (!card.querySelector('.delete-confirm').hidden) return;
    const btns = rovingBtns();
    if (!btns.length) return;
    const idx = btns.indexOf(document.activeElement);

    if (e.key === 'Escape') {
      if (idx !== -1) { e.preventDefault(); focusInfo(); }
      return;
    }
    const fwd = e.key === 'ArrowRight';
    if (idx === -1) {
      // Fokus na .site-info (lub poza przyciskami): wchodzimy od krawędzi.
      if (fwd || !infoEl.contains(document.activeElement)) {
        e.preventDefault();
        btns[fwd ? 0 : btns.length - 1].focus();
      }
      return;
    }
    e.preventDefault();
    const next = (idx + (fwd ? 1 : -1) + btns.length) % btns.length;
    if (next === (fwd ? 0 : btns.length - 1)) {
      // Pełne koło: wracamy na kartę zamiast krążyć w nieskończoność.
      focusInfo();
    } else {
      btns[next].focus();
    }
  });

  // A1: Enter/Spacja na karcie (na .site-info) otwiera „otwieraną stronę"
  // — dotąd obsługa klawiatury kończyła się na strzałkach z drag.js.
  // Nie przechwytujemy klawisza, gdy fokus jest na przycisku/linku wewnątrz.
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
  syncGroupBadges(data.sites || []);
  if (flash && flash.text) announce(flash.text);
}

async function renderSites() {
  const container = document.getElementById('sites-container');
  const data = await chrome.storage.local.get(['sites', 'groups', 'groupTipDone']);
  const sites = data.sites || [];
  const groups = data.groups || [];
  // Audyt: licznik CALKOWITY (tez pauzowane) dla wygaszania "Oznacz jako
  // przeczytane" w pustym stanie (zob. updateRefreshAllButton).
  totalSiteCount = sites.length;
  // The drag tip is only needed until the user has discovered grouping.
  groupTipDone = Boolean(data.groupTipDone) || groups.length > 0;

  document.getElementById('site-count-badge').textContent = `(${sites.length}/${MAX_SITES})`;

  // Pusty stan (U6): zamiast pustego kontenera — wyrażne CTA.
  if (sites.length === 0) {
    // Empty state: duzy przycisk CTA zamiast samego tekstu - od razu
    // widoczna sciezka "co robic", a pod nim czytelna wskazowka o menu
    // kontekstowym (duza czcionka, pelny kontrast).
    const t = TRANSLATIONS[currentLang];
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'btn-main empty-cta';
    // \uff0b (fullwidth plus) zapisany escape'em: doslowny znak UTF-8 byl
    // uszkodzony przy transporcie (mojibake na pustym stanie).
    cta.textContent = `\uff0b ${t.emptyStateCta}`;
    cta.addEventListener('click', () => { openAddForm(); });
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = t.emptyStateHint;
    wrap.append(cta, hint);
    container.replaceChildren(wrap);
    activeSiteCount = 0;
    updateRefreshAllButton();
    sendToBackground({ action: 'updateBadge' });
    return;
  }

  // I5: "changed only" filter (toggled from the batch summary). The count
  // badge still shows the real total.
  const visible = changedOnly ? sites.filter((s) => s.hasChanged) : sites;

  if (changedOnly && visible.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state';
    emptyEl.textContent = TRANSLATIONS[currentLang].emptyFiltered;
    container.replaceChildren(emptyEl);
    updateRefreshAllButton();
    return;
  }

  // Ungrouped pages are cards; a group is drawn once, at the position of its
  // first member, with all its members inside.
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const emitted = new Set();
  const nodes = [];
  for (const site of visible) {
    const group = site.groupId ? groupById.get(site.groupId) : null;
    if (!group) {
      nodes.push(buildCard(site));
      continue;
    }
    if (emitted.has(group.id)) continue;
    emitted.add(group.id);
    nodes.push(buildGroup(
      group,
      visible.filter((s) => s.groupId === group.id),
      sites.filter((s) => s.groupId === group.id)
    ));
  }
  container.replaceChildren(...nodes);

  // Podpowiedź o grupowaniu: RAZ, gdy uzytkownik ma wlasnie 2 strony (wtedy
  // grupowanie staje sie przydatne, a jeszcze nie ma o nim pojecia). Flaga
  // w storage gwarantuje jednorazowosc - nie przeszkadzamy na kazdym
  // renderze ani przy kolejnych uruchomieniach.
  if (sites.length >= 2 && typeof showSummaryNodes === 'function') {
    try {
      const flag = await chrome.storage.local.get('hintGroupShown');
      if (!flag.hintGroupShown) {
        await chrome.storage.local.set({ hintGroupShown: true });
        const t = TRANSLATIONS[currentLang];
        showSummaryNodes([summaryText(t.groupHint)], 'ok', 9000);
      }
    } catch (err) { /* storage niedostepny: pomijamy podpowiedz */ }
  }

  activeSiteCount = sites.filter((s) => !s.isPaused).length;
  updateRefreshAllButton();

  sendToBackground({ action: 'updateBadge' });
}