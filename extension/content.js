// content.js - runs on every arXiv HTML paper page.
// Content scripts can't be ES modules, so this tiny loader imports the real
// code (shared with the web app) as modules from inside the extension.
(async () => {
  const { start } = await import(chrome.runtime.getURL("js/ext-main.js"));
  start();
})();
