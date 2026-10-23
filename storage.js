function sendToBackground(message) {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function callBackground(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, error: 'noResponse' };
  } catch (err) {
    return { ok: false, error: 'unavailable' };
  }
}

// Whole list layout: ungrouped pages and groups in display order, e.g.
// [{type:'site', id}, {type:'group', id, name?, siteIds:[...]}]. The background
// stores the order and each page's group membership from it.
async function persistLayout(layout) {
  await callBackground({ action: 'reorderSites', layout });
}

// Audyt zewn./poz. C — świadomość adresów lokalnych. Rozszerzenie celowo MOŻE
// monitorować adresy prywatne (np. router 192.168.1.1), ale zapis takiego
// adresu ma być świadomą decyzją użytkownika, nie skutkiem literówki.
// Dlatego kreator i formularz edycji pokazują ostrzeżenie przy "Dalej"/"Zapisz".
// Zwraca true tylko dla pewnych przypadków lokalnych/prywatnych; w razie
// wątpliwości (nieznany format) zwraca false, żeby nie blokować normalnych adresów.
function isPrivateOrLocalUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;

    // IPv6: URL.hostname trzyma nawiasy, np. [::1]; zdejmujemy je przed testem.
    const v6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (v6.includes(':')) {
      // "::", "::1" i każdy adres zaczynający się od "::" (np. ::ffff:10.0.0.1)
      // to z definicji adresy specjalne — nie wychodzą do internetu.
      if (v6.startsWith('::')) return true;
      const first = parseInt(v6.split(':')[0], 16);
      if (!Number.isNaN(first)) {
        // fc00::/7 — adresy lokalne (ULA); fe80::/10 — link-local.
        if ((first & 0xfe00) === 0xfc00) return true;
        if ((first & 0xffc0) === 0xfe80) return true;
      }
      return false;
    }

    // IPv4: sprawdzamy tylko pewne zakresy z RFC1918 + loopback/link-local.
    const m = v6.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127) return true;            // 0.0.0.0/8, loopback
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (link-local)
    return false;
  } catch {
    // Nieprawidłowy URL — nie jest to adres lokalny; walidacją protokołu
    // zajmuje się osobno sanitizeSiteInput w background.js.
    return false;
  }
}
