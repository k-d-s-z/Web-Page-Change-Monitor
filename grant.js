// Consent tab: per-site host permission is requested HERE, not in the popup.
// The popup always closes when Chrome's permission dialog appears (a hard
// Chrome limitation), which used to kill the add-page wizard mid-flow. A tab
// survives the dialog, so the flow continues: after the user grants access,
// this tab reopens the popup and the wizard auto-continues at step 2.

document.addEventListener('DOMContentLoaded', async () => {
  const t = TRANSLATIONS[detectGrantLang()];

  document.getElementById('grant-title').textContent = t.grantTitle;
  document.getElementById('grant-text').textContent = t.grantText;
  document.getElementById('grant-btn').textContent = t.grantBtn;

  const pattern = decodeURIComponent(window.location.hash.slice(1)) || '';
  let host = '';
  try { host = new URL(pattern.replace(/\*$/, '')).host; } catch (e) { host = pattern; }
  document.getElementById('grant-host').textContent = host || pattern;

  const btn = document.getElementById('grant-btn');
  const status = document.getElementById('grant-status');
  const hint = document.getElementById('grant-hint');

  if (!pattern) {
    btn.disabled = true;
    status.textContent = t.grantFail;
    status.className = 'status err';
    return;
  }

  // Already granted (e.g. the user re-opened the tab): nothing to ask for.
  let has = false;
  try { has = await chrome.permissions.contains({ origins: [pattern] }); }
  catch (e) { has = false; }
  if (has) {
    btn.disabled = true;
    status.textContent = t.grantAlready;
    status.className = 'status ok';
    return;
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (e) { granted = false; }

    if (granted) {
      status.textContent = t.grantOk;
      status.className = 'status ok';
      hint.textContent = t.grantOkHint;
      hint.style.display = 'block';

      // Mark the wizard draft so the popup knows to continue at step 2.
      try {
        const data = await chrome.storage.local.get('wizardDraft');
        const draft = data.wizardDraft;
        if (draft && draft.url) {
          draft.pendingPermission = true;
          draft.permissionGranted = true;
          draft.ts = Date.now();
          await chrome.storage.local.set({ wizardDraft: draft });
        }
      } catch (e) { /* draft is best-effort */ }

      // Bring the wizard back WITHOUT waiting for the user to hunt for the
      // extension icon. Preferred: the real popup (Chrome 127+). Fallback
      // (always works): popup.html opened as a small app window - it is the
      // same extension page, so the wizard restores there and auto-continues
      // at step 2 (maybeRestoreWizard sees pendingPermission + granted).
      let opened = false;
      try {
        if (chrome.action && typeof chrome.action.openPopup === 'function') {
          await chrome.action.openPopup();
          opened = true;
        }
      } catch (e) { opened = false; }
      if (!opened) {
        try {
          await chrome.windows.create({
            url: chrome.runtime.getURL('popup.html'),
            type: 'popup',
            width: 420,
            height: 660
          });
          opened = true;
        } catch (e) { opened = false; }
      }
      if (opened) window.close();
      // Not opened either way: the hint above stays visible as the fallback.
    } else {
      status.textContent = t.grantFail;
      status.className = 'status err';
      btn.disabled = false;
    }
  });
});

function detectGrantLang() {
  try {
    return (chrome.i18n.getUILanguage() || '').toLowerCase().startsWith('pl') ? 'pl' : 'en';
  } catch (e) {
    return 'en';
  }
}