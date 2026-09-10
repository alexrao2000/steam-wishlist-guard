# Steam Wishlist Guard

Logs games that disappear from your Steam wishlist so an accidental removal can
be undone. Restores are one click from the toolbar popup.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open <https://store.steampowered.com/> and make sure you're signed in.
5. Click the extension icon, then **Check now** to set the baseline.

That last step matters — until a baseline exists there is nothing to diff
against, so nothing is logged.

## How it works

Two detection paths, in order of precedence.

**Interception.** A content script runs in the page's own JS world and wraps
`fetch`/`XHR`. When Steam fires a remove-from-wishlist request, the script reads
the appid straight out of it — query param, form body, or `input_json`, all of
which Steam has used — and the game is logged within a second. No polling
involved, and no waiting for a diff.

**Snapshot diff.** An hourly alarm fetches `/dynamicstore/userdata/` and
compares `rgWishlist` against the stored snapshot. This is the backstop. It
catches removals made in the desktop client or the phone app, which the
interceptor can't see, and it keeps working if Steam renames the endpoints the
interceptor watches for.

A removal caught on click updates the snapshot too, and appids are held in a
30-minute dedupe window, so the two paths never log the same removal twice. The
popup labels each entry with which path caught it.

Three guards keep it from crying wolf:

- A response without an `rgWishlist` array (signed out, or a changed API) is
  treated as an error, not as an empty wishlist.
- A wishlist that reads as empty when the previous snapshot wasn't needs a
  second confirming poll before anything is logged.
- If the interceptor sees a wishlist call but can't parse an appid out of it, it
  falls back to triggering a diff rather than guessing.

## Confirmation

Removing a game pops a confirmation box first. Recovery is the fallback; not
losing the game in the first place is the better outcome.

The gate sits on the request, not on the remove button. Steam's wishlist is a
React app with hashed class names, and the remove control appears in several
places — wishlist rows, app pages, search capsules — so binding to the button
would mean chasing selectors through every redesign. Wrapping `fetch` catches
all of them at once: the hook holds the request, shows the modal, and either
lets it through or drops it.

Cancelling reloads the page. Steam updates its UI optimistically, so by the time
the modal appears the row may already look removed; a reload is the reliable way
to get the page back in sync with a server that never heard about it.

Turn it off with the checkbox in the popup. XHR-based calls are logged but not
gated — `send()` is synchronous, so there's nowhere to await an answer without
faking a response. Steam's store uses `fetch` for wishlist mutations, so this
doesn't come up in practice.

## Restore

The popup posts to `store.steampowered.com/api/addtowishlist` using the
`sessionid` cookie from your live session. If Steam rejects it — the usual cause
is a stale session — the game's name in the popup links to its store page, where
the normal wishlist button always works.

## Notes

Everything stays in `chrome.storage.local`; nothing is sent anywhere. The log
keeps the 500 most recent removals.

Poll interval is `POLL_MINUTES` at the top of `background.js`, currently 60.
It only governs the backstop — clicks in this browser are caught immediately —
so there is little reason to lower it. Chrome may stretch alarm intervals when
the browser is idle, and for a removal caught by the diff rather than the hook,
the logged timestamp is when it was noticed, not when it happened.

If you'd rather have a `.crx`: Chrome can produce one via **Pack extension** on
`chrome://extensions`, but it will refuse to install it by drag-and-drop, since
sideloaded extensions outside the Web Store get disabled. Load unpacked is the
practical route for personal use.
