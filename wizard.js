// Add-page wizard: a step-by-step flow that replaces the single "add" form.
// It reuses popup.js globals (TRANSLATIONS, currentLang, callBackground,
// DEFAULT_FREQ_INDEX, saveErrorMessage, triggerCheck, showList).
// The form view is still used for EDITING a page; only adding goes through here.
//
// Crash-safety: the popup CLOSES when Chrome's permission dialog takes focus,
// killing any pending async flow. The wizard therefore keeps its whole state
// in chrome.storage.local ("wizardDraft") and popup.js restores it on the
// next open (maybeRestoreWizard), so granting permission never loses progress.
//
// Custom interval: offered on the last step as the "Custom..." option. The
// choice lives in wizardState (freqCustomOn + freqCustom) - NOT only in the
// DOM - so renderWizard() can re-apply it without fighting the select.

let wizardState = null;

// Kreator dziala w dedykowanej karcie (popup.html?wizard=1, pelna migracja
// 2026-10). Po Zapisz/Anuluj karta po prostu sie zamyka; popup-lista
// odswiezy sie sam przy nastepnym otwarciu (storage.onChanged/renderSites).
const WIZARD_TAB_MODE = /[?&]wizard=1/.test(window.location.search);

// Zamyka karte kreatora (chrome.tabs.getCurrent zwraca karte tylko w kontekscie
// karty; w popupu zwroci undefined i zostaje window.close()).
async function closeWizardTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab && tab.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch (err) { /* not a tab or API unavailable */ }
  try { window.close(); } catch (err) { /* noop */ }
}

// URL for which the user already confirmed the plain-http warning (step 1).
let wizardHttpConfirm = null;

// True while an external flow (Chrome's permission dialog, the picker tab)
// may close this popup ON PURPOSE: those flows must resurrect the wizard via
// their own drafts, so the pagehide handler below must not treat such a close
// as a cancellation.
let wizardExternalFlow = false;

// A wizard draft older than this is abandoned (user closed the popup without
// Cancel/Save) and must NOT resurrect the wizard on every later popup open -
// that made the extension icon behave like the "+" button.
const WIZARD_DRAFT_MAX_AGE_MS = 15 * 60 * 1000;

const WIZARD_PLACEHOLDERS = {
  en: { name: 'e.g. News / Store', url: 'https://...', selector: '#content, .results, main' },
  pl: { name: 'np. Wiadomo\u015bci / Sklep', url: 'https://...', selector: '#content, .results, main' }
};

function startWizard(prefill = null) {
  wizardHttpConfirm = null;
  wizardState = {
    step: 1,
    url: (prefill && prefill.url) || '',
    name: (prefill && prefill.name) || '',
    rendered: false,
    renderChecked: false,
    finalCheckDone: false,
    requireCookies: false,
    selector: '',
    freqIndex: DEFAULT_FREQ_INDEX,
    freqCustomOn: false,
    freqCustom: '',
    ignoreDates: true,
    enableNotifications: true
  };
  document.getElementById('view-list').style.display = 'none';
  document.getElementById('view-form').style.display = 'none';
  document.getElementById('view-wizard').style.display = 'block';
  clearWizardMessage();
  saveWizardDraft();
  renderWizard();
}

// (Historically the popup released the granted origin itself here. That was
// fragile: a permissions.remove that silently failed during popup teardown
// left the origin granted forever, because the marker the background sweeper
// relies on was already gone. Release now happens ONLY in the background
// (cleanupAbandonedWizard) - the popup just ends the wizard and lets the
// marker pendingWizardOrigin stay as the sweeper's worklist.)

function endWizard() {
  wizardState = null;
  document.getElementById('view-wizard').style.display = 'none';
  clearWizardDraft();
}

