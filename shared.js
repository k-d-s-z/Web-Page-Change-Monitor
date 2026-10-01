export function detectLanguage() {
  const lang = chrome.i18n.getUILanguage() || 'pl';
  return lang.startsWith('pl') ? 'pl' : 'en';
}