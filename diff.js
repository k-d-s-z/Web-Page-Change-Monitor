// Diff "przed \u2192 po" dla strony wskazanej w hashu URL (diff.html#<siteId>).
// Dane czytane bezpo\u015brednio z chrome.storage.local \u2014 nie przechodz\u0105 przez
// service worker, wi\u0119c strona dzia\u0142a nawet gdy SW \u015bpi.
//
// Algorytm: LCS na liniach, a wewn\u0105trz bloku zmienionych linii ten sam LCS
// na s\u0142owach (kr\u00f3tkie ci\u0105gi) dla efektu <del>stare</del><ins>nowe</ins>.
//
// Czytelno\u015b\u0107: niezmienione ci\u0105gi d\u0142u\u017csze ni\u017c 10 linii s\u0105 zwijane do
// klikalnego separatora "\u22ef N niezmienionych linii \u22ef" \u2014 zmiany wida\u0107 od
// razu, bez przewijania morza identycznego tekstu. Pasek narz\u0119dzi pokazuje
// statystyki +dodane/\u2212usuni\u0119te.
//
// B2: "Otw\u00f3rz stron\u0119" prowadzi do site.openUrl (URL monitorowany mo\u017ce by\u0107
// endpointem JSON, nieczytelnym dla cz\u0142owieka); w metadanych pokazujemy
// oba URL-e, gdy si\u0119 r\u00f3\u017cni\u0105. Strona t\u0142umaczy si\u0119 na PL/EN (D1) zgodnie
// z j\u0119zykiem zapisanym w storage.

const CONTEXT_LINES = 3;   // ile linii kontekstu wok\u00f3\u0142 ka\u017cdego bloku zmian
const COLLAPSE_MIN = 10;   // d\u0142u\u017csze niezmienione ci\u0105gi s\u0105 zwijane

// Audyt: wlasmny slownik STR przeniesiony do i18n.js (klucze diff*), zeby
// wszystkie tlumaczenia rozszerzenia zyly w jednym miejscu. diff.html ladowal
// i18n.js przed diff.js, wiec TRANSLATIONS jest tu dostepne.

function esc(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  })[c]);
}

// Zwraca list\u0119 operacji: {t:'eq'|'del'|'ins', l:string}
function computeOps(a, b) {
  const n = a.length;
  const m = b.length;

  // Zabezpieczenie przed O(n\u00b7m) na ogromnych zestawach (np. snapshot
  // uci\u0119ty do limitu 150k znak\u00f3w mo\u017ce da\u0107 ~10k linii): zamiast zawiesi\u0107
  // stron\u0119, pokazujemy "wszystko wymienione" w blokach.
  if (n * m > 4_000_000) {
    const ops = [];
    a.forEach((l) => ops.push({ t: 'del', l }));
    b.forEach((l) => ops.push({ t: 'ins', l }));
    ops.simplified = true;
    return ops;
  }

  // dp[i][j] = d\u0142ugo\u015b\u0107 LCS a[i:] i b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', l: b[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', l: a[i] });
      i++;
    } else {
      ops.push({ t: 'ins', l: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'del', l: a[i++] });
  while (j < m) ops.push({ t: 'ins', l: b[j++] });
  return ops;
}

// Word-diff wewn\u0105trz PARY linii (1 usuni\u0119ta + 1 dodana).
function renderInline(oldLine, newLine) {
  const ops = computeOps(oldLine.split(' '), newLine.split(' '));
  let out = '';
  for (const op of ops) {
    if (op.t === 'eq') out += esc(op.l) + ' ';
    else if (op.t === 'del') out += `<del>${esc(op.l)}</del> `;
    else out += `<ins>${esc(op.l)}</ins> `;
  }
  return out.replace(/\s+$/, '');
}

function line(kind, inner, lineText) {
  const cls = lineText ? `diff-line ${kind}` : 'diff-line empty';
  return `<span class="${cls}">${inner || '\u00a0'}</span>`;
}

function eqLine(text) {
  return line('equivalent', esc(text), text);
}