// Whole wizard state survives a popup restart (e.g. the permission dialog
// closing the popup mid-flight).
function saveWizardDraft() {
  const s = wizardState;
  if (!s) return;
  // PUSTY wizard (krok 1, bez URL) nie jest zapisywany: taki draft wyglada
  // dla zamiatacza (cleanupAbandonedWizard) jak porzucony kreator i powoduje
  // zwolnienie przyznanego originu, mimo ze karta kreatora zyje. Pusty
  // szkic nie ma tez czego wznawiac.
  if (!s.url) return;
  try {
    chrome.storage.local.set({
      wizardDraft: {
        ts: Date.now(),
        step: s.step,
        url: s.url,
        name: s.name,
        rendered: s.rendered,
        renderChecked: s.renderChecked,
        finalCheckDone: s.finalCheckDone,
        requireCookies: s.requireCookies,
        selector: s.selector,
        freqIndex: s.freqIndex,
        freqCustomOn: s.freqCustomOn,
        freqCustom: s.freqCustom,
        ignoreDates: s.ignoreDates,
        enableNotifications: s.enableNotifications
      }
    });
  } catch (err) { /* storage unavailable - the wizard still works in-memory */ }
}

function clearWizardDraft() {
  try { chrome.storage.local.remove('wizardDraft'); } catch (err) { /* noop */ }
}

function showWizardMessage(text, kind = 'error') {
  const box = document.getElementById('wizard-message');
  box.textContent = text;
  box.className = `form-message show${kind === 'warn' ? ' warn' : ''}`;
}

function clearWizardMessage() {
  const box = document.getElementById('wizard-message');
  box.textContent = '';
  box.className = 'form-message';
}

function renderWizard() {
  const s = wizardState;
  if (!s) return;
  const t = TRANSLATIONS[currentLang];
  const ph = WIZARD_PLACEHOLDERS[currentLang] || WIZARD_PLACEHOLDERS.en;

  for (let i = 1; i <= 5; i++) {
    document.getElementById(`wizard-step-${i}`).style.display = (i === s.step) ? 'block' : 'none';
  }

  document.getElementById('wizard-back').style.visibility = s.step === 1 ? 'hidden' : 'visible';
  document.getElementById('wizard-next').textContent = s.step === 5 ? t.btnSave : t.wizNext;
  // Audyt UX#6: wskaźnik "Krok X z 5 · nazwa kroku" pod tytułem kreatora.
  const indicator = document.getElementById('wizard-step-indicator');
  if (indicator) {
    const names = {
      1: t.wizStepName1, 2: t.wizStepName2, 3: t.wizStepName3,
      4: t.wizStepName4, 5: t.wizStepName5
    };
    const stepOf = (t.wizStepOf || '').replace('{n}', String(s.step));
    const stepName = names[s.step] || '';
    indicator.textContent = stepName ? `${stepOf} \u00b7 ${stepName}` : stepOf;
  }
  clearWizardMessage();

  if (s.step === 1) {
    const nameEl = document.getElementById('wizard-name');
    const urlEl = document.getElementById('wizard-url');
    if (document.activeElement !== nameEl) nameEl.value = s.name;
    if (document.activeElement !== urlEl) urlEl.value = s.url;
    nameEl.placeholder = ph.name;
    urlEl.placeholder = ph.url;
  }

  if (s.step === 2) {
    const info = document.getElementById('wizard-render-info');
    if (!s.renderChecked) {
      info.textContent = t.wizRenderChecking;
      info.className = 'wizard-note';
    } else if (s.rendered) {
      info.textContent = t.wizRenderDetected;
      info.className = 'wizard-note ok';
    } else {
      info.textContent = t.wizRenderNotDetected;
      info.className = 'wizard-note';
    }
  }

  if (s.step === 3) {
    const sel = document.getElementById('wizard-selector');
    if (document.activeElement !== sel) sel.value = s.selector;
    sel.placeholder = ph.selector;
    // Audyt UX#2/3: reczny selektor to opcja "zaawansowane" - panel
    // rozwijamy automatycznie tylko, gdy juz jest w nim wartosc
    // (kreator wznowiony po pickerze / z draftu), zeby jej nie ukryc.
    const panel = document.getElementById('wizard-adv');
    const toggle = document.getElementById('wizard-adv-toggle');
    if (panel && toggle) {
      const open = Boolean(s.selector);
      panel.classList.toggle('open', open);
      panel.style.display = open ? 'block' : 'none';
      toggle.setAttribute('aria-expanded', String(open));
    }
  }

  if (s.step === 4) {
    // Audyt: odpowied\u017a Tak/Nie dwoma przyciskami (checkbox o innej
    // tre\u015bci ni\u017c pytanie myli\u0142). Stan trzymany w wizardState.
    syncLoginButtons(Boolean(s.requireCookies));
  }

  if (s.step === 5) {
    const freq = document.getElementById('wizard-freq');
    const finalNote = document.getElementById('wizard-render-final');
    freq.value = s.freqCustomOn ? 'custom' : String(s.freqIndex);
    // Rendered mode: no 1-minute checks (preset nor custom).
    const oneMin = freq.querySelector('option[value="0"]');
    if (oneMin) oneMin.disabled = s.rendered;
    if (s.rendered && !s.freqCustomOn && freq.value === '0') {
      freq.value = '1';
      s.freqIndex = 1;
    }
    // "Custom..." interval: minutes field shown only for that option.
    const customWrap = document.getElementById('wizard-freq-custom');
    const customInput = document.getElementById('wizard-freq-custom-input');
    customWrap.style.display = s.freqCustomOn ? 'flex' : 'none';
    customInput.min = s.rendered ? '5' : '1';
    if (s.rendered && s.freqCustomOn && s.freqCustom !== '' && Number(s.freqCustom) < 5) {
      s.freqCustom = '5';
    }
    if (document.activeElement !== customInput) customInput.value = s.freqCustom;
    // Late rendered detection (cookies only known since step 3): keep the
    // user informed right where they finish the setup.
    finalNote.style.display = s.rendered ? 'block' : 'none';
    finalNote.textContent = s.rendered ? t.wizRenderDetected : '';
    finalNote.className = s.rendered ? 'wizard-note ok' : 'wizard-note';
    document.getElementById('wizard-notifications').checked = s.enableNotifications;
    document.getElementById('wizard-ignore-dates').checked = s.ignoreDates;
  }
}

