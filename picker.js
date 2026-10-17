// Element picker - injected by background.js (handleStartPicker) when the
// user clicks "Pick element on the page..." in the Add/Edit form.
//
// UX model (like uBlock's element picker): the fragment under the cursor is
// highlighted; a click "picks" it. The generated CSS selector is saved to
// chrome.storage.local ("pendingPicker") DIRECTLY from this content script -
// the runtime message to the background is only used to close the tab, so a
// broken message channel can never lose the user's pick. Esc cancels.
//
// Runs in the ISOLATED world (chrome.scripting default): sees the page DOM
// but does not touch the page's JS context.

(function () {
  // Double-injection guard (e.g. handler retry): keep only one picker.
  if (window.__wpcmPickerActive) return;
  window.__wpcmPickerActive = true;

  let target = null;
  let downTarget = null;
  let picked = false;
  let ctx = { url: null, siteId: null, requireCookies: false, rendered: false };

  const overlay = document.createElement('div');
  overlay.className = 'wpcm-picker-overlay';
  const label = document.createElement('div');
  label.className = 'wpcm-picker-label';
  const hintBar = document.createElement('div');
  hintBar.className = 'wpcm-picker-hint';

  function cssEscape(value) {
    return (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/([^\w-])/g, '\\$1');
  }

  function isUnique(el, selector) {
    try {
      const list = document.querySelectorAll(selector);
      return list.length === 1 && list[0] === el;
    } catch (e) {
      return false;
    }
  }

  // Full nth-child chain from <body> - always unique; last-resort fallback.
  function fullChain(el) {
    const parts = [];
    let node = el;
    while (node && node.parentElement && node !== document.body) {
      const index = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
      node = node.parentElement;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : 'body';
  }

  // Shortest selector that matches exactly this element:
  // 1. unique id           -> #results
  // 2. class combo (1-3)    -> .results.table
  // 3. path to unique id ancestor + nth-of-type segments
  // 4. full nth-child chain from <body> (fallback, always unique)
  function selectorFor(el) {
    if (!el || el === document.documentElement || el === document.body) return 'body';

    if (el.id) {
      const byId = '#' + cssEscape(el.id);
      if (isUnique(el, byId)) return byId;
    }

    const classes = Array.from(el.classList).filter((c) => /^[\w-]+$/.test(c));
    for (let n = 1; n <= Math.min(3, classes.length); n++) {
      const combo = '.' + classes.slice(0, n).map(cssEscape).join('.');
      if (isUnique(el, combo)) return combo;
    }

    const parts = [];
    let anchored = false;
    let node = el;
    while (node && node.parentElement && node !== document.body) {
      if (node.id) {
        const byId = '#' + cssEscape(node.id);
        if (isUnique(node, byId)) {
          parts.unshift(byId);
          anchored = true;
          break;
        }
      }
      const sameTag = Array.prototype.filter.call(
        node.parentElement.children,
        (c) => c.tagName === node.tagName
      );
      const idx = Array.prototype.indexOf.call(sameTag, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + (idx > 1 ? ':nth-of-type(' + idx + ')' : ''));
      node = node.parentElement;
    }
    let selector = anchored
      ? parts.join(' > ')
      : 'body' + (parts.length ? ' > ' + parts.join(' > ') : '');

    if (!isUnique(el, selector)) selector = fullChain(el);
    return selector;
  }

  function place(box, rect) {
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  // Brief warning in the hint bar (fragile-pick refusal). Keeps the picker
  // ACTIVE - the user can immediately aim somewhere else.
  function flashHint(text) {
    if (!hintBar.parentNode) return;
    const prev = hintBar.textContent;
    hintBar.textContent = text;
    hintBar.style.background = 'rgba(180, 60, 30, 0.92)';
    setTimeout(() => {
      hintBar.textContent = prev;
      hintBar.style.background = '';
    }, 2500);
  }

  // C: only elements WITH an id or a class are pickable. Elements without
  // any (bare <div>, <td>...) would get a fragile nth-child selector that
  // breaks the moment the page structure changes - they get NO highlight
  // and a click on them does nothing (strict mode, no ancestor bubbling).
  // document.body stays pickable for whole-page monitoring ("body").
  function isPickable(el) {
    if (!el || el === document.documentElement) return false;
    if (el === document.body) return true; // whole page (selector "body")
    return Boolean(el.id) || el.classList.length > 0;
  }
  function onMouseMove(e) {
    if (e.target === overlay || e.target === label || e.target === hintBar) return;
    // STRICT mode: only the element DIRECTLY under the cursor is a pick
    // candidate - NO bubbling to ancestors. A bare element (no id/class)
    // shows no highlight at all, so the user clearly sees what is and is
    // not pickable.
    const el = isPickable(e.target) ? e.target : null;
    if (!el) {
      target = null;
      overlay.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    target = el;
    overlay.style.display = 'block';
    label.style.display = 'block';
    const rect = target.getBoundingClientRect();
    place(overlay, rect);
    place(label, rect);

    // Element name badge: tag + id/class preview (first two classes).
    const cls = (typeof target.className === 'string' && target.className.trim())
      ? '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    label.textContent = target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') + cls;

    // Badge sits above the fragment; when there is no room, drop it below.
    if (rect.top < 30) {
      label.style.transform = 'none';
      label.style.top = (rect.bottom + 4) + 'px';
    } else {
      label.style.transform = 'translateY(-100%)';
    }
  }

  // Fast mode reads the server HTML (no JavaScript), while the picker sees the
  // rendered page. Re-fetch the source the same way the monitor does (same
  // cookie policy) and check whether the selector exists there.
  // Returns true / false, or null when it cannot be determined.
  async function existsInSource(selector) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(ctx.url || location.href, {
        credentials: ctx.requireCookies ? 'include' : 'omit',
        cache: 'no-store',
        signal: ctrl.signal
      });
      if (!res.ok) return null;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      return Boolean(doc.querySelector(selector));
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // The pick itself: save the selector DIRECTLY to storage (the record was
  // seeded by the popup with url/siteId; the pickerStart message carried
  // them here so this content script can write a complete record even if
  // the runtime message below never reaches the background). The
  // pickerPicked message only asks the background to close the tab.
  async function pick(el) {
    if (picked) return;
    if (!isPickable(el)) {
      // Strict mode: bare elements are never picked - do nothing, let the
      // user aim at an element with an id/class instead.
      return;
    }
    // Compute the selector FIRST and refuse FRAGILE picks: an element may
    // have classes, but if none of them is unique on the page, selectorFor()
    // falls back to a positional body > div:nth-child(2) > ... chain that
    // breaks the moment the page structure changes. Such a pick is worse
    // than no pick - warn instead of committing it.
    const candidate = selectorFor(el || target || downTarget);
    if (!/[.#]/.test(candidate)) {
      flashHint(
        el.classList && el.classList.length
          ? 'Klasa tego elementu nie jest unikalna \u2014 wybierz inny fragment (np. nadrz\u0119dny blok z klas\u0105).'
          : 'Ten element nie ma unikalnego id/klasy \u2014 wybierz inny fragment.'
      );
      return;
    }
    picked = true;
    const selector = candidate;
    cleanup();

    // needsRendered: the element is NOT in the server HTML, so the fast mode
    // would never find it - the popup then turns the rendered mode on.
    let needsRendered = false;
    if (!ctx.rendered) needsRendered = (await existsInSource(selector)) === false;

    const record = { url: ctx.url, siteId: ctx.siteId, selector, needsRendered };

    try {
      // Direct, channel-independent persistence - this is what the popup
      // reads on its next open (maybeRestorePicker()).
      await chrome.storage.local.set({ pendingPicker: record });
    } catch (err) { /* noop */ }

    try { chrome.runtime.sendMessage({ action: 'pickerPicked', selector }); } catch (err) { /* noop */ }
  }

  // Selection uses mousedown + mouseup instead of click: the page's own
  // click handlers (some sites stopImmediatePropagation on window clicks,
  // SPA routers, mousedown-driven navigations) can no longer swallow or
  // hijack the gesture. preventDefault on mousedown also stops focus,
  // text-selection and drag-start on the picked fragment.
  function onMouseDown(e) {
    if (e.target === overlay || e.target === label || e.target === hintBar) return;
    e.preventDefault();
    e.stopPropagation();
    // Strict: record the target ONLY if it is pickable itself.
    downTarget = isPickable(e.target) ? e.target : null;
  }

  function onMouseUp(e) {
    if (e.target === overlay || e.target === label || e.target === hintBar) return;
    e.preventDefault();
    e.stopPropagation();
    pick(downTarget || (isPickable(target) ? target : null));
  }

  // Fallback for environments where mouseup never fires (e.g. unusual
  // pointer types); never fires after a successful mouseup pick.
  function onClick(e) {
    if (picked) return;
    e.preventDefault();
    e.stopPropagation();
    pick(isPickable(e.target) ? e.target : (isPickable(target) ? target : null));
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
    try { chrome.runtime.sendMessage({ action: 'pickerCancelled' }); } catch (err) { /* noop */ }
  }

  function cleanup() {
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    label.remove();
    hintBar.remove();
    window.__wpcmPickerActive = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.action !== 'pickerStart') return;
    hintBar.textContent = msg.hint || '';
    ctx.url = msg.url || null;
    ctx.siteId = msg.siteId || null;
    ctx.requireCookies = Boolean(msg.requireCookies);
    ctx.rendered = Boolean(msg.rendered);
    document.documentElement.appendChild(hintBar);
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(label);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
  });
})();