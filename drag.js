// Drag & drop of pages and groups.
//  - Drag a page by its handle to reorder it.
//  - Drop it on the MIDDLE of another ungrouped page: both become a new group.
//  - Drop it inside a group (header or body) to add it; drag it out to remove it.
//  - Groups are reordered by their own handle.
// Keyboard: with a handle focused (or Alt on a card), ArrowUp/ArrowDown moves
// the item; moving past a group's edge enters/leaves it.
// Dragging is disabled while the "changed only" filter hides some pages, so a
// partial list can never overwrite the real order.

const MERGE_BAND = 0.28; // top/bottom 28% of a page reorder, the middle merges

function initDragAndDrop(container) {
  container.addEventListener('pointerdown', onCardPointerDown);
  container.addEventListener('click', (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

// Current list as the background stores it.
function getLayout() {
  const container = document.getElementById('sites-container');
  const layout = [];
  for (const el of container.children) {
    if (el.classList.contains('site-card')) {
      layout.push({ type: 'site', id: el.dataset.id });
    } else if (el.classList.contains('group')) {
      layout.push({
        type: 'group',
        id: el.dataset.groupId,
        siteIds: Array.from(el.querySelectorAll('.site-card')).map((c) => c.dataset.id)
      });
    }
  }
  return layout;
}

function hasEmptyGroup() {
  return Array.from(document.querySelectorAll('.group')).some((g) => !g.querySelector('.site-card'));
}

// Replaces the ungrouped target with a new group [target, dragged].
function mergeIntoNewGroup(layout, targetId, draggedId, groupId) {
  const out = [];
  for (const item of layout) {
    if (item.type === 'site') {
      if (item.id !== draggedId) out.push(item);
    } else {
      out.push({ ...item, siteIds: item.siteIds.filter((id) => id !== draggedId) });
    }
  }
  const idx = out.findIndex((i) => i.type === 'site' && i.id === targetId);
  if (idx === -1) return null;
  out[idx] = {
    type: 'group',
    id: groupId,
    name: TRANSLATIONS[currentLang].groupDefaultName,
    siteIds: [targetId, draggedId]
  };
  return out;
}

// Moves a page to the end of the given (collapsed) group.
function addToGroupLayout(layout, draggedId, groupId) {
  const out = layout
    .map((item) => (item.type === 'site'
      ? (item.id === draggedId ? null : item)
      : { ...item, siteIds: item.siteIds.filter((id) => id !== draggedId) }))
    .filter(Boolean);
  const group = out.find((i) => i.type === 'group' && i.id === groupId);
  if (!group) return null;
  group.siteIds.push(draggedId);
  return out;
}

function expandGroupEl(g) {
  if (!g.classList.contains('collapsed')) return;
  g.classList.remove('collapsed');
  const btn = g.querySelector('.group-toggle');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  callBackground({ action: 'updateGroup', id: g.dataset.groupId, collapsed: false });
}

async function finishKeyboardMove(handle) {
  const empty = hasEmptyGroup();
  await persistLayout(getLayout());
  if (empty) {
    await renderSites();
  } else {
    await syncGroupMeta();
    if (handle && handle.isConnected) handle.focus();
  }
}

async function onCardKeyDown(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

  const onHandle = e.target.classList.contains('drag-handle');
  if (!onHandle && !e.altKey) return;

  const card = e.currentTarget;
  if (card.classList.contains('confirming') || drag || changedOnly) return;

  e.preventDefault();
  const up = e.key === 'ArrowUp';
  const parent = card.parentElement;
  const inGroup = parent.classList.contains('group-body');
  const sib = up ? card.previousElementSibling : card.nextElementSibling;

  if (sib && sib.classList.contains('group')) {
    // ungrouped page next to a group: enter it (last / first position)
    expandGroupEl(sib);
    const body = sib.querySelector('.group-body');
    if (up) body.append(card); else body.prepend(card);
  } else if (sib) {
    if (up) card.after(sib); else card.before(sib);
  } else if (inGroup) {
    // edge of a group: leave it
    const group = parent.closest('.group');
    if (up) group.before(card); else group.after(card);
  } else {
    return;
  }
  await finishKeyboardMove(onHandle ? e.target : card.querySelector('.drag-handle'));
}

async function onGroupKeyDown(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const handle = e.target;
  if (!handle.classList || !handle.classList.contains('drag-handle') || !handle.closest('.group-header')) return;
  if (drag || changedOnly) return;

  const group = e.currentTarget;
  const up = e.key === 'ArrowUp';
  const sib = up ? group.previousElementSibling : group.nextElementSibling;
  e.preventDefault();
  if (!sib) return;
  if (up) group.after(sib); else group.before(sib);
  await finishKeyboardMove(handle);
}

function onCardPointerDown(e) {
  if (e.button !== 0 || drag || changedOnly) return;

  const handle = e.target.closest('.drag-handle');
  if (!handle) return;

  const card = handle.closest('.site-card') || handle.closest('.group');
  if (!card || card.classList.contains('confirming')) return;

  drag = {
    card,
    startX: e.clientX,
    startY: e.clientY,
    lastY: e.clientY,
    active: false,
    rafId: null,
    layoutBefore: JSON.stringify(getLayout()),
    mergeTarget: null,
    dropGroup: null,
    originGroupId: card.closest('.group') && card.closest('.group') !== card ? card.closest('.group').dataset.groupId : null
  };

  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragCancel);
}

// Footer hint while dragging: a general tip until the user has made a group,
// then only contextual messages (what releasing here will do).
function updateDragHint() {
  const el = document.getElementById('drag-hint');
  if (!el || !drag || !drag.active) return;
  const t = TRANSLATIONS[currentLang];
  let text = '';
  if (!drag.card.classList.contains('group')) {
    if (drag.mergeTarget) {
      text = t.dragHintMerge.replace('{name}', drag.mergeTarget.dataset.name || '');
    } else if (drag.dropGroup && drag.dropGroup.dataset.groupId !== drag.originGroupId) {
      const nameEl = drag.dropGroup.querySelector('.group-name');
      text = t.dragHintInto.replace('{name}', nameEl ? nameEl.textContent : '');
    } else if (!groupTipDone) {
      text = t.dragHintGroup;
    }
  }
  el.textContent = text;
  el.classList.toggle('show', Boolean(text));
}

function hideDragHint() {
  const el = document.getElementById('drag-hint');
  if (!el) return;
  el.textContent = '';
  el.classList.remove('show');
}

function activateDrag() {
  if (!drag) return;
  drag.active = true;
  updateDragHint();
  drag.card.classList.add('dragging');
  document.body.classList.add('is-dragging');
  drag.rafId = requestAnimationFrame(dragFrame);
}

function onDragMove(e) {
  if (!drag) return;
  drag.lastY = e.clientY;

  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
    activateDrag();
  }

  e.preventDefault();
  moveDraggedCard(e.clientY);
}

function dragFrame() {
  if (!drag || !drag.active) return;

  const footer = document.querySelector('.list-footer');
  const bottomEdge = footer ? footer.getBoundingClientRect().top : window.innerHeight;

  if (drag.lastY < AUTOSCROLL_ZONE_PX) {
    window.scrollBy(0, -AUTOSCROLL_SPEED_PX);
  } else if (drag.lastY > bottomEdge - AUTOSCROLL_ZONE_PX) {
    window.scrollBy(0, AUTOSCROLL_SPEED_PX);
  }
  moveDraggedCard(drag.lastY);
  drag.rafId = requestAnimationFrame(dragFrame);
}

// Visual hints: merge-target = page that would be merged with; drop-into =
// group that would receive the page.
function setDropHints(mergeEl, groupEl) {
  if (drag.mergeTarget !== mergeEl) {
    if (drag.mergeTarget) drag.mergeTarget.classList.remove('merge-target');
    if (mergeEl) mergeEl.classList.add('merge-target');
    drag.mergeTarget = mergeEl;
  }
  if (drag.dropGroup !== groupEl) {
    if (drag.dropGroup) drag.dropGroup.classList.remove('drop-into');
    if (groupEl) groupEl.classList.add('drop-into');
    drag.dropGroup = groupEl;
  }
  updateDragHint();
}

function clearDropHints(d) {
  if (d.mergeTarget) d.mergeTarget.classList.remove('merge-target');
  if (d.dropGroup) d.dropGroup.classList.remove('drop-into');
  d.mergeTarget = null;
  d.dropGroup = null;
}

function moveDraggedCard(clientY) {
  const container = document.getElementById('sites-container');
  const dragged = drag.card;
  const isGroup = dragged.classList.contains('group');
  const tops = Array.from(container.children).filter((el) =>
    el !== dragged && (el.classList.contains('site-card') || el.classList.contains('group')));

  if (!isGroup) {
    // 1) pointer inside a group (header or body): the page goes into it
    for (const g of tops) {
      if (!g.classList.contains('group')) continue;
      const r = g.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) continue;

      // A collapsed group has no visible body: moving the page into it would
      // shrink the list and pull the group away from the pointer (jitter). Only
      // highlight it; onDragEnd adds the page when it is dropped here.
      if (g.classList.contains('collapsed')) {
        setDropHints(null, g);
        return;
      }

      const body = g.querySelector('.group-body');
      let next = null;
      for (const el of body.querySelectorAll('.site-card')) {
        if (el === dragged) continue;
        const b = el.getBoundingClientRect();
        if (clientY < b.top + b.height / 2) { next = el; break; }
      }
      if (dragged.parentElement !== body || dragged.nextElementSibling !== next) {
        body.insertBefore(dragged, next);
      }
      setDropHints(null, g);
      return;
    }

    // 2) middle of an ungrouped page: candidate for a new group (no reordering)
    for (const el of tops) {
      if (!el.classList.contains('site-card')) continue;
      const r = el.getBoundingClientRect();
      const band = r.height * MERGE_BAND;
      if (clientY > r.top + band && clientY < r.bottom - band) {
        setDropHints(el, null);
        return;
      }
    }
  }

  // 3) plain reorder among the top-level items
  setDropHints(null, null);
  let next = null;
  for (const el of tops) {
    const box = el.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) {
      next = el;
      break;
    }
  }
  if (dragged.parentElement !== container || dragged.nextElementSibling !== next) {
    container.insertBefore(dragged, next);
  }
}

