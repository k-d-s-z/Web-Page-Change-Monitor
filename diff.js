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

const STR = {
  en: {
    title: 'Change details \u2014 Web Page Change Monitor',
    openPage: 'Open page',
    siteNotFound: 'Site not found.',
    noVersionYet: 'No stored version of this page yet \u2014 the next detected change will show a full diff.',
    onlyCurrent: 'Only the current version is stored (baseline saved after the update). The next detected change will show a diff.',
    noChanges: 'No visible text changes.',
    monitoredUrl: 'monitored',
    skipLines: 'unchanged lines',
    skipTitle: 'Click to show these lines',
    added: 'added',
    removed: 'removed'
  },
  pl: {
    title: 'Szczeg\u00f3\u0142y zmiany \u2014 Web Page Change Monitor',
    openPage: 'Otw\u00f3rz stron\u0119',
    siteNotFound: 'Nie znaleziono takiej strony.',
    noVersionYet: 'Nie ma jeszcze zapisanej wersji tej strony \u2014 kolejna wykryta zmiana poka\u017ce pe\u0142ny diff.',
    onlyCurrent: 'Zapisana jest tylko bie\u017c\u0105ca wersja (baseline zapisany po aktualizacji). Kolejna wykryta zmiana poka\u017ce diff.',
    noChanges: 'Brak widocznych zmian tre\u015bci.',
    monitoredUrl: 'monitorowany',
    skipLines: 'niezmienionych linii',
    skipTitle: 'Kliknij, aby pokaza\u0107 te linie',
    added: 'dodane',
    removed: 'usuni\u0119te'
  }
};

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
function renderChangeBlock(block) {
  let html = '';
  const dels = block.filter((o) => o.t === 'del');
  const ins = block.filter((o) => o.t === 'ins');

  if (dels.length === ins.length && dels.length > 0 && dels.length <= 3) {
    for (let p = 0; p < dels.length; p++) {
      html += line('changed', renderInline(dels[p].l, ins[p].l), dels[p].l);
    }
  } else {
    dels.forEach((o) => { html += line('removed', `<del>${esc(o.l)}</del>`, o.l); });
    ins.forEach((o) => { html += line('added', `<ins>${esc(o.l)}</ins>`, o.l); });
  }
  return html;
}

// Renderuje diff ze zwijaniem: zwraca { html, skipped, added, removed }.
function renderDiff(oldLines, newLines, t) {
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

  return { html, skipped, added, removed };
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
  const { sites, language } = await chrome.storage.local.get(['sites', 'language']);
  const t = language === 'pl' ? STR.pl : STR.en;

  document.documentElement.lang = language === 'pl' ? 'pl' : 'en';
  document.title = t.title;
  document.getElementById('open-label').textContent = t.openPage;

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
    ? `${new Date(site.changedAt).toLocaleString()} \u2022 ${openUrl}`
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
  const { html, skipped, added, removed } = renderDiff(oldLines, newLines, t);

  // Statystyki w pasku narz\u0119dzi: +dodane / \u2212usuni\u0119te.
  const statsEl = document.getElementById('stats');
  if (statsEl) {
    statsEl.innerHTML =
      `<span class="stat-add" title="${t.added}">+${added}</span>` +
      `<span class="stat-del" title="${t.removed}">\u2212${removed}</span>`;
  }

  box.innerHTML = html || `<span class="empty">${t.noChanges}</span>`;
  wireSkipToggle(box, skipped);
}

main();