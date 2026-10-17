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
