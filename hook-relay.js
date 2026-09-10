// Bridges the MAIN-world hook to the extension. MAIN-world scripts have no
// access to chrome.runtime, so everything travels as window events.

// Tell the worker a Steam page is open with the hook installed. It uses this
// to tell "the phone app removed something" apart from "the interceptor
// stopped working".
chrome.runtime.sendMessage({ type: 'page-active' }).catch(() => {});

// Push the confirm setting into the page, and keep it current if the user
// toggles it in the popup while a Steam tab is open.
function pushConfig(confirmEnabled) {
  window.dispatchEvent(new CustomEvent('swg:config', { detail: { confirmEnabled } }));
}

chrome.storage.local.get('confirmEnabled').then(({ confirmEnabled }) => {
  // Undefined means never set — confirming is the default.
  pushConfig(confirmEnabled !== false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.confirmEnabled) {
    pushConfig(changes.confirmEnabled.newValue !== false);
  }
});

// The modal wants a game name rather than a bare appid.
window.addEventListener('swg:need-name', (ev) => {
  const appid = ev.detail?.appid;
  chrome.runtime.sendMessage({ type: 'resolve-name', appid })
    .then((res) => {
      window.dispatchEvent(new CustomEvent('swg:name', {
        detail: { appid, name: res?.name || null },
      }));
    })
    .catch(() => { /* modal falls back to "App <id>" on its own timeout */ });
});

window.addEventListener('swg:wishlist-mutated', (ev) => {
  const { action, appid } = ev.detail || {};
  chrome.runtime.sendMessage({ type: 'wishlist-mutated', action, appid }).catch(() => {
    // Worker asleep mid-reload, or extension updating — the next poll covers it.
  });
});
