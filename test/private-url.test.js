'use strict';

// Testy ostrzezenia o adresach lokalnych/prywatnych (Audyt #3/P2).
// Funkcja isPrivateOrLocalUrl z storage.js ma OSTRZEGAC przy adresach,
// ktore nie wychodza do internetu, a nie blokowac publicznych — testy
// pilnuja obu kierunkow (kazdy falszywy alarm = znieczulica na ostrzezenia).
// Funkcja jest czysta: ekstrakcja przez extract-decl.js, URL wstrzykniety
// jako parametr (node ma global, inne srodowiska moga nie miec).
// Uruchomienie: npm test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractDecls } = require('./extract-decl.js');

const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'storage.js'), 'utf8');
const decls = extractDecls(storageSrc, ['isPrivateOrLocalUrl']);
const mod = { exports: {} };
new Function('module', 'exports', 'URL', decls.isPrivateOrLocalUrl +
  '\nmodule.exports = { isPrivateOrLocalUrl };')(mod, mod.exports, URL);
const { isPrivateOrLocalUrl } = mod.exports;

const priv = (u) => assert.equal(isPrivateOrLocalUrl(u), true, 'oczekiwano lokalny: ' + u);
const pub = (u) => assert.equal(isPrivateOrLocalUrl(u), false, 'oczekiwano publiczny: ' + u);

test('isPrivateOrLocalUrl: localhost i subdomeny .localhost', () => {
  priv('http://localhost/');
  priv('http://localhost:8080/');
  priv('https://app.localhost/');
  priv('http://LOCALHOST/'); // wielkie litery -> toLowerCase przed testem
});

test('isPrivateOrLocalUrl: IPv4 loopback i 0.0.0.0/8', () => {
  priv('http://127.0.0.1/');
  priv('http://127.255.255.254/');
  priv('http://0.0.0.0/');
});

test('isPrivateOrLocalUrl: RFC1918 — 10/8, 192.168/16, 172.16-31/12', () => {
  priv('http://10.0.0.1/');
  priv('http://10.255.0.3/');
  priv('http://192.168.1.1/');
  priv('http://192.168.55.99/');
  priv('http://172.16.0.1/');
  priv('http://172.31.255.254/');
});

test('isPrivateOrLocalUrl: adresy tuz za zakresami prywatnymi sa publiczne', () => {
  pub('http://172.15.0.1/');  // ponizej 172.16
  pub('http://172.32.0.1/');  // powyzej 172.31
  pub('http://192.169.1.1/'); // nie jest 192.168
  pub('http://11.0.0.1/');    // nie jest 10.x
  pub('http://8.8.8.8/');
  pub('https://example.com/');
});

test('isPrivateOrLocalUrl: 169.254/16 link-local IPv4 (i tylko on)', () => {
  priv('http://169.254.1.1/');
  pub('http://169.253.1.1/');
  pub('http://169.255.1.1/');
});

test('isPrivateOrLocalUrl: IPv6 loopback, ::, IPv4-mapped (startuja od ::)', () => {
  priv('http://[::1]/');
  priv('http://[::]/');
  priv('http://[::ffff:10.0.0.1]/');
});

test('isPrivateOrLocalUrl: IPv4-mapped z PUBLICZNYM IPv4 nie daje falszywego alarmu (Audyt #5/P2)', () => {
  // Audyt #5/P2: ::ffff:8.8.8.8 to adres internetu (osadzony IPv4 jest
  // publiczny) — szeroki warunek "zaczyna sie od ::" dawal falszywe
  // ostrzezenie o adresie lokalnym.
  pub('http://[::ffff:8.8.8.8]/');
  pub('http://[::ffff:1.1.1.1]/');
  pub('http://[::ffff:808:808]/'); // zapis szesnastkowy — WHATWG URL kanonizuje na ::ffff:8.8.8.8
});

test('isPrivateOrLocalUrl: IPv4-mapped z prywatnym IPv4 nadal ostrzega', () => {
  priv('http://[::ffff:192.168.1.1]/');
  priv('http://[::ffff:127.0.0.1]/');
  priv('http://[::ffff:10.1.2.3]/');
  priv('http://[::ffff:172.16.5.5]/');
  priv('http://[::ffff:169.254.1.1]/');
});

test('isPrivateOrLocalUrl: IPv6 ULA fc00::/7 i link-local fe80::/10', () => {
  priv('http://[fc00::1]/');
  priv('http://[fd12:3456:789a::1]/'); // fd* to tez ULA (fc00::/7)
  priv('http://[fe80::1]/');
  priv('http://[febf::1]/');           // ostatni adres fe80::/10
  pub('http://[fe00::1]/');           // ponizej fe80::/10
  pub('http://[ff00::1]/');           // multicast — poza zakresem ostrzezenia
  pub('http://[2001:db8::1]/');
});

test('isPrivateOrLocalUrl: nietypowe zapisy IPv4 — normalizuje je WHATWG URL', () => {
  // Chromium (i node) kanonizuja dziesietne/szesnastkowe/skrocone zapisy
  // IPv4 juz w new URL(), wiec hostname dociera do funkcji jako "normalny"
  // adres — to zamkniecie drogi obchodzenia ostrzezenia literowkami.
  priv('http://2130706433/');  // = 127.0.0.1
  priv('http://127.1/');       // = 127.0.0.1
  priv('http://0x7f.0.0.1/');  // = 127.0.0.1
  pub('http://134744072/');    // = 8.8.8.8 — normalizacja nie moze dawac falszywego alarmu
});

test('isPrivateOrLocalUrl: niepoprawny URL -> false (to walidacja zapisu, nie adresu)', () => {
  // Kontakt z sanitizeSiteInput: odrzuceniem zlego URL/proto zajmuje sie
  // on (testy w pure.test.js); tutaj zly URL po prostu nie jest "lokalny".
  pub('not a url');
  pub('');
  pub('http://exa mple.com/');
});