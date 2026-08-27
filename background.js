// Steam Wishlist Guard — background service worker.
//
// Two detection paths, in order of precedence:
//
//   1. Interception. A content script reads the appid out of Steam's own
//      remove-from-wishlist request, so a click in this browser is logged
//      within a second or so. No polling involved.
//
//   2. Snapshot diff. A periodic alarm fetches the wishlist and compares it
//      against the last known state. This is the backstop: it catches removals
//      made in the desktop client or phone app, and it keeps working if Steam
//      renames the endpoints the interceptor watches for.
//
// Everything is stored locally in chrome.storage.local. Nothing is sent
// anywhere.

const USERDATA = 'https://store.steampowered.com/dynamicstore/userdata/';
const APPDETAILS = 'https://store.steampowered.com/api/appdetails';
const POLL_MINUTES = 60;
const MAX_LOG = 500;

// A removal caught by interception must not be logged a second time when the
// next diff notices the same absence. Appids are held here briefly to bridge
// that window.
const DEDUPE_MS = 30 * 60 * 1000;

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

// --- wishlist fetch --------------------------------------------------------

// Returns an array of appids, or throws if the answer can't be trusted.
async function fetchWishlist() {
  const res = await fetch(USERDATA, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`userdata returned HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.rgWishlist)) {
    // Signed out, or Steam changed the response shape. Either way, do not read
    // this as "the wishlist is empty" — that would log every game as removed.
    throw new Error('no rgWishlist in response (signed out?)');
  }
  return data.rgWishlist.map(Number).filter(Number.isFinite);
}

// Names are cached indefinitely; they effectively never change, and appdetails
// is rate limited to roughly 200 requests per 5 minutes.
async function resolveName(appid) {
  const { names = {} } = await get('names');
  if (names[appid]) return names[appid];
  try {
    const res = await fetch(`${APPDETAILS}?appids=${appid}&filters=basic`, { cache: 'no-store' });
    const body = await res.json();
    const entry = body?.[String(appid)];
    if (entry?.success && entry.data?.name) {
      names[appid] = entry.data.name;
      await set({ names });
      return names[appid];
    }
  } catch (err) {
    console.warn('name lookup failed for', appid, err);
  }
  return null;
}

// --- logging ---------------------------------------------------------------

function prune(seen) {
  const cutoff = Date.now() - DEDUPE_MS;
  for (const [appid, ts] of Object.entries(seen)) {
    if (ts < cutoff) delete seen[appid];
  }
  return seen;
}

async function appendRemovals(appids, detectedBy) {
  const { log = [], seen = {} } = await get(['log', 'seen']);
  prune(seen);

  const fresh = appids.filter((appid) => !seen[appid]);
  if (!fresh.length) return [];

  const entries = [];
  for (const appid of fresh) {
    seen[appid] = Date.now();
    entries.push({
      appid,
      name: await resolveName(appid),
      removedAt: Date.now(),
      detectedBy,
      restored: false,
    });
  }

  await set({ log: [...entries, ...log].slice(0, MAX_LOG), seen });
  notify(entries);
  return entries;
}

function notify(entries) {
  const label = entries.length === 1
    ? (entries[0].name || `App ${entries[0].appid}`)
    : `${entries.length} games`;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Removed from your wishlist',
    message: `${label} — logged, and restorable from the extension popup.`,
  });
  // Badge the toolbar icon too, so a dismissed notification still leaves a trace.
  chrome.action.setBadgeText({ text: String(entries.length) });
  chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
}

// --- path 1: interception --------------------------------------------------

async function onIntercepted(action, appid) {
  if (!Number.isFinite(appid)) {
    // Saw the call but couldn't read the appid. Let the diff work it out.
    setTimeout(() => snapshot('hook-fallback'), 1500);
    return;
  }

  if (action === 'add') {
    // Re-adding clears the dedupe entry, so removing it again later still logs.
    const { seen = {}, snapshot: snap } = await get(['seen', 'snapshot']);
    delete seen[appid];
    const next = Array.isArray(snap) && !snap.includes(appid) ? [...snap, appid] : snap;
    await set({ seen, ...(next ? { snapshot: next } : {}) });
    return;
  }

  await appendRemovals([appid], 'click');

  // Keep the baseline consistent with what we just logged, so the next diff
  // doesn't see this appid as newly missing.
  const { snapshot: snap } = await get('snapshot');
  if (Array.isArray(snap)) {
    await set({ snapshot: snap.filter((a) => a !== appid) });
  }
}

// --- path 2: snapshot diff -------------------------------------------------

async function snapshot(reason) {
  let current;
  try {
    current = await fetchWishlist();
  } catch (err) {
    await set({ lastError: { message: String(err.message || err), at: Date.now() } });
    return { ok: false, reason: String(err.message || err) };
  }

  const { snapshot: previous } = await get('snapshot');
  await set({ lastError: null, lastCheck: Date.now() });

  // First run: establish a baseline and log nothing.
  if (!Array.isArray(previous)) {
    await set({ snapshot: current });
    return { ok: true, baseline: true, size: current.length };
  }

  // Guard against a wishlist that reads as empty because of a bad session or a
  // Steam-side hiccup. A genuine "removed everything" is rare enough that one
  // confirming poll is the right trade.
  if (current.length === 0 && previous.length > 0) {
    const { emptyStrikes = 0 } = await get('emptyStrikes');
    if (emptyStrikes < 1) {
      await set({ emptyStrikes: emptyStrikes + 1 });
      return { ok: false, reason: 'wishlist read as empty; waiting for a second confirmation' };
    }
  }
  await set({ emptyStrikes: 0 });

  const now = new Set(current);
  const missing = previous.filter((a) => !now.has(a));
  const logged = missing.length ? await appendRemovals(missing, reason) : [];

  await set({ snapshot: current });
  return { ok: true, removed: logged.length, size: current.length };
}

// --- restore ---------------------------------------------------------------

async function restore(appid) {
  const cookie = await chrome.cookies.get({
    url: 'https://store.steampowered.com',
    name: 'sessionid',
  });
  if (!cookie) {
    return { ok: false, reason: 'No Steam session found. Open store.steampowered.com and sign in first.' };
  }
  const res = await fetch('https://store.steampowered.com/api/addtowishlist', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sessionid: cookie.value, appid: String(appid) }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* Steam sometimes replies with HTML on failure */ }
  if (!res.ok || !body?.success) {
    return {
      ok: false,
      reason: `Steam rejected the request (HTTP ${res.status}). Add it from the store page instead.`,
    };
  }

  const { log = [], seen = {} } = await get(['log', 'seen']);
  for (const entry of log) {
    if (entry.appid === appid) entry.restored = true;
  }
  delete seen[appid];
  await set({ log, seen });
  await snapshot('post-restore');
  return { ok: true };
}

// --- wiring ---------------------------------------------------------------

function schedule() {
  chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES, delayInMinutes: 0.1 });
}

chrome.runtime.onInstalled.addListener(() => { schedule(); snapshot('installed'); });
chrome.runtime.onStartup.addListener(() => { schedule(); snapshot('startup'); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll') snapshot('poll');
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  switch (msg?.type) {
    case 'wishlist-mutated':
      onIntercepted(msg.action, Number(msg.appid));
      return false;
    case 'snapshot-now':
      snapshot('manual').then(respond);
      return true;
    case 'restore':
      restore(Number(msg.appid)).then(respond);
      return true;
    case 'clear-badge':
      chrome.action.setBadgeText({ text: '' });
      return false;
    default:
      return false;
  }
});
