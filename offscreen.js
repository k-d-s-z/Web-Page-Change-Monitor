// === OFFSCREEN.JS ===
// Ukryty dokument offscreen: jedyne miejsce poza karta, gdzie Chrome pozwala
// uzyc DOMParser. background.js (extractFragment) przysyla surowy HTML i
// selektor CSS; my parsujemy HTML, wycinamy dopasowany fragment i zwracamy
// jego outerHTML. Nic tu nie jest wyswietlane ani zapisywane.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.action !== 'extractFragment') return false;
  try {
    const doc = new DOMParser().parseFromString(String(msg.html || ''), 'text/html');
    let el = null;
    try {
      el = doc.querySelector(String(msg.selector || ''));
    } catch (e) {
      // Audyt#3/poprawka3: niepoprawny skladniowo selektor to NIE to samo,
      // co selektor niepasujacy. Rozrozniamy te dwa przypadki, zeby tlo
      // pokazalo "Invalid selector" (i18n errSelectorInvalid) zamiast
      // mylacego "Selector not found (JS-drawn content?)".
      sendResponse({ ok: true, found: false, invalidSelector: true });
      return false;
    }
    sendResponse({ ok: true, found: Boolean(el), html: el ? el.outerHTML : '' });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return false;
});