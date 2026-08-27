// Bridges the MAIN-world hook to the extension. MAIN-world scripts have no
// access to chrome.runtime, so the signal travels as a window event.
window.addEventListener('swg:wishlist-mutated', (ev) => {
  const { action, appid } = ev.detail || {};
  chrome.runtime.sendMessage({ type: 'wishlist-mutated', action, appid }).catch(() => {
    // Worker asleep mid-reload, or extension updating — the next poll covers it.
  });
});
