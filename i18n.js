const TRANSLATIONS = {
  en: {
    titleList: 'Monitored Pages',
    btnAdd: 'Add New Page',
    btnRefreshAll: 'Refresh all',
    btnRefreshAllBusy: 'Refreshing…',
    btnBackup: 'Create Backup',
    btnRestore: 'Restore Backup',
    settingsTitle: 'Settings',
    lblLanguage: 'Language',
    titleSettings: 'Settings',
    titleCloseSettings: 'Close settings',
    summaryProgress: 'Refreshing',
    summaryRefreshed: 'Refreshed',
    summaryChanges: 'changes',
    summaryErrors: 'errors',
    errRefresh: 'Could not refresh. Please try again.',
    restoreInvalid: 'Invalid backup file.',
    restoreEmpty: 'Backup file contains no pages.',
    restoreUnsupportedVersion: 'This backup was created by a newer, unsupported version of this extension.',
    restoreAdded: 'Restored',
    restoreSkipped: 'skipped',
    skipReasonDuplicate: 'duplicate',
    skipReasonLimit: 'limit reached',
    skipReasonInvalid: 'invalid',
    restorePermissionPending: 'Grant access (via Edit) to finish enabling the restored pages.',
    titleDrag: 'Drag to reorder (or use ↑/↓)',
    titleAdd: 'Add Page',
    titleEdit: 'Edit Page',
    lblSiteName: 'Name',
    lblSiteUrl: 'URL Address',
    lblFreq: 'Check Frequency',
    chkIgnoreDates: 'Ignore date and time changes',
    chkCookies: 'Require cookies (logged-in sites)',
    hintCookies: 'Sends your active session cookies. Use only for sites requiring login.',
    chkNotifications: 'Enable desktop notifications',
    btnSave: 'Save',
    btnCancel: 'Cancel',
    opt1m: 'Every 1 minute',
    opt5m: 'Every 5 minutes',
    opt10m: 'Every 10 minutes',
    opt1h: 'Every 1 hour',
    opt24h: 'Once a day',
    badgeNew: 'NEW',
    badgePaused: 'PAUSED',
    lastCheck: 'Last check',
    alertFillFields: 'Please fill in Name and URL fields.',
    alertPermissionReq: 'Extension needs permission for this website to monitor it.',
    alertInvalidUrl: 'Invalid URL provided. Please use https://...',
    errDuplicate: 'This page is already on the list.',
    errLimit: 'Page limit reached (50). Delete a page to add a new one.',
    errSave: 'Could not save. Please try again.',
    warnHttp: 'WARNING: http:// is unencrypted. Traffic can be intercepted (MITM). Click Save again to proceed anyway.',
    errHttpCookiesBlocked: 'SECURITY ERROR: Session cookies cannot be sent over unencrypted http://. Use https:// or disable cookies option.',
    hintJs: 'The extension checks the server response (HTML or JSON data) but does not run JavaScript. If content is rendered by JS, open the page → F12 → Network → Fetch/XHR and monitor the data request URL instead; put the human-readable page in the «Opened page» field.',
    lblOpenUrl: 'Opened page (optional)',
    hintOpenUrl: 'Opened when you click the card or notification. Useful when monitoring an API/data URL — put the human-readable page address here.',
    titleToggle: 'Pause/Resume',
    titleEditBtn: 'Edit',
    titleDeleteBtn: 'Delete',
    titleRefresh: 'Check now',
    titleDiff: 'View change details',
    linkDiff: 'show changes',
    confirmDelete: 'Are you sure?',
    btnYes: 'Yes',
    btnNo: 'No',
    checkNoChange: 'No changes',
    checkBaseline: 'Initial state saved',
    checkChanged: 'Change detected!',
    checkError: 'Error',
    emptyState: 'No pages monitored yet.\nClick the ＋ button in the top right corner to start.',
    freqLabels: ['1 min', '5 min', '10 min', '1 hr', '24 hrs'],
    urlPlaceholder: 'e.g. https://news-site.com',
    namePlaceholder: 'e.g. News / Store'
  },
  pl: {
    titleList: 'Monitorowane strony',
    btnAdd: 'Dodaj nową stronę',
    btnRefreshAll: 'Odśwież wszystkie',
    btnRefreshAllBusy: 'Odświeżanie…',
    btnBackup: 'Utwórz kopię',
    btnRestore: 'Przywróć kopię',
    settingsTitle: 'Ustawienia',
    lblLanguage: 'Język',
    titleSettings: 'Ustawienia',
    titleCloseSettings: 'Zamknij ustawienia',
    summaryProgress: 'Odświeżanie',
    summaryRefreshed: 'Odświeżono',
    summaryChanges: 'zmiany',
    summaryErrors: 'błędy',
    errRefresh: 'Nie udało się odświeżyć. Spróbuj ponownie.',
    restoreInvalid: 'Nieprawidłowy plik kopii zapasowej.',
    restoreEmpty: 'Plik kopii zapasowej nie zawiera żadnych stron.',
    restoreUnsupportedVersion: 'Ta kopia zapasowa pochodzi z nowszej, nieobsługiwanej wersji tego rozszerzenia.',
    restoreAdded: 'Przywrócono',
    restoreSkipped: 'pominięto',
    skipReasonDuplicate: 'duplikaty',
    skipReasonLimit: 'limit',
    skipReasonInvalid: 'nieprawidłowe',
    restorePermissionPending: 'Nadaj uprawnienia (przez Edytuj), aby włączyć sprawdzanie przywróconych stron.',
    titleDrag: 'Przeciągnij, aby zmienić kolejność (lub użyj ↑/↓)',
    titleAdd: 'Dodaj stronę',
    titleEdit: 'Edytuj stronę',
    lblSiteName: 'Nazwa',
    lblSiteUrl: 'Adres URL',
    lblFreq: 'Częstotliwość sprawdzania',
    chkIgnoreDates: 'Pomijaj zmianę daty i godziny',
    chkCookies: 'Wymagane ciasteczka (strony z logowaniem)',
    hintCookies: 'Wysyła ciasteczka aktywnej sesji. Używaj tylko dla stron wymagających logowania.',
    chkNotifications: 'Włącz powiadomienia pulpitowe',
    btnSave: 'Zapisz',
    btnCancel: 'Anuluj',
    opt1m: 'Co 1 minutę',
    opt5m: 'Co 5 minut',
    opt10m: 'Co 10 minut',
    opt1h: 'Co 1 godzinę',
    opt24h: 'Raz dziennie',
    badgeNew: 'NOWE',
    badgePaused: 'WSTRZYMANE',
    lastCheck: 'Ostatnio',
    alertFillFields: 'Wypełnij pola Nazwa i URL.',
    alertPermissionReq: 'Rozszerzenie potrzebuje uprawnień do tej strony, aby móc ją monitorować.',
    alertInvalidUrl: 'Nieprawidłowy URL. Użyj https://...',
    errDuplicate: 'Ta strona jest już na liście.',
    errLimit: 'Osiągnięto limit stron (50). Usuń jakąś stronę, aby dodać nową.',
    errSave: 'Nie udało się zapisać. Spróbuj ponownie.',
    warnHttp: 'OSTRZEŻENIE: Połączenie http:// nie jest szyfrowane. Kliknij Zapisz ponownie, aby kontynuować na własne ryzyko.',
    errHttpCookiesBlocked: 'BŁĄD BEZPIECZEŃSTWA: Ciasteczka sesyjne nie mogą być przesyłane przez nieszyfrowane http://. Użyj https:// lub wyłącz opcję ciasteczek.',
    hintJs: 'Rozszerzenie sprawdza odpowiedź serwera (HTML lub dane JSON), ale nie uruchamia JavaScriptu. Jeśli treść jest rysowana przez JS, otwórz stronę → F12 → Network → Fetch/XHR i monitoruj adres żądania z danymi; czytelną stronę wpisz w polu «Otwierana strona».',
    lblOpenUrl: 'Otwierana strona (opcjonalne)',
    hintOpenUrl: 'Otwierana po kliknięciu karty lub powiadomienia. Przydatne, gdy monitorujesz adres API/danych — wpisz tu adres czytelnej strony.',
    titleToggle: 'Wstrzymaj/Wznów',
    titleEditBtn: 'Edytuj',
    titleDeleteBtn: 'Usuń',
    titleRefresh: 'Sprawdź teraz',
    titleDiff: 'Podejrzyj szczegóły zmiany',
    linkDiff: 'pokaż zmiany',
    confirmDelete: 'Na pewno?',
    btnYes: 'Tak',
    btnNo: 'Nie',
    checkNoChange: 'Bez zmian',
    checkBaseline: 'Zapisano stan początkowy',
    checkChanged: 'Wykryto zmianę!',
    checkError: 'Błąd',
    emptyState: 'Brak monitorowanych stron.\nKliknij przycisk ＋ w prawym górnym roku, aby zacząć.',
    freqLabels: ['1 min', '5 min', '10 min', '1 godz', '24 godz'],
    urlPlaceholder: 'np. https://dziennik.pl',
    namePlaceholder: 'np. Wiadomości / Sklep'
  }
};

function detectLanguage() {
  try {
    return (chrome.i18n.getUILanguage() || '').toLowerCase().startsWith('pl') ? 'pl' : 'en';
  } catch (e) {
    return 'en';
  }
}

function updateLangButtonsUI() {
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === currentLang);
  });
}

function applyTranslations() {
  const t = TRANSLATIONS[currentLang];
  document.documentElement.lang = currentLang;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (t[key]) el.innerText = t[key];
  });

  // Tytuły (tooltipy) i aria-label — wcześniej zahardkodowane po angielsku.
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (t[key]) el.title = t[key];
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (t[key]) el.setAttribute('aria-label', t[key]);
  });

  const urlInput = document.getElementById('site-url');
  if (urlInput) urlInput.placeholder = t.urlPlaceholder;

  const nameInput = document.getElementById('site-name');
  if (nameInput) nameInput.placeholder = t.namePlaceholder;

  updateRefreshAllButton();
}