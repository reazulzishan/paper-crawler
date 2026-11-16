// background.js - clicking the toolbar icon opens the explanation side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