// Grupuje operacje: ci\u0105gi 'eq' i bloki zmian (del/ins).
function groupOps(ops) {
  const groups = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === 'eq') {
      const lines = [];
      while (k < ops.length && ops[k].t === 'eq') lines.push(ops[k++].l);
      groups.push({ type: 'eq', lines });
    } else {
      const block = [];
      while (k < ops.length && ops[k].t !== 'eq') block.push(ops[k++]);
      groups.push({ type: 'chg', ops: block });
    }
  }
  return groups;
}

// Blok zmian: pary del/ins (do 3 par) renderowane word-diffem liniowo,
// reszta jako osobne linie dodane/usuni\u0119te.
// Audyt: podobie\u0144stwo dw\u00f3ch linii jako u\u0142amek wsp\u00f3lnych s\u0142\u00f3w -
// "Cena: 199 z\u0142" vs "Cena: 179 z\u0142" to edycja, nie "usuni\u0119to + dodano".
function wordSimilarity(x, y) {
  const wx = x.split(/\s+/).filter(Boolean);
  const wy = y.split(/\s+/).filter(Boolean);
  if (!wx.length || !wy.length) return 0;
  const set = new Set(wy);
  let shared = 0;
  wx.forEach((w) => { if (set.has(w)) shared++; });
  return shared / Math.max(wx.length, wy.length);
}

// Paruje zach\u0142annie najbardziej podobne pary del/ins (pr\u00f3g 0.5),
// deterministycznie: najlepszy wynik pierwszy, remisy po kolejno\u015bci.
function pairChangedLines(dels, ins) {
  const cands = [];
  dels.forEach((d, di) => ins.forEach((n, ni) => {
    const score = wordSimilarity(d.l, n.l);
    if (score >= 0.5) cands.push({ di, ni, score });
  }));
  cands.sort((a, b) => b.score - a.score || a.di - b.di || a.ni - b.ni);
  const usedD = new Set();
  const usedI = new Set();
  const pairs = [];
  for (const c of cands) {
    if (usedD.has(c.di) || usedI.has(c.ni)) continue;
    usedD.add(c.di);
    usedI.add(c.ni);
    pairs.push({ del: dels[c.di], ins: ins[c.ni] });
  }
  return {
    pairs,
    restDel: dels.filter((_, idx) => !usedD.has(idx)),
    restIns: ins.filter((_, idx) => !usedI.has(idx))
  };
}

