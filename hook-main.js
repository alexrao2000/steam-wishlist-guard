// Runs in the page's own JS world, wrapping fetch/XHR. Two jobs:
//
//   1. Gate removals behind a confirmation modal, by holding the request until
//      the user answers.
//   2. Read the appid out of wishlist mutations so the extension can log a
//      removal from the request itself rather than a later snapshot diff.
//
// Hooking the request rather than the remove button is deliberate. Steam's
// wishlist is a React app with hashed class names, and the remove control shows
// up in several different places (wishlist rows, app pages, search capsules).
// The request is the one thing all of them have in common, and it doesn't
// change shape when the UI gets redesigned.
(() => {
  const WISHLIST_CALL = /(removefromwishlist|addtowishlist|RemoveFromWishlist|AddToWishlist)/i;
  const isRemoval = (url) => /remove/i.test(url);

  // Default to confirming. The real setting arrives from the extension a beat
  // after document_start, so erring this way means a click in that window
  // prompts rather than silently removing.
  let confirmEnabled = true;
  window.addEventListener('swg:config', (ev) => {
    if (typeof ev.detail?.confirmEnabled === 'boolean') confirmEnabled = ev.detail.confirmEnabled;
  });

  const announce = (detail) => {
    try {
      window.dispatchEvent(new CustomEvent('swg:wishlist-mutated', { detail }));
    } catch { /* never let instrumentation break the page */ }
  };

  // Steam has used several shapes over the years: form-encoded POST bodies,
  // appid as a query param, and input_json blobs. Check all of them.
  const appidFrom = (url, body) => {
    try {
      const params = new URL(url, location.origin).searchParams;
      const direct = params.get('appid');
      if (direct) return Number(direct);
      const inputJson = params.get('input_json');
      if (inputJson) {
        const m = /"appid"\s*:\s*(\d+)/.exec(inputJson);
        if (m) return Number(m[1]);
      }
    } catch { /* relative or malformed URL — fall through to the body */ }

    if (body instanceof URLSearchParams) {
      const v = body.get('appid');
      if (v) return Number(v);
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const v = body.get('appid');
      if (v) return Number(v);
    }
    if (typeof body === 'string') {
      const m = /(?:^|[&?])appid=(\d+)/.exec(body) || /"appid"\s*:\s*(\d+)/.exec(body);
      if (m) return Number(m[1]);
    }
    return null;
  };

  const report = (url, body) => {
    announce({ action: isRemoval(url) ? 'remove' : 'add', appid: appidFrom(url, body), url: String(url) });
  };

  // --- confirmation modal --------------------------------------------------

  // Ask the extension for a display name; it has a cache and can hit
  // appdetails. Resolves to null quickly if nothing comes back.
  const nameFor = (appid) => new Promise((resolve) => {
    if (!Number.isFinite(appid)) return resolve(null);
    const done = (ev) => {
      if (ev.detail?.appid !== appid) return;
      window.removeEventListener('swg:name', done);
      clearTimeout(timer);
      resolve(ev.detail.name || null);
    };
    const timer = setTimeout(() => {
      window.removeEventListener('swg:name', done);
      resolve(null);
    }, 1200);
    window.addEventListener('swg:name', done);
    window.dispatchEvent(new CustomEvent('swg:need-name', { detail: { appid } }));
  });

  const CSS = `
    :host { all: initial; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.72);
      display: flex; align-items: center; justify-content: center;
      font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    }
    .card {
      background: #1b2838; color: #c7d5e0; border: 1px solid #2a475e;
      border-radius: 4px; width: min(420px, calc(100vw - 40px));
      padding: 20px 22px; box-shadow: 0 12px 40px rgba(0,0,0,.55);
    }
    h2 { margin: 0 0 10px; font-size: 16px; color: #fff; font-weight: 600; }
    p { margin: 0 0 18px; }
    .game { color: #66c0f4; font-weight: 600; }
    .row { display: flex; gap: 10px; justify-content: flex-end; }
    button {
      font: inherit; border-radius: 3px; padding: 7px 16px; cursor: pointer;
      border: 1px solid #2a475e; background: #2a475e; color: #c7d5e0;
    }
    button:hover { background: #3d6c8d; }
    button.danger { background: #7a2f28; border-color: #7a2f28; color: #f0d6d2; }
    button.danger:hover { background: #9c3a31; }
    button:focus-visible { outline: 2px solid #66c0f4; outline-offset: 2px; }
  `;

  function askToRemove(appid) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      // Shadow DOM so Steam's stylesheets can't reach in and the modal can't
      // leak styles back out.
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;

      const backdrop = document.createElement('div');
      backdrop.className = 'backdrop';
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');

      const h2 = document.createElement('h2');
      h2.textContent = 'Remove from wishlist?';
      const p = document.createElement('p');
      const gameEl = document.createElement('span');
      gameEl.className = 'game';
      gameEl.textContent = Number.isFinite(appid) ? `App ${appid}` : 'This game';
      p.append(gameEl, document.createTextNode(' will be taken off your wishlist.'));

      const row = document.createElement('div');
      row.className = 'row';
      const keep = document.createElement('button');
      keep.textContent = 'Keep it';
      const remove = document.createElement('button');
      remove.className = 'danger';
      remove.textContent = 'Remove';

      row.append(keep, remove);
      card.append(h2, p, row);
      backdrop.append(card);
      root.append(style, backdrop);
      (document.body || document.documentElement).append(host);

      // Fill in the real name once it arrives.
      nameFor(appid).then((name) => { if (name) gameEl.textContent = name; });

      let settled = false;
      const close = (answer) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        host.remove();
        resolve(answer);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(false); }
      };

      keep.addEventListener('click', () => close(false));
      remove.addEventListener('click', () => close(true));
      backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(false); });
      document.addEventListener('keydown', onKey, true);
      // Default focus on the safe choice.
      keep.focus();
    });
  }

  // --- fetch ---------------------------------------------------------------

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url;
    try {
      url = typeof input === 'string' ? input : input?.url;
    } catch { /* fall through to the unmodified call */ }

    if (!url || !WISHLIST_CALL.test(url)) return origFetch.apply(this, arguments);

    const args = arguments;
    const self = this;
    const body = init?.body !== undefined ? init.body
      : (input instanceof Request ? null : undefined);

    if (!isRemoval(url) || !confirmEnabled) {
      try { report(url, body); } catch { /* never break the page */ }
      return origFetch.apply(self, args);
    }

    const appid = appidFrom(url, body);
    return askToRemove(appid).then((confirmed) => {
      if (confirmed) {
        try { report(url, body); } catch { /* same */ }
        return origFetch.apply(self, args);
      }
      // Steam has very likely already updated its UI optimistically, so the
      // page now disagrees with the server. Reload to resync rather than
      // rejecting and leaving a half-removed row on screen. The returned
      // promise never settles, which is fine — the document is going away.
      window.dispatchEvent(new CustomEvent('swg:removal-cancelled', { detail: { appid } }));
      location.reload();
      return new Promise(() => {});
    });
  };

  // --- XHR -----------------------------------------------------------------
  //
  // Log-only. XHR's send() is synchronous from the caller's point of view, so
  // there is nowhere to await a modal without lying about the response. Steam's
  // store uses fetch for wishlist mutations; this is here so that if some
  // corner of the site still uses XHR, the removal is at least recorded.

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url && WISHLIST_CALL.test(String(url))) this.__swgUrl = String(url);
    } catch { /* same */ }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__swgUrl) report(this.__swgUrl, body);
    } catch { /* same */ }
    return origSend.apply(this, arguments);
  };
})();
