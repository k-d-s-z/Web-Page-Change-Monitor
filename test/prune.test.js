'use strict';

// Testy retencji snapshotow — Audyt 2.0.0 (2)/P1 + Audyt #3/P1:
// (1) czysta funkcja planSnapshotPrune (reguly ciecia),
// (2) model kolejki withStorageLock (wlasnosci mechanizmu),
// (3) INTEGRACJA: prawdziwy pruneSnapshots + withStorageLock wyekstrahowane
//     z background.js, z kontrolowanym mockiem chrome.storage.local —
//     usuniecie blokady z produkcji pada na tescie, nie na audycie.
// Uruchomienie: npm test  (node >= 18, zero zaleznosci zewnetrznych).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractDecls, extractOne } = require('./extract-decl.js');

const backgroundSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const bg = extractDecls(backgroundSrc, ['planSnapshotPrune']);
const mod = { exports: {} };
new Function('module', 'exports', bg.planSnapshotPrune +
  '\nmodule.exports = { planSnapshotPrune };')(mod, mod.exports);
const { planSnapshotPrune } = mod.exports;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1000000000000; // staly "teraz" — deterministyczne granice

function mkSite(extra) {
  return Object.assign({
    url: 'https://example.com/', name: 'T',
    prevSnapshot: 'stary', prevSnapshotTs: NOW - 30 * DAY,
    lastSnapshot: 'nowy', lastSnapshotTs: NOW - DAY
  }, extra);
}

// --- planSnapshotPrune: reguly ciecia ---

test('planSnapshotPrune: stary prevSnapshot uciety, Ts wyzerowany', () => {
  const { sites, touched } = planSnapshotPrune([mkSite()], 7, NOW);
  assert.equal(touched, true);
  assert.equal(sites[0].prevSnapshot, '');
  assert.equal(sites[0].prevSnapshotTs, null);
  assert.equal(sites[0].lastSnapshot, 'nowy'); // swiezy zostaje
  assert.equal(sites[0].lastSnapshotTs, NOW - DAY);
});

test('planSnapshotPrune: swieze snapshoty zostaja, touched=false', () => {
  const input = [mkSite({ prevSnapshotTs: NOW - DAY, lastSnapshotTs: NOW - DAY })];
  const { sites, touched } = planSnapshotPrune(input, 7, NOW);
  assert.equal(touched, false);
  assert.equal(sites[0], input[0]); // ta sama referencja = nic nie ruszono
});

test('planSnapshotPrune: fallback timing z changedAt/lastCheckTime', () => {
  // Rekord sprzed aktualizacji (brak *SnapshotTs): prev czytany po
  // changedAt, last po lastCheckTime.
  const { sites, touched } = planSnapshotPrune([mkSite({
    prevSnapshotTs: null, changedAt: NOW - 30 * DAY,
    lastSnapshotTs: null, lastCheckTime: NOW - DAY
  })], 7, NOW);
  assert.equal(touched, true);
  assert.equal(sites[0].prevSnapshot, '');    // uciety po changedAt
  assert.equal(sites[0].lastSnapshot, 'nowy'); // zostaje po lastCheckTime
});

test('planSnapshotPrune: rekord bez zadnych timestampow zostaje (day zero)', () => {
  const { sites, touched } = planSnapshotPrune([mkSite({
    prevSnapshotTs: null, changedAt: null, lastCheckTime: null, lastSnapshotTs: null
  })], 7, NOW);
  assert.equal(touched, false);
  assert.equal(sites[0].prevSnapshot, 'stary');
  assert.equal(sites[0].lastSnapshot, 'nowy');
});

test('planSnapshotPrune: granica ts === cutoff NIE jest cieta (strict <)', () => {
  const boundary = NOW - 7 * DAY;
  const { touched } = planSnapshotPrune([mkSite({ prevSnapshotTs: boundary, lastSnapshotTs: boundary })], 7, NOW);
  assert.equal(touched, false);
});

test('planSnapshotPrune: lastSnapshot ciety niezaleznie od prev', () => {
  const { sites } = planSnapshotPrune([mkSite({
    prevSnapshotTs: NOW - DAY, lastSnapshotTs: NOW - 30 * DAY
  })], 7, NOW);
  assert.equal(sites[0].prevSnapshot, 'stary');  // swiezy zostaje
  assert.equal(sites[0].lastSnapshot, '');       // stary uciety
  assert.equal(sites[0].lastSnapshotTs, null);
});