function wizardGo(step) {
  if (!wizardState) return;
  wizardState.step = step;
  saveWizardDraft();
  renderWizard();
}

function wizardBack() {
  if (!wizardState || wizardState.step <= 1) return;
  wizardGo(wizardState.step - 1);
}

// Step 2 detection, factored out so the restored wizard (popup closed during
// the permission dialog) can continue exactly where it stopped.
async function runWizardDetection() {
  const s = wizardState;
  if (!s) return;
  const res = await callBackground({
    action: 'previewSite',
    site: {
      url: s.url,
      freqIndex: 2,
      ignoreDates: false,
      requireCookies: false,
      enableNotifications: true,
      renderMode: 'fast',
      selector: ''
    }
  });
  if (!wizardState) return; // wizard finished/cancelled while we were checking
  s.renderChecked = true;
  if (res && res.ok && res.suggestRendered) s.rendered = true;
  if (res && res.ok && s.rendered) s.requireCookies = true;
  saveWizardDraft();
  if (wizardState.step === 2) {
    // 4.1: rendered page detected - stay and inform; 4.2: plain HTML -
    // skip the note and move on to the login question automatically.
    if (s.rendered) renderWizard();
    else wizardGo(3);
  }
}

// Final safety net before saving: the step-2 probe ran WITHOUT cookies (the
// cookie question comes later), so a logged-in page could look like plain
// HTML then. Re-check with the settings the user actually chose; if the
// page turns out to be script-drawn (or the selector is missing from the
// source), switch to rendered mode and say so on step 5 - instead of the
// user only finding out later from the yellow card badge.
async function maybeFinalRenderCheck() {
  const s = wizardState;
  if (!s || s.rendered || s.finalCheckDone) return;
  s.finalCheckDone = true;
  saveWizardDraft();

  const res = await callBackground({
    action: 'previewSite',
    site: {
      url: s.url,
      freqIndex: 2,
      ignoreDates: false,
      requireCookies: s.requireCookies,
      enableNotifications: true,
      renderMode: 'fast',
      selector: s.selector
    }
  });
  if (!wizardState) return;

  const suggestByHeuristic = !!(res && res.ok && res.suggestRendered);
  const selectorMissingInSource = !!(!res || (!res.ok && /^Selector not found/i.test(String(res.error || ''))));
  if (suggestByHeuristic || selectorMissingInSource) {
    s.rendered = true;
    s.requireCookies = true; // rendered mode always uses the browser session
    saveWizardDraft();
    if (wizardState.step === 5) renderWizard();
  }
}

