const TRANSLATIONS = {
  en: {
    titleList: 'Monitored Pages',
    btnAdd: 'Add New Page',
    btnRefreshAll: 'Refresh all',
    btnRefreshAllBusy: 'Refreshing\u2026',
    btnBackup: 'Create',
    btnRestore: 'Restore',
    lblBackupCol: 'Settings backup',
    settingsTitle: 'Settings',
    lblLanguage: 'Language',
    lblThemeCol: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
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
    restoreTooBig: 'Backup file is too large (over 2 MB).',
    deletedSummary: 'Deleted',
    undoDelete: 'Undo',
    undoDone: 'Restored',
    undoFailed: 'Could not restore the page.',
    showChanged: 'show',
    filterChanged: 'Filter: changed only',
    clearFilter: 'clear',
    emptyFiltered: 'No changed pages.',
    restoreAdded: 'Restored',
    restoreSkipped: 'skipped',
    skipReasonDuplicate: 'duplicate',
    skipReasonLimit: 'limit reached',
    skipReasonInvalid: 'invalid',
    restorePermissionPending: 'Grant access (via Edit) to finish enabling the restored pages.',
    titleDrag: 'Drag to reorder (or use \u2191/\u2193)',
    titleAdd: 'Add Page',
    titleEdit: 'Edit Page',
    lblSiteName: 'Name',
    lblSiteUrl: 'URL Address',
    lblFreq: 'Check Frequency',
    chkIgnoreDates: 'Ignore date and time changes',
    chkCookies: 'Require cookies (logged-in sites)',
    hintCookies: 'Sends your active session cookies. Use only for sites requiring login.',
    chkNotifications: 'Enable desktop notifications',
    chkRendered: 'Rendered page mode (JS-rendered sites)',
    hintRendered: 'Opens the page in a hidden tab and reads what you see. Use for pages that load content with scripts. Slower.',
    suggestRendered: 'Looks JS-rendered - enable rendered mode when editing',
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
    hintJs: 'The extension checks the page code and the data it receives, but does not run JavaScript. If the content only appears once the page scripts have loaded, follow these steps:\n- open the page you want to monitor and press F12,\n- go to the Network tab and select the Fetch/XHR filter,\n- click the right entry in the Name column and copy the address from the Request URL row,\n- paste that address in the \u00abURL\u00bb field, and enter the main page address in the \u00abOpened page\u00bb field below.',
    lblOpenUrl: 'Opened page (optional)',
    hintOpenUrl: 'Enter the address of a readable page when the \u00abURL\u00bb field contains an address taken from Request URL.',
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
    emptyState: 'No pages monitored yet.\nClick the \uff0b button in the top right corner to start.',
    freqLabels: ['1 min', '5 min', '10 min', '1 hr', '24 hrs'],
    urlPlaceholder: 'e.g. https://news-site.com',
    namePlaceholder: 'e.g. News / Store'
  },
  pl: {
    titleList: 'Monitorowane strony',
    btnAdd: 'Dodaj now\u0105 stron\u0119',
    btnRefreshAll: 'Od\u015bwie\u017c wszystkie',
    btnRefreshAllBusy: 'Od\u015bwie\u017canie\u2026',
    btnBackup: 'Utw\u00f3rz',
    btnRestore: 'Przywr\u00f3\u0107',
    lblBackupCol: 'Kopia ustawie\u0144',
    settingsTitle: 'Ustawienia',
    lblLanguage: 'J\u0119zyk',
    lblThemeCol: 'Motyw',
    themeLight: 'Jasny',
    themeDark: 'Ciemny',
    titleSettings: 'Ustawienia',
    titleCloseSettings: 'Zamknij ustawienia',
    summaryProgress: 'Od\u015bwie\u017canie',
    summaryRefreshed: 'Od\u015bwie\u017cono',
    summaryChanges: 'zmiany',
    summaryErrors: 'b\u0142\u0119dy',
    errRefresh: 'Nie uda\u0142o si\u0119 od\u015bwie\u017cy\u0107. Spr\u00f3buj ponownie.',
    restoreInvalid: 'Nieprawid\u0142owy plik kopii zapasowej.',
    restoreEmpty: 'Plik kopii zapasowej nie zawiera \u017cadnych stron.',
    restoreUnsupportedVersion: 'Ta kopia zapasowa pochodzi z nowszej, nieobs\u0142ugiwanej wersji tego rozszerzenia.',
    restoreTooBig: 'Plik kopii zapasowej jest zbyt du\u017cy (powy\u017cej 2 MB).',
    deletedSummary: 'Usuni\u0119to',
    undoDelete: 'Cofnij',
    undoDone: 'Przywr\u00f3cono',
    undoFailed: 'Nie uda\u0142o si\u0119 przywr\u00f3ci\u0107 strony.',
    showChanged: 'poka\u017c',
    filterChanged: 'Filtr: tylko zmienione',
    clearFilter: 'wyczy\u015b\u0107',
    emptyFiltered: 'Brak zmienionych stron.',
    restoreAdded: 'Przywr\u00f3cono',
    restoreSkipped: 'pomini\u0119to',
    skipReasonDuplicate: 'duplikaty',
    skipReasonLimit: 'limit',
    skipReasonInvalid: 'nieprawid\u0142owe',
    restorePermissionPending: 'Nadaj uprawnienia (przez Edytuj), aby w\u0142\u0105czy\u0107 sprawdzanie przywr\u00f3conych stron.',
    titleDrag: 'Przeci\u0105gnij, aby zmieni\u0107 kolejno\u015b\u0107 (lub u\u017cyj \u2191/\u2193)',
    titleAdd: 'Dodaj stron\u0119',
    titleEdit: 'Edytuj stron\u0119',
    lblSiteName: 'Nazwa',
    lblSiteUrl: 'Adres URL',
    lblFreq: 'Cz\u0119stotliwo\u015b\u0107 sprawdzania',
    chkIgnoreDates: 'Pomijaj zmian\u0119 daty i godziny',
    chkCookies: 'Wymagane ciasteczka (strony z logowaniem)',
    hintCookies: 'Wysy\u0142a ciasteczka aktywnej sesji. U\u017cywaj tylko dla stron wymagaj\u0105cych logowania.',
    chkNotifications: 'W\u0142\u0105cz powiadomienia pulpitowe',
    chkRendered: 'Tryb strony renderowanej (strony rysowane przez skrypty)',
    hintRendered: 'Otwiera stron\u0119 w ukrytej karcie i odczytuje to, co widzisz. U\u017cyj dla stron, kt\u00f3re \u0142aduj\u0105 tre\u015b\u0107 skryptami. Wolniejsze.',
    suggestRendered: 'Wygl\u0105da na rysowan\u0105 przez JS - w\u0142\u0105cz tryb renderowany w edycji',
    btnSave: 'Zapisz',
    btnCancel: 'Anuluj',
    opt1m: 'Co 1 minut\u0119',
    opt5m: 'Co 5 minut',
    opt10m: 'Co 10 minut',
    opt1h: 'Co 1 godzin\u0119',
    opt24h: 'Raz dziennie',
    badgeNew: 'NOWE',
    badgePaused: 'WSTRZYMANE',
    lastCheck: 'Ostatnio',
    alertFillFields: 'Wype\u0142nij pola Nazwa i URL.',
    alertPermissionReq: 'Rozszerzenie potrzebuje uprawnie\u0144 do tej strony, aby m\u00f3c j\u0105 monitorowa\u0107.',
    alertInvalidUrl: 'Nieprawid\u0142owy URL. U\u017cyj https://...',
    errDuplicate: 'Ta strona jest ju\u017c na li\u015bcie.',
    errLimit: 'Osi\u0105gni\u0119to limit stron (50). Usu\u0144 jak\u0105\u015b stron\u0119, aby doda\u0107 now\u0105.',
    errSave: 'Nie uda\u0142o si\u0119 zapisa\u0107. Spr\u00f3buj ponownie.',
    warnHttp: 'OSTRZE\u017bENIE: Po\u0142\u0105czenie http:// nie jest szyfrowane. Kliknij Zapisz ponownie, aby kontynuowa\u0107 na w\u0142asne ryzyko.',
    errHttpCookiesBlocked: 'B\u0141\u0104D BEZPIECZE\u0143STWA: Ciasteczka sesyjne nie mog\u0105 by\u0107 przesy\u0142ane przez nieszyfrowane http://. U\u017cyj https:// lub wy\u0142\u0105cz opcj\u0119 ciasteczek.',
    hintJs: 'Rozszerzenie sprawdza kod strony oraz przesy\u0142ane dane, ale nie uruchamia JavaScriptu. Je\u015bli tre\u015b\u0107 na stronie pojawia si\u0119 dopiero po za\u0142adowaniu skrypt\u00f3w, wykonaj poni\u017csze kroki:\n- otw\u00f3rz stron\u0119 do monitorowania i naci\u015bnij F12,\n- przejd\u017a do zak\u0142adki Network (Sie\u0107) i zaznacz filtr Fetch/XHR,\n- kliknij odpowiedni\u0105 pozycj\u0119 na li\u015bcie w kolumnie Name i skopiuj adres z wiersza Request URL,\n- wklej ten adres w polu \u00abAdres URL\u00bb, a g\u0142\u00f3wny adres strony wpisz poni\u017cej w polu \u00abOtwierana strona\u00bb.',
    lblOpenUrl: 'Otwierana strona (opcjonalne)',
    hintOpenUrl: 'Wpisz adres czytelnej strony w przypadku podania w polu \u00abAdres URL\u00bb pozycji z Request URL.',
    titleToggle: 'Wstrzymaj/Wzn\u00f3w',
    titleEditBtn: 'Edytuj',
    titleDeleteBtn: 'Usu\u0144',
    titleRefresh: 'Sprawd\u017a teraz',
    titleDiff: 'Podejrzyj szczeg\u00f3\u0142y zmiany',
    linkDiff: 'poka\u017c zmiany',
    confirmDelete: 'Na pewno?',
    btnYes: 'Tak',
    btnNo: 'Nie',
    checkNoChange: 'Bez zmian',
    checkBaseline: 'Zapisano stan pocz\u0105tkowy',
    checkChanged: 'Wykryto zmian\u0119!',
    checkError: 'B\u0142\u0105d',
    emptyState: 'Brak monitorowanych stron.\nKliknij przycisk \uff0b w prawym g\u00f3rnym roku, aby zacz\u0105\u0107.',
    freqLabels: ['1 min', '5 min', '10 min', '1 godz', '24 godz'],
    urlPlaceholder: 'np. https://dziennik.pl',
    namePlaceholder: 'np. Wiadomo\u015bci / Sklep'
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

  // Tytu\u0142y (tooltipy) i aria-label \u2014 wcze\u015bniej zahardkodowane po angielsku.
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