function renderChangeBlock(block) {
  let html = '';
  const dels = block.filter((o) => o.t === 'del');
  const ins = block.filter((o) => o.t === 'ins');
  if (!dels.length || !ins.length) {
    dels.forEach((o) => { html += line('removed', `<del>${esc(o.l)}</del>`, o.l); });
    ins.forEach((o) => { html += line('added', `<ins>${esc(o.l)}</ins>`, o.l); });
    return html;
  }

  // R\u00f3wne liczby linii: parowanie po kolejno\u015bci (do 3 par word-diffem),
  // wi\u0119ksze bloki zostaj\u0105 czytelne jako osobne linie (jak dotychczas).
  if (dels.length === ins.length) {
    if (dels.length <= 3) {
      for (let p = 0; p < dels.length; p++) {
        html += line('changed', renderInline(dels[p].l, ins[p].l), dels[p].l);
      }
    } else {
      dels.forEach((o) => { html += line('removed', `<del>${esc(o.l)}</del>`, o.l); });
      ins.forEach((o) => { html += line('added', `<ins>${esc(o.l)}</ins>`, o.l); });
    }
    return html;
  }

  // R\u00f3\u017cne liczby linii (audyt): sparuj podobne linie s\u0142owo w s\u0142owo,
  // reszt\u0119 poka\u017c jako zwyk\u0142e usuni\u0119te/dodane.
  const { pairs, restDel, restIns } = pairChangedLines(dels, ins);
  if (pairs.length) {
    for (const pr of pairs) {
      html += line('changed', renderInline(pr.del.l, pr.ins.l), pr.del.l);
    }
    restDel.forEach((o) => { html += line('removed', `<del>${esc(o.l)}</del>`, o.l); });
    restIns.forEach((o) => { html += line('added', `<ins>${esc(o.l)}</ins>`, o.l); });
    return html;
  }

  dels.forEach((o) => { html += line('removed', `<del>${esc(o.l)}</del>`, o.l); });
  ins.forEach((o) => { html += line('added', `<ins>${esc(o.l)}</ins>`, o.l); });
  return html;
}
// Renderuje diff ze zwijaniem: zwraca { html, skipped, added, removed }.
function renderDiff(oldLines, newLines, t, onlyChanges) {
  const ops = computeOps(oldLines, newLines);
  const groups = groupOps(ops);

  let added = 0;
  let removed = 0;
  for (const g of groups) {
    if (g.type !== 'chg') continue;
    for (const o of g.ops) {
      if (o.t === 'ins') added++;
      else removed++;
    }
  }

  let html = '';
  const skipped = [];

  groups.forEach((g, gi) => {
    if (g.type === 'chg') {
      html += renderChangeBlock(g.ops);
      return;
    }


    // Tryb "tylko zmiany": pomijamy wszystkie niezmienione linie -
    // zostaj\u0105 wy\u0142\u0105cznie bloki +/\u2212 (realne zmiany).
    if (onlyChanges) return;
    const isFirst = gi === 0;
    const isLast = gi === groups.length - 1;
    const n = g.lines.length;

    if (n <= COLLAPSE_MIN) {
      html += g.lines.map(eqLine).join('');
      return;
    }

    // D\u0142ugi niezmieniony ci\u0105g: kontekst przy s\u0105siaduj\u0105cych zmianach,
    // reszt\u0119 zwijamy do klikalnego separatora.
    const head = isFirst ? 0 : CONTEXT_LINES;
    const tail = isLast ? 0 : CONTEXT_LINES;

    html += g.lines.slice(0, head).map(eqLine).join('');

    const hidden = g.lines.slice(head, n - tail);
    if (hidden.length > 0) {
      skipped.push(hidden.map(eqLine).join(''));
      html += `<span class="diff-skip" data-skip="${skipped.length - 1}" title="${t.skipTitle}" role="button" tabindex="0">\u22ef ${hidden.length} ${t.skipLines} \u22ef</span>`;
    }

    html += g.lines.slice(n - tail).map(eqLine).join('');
  });

  return { html, skipped, added, removed, simplified: Boolean(ops.simplified) };
}

// Podpina rozwijanie zwini\u0119tych fragment\u00f3w (klik / Enter/Spacja).
function wireSkipToggle(box, skipped) {
  box.querySelectorAll('.diff-skip').forEach((el) => {
    const expand = () => {
      const idx = Number(el.dataset.skip);
      el.insertAdjacentHTML('afterend', skipped[idx] || '');
      el.remove();
    };
    el.addEventListener('click', expand);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        expand();
      }
    });
  });
}