async function wizardNext() {
  const s = wizardState;
  if (!s) return;
  const t = TRANSLATIONS[currentLang];

  if (s.step === 1) {
    const name = document.getElementById('wizard-name').value.trim();
    let url = document.getElementById('wizard-url').value.trim();
    if (!name || !url) { showWizardMessage(t.alertFillFields); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let urlObj;
    try { urlObj = new URL(url); } catch (err) { showWizardMessage(t.alertInvalidUrl); return; }

    s.name = name;
    s.url = url;
    s.renderChecked = false;
    saveWizardDraft(); // step stays 1: name/url must reach the restored wizard

    // Duplicate check right at the first step - walking the whole wizard just
    // to hear "already on the list" at the end would waste the user's time.
    {
      const data = await chrome.storage.local.get('sites');
      const identity = urlObj.href;
      const dup = (data.sites || []).some((x) => {
        try { return new URL(x.url).href === identity; } catch (e) { return false; }
      });
      if (dup) {
        showWizardMessage(t.errDuplicate);
        return;
      }
    }

    // Plain http:// is unencrypted: warn once (same two-click pattern as the
    // edit form) before asking for any permission.
    if (urlObj.protocol === 'http:' && wizardHttpConfirm !== url) {
      wizardHttpConfirm = url;
      showWizardMessage(t.warnHttpWizard, 'warn');
      return;
    }

    // Per-site consent: Chrome's OWN native dialog (it already says "read and
    // modify your data on this site"), asked for DIRECTLY from the "Next"
    // click - no intermediate extension tab. The dialog usually closes this
    // popup (Chrome limitation); the draft survives in storage, and the next
    // popup open resumes at step 2 (maybeRestoreWizard). If the popup
    // survives, we continue right away.
    const pattern = `${urlObj.protocol}//${urlObj.host}/*`;
    let granted = false;
    try { granted = await chrome.permissions.contains({ origins: [pattern] }); }
    catch (err) { granted = false; }

    if (!granted) {
      // Mark the draft BEFORE asking: if the dialog closes this popup,
      // maybeRestoreWizard picks the draft up on the next popup open.
      try {
        const data = await chrome.storage.local.get('wizardDraft');
        const draft = data.wizardDraft;
        if (draft && draft.url === url) {
          draft.pendingPermission = true;
          draft.permissionGranted = false;
          draft.ts = Date.now();
          await chrome.storage.local.set({ wizardDraft: draft });
        }
      } catch (err) { /* draft is best-effort */ }
      // Record the origin BEFORE the permission dialog: the dialog usually
      // CLOSES this popup, so any code after requestWithResume may never run
      // (that is exactly why the marker written after the dialog never
      // appeared and the background sweeper had nothing to clean). Written
      // up-front, the marker survives the popup's death; if consent is denied
      // or the page is saved, the marker is removed/ignored by the same paths
      // as before (save removes it; a denied origin simply removes nothing).
      try { await chrome.storage.local.set({ pendingWizardOrigin: pattern }); } catch (err) { /* best-effort */ }
      wizardExternalFlow = true; // the dialog may close this popup - not a cancel
      try { granted = await requestWithResume({ origins: [pattern] }); }
      catch (err) { granted = false; }
      wizardExternalFlow = false;
    }

    if (!granted) {
      // Popup survived the dialog but consent was refused (or dismissed).
      showWizardMessage(t.alertPermissionReq);
      return;
    }

    wizardGo(2);
    await runWizardDetection();
    return;
  }

  if (s.step === 2) { wizardGo(3); return; }

  // Step 3 (selector) comes BEFORE the cookie question on purpose: the picker
  // works without knowing anything about the login, and the final render-mode
  // check can then use the complete settings (cookies included).
  if (s.step === 3) {
    s.selector = document.getElementById('wizard-selector').value.trim();
    wizardGo(4);
    return;
  }

  if (s.step === 4) {
    // Audyt: odpowied\u017a jest juz w wizardState.requireCookies (przyciski
    // Tak/Nie); rendered zawsze korzysta z sesji przegladarki.
    s.requireCookies = s.requireCookies || s.rendered;
    // Session cookies over plain http:// are refused by the background too;
    // say so here instead of failing at the very last step.
    if (s.requireCookies && /^http:/i.test(s.url)) {
      showWizardMessage(t.errHttpCookiesBlocked);
      return;
    }
    wizardGo(5);
    // Cookies/selector are known only now - verify the render mode once more.
    maybeFinalRenderCheck();
    return;
  }

  if (s.step === 5) {
    const freqValue = document.getElementById('wizard-freq').value;
    const isCustomFreq = freqValue === 'custom';
    let freqMinutes = null;
    if (isCustomFreq) {
      const raw = document.getElementById('wizard-freq-custom-input').value.trim();
      freqMinutes = Number(raw);
      const minAllowed = s.rendered ? 5 : 1;
      if (raw === '' || !Number.isInteger(freqMinutes) || freqMinutes < 1 || freqMinutes > 10080) {
        showWizardMessage(t.errFreqRange);
        return;
      }
      if (freqMinutes < minAllowed) {
        showWizardMessage(t.errFreqRangeRendered);
        return;
      }
      s.freqCustomOn = true;
      s.freqCustom = String(freqMinutes);
      s.freqIndex = parseInt(DEFAULT_FREQ_INDEX, 10); // fallback preset, like the edit form
    } else {
      const freqIndex = parseInt(freqValue, 10);
      s.freqCustomOn = false;
      s.freqIndex = (s.rendered && freqIndex === 0) ? 1 : freqIndex;
    }
    s.ignoreDates = document.getElementById('wizard-ignore-dates').checked;
    s.enableNotifications = document.getElementById('wizard-notifications').checked;
    saveWizardDraft();

    const res = await callBackground({
      action: 'saveSite',
      site: {
        id: '',
        name: s.name,
        url: s.url,
        freqIndex: s.freqIndex,
        freqMinutes: isCustomFreq ? freqMinutes : null,
        ignoreDates: s.ignoreDates,
        requireCookies: s.requireCookies,
        enableNotifications: s.enableNotifications,
        renderMode: s.rendered ? 'rendered' : 'fast',
        selector: s.selector
      }
    });

    if (!res || !res.ok) {
      showWizardMessage(res && res.error === 'invalid' && /^http:/i.test(s.url)
        ? t.errHttpCookiesBlocked
        : saveErrorMessage(res));
      return;
    }

    const siteId = res.siteId;
    // Saved: the origin is now in legitimate use by the monitored page.
    try { await chrome.storage.local.remove('pendingWizardOrigin'); } catch (err) { /* best-effort */ }
    endWizard();
    if (res.needsBaseline && siteId) triggerCheck(siteId);
    // Karta kreatora: zapis zakonczyl prace - zamknij karte (lista odswiezy
    // sie w popupie przy nastepnym otwarciu).
    if (WIZARD_TAB_MODE) {
      await closeWizardTab();
      return;
    }
    await showList();
  }
}

async function wizardPick() {
  const s = wizardState;
  if (!s) return;
  const t = TRANSLATIONS[currentLang];

  const pattern = `${new URL(s.url).origin}/*`;
  // contains() first: with install-time host_permissions it is always true,
  // so the request dialog (which closes this popup) never triggers.
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [pattern] })
      || await chrome.permissions.request({ origins: [pattern] });
  } catch (err) { granted = false; }
  if (!granted) { showWizardMessage(t.pickerPermission); return; }

  // Keep the whole wizard state under pickerDraft: the popup will close when
  // the tab takes focus, and maybeRestorePicker() brings the user back here.
  const draft = {
    wizard: true,
    ts: Date.now(),
    step: s.step,
    url: s.url,
    name: s.name,
    rendered: s.rendered,
    renderChecked: s.renderChecked,
    finalCheckDone: s.finalCheckDone,
    requireCookies: s.requireCookies,
    selector: document.getElementById('wizard-selector').value.trim(),
    freqIndex: s.freqIndex,
    freqCustomOn: s.freqCustomOn,
    freqCustom: s.freqCustom,
    ignoreDates: s.ignoreDates,
    enableNotifications: s.enableNotifications
  };
  await chrome.storage.local.set({
    pendingPicker: { url: s.url, siteId: null },
    pickerDraft: draft
  });
  wizardExternalFlow = true; // the picker tab takes focus and closes this popup
  const res = await callBackground({
    action: 'startPicker',
    url: s.url,
    siteId: null,
    requireCookies: s.requireCookies,
    rendered: s.rendered
  });
  wizardExternalFlow = false; // popup survived after all (some browsers)
  if (!res || !res.ok) {
    await chrome.storage.local.remove(['pendingPicker', 'pickerDraft']);
    showWizardMessage(res && res.error === 'permission' ? t.pickerPermission : t.errSave);
  }
}