test('planSnapshotPrune: puste snapshoty nie daja touched', () => {
  const { touched } = planSnapshotPrune([mkSite({ prevSnapshot: '', lastSnapshot: '' })], 7, NOW);
  assert.equal(touched, false);
});

test('planSnapshotPrune: inne pola rekordu nienaruszone', () => {
  const { sites } = planSnapshotPrune([mkSite({
    url: 'https://x.example/', changedAt: 123, freqIndex: 2, groups: ['a']
  })], 7, NOW);
  assert.equal(sites[0].url, 'https://x.example/');
  assert.equal(sites[0].changedAt, 123);
  assert.equal(sites[0].freqIndex, 2);
  assert.deepEqual(sites[0].groups, ['a']);
});

test('planSnapshotPrune: wejscie nie jest mutowane', () => {
  const input = [mkSite()];
  planSnapshotPrune(input, 7, NOW);
  assert.equal(input[0].prevSnapshot, 'stary');
  assert.equal(input[0].prevSnapshotTs, NOW - 30 * DAY);
  assert.equal(input[0].lastSnapshot, 'nowy');
});

test('planSnapshotPrune: wiele rekordow, tylko przeterminowane uciete', () => {
  const { sites, touched } = planSnapshotPrune([
    mkSite({ url: 'https://a.example/', prevSnapshotTs: NOW - 30 * DAY }),
    mkSite({ url: 'https://b.example/', prevSnapshotTs: NOW - DAY }),
    mkSite({ url: 'https://c.example/', prevSnapshotTs: NOW - 90 * DAY })
  ], 7, NOW);
  assert.equal(touched, true);
  assert.equal(sites[0].prevSnapshot, '');
  assert.equal(sites[1].prevSnapshot, 'stary');
  assert.equal(sites[2].prevSnapshot, '');
});

// --- Model kolejki withStorageLock (Audyt 2.0.0 (2)/P1) ---
// Te dwa testy dowodza WLASCIWOSCI mechanizmu kolejki (izolacyjnie,
// czytelnie). Ochrona samego background.js jest w sekcji integracyjnej.

test('bez kolejki: rownolegle sprzatanie gubi update checku (regresja P1)', async () => {
  const store = { sites: [{ name: 'A', lastSnapshot: 'v1' }] };
  const prune = (async () => {
    const sites = JSON.parse(JSON.stringify(store.sites)); // odczyt (stary stan)
    await new Promise((r) => setTimeout(r, 20));            // "praca"
    sites[0].prevSnapshot = '';                            // modyfikacja
    store.sites = sites;                                   // spozniony zapis
  })();
  const checkUpdate = (async () => {
    const sites = JSON.parse(JSON.stringify(store.sites)); // odczyt
    sites[0].status = 'changed';
    store.sites = sites;                                   // zapis PRZED prune
  })();
  await Promise.all([prune, checkUpdate]);
  assert.equal(store.sites[0].status, undefined); // update checku ZGINAL
});

test('z kolejka (model withStorageLock): update checku przezywa prune', async () => {
  const store = { sites: [{ name: 'A', lastSnapshot: 'v1' }] };
  let queue = Promise.resolve();
  const withStorageLock = (task) => {           // model powloki z background.js
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };
  const prune = withStorageLock(async () => {
    const sites = JSON.parse(JSON.stringify(store.sites));
    await new Promise((r) => setTimeout(r, 20));
    sites[0].prevSnapshot = '';
    store.sites = sites;
  });
  const checkUpdate = withStorageLock(async () => {
    const sites = JSON.parse(JSON.stringify(store.sites)); // juz NOWY stan
    sites[0].status = 'changed';
    store.sites = sites;
  });
  await Promise.all([prune, checkUpdate]);
  assert.equal(store.sites[0].status, 'changed'); // ocalony
  assert.equal(store.sites[0].prevSnapshot, '');
});

// --- Integracja: REALNY kod produkcyjny (Audyt #3/P1) ---
// Wyjasnienie: wyzej dowodzimy wlasnosci mechanizmu; TU uruchamiamy
// prawdziwe funkcje z background.js (ta sama ekstrakcja, ktora uzywaja
// pure.test.js) z mockiem chrome.storage.local. Mock kluczowo odwzorowuje
// prawdziwe storage: get przechwytuje dane W CHWILI WYWOLANIA i rozstrzyga
// je po opoznieniu — bez tego przenikanie operacji byloby niefalsyfiowalne.

