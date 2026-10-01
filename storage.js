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

async function persistOrder(orderedIds) {
  await callBackground({ action: 'reorderSites', order: orderedIds });
}