// Called by popup.js (maybeRestorePicker) when the user picked an element.
function restoreWizardWithSelector(picked, draft) {
  startWizard(null);
  const s = wizardState;
  s.url = picked.url || (draft && draft.url) || '';
  s.name = (draft && draft.name) || '';
  s.rendered = !!(draft && draft.rendered);
  s.renderChecked = !!(draft && draft.renderChecked);
  s.finalCheckDone = !!(draft && draft.finalCheckDone);
  s.requireCookies = !!(draft && draft.requireCookies);
  s.selector = (picked && picked.selector) || '';
  s.freqIndex = (draft && draft.freqIndex) || DEFAULT_FREQ_INDEX;
  s.freqCustomOn = !!(draft && draft.freqCustomOn);
  s.freqCustom = (draft && draft.freqCustom) ? String(draft.freqCustom) : '';
  s.ignoreDates = draft ? draft.ignoreDates !== false : true;
  s.enableNotifications = draft ? draft.enableNotifications !== false : true;
  wizardGo(3); // step 3 is now the selector step - let the user refine or move on
}

// Popup was closed while the wizard was running (e.g. the permission dialog):
// bring the wizard back at the exact step, and finish a pending detection.
// The guard flag makes it safe to call from both popup.js and the fallback
// below (only one restore per popup open, no double init).
let wizardRestoreStarted = false;

