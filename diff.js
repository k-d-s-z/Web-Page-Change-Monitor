// Diff "przed → po" dla strony wskazanej w hashu URL (diff.html#<siteId>).
// Dane czytane bezpośrednio z chrome.storage.local — nie przechodzą przez
// service worker, więc strona działa nawet gdy SW śpi.
//
// Algorytm: LCS na liniach (tani — setki/tysiące linii), a wewnątrz bloku
// zmienionych linii ten sam LCS na słowach (krótkie ciągi) dla efektu
// <del>stare</del><ins>nowe</ins> w obrębie jednej linii.

function esc(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  })[c]);
}

// Zwraca listę operacji: {t:'eq'|'del'|'ins', l:string}
function computeOps(a, b) {
  const n = a.length;
  const m = b.length;

  // Zabezpieczenie przed O(n·m) na ogromnych zestawach (np. snapshot
  // ucięty do limitu 150k znaków może dać ~10k linii): zamiast zawiesić
  // stronę, pokazujemy "wszystko wymienione" w blokach.
  if (n * m > 4_000_000) {
    const ops = [];
    a.forEach((l) => ops.push({ t: 'del', l }));
    b.forEach((l) => ops.push({ t: 'ins', l }));
    return ops;
  }

  // dp[i][j] = długość LCS a[i:] i b[j:]
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

// Word-diff wewnątrz PARY linii (1 usunięta + 1 dodana).
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

// Grupuje ciąg operacji nie-'eq' w bloki; blok z równą liczbą del/ins
// renderowany jest linia-po-linii inline (czytelny word-diff).
function renderDiff(oldLines, newLines) {
  const ops = computeOps(oldLines, newLines);
  let html = '';
  let k = 0;

  while (k < ops.length) {
    if (ops[k].t === 'eq') {
      html += esc(ops[k].l) + '\n';
      k++;
      continue;
    }

    // Blok operacji nie-eq.
    const block = [];
    while (k < ops.length && ops[k].t !== 'eq') block.push(ops[k++]);

    const dels = block.filter((o) => o.t === 'del');
    const ins = block.filter((o) => o.t === 'ins');

    if (dels.length === ins.length && dels.length > 0 && dels.length <= 3) {
      for (let p = 0; p < dels.length; p++) {
        html += renderInline(dels[p].l, ins[p].l) + '\n';
      }
    } else {
      dels.forEach((o) => { html += `<del>${esc(o.l)}</del>\n`; });
      ins.forEach((o) => { html += `<ins>${esc(o.l)}</ins>\n`; });
    }
  }
  return html;
}

async function main() {
  const siteId = decodeURIComponent(location.hash.slice(1));
  const { sites } = await chrome.storage.local.get('sites');
  const site = (sites || []).find((s) => s.id === siteId);

  const box = document.getElementById('diff');
  if (!site) {
    box.innerHTML = '<span class="empty">Site not found.</span>';
    return;
  }

  document.getElementById('title').textContent = site.name;
  document.getElementById('open').href = site.url;
  document.getElementById('meta').textContent = site.changedAt
    ? `${new Date(site.changedAt).toLocaleString()} • ${site.url}`
    : site.url;

  if (!site.prevSnapshot && !site.lastSnapshot) {
    box.innerHTML = '<span class="empty">No stored version of this page yet — the next detected change will show a full diff.</span>';
    return;
  }
  if (!site.prevSnapshot) {
    box.innerHTML = '<span class="empty">Only the current version is stored (baseline saved after the update). The next detected change will show a diff.</span>';
    return;
  }

  const oldLines = site.prevSnapshot.split('\n');
  const newLines = (site.lastSnapshot || '').split('\n');
  const html = renderDiff(oldLines, newLines);
  box.innerHTML = html || '<span class="empty">No visible text changes.</span>';
}

main();