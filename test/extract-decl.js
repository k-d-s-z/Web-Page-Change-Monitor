'use strict';

// Ekstrakcja wybranych deklaracji (funkcji / const) z plikow zrodlowych
// rozszerzenia. Po co: background.js i diff.js dotykaja chrome/DOM na
// poziomie modulu, wiec zwykle require() odpalilby caly plik i wywalilby
// sie w node. Wyciagamy TYLKO czyste funkcje i ich zaleznosci.
//
// Skaner jest celowo heurystyczny, pokrywa idiomy tego projektu:
// stringi ' " ` (z escape'ami), komentarze // i /* */, literaly regex
// (rowniez klasy znakow), bloki {}. Nie jest to pelny parser JS.

function isRegexStart(prev) {
  return prev === '' || '(,:[!&|?{};+-*%~^<>'.includes(prev);
}

function scanBody(source, start, kind) {
  let i = start;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote = null;
  let prevSig = '';
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) { quote = null; prevSig = ch; }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; prevSig = ch; i++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      prevSig = ';';
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const e = source.indexOf('*/', i + 2);
      i = e === -1 ? source.length : e + 2;
      prevSig = ';';
      continue;
    }
    if (ch === '/' && isRegexStart(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (inClass) { if (c === ']') inClass = false; j++; continue; }
        if (c === '[') { inClass = true; j++; continue; }
        if (c === '/') { j++; closed = true; break; }
        if (c === '\n') break; // jednak nie regex — bledny trop
        j++;
      }
      if (closed) {
        while (j < source.length && /[a-z]/i.test(source[j])) j++; // flagi (gi, iu...)
        i = j;
        prevSig = '/';
        continue;
      }
    }
    if (ch === '{') brace++;
    else if (ch === '}') {
      brace--;
      if (kind === 'fn' && brace === 0) return source.slice(start, i + 1);
    } else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (kind === 'const' && ch === ';' && brace === 0 && paren === 0 && bracket === 0) {
      return source.slice(start, i + 1);
    }
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  return null;
}

function extractOne(source, name) {
  let start = source.indexOf('function ' + name + '(');
  if (start !== -1) return scanBody(source, start, 'fn');
  start = source.indexOf('const ' + name + ' =');
  if (start !== -1) return scanBody(source, start, 'const');
  return null;
}

function extractDecls(source, names) {
  const found = {};
  for (const n of names) {
    const decl = extractOne(source, n);
    if (decl) found[n] = decl;
  }
  const missing = names.filter((n) => !found[n]);
  if (missing.length) throw new Error('Nie znaleziono deklaracji: ' + missing.join(', '));
  return found;
}

module.exports = { extractDecls, extractOne };