async function maybeRestoreWizard() {
  if (wizardRestoreStarted) return false;
  wizardRestoreStarted = true;
  if (wizardState) return false; // already running (e.g. pendingAdd)
  const data = await chrome.storage.local.get('wizardDraft');
  const d = data.wizardDraft;
  if (!d || !d.url) return false;

  // Stale draft (abandoned wizard): drop it instead of hijacking the popup.
  // Do NOT touch pendingWizardOrigin or remove the permission here - the
  // background sweeper (cleanupAbandonedWizard) owns both: it reacts to the
  // draft disappearing and releases the origin if no saved page uses it.
  if (Date.now() - (d.ts || 0) > WIZARD_DRAFT_MAX_AGE_MS) {
    await chrome.storage.local.remove('wizardDraft');
    return false;
  }

  // A draft WITHOUT a pending permission dialog means the popup was closed
  // by clicking outside it (= cancellation without the Cancel button). The
  // pagehide handler clears such drafts already; this is the safety net for
  // the rare case where that storage write did not complete. Never resurrect
  // a wizard the user already abandoned. The background sweeper handles the
  // origin (pendingWizardOrigin stays as its worklist).
  if (!d.pendingPermission) {
    await chrome.storage.local.remove('wizardDraft');
    return false;
  }

  wizardState = {
    step: Math.min(Math.max(parseInt(d.step, 10) || 1, 1), 5),
    url: d.url || '',
    name: d.name || '',
    rendered: !!d.rendered,
    renderChecked: !!d.renderChecked,
    finalCheckDone: !!d.finalCheckDone,
    requireCookies: !!d.requireCookies,
    selector: d.selector || '',
    freqIndex: d.freqIndex || DEFAULT_FREQ_INDEX,
    freqCustomOn: !!d.freqCustomOn,
    freqCustom: d.freqCustom ? String(d.freqCustom) : '',
    ignoreDates: d.ignoreDates !== false,
    enableNotifications: d.enableNotifications !== false
  };
  document.getElementById('view-list').style.display = 'none';
  document.getElementById('view-form').style.display = 'none';
  document.getElementById('view-wizard').style.display = 'block';
  renderWizard();

  if (wizardState.step === 1 && d.pendingPermission) {
    // The permission dialog closed the popup while consent was pending.
    // Granted (the user clicked "Allow") -> continue at step 2 automatically;
    // denied/abandoned -> stay at step 1 so "Next" re-asks.
    let pattern = '';
    try { pattern = `${new URL(d.url).protocol}//${new URL(d.url).host}/*`; } catch (err) { pattern = ''; }
    let granted = false;
    try { granted = !!pattern && await chrome.permissions.contains({ origins: [pattern] }); }
    catch (err) { granted = false; }
    if (granted) {
      wizardState.renderChecked = false;
      wizardGo(2);
      await runWizardDetection();
    }
    return true;
  }

  if (wizardState.step === 2) {
    if (!wizardState.renderChecked) {
      await runWizardDetection();
    } else if (!wizardState.rendered) {
      wizardGo(3);
    }
  } else if (wizardState.step === 4 && !wizardState.finalCheckDone) {
    // Popup died between the cookie question and the final render check.
    wizardGo(5);
    maybeFinalRenderCheck();
  } else if (wizardState.step === 5) {
    maybeFinalRenderCheck();
  }
  return true;
}

