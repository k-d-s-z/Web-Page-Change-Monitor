// Groups of monitored pages: a collapsible header with a name, page count,
// unread-change badge and bulk actions (check, mark read, rename, ungroup).
// Data model: storage.groups = [{ id, name, collapsed }] and site.groupId.
// The group list is drawn by renderSites() (cards.js); membership is changed
// by dragging (drag.js) and saved through persistLayout() (storage.js).

let groupTipDone = false; // set once a group exists / was created by dragging

const GROUP_SVG_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const GROUP_ICONS = {
  chevron: `${GROUP_SVG_OPEN}<path d="m6 9 6 6 6-6"/></svg>`,
  markRead: `${GROUP_SVG_OPEN}<path d="m2 13 4 4 8-9"/><path d="m11 16 2 2 9-10"/></svg>`,
  ungroup: `${GROUP_SVG_OPEN}<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`
};

function groupUnreadCount(members) {
  return members.filter((s) => s.hasChanged).length;
}

function groupUnreadHtml(n) {
  const t = TRANSLATIONS[currentLang];
  return n > 0 ? `<span class="badge-changed group-unread">${t.badgeNew} ${n}</span>` : '';
}

// group: {id, name, collapsed}; visible: members shown now (the "changed only"
// filter hides the rest); all: every member (counts always reflect the whole group).
function buildGroup(group, visible, all) {
  const t = TRANSLATIONS[currentLang];
  const collapsed = Boolean(group.collapsed) && !changedOnly; // filter view is always expanded

  const el = document.createElement('div');
  el.className = `group${collapsed ? ' collapsed' : ''}`;
  el.dataset.groupId = group.id;

  el.innerHTML = `
    <div class="group-header">
      <button type="button" class="drag-handle" title="${t.titleDragGroup}" aria-label="${t.titleDragGroup}"><svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7"/><circle cx="10" cy="3.5" r="1.7"/><circle cx="4" cy="9" r="1.7"/><circle cx="10" cy="9" r="1.7"/><circle cx="4" cy="14.5" r="1.7"/><circle cx="10" cy="14.5" r="1.7"/></svg></button>
      <button type="button" class="btn-icon group-toggle" title="${t.titleToggleGroup}" aria-label="${t.titleToggleGroup}" aria-expanded="${!collapsed}">${GROUP_ICONS.chevron}</button>
      <div class="group-title">
        <span class="group-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
        <span class="group-count">(${all.length})</span>${groupUnreadHtml(groupUnreadCount(all))}
      </div>
      <div class="actions">
        <button type="button" class="btn-icon group-refresh" title="${t.titleRefreshGroup}" aria-label="${t.titleRefreshGroup}">${ICONS.refresh}</button>
        <button type="button" class="btn-icon group-markread" title="${t.titleMarkGroupRead}" aria-label="${t.titleMarkGroupRead}">${GROUP_ICONS.markRead}</button>
        <button type="button" class="btn-icon group-rename" title="${t.titleRenameGroup}" aria-label="${t.titleRenameGroup}">${ICONS.edit}</button>
        <button type="button" class="btn-icon group-ungroup" title="${t.titleUngroup}" aria-label="${t.titleUngroup}">${GROUP_ICONS.ungroup}</button>
      </div>
    </div>
    <div class="group-body"></div>
  `;

  const body = el.querySelector('.group-body');
  visible.forEach((s) => body.appendChild(buildCard(s)));

  // Click anywhere on the header (outside the controls) expands/collapses.
  el.querySelector('.group-header').addEventListener('click', (e) => {
    if (e.target.closest('.actions, .drag-handle, input')) return;
    toggleGroup(el);
  });
  el.querySelector('.group-refresh').addEventListener('click', (e) => { e.stopPropagation(); refreshGroup(group.id); });
  el.querySelector('.group-markread').addEventListener('click', (e) => { e.stopPropagation(); markGroupRead(group.id); });
  el.querySelector('.group-rename').addEventListener('click', (e) => { e.stopPropagation(); startGroupRename(el); });
  el.querySelector('.group-ungroup').addEventListener('click', (e) => { e.stopPropagation(); ungroup(group.id); });
  el.addEventListener('keydown', onGroupKeyDown);

  return el;
}

function findGroupEl(groupId) {
  return Array.from(document.querySelectorAll('.group')).find((g) => g.dataset.groupId === groupId) || null;
}

async function toggleGroup(el) {
  const collapsed = !el.classList.contains('collapsed');
  el.classList.toggle('collapsed', collapsed);
  el.querySelector('.group-toggle').setAttribute('aria-expanded', String(!collapsed));
  await callBackground({ action: 'updateGroup', id: el.dataset.groupId, collapsed });
}

// Inline rename: Enter / blur saves, Esc cancels, empty keeps the old name.
function startGroupRename(el) {
  if (!el || el.querySelector('.group-name-input')) return;
  const t = TRANSLATIONS[currentLang];
  const nameEl = el.querySelector('.group-name');
  const oldName = nameEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-name-input';
  input.maxLength = 60;
  input.value = oldName;
  input.setAttribute('aria-label', t.titleRenameGroup);
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = save ? (input.value.trim().slice(0, 60) || oldName) : oldName;
    nameEl.textContent = name;
    nameEl.title = name;
    input.replaceWith(nameEl);
    if (name !== oldName) {
      await callBackground({ action: 'updateGroup', id: el.dataset.groupId, name });
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function refreshGroup(groupId) {
  const data = await chrome.storage.local.get('sites');
  const ids = (data.sites || []).filter((s) => s.groupId === groupId && !s.isPaused).map((s) => s.id);
  if (ids.length === 0) return;
  ids.forEach((id) => { checkingIds.add(id); setCardChecking(id); });
  await callBackground({ action: 'checkSites', siteIds: ids });
  ids.forEach((id) => checkingIds.delete(id));
  await renderSites();
}

async function markGroupRead(groupId) {
  const data = await chrome.storage.local.get('sites');
  const ids = (data.sites || []).filter((s) => s.groupId === groupId).map((s) => s.id);
  await callBackground({ action: 'markSitesRead', siteIds: ids });
  await renderSites();
}

// Pages stay on the list, at the same place, just without the group.
async function ungroup(groupId) {
  await callBackground({ action: 'ungroup', id: groupId });
  await renderSites();
}

// Keeps the unread badges in group headers in sync after a single card refresh.
function syncGroupBadges(sites) {
  document.querySelectorAll('.group').forEach((el) => {
    const members = sites.filter((s) => s.groupId === el.dataset.groupId);
    const n = groupUnreadCount(members);
    const old = el.querySelector('.group-unread');
    if (old) old.remove();
    if (n > 0) el.querySelector('.group-title').insertAdjacentHTML('beforeend', groupUnreadHtml(n));
  });
}

// After a drag the DOM is already right, but the counters/badges in group
// headers still show the old membership - refresh them from storage.
async function syncGroupMeta() {
  const data = await chrome.storage.local.get('sites');
  const sites = data.sites || [];
  document.querySelectorAll('.group').forEach((el) => {
    const members = sites.filter((s) => s.groupId === el.dataset.groupId);
    const c = el.querySelector('.group-count');
    if (c) c.textContent = `(${members.length})`;
  });
  syncGroupBadges(sites);
}