function makeChromeApi(data) {
  const store = JSON.parse(JSON.stringify(data));
  return {
    store,
    api: {
      storage: {
        local: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            const snapshot = {};
            for (const k of list) {
              snapshot[k] = store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k]));
            }
            await new Promise((r) => setTimeout(r, 10));
            return snapshot;
          },
          async set(obj) {
            Object.assign(store, JSON.parse(JSON.stringify(obj)));
          }
        }
      }
    }
  };
}

function makeProd(chromeApi) {
  const decls = extractDecls(backgroundSrc, [
    'withStorageLock', 'SNAPSHOT_PRUNE_CHECK_MS', 'SNAPSHOT_RETENTION_MAX_DAYS',
    'planSnapshotPrune', 'pruneSnapshots'
  ]);
  // storageQueue to w background.js "let" — ekstraktor bierze tylko
  // function/const, wiec deklarujemy je recznie (identycznie jak w zrodle).
  const src = 'let storageQueue = Promise.resolve();\n' +
    Object.values(decls).join('\n') +
    '\nmodule.exports = { pruneSnapshots, withStorageLock };';
  const m = { exports: {} };
  new Function('module', 'exports', 'chrome', src)(m, m.exports, chromeApi);
  return m.exports;
}

function freshSite() {
  const now = Date.now();
  return mkSite({ prevSnapshotTs: now - 30 * DAY, lastSnapshotTs: now - DAY });
}

test('integracyjny: produkcyjny prune tnie stary snapshot i zapisuje znacznik', async () => {
  const h = makeChromeApi({ sites: [freshSite()], snapshotRetentionDays: 7 });
  const { pruneSnapshots } = makeProd(h.api);
  await pruneSnapshots();
  assert.equal(h.store.sites[0].prevSnapshot, '');
  assert.equal(h.store.sites[0].prevSnapshotTs, null);
  assert.equal(h.store.sites[0].lastSnapshot, 'nowy'); // swiezy zostaje
  assert.ok(Number.isFinite(h.store.snapshotPruneTime));
});

test('integracyjny: throttle — swiezy znacznik blokuje przycinanie i zapis znacznika', async () => {
  const stamp = Date.now();
  const h = makeChromeApi({ sites: [freshSite()], snapshotRetentionDays: 7, snapshotPruneTime: stamp });
  const { pruneSnapshots } = makeProd(h.api);
  await pruneSnapshots();
  assert.equal(h.store.sites[0].prevSnapshot, 'stary'); // nietkniety
  assert.equal(h.store.snapshotPruneTime, stamp);      // wczesny return, zero zapisow
});

test('integracyjny: rownolegly update "sites" przezywa PRODUKCYJNE prune (Audyt #3/P1)', async () => {
  const h = makeChromeApi({ sites: [freshSite()], snapshotRetentionDays: 7 });
  const { pruneSnapshots, withStorageLock } = makeProd(h.api);
  const pruneRun = pruneSnapshots();
  // Rownolegly check strony korzysta z TEJ SAMEJ produkcyjnej kolejki.
  const checkRun = withStorageLock(async () => {
    const d = await h.api.storage.local.get('sites');
    d.sites[0].status = 'changed';
    await h.api.storage.local.set({ sites: d.sites });
  });
  await Promise.all([pruneRun, checkRun]);
  // Obie operacje musza przetrwac: update checku i przyciecie.
  // Gdyby ktos usunal withStorageLock z pruneSnapshots, jedna z tych
  // asercji pada (update checku nadpisalby ciete "sites" albo odwrotnie).
  assert.equal(h.store.sites[0].status, 'changed');
  assert.equal(h.store.sites[0].prevSnapshot, '');
  assert.equal(h.store.sites[0].prevSnapshotTs, null);
  assert.ok(Number.isFinite(h.store.snapshotPruneTime));
});

test('statyczny straznik: pruneSnapshots korzysta z withStorageLock', () => {
  const decl = extractOne(backgroundSrc, 'pruneSnapshots');
  assert.ok(decl, 'brak deklaracji pruneSnapshots w background.js');
  assert.ok(decl.includes('withStorageLock('),
    'pruneSnapshots pisze do "sites" bez withStorageLock — regresja P1 z audytu');
});