// Audyt: stan przycisk\u00f3w Tak/Nie w kroku 4 - wybrany dostaje klas\u0119 .sel
// (styl marki), drugi wraca do neutralnego wygl\u0105du.
function syncLoginButtons(requireCookies) {
  const yesBtn = document.getElementById('wizard-login-yes');
  const noBtn = document.getElementById('wizard-login-no');
  if (!yesBtn || !noBtn) return;
  yesBtn.classList.toggle('sel', requireCookies);
  noBtn.classList.toggle('sel', !requireCookies);
  yesBtn.setAttribute('aria-pressed', String(requireCookies));
  noBtn.setAttribute('aria-pressed', String(!requireCookies));
}

function setLoginAnswer(requireCookies) {
  if (!wizardState) return;
  // Tylko zapis odpowiedzi; przej\u015bcie Dalej zostaje przy "Dalej" -
  // walidacja http+ciasteczka w wizardNext musi si\u0119 wykona\u0107.
  wizardState.requireCookies = requireCookies;
  syncLoginButtons(requireCookies);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('wizard-next').addEventListener('click', wizardNext);
  document.getElementById('wizard-back').addEventListener('click', wizardBack);
  // Audyt: krok 4 odpowiada na pytanie o logowanie przyciskami Tak/Nie
  // (zamiast checkboxa o innej tre\u015bci ni\u017c pytanie).
  const yesBtn = document.getElementById('wizard-login-yes');
  const noBtn = document.getElementById('wizard-login-no');
  yesBtn.addEventListener('click', () => { setLoginAnswer(true); });
  noBtn.addEventListener('click', () => { setLoginAnswer(false); });
  document.getElementById('wizard-cancel').addEventListener('click', async () => {
    // Only END the wizard here (draft removed -> background cleanupAbandonedWizard
    // fires via storage.onChanged and releases the granted origin). The popup
    // does NOT remove the permission itself: if that call silently failed
    // (as it sometimes does during popup teardown or a race), the marker
    // pendingWizardOrigin stays behind as the background's worklist and the
    // sweeper + 1-minute alarm guarantee the release anyway.
    endWizard();
    if (WIZARD_TAB_MODE) {
      await closeWizardTab();
      return;
    }
    await showList();
  });
  document.getElementById('wizard-pick').addEventListener('click', wizardPick);
  // Audyt UX#2/3: selektor CSS wpisany recznie - opcja "zaawansowane",
  // rozwijana lacznikiem pod podpowiedzia (glowna sciezka to picker).
  const advToggle = document.getElementById('wizard-adv-toggle');
  const advPanel = document.getElementById('wizard-adv');
  if (advToggle && advPanel) {
    advToggle.addEventListener('click', () => {
      const open = !advPanel.classList.contains('open');
      advPanel.classList.toggle('open', open);
      advPanel.style.display = open ? 'block' : 'none';
      advToggle.setAttribute('aria-expanded', String(open));
      if (open) document.getElementById('wizard-selector').focus();
    });
  }
  document.getElementById('wizard-freq').addEventListener('change', () => {
    if (!wizardState) return;
    const value = document.getElementById('wizard-freq').value;
    if (value === 'custom') {
      wizardState.freqCustomOn = true;
      renderWizard();
      document.getElementById('wizard-freq-custom-input').focus();
    } else {
      const freqIndex = parseInt(value, 10);
      wizardState.freqCustomOn = false;
      wizardState.freqIndex = (wizardState.rendered && freqIndex === 0) ? 1 : freqIndex;
      renderWizard();
    }
    saveWizardDraft();
  });
  document.getElementById('wizard-freq-custom-input').addEventListener('input', () => {
    if (!wizardState) return;
    wizardState.freqCustom = document.getElementById('wizard-freq-custom-input').value.trim();
    saveWizardDraft();
  });

  // Clicking outside the popup closes it with NO cancel event. Treat that
  // close as cancellation: release the freshly granted origin (best-effort;
  // the background sweeper is the safety net) and drop the draft so the
  // wizard never resurrects on its own. While wizardExternalFlow is set
  // (permission dialog / picker tab), the close is expected and the
  // dedicated drafts (wizardDraft.pendingPermission / pickerDraft) take over.
  window.addEventListener('pagehide', () => {
    if (!wizardState || wizardExternalFlow) return;
    // Only the DRAFT removal matters here (a single quick storage write with
    // a real chance to commit while the popup is torn down). The granted
    // origin is NOT touched: the background sweeper sees the draft vanish
    // (storage.onChanged -> cleanupAbandonedWizard) and releases the
    // permission; if even this write dies, the 1-minute alarm catches it.
    endWizard();
  });

  // Self-restore fallback: karta kreatora normalnie wywoluje
  // maybeRestoreWizard() w swoim DOMContentLoaded; ten fallback to tylko
  // bezpieczenstwo dla poprawki czesciowego wdrozenia (popup.js starszej
  // wersji). W POPUPIE kreator juz nie zyje (pelna migracja do karty) -
  // nie wskrzeszaj go tu.
  setTimeout(async () => {
    if (WIZARD_TAB_MODE && !wizardState) await maybeRestoreWizard();
  }, 250);
});