function stopDragTracking() {
  const d = drag;
  drag = null;
  if (!d) return null;

  if (d.rafId) cancelAnimationFrame(d.rafId);
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragCancel);
  return d;
}

function finishActiveDrag(d) {
  hideDragHint();
  d.card.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 100);
}

async function onDragEnd() {
  const d = stopDragTracking();
  if (!d || !d.active) return;

  const mergeTarget = d.mergeTarget;
  const intoCollapsed = d.dropGroup && d.dropGroup.classList.contains('collapsed') && !d.card.classList.contains('group')
    ? d.dropGroup.dataset.groupId : null;
  clearDropHints(d);
  finishActiveDrag(d);

  let layout = getLayout();
  let newGroupId = null;

  if (mergeTarget && !d.card.classList.contains('group') && mergeTarget.dataset.id && d.card.dataset.id) {
    const gid = crypto.randomUUID();
    const merged = mergeIntoNewGroup(layout, mergeTarget.dataset.id, d.card.dataset.id, gid);
    if (merged) {
      layout = merged;
      newGroupId = gid;
      groupTipDone = true; // discovered - stop showing the general tip
      chrome.storage.local.set({ groupTipDone: true });
    }
  }
  let addedToCollapsed = false;
  if (!newGroupId && intoCollapsed) {
    const next = addToGroupLayout(layout, d.card.dataset.id, intoCollapsed);
    if (next) {
      layout = next;
      addedToCollapsed = true;
    }
  }
  if (!newGroupId && !addedToCollapsed && JSON.stringify(layout) === d.layoutBefore) return;

  const empty = hasEmptyGroup();
  await persistLayout(layout);

  if (newGroupId || empty || addedToCollapsed) {
    await renderSites();
    if (newGroupId) startGroupRename(findGroupEl(newGroupId));
  } else {
    await syncGroupMeta();
  }
}

function onDragCancel() {
  const d = stopDragTracking();
  if (!d || !d.active) return;

  clearDropHints(d);
  finishActiveDrag(d);
  renderSites();
}