async function main() {
  const siteId = decodeURIComponent(location.hash.slice(1));
  const { sites, language, theme } = await chrome.storage.local.get(['sites', 'language', 'theme']);
  // Audyt: tlumaczenia z i18n.js (klucze diff*); alias mapuje je na krotkie
  // nazwy uzywane nizej, zeby reszta pliku nie wymagala przepisywania.
  const T = TRANSLATIONS[language === 'pl' ? 'pl' : 'en'];
  // Audyt#2/ust.6: format daty zgodny z jezykiem interfejsu (jak w cards.js),
  // zamiast domyslnego "10/22/2026, 6:17:30 AM" przy polskim UI.
  const locale = language === 'pl' ? 'pl-PL' : 'en-US';
  const t = {
    title: T.diffTitle,
    openPage: T.diffOpenPage,
    siteNotFound: T.diffSiteNotFound,
    noVersionYet: T.diffNoVersionYet,
    onlyCurrent: T.diffOnlyCurrent,
    noChanges: T.diffNoChanges,
    monitoredUrl: T.diffMonitoredUrl,
    skipLines: T.diffSkipLines,
    skipTitle: T.diffSkipTitle,
    added: T.diffAdded,
    removed: T.diffRemoved,
    onlyChanges: T.diffOnlyChanges,
    diffSimplified: T.diffSimplified,
    statsReplaced: T.diffStatsReplaced
  };

  document.documentElement.lang = language === 'pl' ? 'pl' : 'en';
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  document.title = t.title;
  document.getElementById('open-label').textContent = t.openPage;
  document.getElementById('only-changes-label').textContent = t.onlyChanges;

  const site = (sites || []).find((s) => s.id === siteId);

  const box = document.getElementById('diff');
  const openEl = document.getElementById('open');
  if (!site) {
    openEl.style.display = 'none';
    box.innerHTML = `<span class="empty">${t.siteNotFound}</span>`;
    return;
  }

  // B2: otwieramy "otwieran\u0105 stron\u0119" (site.openUrl) \u2014 URL monitorowany
  // mo\u017ce by\u0107 endpointem JSON, kt\u00f3rego cz\u0142owiek nie chce czyta\u0107 surowy.
  const openUrl = site.openUrl || site.url;
  openEl.href = openUrl;

  document.getElementById('title').textContent = site.name;
  let metaText = site.changedAt
    ? `${new Date(site.changedAt).toLocaleString(locale)} \u2022 ${openUrl}`
    : openUrl;
  if (openUrl !== site.url) metaText += ` \u2022 ${t.monitoredUrl}: ${site.url}`;
  document.getElementById('meta').textContent = metaText;

  if (!site.prevSnapshot && !site.lastSnapshot) {
    box.innerHTML = `<span class="empty">${t.noVersionYet}</span>`;
    return;
  }
  if (!site.prevSnapshot) {
    box.innerHTML = `<span class="empty">${t.onlyCurrent}</span>`;
    return;
  }

  const oldLines = site.prevSnapshot.split('\n');
  const newLines = (site.lastSnapshot || '').split('\n');

  // Przelacznik "tylko zmiany" w pasku narzedzi: ukrywa wszystkie
  // niezmienione linie, zostawia wylacznie bloki +/- (realne zmiany).
  // Przerenderowuje widok bez przeladowania strony.
  const statsEl = document.getElementById('stats');
  const render = (onlyChanges) => {
    const { html, skipped, added, removed, simplified } = renderDiff(oldLines, newLines, t, onlyChanges);

    // Stats: labelled counts ("Added: 3" / "Removed: 5") - clearer than bare
    // +3/-5. When the LCS fallback kicked in, show line counts instead.
    if (statsEl) {
      statsEl.innerHTML = simplified
        ? `<span class="stat-add" title="${t.statsReplaced}">${t.statsReplaced}: ${oldLines.length} \u2192 ${newLines.length}</span>`
        : `<span class="stat-add" title="${t.added}">${t.added}: ${added}</span>` +
          `<span class="stat-del" title="${t.removed}">${t.removed}: ${removed}</span>`;
    }
    // Notice for the simplified (fallback) comparison mode.
    const notice = simplified ? '<span class="diff-skip" style="display:block;margin-bottom:6px">' + t.diffSimplified + ' (' + oldLines.length + ' \u2192 ' + newLines.length + ')</span>' : '';
    box.innerHTML = notice + (html || `<span class="empty">${t.noChanges}</span>`);
    wireSkipToggle(box, skipped);
  };

  const onlyEl = document.getElementById('only-changes');
  if (onlyEl) {
    // Audyt#2/ust.6: domyslnie PELNY widok (3 linie kontekstu wokol zmian),
    // a nie same zmienione linie - zmiana bez kontekstu jest nieczytelna.
    onlyEl.checked = false;
    onlyEl.addEventListener('change', () => render(onlyEl.checked));
  }
  render(onlyEl ? onlyEl.checked : false);
}


main();