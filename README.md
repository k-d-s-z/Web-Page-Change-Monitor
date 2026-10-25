# Web Page Change Monitor

[EN](#en) | [PL](#pl)

---

<a name="en"></a>

## Web Page Change Monitor (English)

**Web Page Change Monitor** is a Chromium extension (Manifest V3) that periodically checks selected pages and notifies you when their content changes. Privacy-first by design: no middleman servers, no accounts, no telemetry — all analysis happens locally in your browser.

### Features

- **Monitor up to 50 pages**, each with its own check frequency (from 1 minute to once a day)
- **Guided setup wizard** — adding or editing a monitor opens a step-by-step wizard in a separate tab (name, URL, frequency, optional fragment, cookie handling); works also from the context menu
- **Monitor a chosen part of the page** — in the wizard you can click "Pick element on the page" and select the element visually, or type a CSS selector; leave empty to monitor the whole page. The fragment is extracted in an offscreen document, so only the matched part is compared
- **Two fetching modes:**
  - *Fast (default)* — fetches the HTML sent by the server, without running JavaScript; light and quick
  - *Rendered page mode* — opens the page in a hidden tab and reads the rendered content; for pages that draw their content with scripts (SPAs, XHR-loaded result tables)
- **Automatic JS-page detection** — when a page returns a large HTML shell but almost no readable text, the card suggests enabling rendered mode
- **Groups** — drag one card onto another to create a group (a folder of monitors); groups can be renamed, collapsed, opened and deleted
- **Smart comparison:**
  - optional ignoring of date/time changes (protects against false alarms from "last updated" stamps)
  - line-by-line diff view with changed words highlighted
  - collapsing of unchanged runs, "only changes" view (on by default), "Jump to changes" button
  - +added / −removed statistics, honest notice for very large changes (simplified mode)
- **Desktop notifications** linking to the diff view
- **List management:** cards with favicons, pausing, drag & drop reordering with persisted order, "only changed" filter, "Mark all as read", unread-count badge on the extension icon
- **Context menu** — "Monitor this page" from any page
- **Light / dark themes** (full support for both, choice persisted)
- **PL / EN language** (whole UI, including notifications)
- **Settings backup** — JSON export/import with full validation (2 MB limit, version and duplicate checks). Backups can also carry the optional per-site "opened page" address (`openUrl`); there is no dedicated form field for it, but a value set through a backup is preserved when editing the site

### Installation (developer mode)

1. Download or clone the repository
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and point to the extension directory

Requires Chrome 116 or newer (offscreen documents, Manifest V3).

### Usage

1. Click the extension icon, or use the "Monitor this page" context menu
2. The wizard opens in a new tab: provide a name, URL and check frequency
3. **Monitor only a part of the page (optional)** — click "Pick element on the page" and select the element visually, or type a CSS selector (e.g. `#content, .results, main`); leave empty for the whole page
4. The first check stores a baseline; subsequent checks detect changes
5. Click "View changes" on a card to open the diff view

**Tip:** if a card shows "Looks JS-rendered", edit the monitor and enable "Rendered page mode".

**Groups:** drag one card onto another to group them. Drag a card onto a group to move it inside; drag it back to the top bar to ungroup.

### Privacy

- The extension **never sends data anywhere except the pages you monitor**
- Fast mode fetches the page like a regular browser request; the "Require cookies" option decides whether your session is included
- Rendered mode **always uses your browser session** (it opens a real tab) and cannot run cookieless — assume the page sees you as on a normal visit
- Monitoring `http://` pages with cookies is blocked (protects your session)
- Adding a **local or private address** (localhost, LAN IP such as a router) shows an explicit warning that must be confirmed — monitoring your own devices is allowed, but it is always a deliberate choice
- URLs with embedded login data (`user:password@host`) are rejected — such secrets would leak into backups, logs and the UI
- Importing a backup reports how many of the restored addresses are local/private, and rows with embedded login data are skipped and listed in the import summary
- Stored page versions (diff preview) are kept for a configurable retention period (Settings → Privacy and data: 7 days by default, or 30/90/custom days). The cleanup runs silently in the background; only old versions are removed, never the monitored page itself
- "Delete all data" (Settings → Privacy and data) permanently removes every monitored page, its stored versions, groups and drafts in one click; interface preferences (language, theme) stay

### Permissions and why

| Permission | Purpose |
| --- | --- |
| `storage`, `unlimitedStorage` | local storage of the site list and content snapshots |
| `alarms` | recurring check schedule (MV3) |
| `notifications` | change notifications |
| `contextMenus` | the "Monitor this page" entry |
| `scripting` | injecting the element picker into the page and reading text out of the hidden tab (rendered mode) |
| `tabs` | the wizard & edit tab (opening, finding and focusing it among all open tabs), the hidden tab of rendered mode (a minimized background window), opening a page from a notification; `activeTab` alone would not cover any of these |
| `offscreen` | extracting the selected page fragment (CSS selector) in a background document |
| `favicon` | site icons on cards |
| `optional_host_permissions` | access to monitored origins, granted only after you add a page |

### Project structure

```
background.js   — service worker: scheduling, fetching, fragment extraction (offscreen), change detection, notifications
popup.html/.js  — monitor list UI
wizard.js       — guided add/edit wizard (separate tab)
picker.js/.css  — visual element picker for the monitored fragment
cards.js        — monitor card rendering
groups.js       — card groups (folders)
drag.js         — drag & drop reordering
diff.html/.js   — diff view page
offscreen.js/.html — hidden document that extracts the selected fragment
i18n.js         — PL/EN translations
storage.js      — popup ↔ service worker messaging + shared local/LAN address helper
theme.css       — light/dark theme variables
manifest.json   — Manifest V3, version 2.0.0
```

No external dependencies; for development: ESLint (`npm run lint`).

### License

GPL-3.0 — see `LICENSE` for details.

---

<a name="pl"></a>

## Monitor zmian na stronach internetowych (wersja polska)

**Web Page Change Monitor** to rozszerzenie Chromium (Manifest V3), które cyklicznie sprawdza wybrane strony i powiadamia o zmianach ich treści. Zaprojektowane z myślą o maksymalnej prywatności: bez serwerów pośredniczących, bez kont, bez telemetrii — cała analiza odbywa się lokalnie w Twojej przeglądarce.

### Funkcje

- **Monitorowanie do 50 stron** z indywidualną częstotliwością sprawdzania (od 1 minuty do raz na dobę)
- **Kreator dodawania** — dodanie lub edycja monitora uruchamia wieloetapowy kreator w osobnej karcie (nazwa, adres, częstotliwość, opcjonalny fragment, ciasteczka); działa też z menu kontekstowego
- **Monitorowanie wybranego fragmentu strony** — w kreatorze możesz kliknąć „Wybierz element na stronie” i wskazać go wizualnie albo wpisać selektor CSS; puste pole oznacza całą stronę. Fragment jest wyodrębniany w dokumencie offscreen, więc porównywana jest tylko dopasowana część
- **Dwa tryby pobierania:**
  - *Szybki (domyślny)* — pobiera kod HTML z serwera, bez uruchamiania JavaScriptu; lekki i szybki
  - *Strona renderowana* — otwiera stronę w ukrytej karcie i odczytuje wyrenderowaną treść; dla stron, które rysują zawartość skryptami (SPA, tabele wyników ładowane przez XHR)
- **Automatyczna detekcja stron JS** — gdy strona ma duży szkielet HTML, ale prawie brak czytelnego tekstu, rozszerzenie podpowiada na karcie włączenie trybu renderowanego
- **Grupy** — przeciągnij jedną kartę na drugą, aby utworzyć grupę (folder monitorów); grupy można zwijać, otwierać, zmieniać im nazwę i usuwać
- **Inteligentne porównywanie:**
  - pomijanie zmian daty i godziny (opcjonalne, chroni przed fałszywymi alarmami przy znacznikach „ostatnia aktualizacja”)
  - widok różnic linia po linii z wyróżnieniem zmienionych słów
  - zwijanie niezmienionych fragmentów, tryb „tylko zmiany” (domyślnie włączony), przycisk „Przejdź do zmian”
  - statystyki +dodane / −usunięte, uczciwy komunikat przy bardzo dużych zmianach (tryb uproszczony)
- **Powiadomienia** na pulpicie z linkiem do podglądu różnic
- **Zarządzanie listą:** karty z favikonami, pauzowanie, przeciąganie (drag & drop) ze zapisem kolejności, filtrowanie „tylko ze zmianami”, „Oznacz wszystkie jako przeczytane”, badge z liczbą zmian na ikonie rozszerzenia
- **Menu kontekstowe** — „Monitoruj stronę” z poziomu dowolnej strony
- **Motywy** jasny / ciemny (pełne wsparcie obu, zapamiętywanie wyboru)
- **Język** PL / EN (cały interfejs, łącznie z powiadomieniami)
- **Kopia zapasowa ustawień** — eksport/import JSON z pełną walidacją (limit 2 MB, kontrola wersji i duplikatów). Kopia może przenosić także opcjonalny adres „otwieranej strony" (`openUrl`); nie ma dla niego osobnego pola w formularzu, ale wartość ustawiona przez kopię jest zachowywana przy edycji strony

### Instalacja (deweloperska)

1. Pobierz lub sklonuj repozytorium
2. Otwórz `chrome://extensions`
3. Włącz „Tryb programisty”
4. Kliknij „Załaduj rozpakowane” i wskaż katalog z rozszerzeniem

Wymaga Chrome 116 lub nowszego (dokumenty offscreen, Manifest V3).

### Jak używać

1. Kliknij ikonę rozszerzenia lub użyj menu kontekstowego „Monitoruj stronę”
2. W nowej karcie otworzy się kreator: podaj nazwę, adres URL i częstotliwość sprawdzania
3. **Monitorowanie fragmentu (opcjonalnie)** — kliknij „Wybierz element na stronie” i wskaż element wizualnie albo wpisz selektor CSS (np. `#content, .results, main`); puste pole oznacza całą stronę
4. Pierwsze sprawdzenie zapisuje stan bazowy; kolejne wykrywają zmiany
5. Kliknij „Zobacz zmiany” na karcie, aby otworzyć widok różnic

**Wskazówka:** jeśli karta strony pokaże komunikat „Wygląda na rysowaną przez JS”, edytuj monitor i zaznacz „Tryb strony renderowanej”.

**Grupy:** przeciągnij jedną kartę na drugą, aby je zgrupować. Przeciągnij kartę na grupę, aby ją do grupy przenieść; przeciągnij ją z powrotem na górny pasek, aby usunąć z grupy.

### Prywatność

- Rozszerzenie **nie wysyła danych nigdzie poza monitorowane przez Ciebie strony**
- Tryb szybki pobiera stronę tak jak zwykłe żądanie przeglądarki; opcja „Wymagaj ciasteczek” decyduje, czy dołączana jest Twoja sesja
- Tryb renderowany **zawsze korzysta z sesji przeglądarki** (otwiera realną kartę) — nie da się go uruchomić bez ciasteczek; zakładaj, że strona widzi Cię tak, jak przy zwykłej wizycie
- Monitorowanie po `http://` z ciasteczkami jest blokowane (ochrona sesji przed zapisem w formie niezaszyfrowanej)
- Dodanie **adresu lokalnego lub prywatnego** (localhost, adres IP w sieci LAN, np. router) pokazuje jawne ostrzeżenie wymagające potwierdzenia — monitorowanie własnych urządzeń jest możliwe, ale zawsze świadome
- Adresy z danymi logowania (`użytkownik:hasło@`) są odrzucane — takie dane wyciekłyby do kopii zapasowych, logów i interfejsu
- Import z kopii zapasowej informuje, ile przywróconych adresów jest lokalnych/prywatnych; rekordy z danymi logowania w adresie są pomijane i zgłaszane w podsumowaniu importu
- Zapisane wersje stron (do podglądu zmian) są przechowywane przez konfigurowalny okres retencji (Ustawienia → Prywatność i dane: domyślnie 7 dni, opcjonalnie 30/90 dni lub wartość własna). Sprzątanie odbywa się po cichu w tle; usuwane są tylko stare wersje, nigdy sama monitorowana strona
- „Usuń wszystkie dane” (Ustawienia → Prywatność i dane) trwale usuwa wszystkie monitorowane strony, ich zapisane wersje, grupy i szkice jednym kliknięciem; preferencje interfejsu (język, motyw) zostają

### Uprawnienia i dlaczego

| Uprawnienie | Cel |
| --- | --- |
| `storage`, `unlimitedStorage` | lokalny zapis listy stron i snapshotów treści |
| `alarms` | harmonogram cyklicznych sprawdzeń (MV3) |
| `notifications` | powiadomienia o wykrytych zmianach |
| `contextMenus` | pozycja „Monitoruj stronę” |
| `scripting` | wstrzykiwanie selektora elementów do strony i odczyt tekstu z ukrytej karty (tryb renderowany) |
| `tabs` | karta kreatora i edycji (otwieranie, odnajdowanie i fokus wśród wszystkich otwartych kart), ukryta karta trybu renderowanego (zminimalizowane okno w tle), otwieranie strony z powiadomienia; samo `activeTab` nie pokryłoby żadnej z tych potrzeb |
| `offscreen` | wyodrębnianie wybranego fragmentu strony (selektor CSS) w dokumencie w tle |
| `favicon` | ikony stron na kartach |
| `optional_host_permissions` | dostęp do monitorowanych adresów udzielany dopiero po dodaniu strony |

### Struktura projektu

```
background.js   — service worker: harmonogram, pobieranie, wyodrębnianie fragmentu (offscreen), detekcja zmian, powiadomienia
popup.html/.js  — interfejs listy monitorów
wizard.js       — wieloetapowy kreator dodawania/edycji (osobna karta)
picker.js/.css  — wizualny wybór monitorowanego elementu
cards.js        — renderowanie kart monitorów
groups.js       — grupy kart (foldery)
drag.js         — przestawianie kolejności
diff.html/.js   — strona podglądu różnic
offscreen.js/.html — ukryty dokument wyodrębniający wybrany fragment
i18n.js         — tłumaczenia PL/EN
storage.js      — komunikacja popup ↔ service worker + współdzielony helper adresów lokalnych/sieciowych
theme.css       — zmienne motywu jasny/ciemny
manifest.json   — Manifest V3, wersja 2.0.0
```

Bez zależności zewnętrznych; do developmentu: ESLint (`npm run lint`).

### Licencja

GPL-3.0 — szczegóły w pliku `LICENSE`.