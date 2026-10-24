'use strict';

// Testy czystych funkcji Web Page Change Monitor (punkt 3 audytu).
// Uruchomienie: npm test  (node >= 18, zero zaleznosci zewnetrznych).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractDecls } = require('./extract-decl.js');

const backgroundSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const diffSrc = fs.readFileSync(path.join(__dirname, '..', 'diff.js'), 'utf8');

// Consty przed funkcjami: deklaracje funkcji sa hoistowane, ale const
// (TDZ) musi byc zainicjalizowany przed PIERWSZYM WYWOLANIEM funkcji,
// ktore go uzywa. Kolejnosc w tablicy = kolejnosc w sklejanym zrodle.
const bg = extractDecls(backgroundSrc, [
  'FREQ_MAP', 'MIN_RENDERED_MINUTES', 'MAX_CUSTOM_MINUTES', 'SNAPSHOT_MAX_CHARS',
  'SNAPSHOT_BLOCK_TAGS', 'removeComments', 'removeRawTextBlocks', 'replaceAllTags',
  'replaceBlockTags', 'cleanHtmlStructured', 'sanitizeSiteInput'
]);
const df = extractDecls(diffSrc, ['computeOps']);

const code = [...Object.values(bg), ...Object.values(df)].join('\n') +
  '\nmodule.exports = { removeComments, cleanHtmlStructured, sanitizeSiteInput, computeOps };';
const mod = { exports: {} };
new Function('module', 'exports', 'URL', code)(mod, mod.exports, URL);
const { removeComments, cleanHtmlStructured, sanitizeSiteInput, computeOps } = mod.exports;

// --- computeOps (diff) ---

test('computeOps: identyczne listy -> same eq', () => {
  assert.deepEqual(computeOps(['a', 'b'], ['a', 'b']), [{ t: 'eq', l: 'a' }, { t: 'eq', l: 'b' }]);
});

test('computeOps: puste -> X = same ins', () => {
  assert.deepEqual(computeOps([], ['x']), [{ t: 'ins', l: 'x' }]);
});

test('computeOps: X -> puste = same del', () => {
  assert.deepEqual(computeOps(['x'], []), [{ t: 'del', l: 'x' }]);
});

test('computeOps: LCS rozklada del/ins/eq', () => {
  assert.deepEqual(computeOps(['a', 'b', 'c'], ['a', 'x', 'c']), [
    { t: 'eq', l: 'a' }, { t: 'del', l: 'b' }, { t: 'ins', l: 'x' }, { t: 'eq', l: 'c' }
  ]);
});

test('computeOps: ogromne wejscie -> sciezka simplified', () => {
  const ops = computeOps(Array(2001).fill('x'), Array(2001).fill('y'));
  assert.equal(ops.simplified, true);
  assert.equal(ops.length, 4002); // 2001 del + 2001 ins
});

// --- removeComments (background) ---

test('removeComments: wycina komentarz, skleja reszte', () => {
  assert.equal(removeComments('a<!-- x -->b'), 'ab');
});

test('removeComments: bez komentarzy bez zmian', () => {
  assert.equal(removeComments('bez komentarzy'), 'bez komentarzy');
});

test('removeComments: niedomkniety komentarz zostaje (udokumentowane)', () => {
  assert.equal(removeComments('start <!-- oops'), 'start <!-- oops');
});

test('removeComments: sasiednie komentarze', () => {
  assert.equal(removeComments('<!--a--><!--b-->'), '');
});

// --- cleanHtmlStructured (background) ---

test('cleanHtmlStructured: puste wejscie', () => {
  assert.equal(cleanHtmlStructured(''), '');
});

test('cleanHtmlStructured: script wyciety, akapity jako osobne linie', () => {
  assert.equal(
    cleanHtmlStructured('<p>Ala</p><script>var x=1;</script><p>ma kota</p>'),
    'Ala\nma kota'
  );
});

test('cleanHtmlStructured: JSON pretty-print', () => {
  assert.equal(cleanHtmlStructured('{"b":2,"a":1}'), '{\n  "b": 2,\n  "a": 1\n}');
});

test('cleanHtmlStructured: dekodowanie encji', () => {
  assert.equal(cleanHtmlStructured('<p>&nbsp;a &amp; b &lt;tag&gt;</p>'), 'a & b <tag>');
});

test('cleanHtmlStructured: komentarz HTML wyciety', () => {
  assert.equal(cleanHtmlStructured('<div><!-- komentarz --><p>tekst</p></div>'), 'tekst');
});

// --- sanitizeSiteInput (background) ---

test('sanitizeSiteInput: odrzucenia', () => {
  assert.equal(sanitizeSiteInput({}), null);
  assert.equal(sanitizeSiteInput({ name: 'x', url: 'not a url' }), null);
  assert.equal(sanitizeSiteInput({ name: 'x', url: 'ftp://example.com/' }), null);
  assert.equal(sanitizeSiteInput({ name: 'x', url: 'http://example.com/', requireCookies: true }), null);
});

test('sanitizeSiteInput: domyslne wartosci', () => {
  const s = sanitizeSiteInput({ name: 'Test', url: 'https://example.com/' });
  assert.ok(s);
  assert.equal(s.freqIndex, 2);
  assert.equal(s.freqMinutes, null);
  assert.equal(s.renderMode, 'fast');
  assert.equal(s.openUrl, 'https://example.com/');
  assert.equal(s.openUrlCustom, false);
  assert.equal(s.selector, '');
});

test('sanitizeSiteInput: rendered clamp 3 -> 5, freqIndex fallback 2', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', freqMinutes: 3, renderMode: 'rendered' });
  assert.ok(s);
  assert.equal(s.freqMinutes, 5);
  assert.equal(s.freqIndex, 2);
});

test('sanitizeSiteInput: rendered bez wlasnego interwalu, freqIndex 0 -> 1', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', freqIndex: 0, renderMode: 'rendered' });
  assert.ok(s);
  assert.equal(s.freqMinutes, null);
  assert.equal(s.freqIndex, 1);
});

test('sanitizeSiteInput: wlasny interwal 42', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', freqMinutes: 42 });
  assert.ok(s && s.freqMinutes === 42);
});

test('sanitizeSiteInput: freqMinutes 0 -> null (preset)', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', freqMinutes: 0 });
  assert.ok(s && s.freqMinutes === null);
});

test('sanitizeSiteInput: dozwolony selector zostaje', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', selector: 'div > .x[1]' });
  assert.ok(s && s.selector === 'div > .x[1]');
});

test('sanitizeSiteInput: selector ze zabronionym znakiem -> invalidSelector', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', selector: 'a;b' });
  assert.deepEqual(s, { invalidSelector: true });
});

test('sanitizeSiteInput: selector ponad 200 znakow -> invalidSelector', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', selector: 'a'.repeat(201) });
  assert.deepEqual(s, { invalidSelector: true });
});

test('sanitizeSiteInput: selector z literami unicode dozwolony', () => {
  const sel = '.cz' + '\u0119' + '\u015b' + '\u0107' + '-2';
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', selector: sel });
  assert.ok(s && s.selector === sel);
});

test('sanitizeSiteInput: poprawny openUrl zostaje', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://m.example/', openUrl: 'https://view.example/' });
  assert.ok(s && s.openUrl === 'https://view.example/' && s.openUrlCustom === true);
});

test('sanitizeSiteInput: openUrl javascript: -> fallback na monitorowany URL', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://m.example/', openUrl: 'javascript:alert(1)' });
  assert.ok(s && s.openUrl === 'https://m.example/' && s.openUrlCustom === false);
});