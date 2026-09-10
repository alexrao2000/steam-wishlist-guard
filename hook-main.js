// Runs in the page's own JS world, wrapping fetch/XHR/sendBeacon. Two jobs:
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
//
// Endpoint names are treated as unreliable. Rather than matching a fixed list,
// anything wishlist-shaped that isn't a known read is treated as a mutation,
// and anything whose direction can't be determined is handed to the snapshot
// diff instead of guessed at.
(() => {
  // Any wishlist URL that isn't one of the known read endpoints.
  const WISHLIST_URL = /wishlist/i;
  const READ_ONLY = /(getwishlist|wishlistdata|wishlist\/profiles|sortedfiltered|wishlistcount)/i;
  const REMOVE_HINT = /(remove|delete|unwish)/i;
  const ADD_HINT = /(add|create)/i;

  // 'remove' and 'add' are actionable. 'mutation' means "something changed the
  // wishlist but the name doesn't say which way" — a rename we haven't seen.
  // Those aren't gated (guessing the direction could block an add) but they do
  // trigger a diff, so the removal is still logged.
  const classify = (url, method) => {
    if (!url || !WISHLIST_URL.test(url) || READ_ONLY.test(url)) return null;
    if (REMOVE_HINT.test(url)) return 'remove';
    if (ADD_HINT.test(url)) return 'add';
    const m = String(method || 'GET').toUpperCase();
    return (m === 'POST' || m === 'PUT' || m === 'DELETE') ? 'mutation' : null;
  };

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

  // Steam's service API increasingly sends protobuf rather than form fields —
  // the notification API already does. appid is field 1 of the wishlist request
  // messages, so a minimal varint walk is enough to recover it.
  const appidFromProtobuf = (b64) => {
    try {
      const bin = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
      const readVarint = (i) => {
        let v = 0, shift = 0, byte;
        do {
          if (i >= bin.length || shift > 35) return null;
          byte = bin.charCodeAt(i++);
          v |= (byte & 0x7f) << shift;
          shift += 7;
        } while (byte & 0x80);
        return [v >>> 0, i];
      };
      let i = 0;
      while (i < bin.length) {
        const key = readVarint(i);
        if (!key) return null;
        const [k, afterKey] = key;
        i = afterKey;
        const field = k >> 3, wire = k & 7;
        if (wire === 0) {
          const val = readVarint(i);
          if (!val) return null;
          if (field === 1) return val[0];
          i = val[1];
        } else if (wire === 2) {
          const len = readVarint(i);
          if (!len) return null;
          i = len[1] + len[0];
        } else if (wire === 5) i += 4;
        else if (wire === 1) i += 8;
        else return null;
      }
    } catch { /* not protobuf, or truncated */ }
    return null;
  };

  // Steam has used several shapes over the years: form-encoded POST bodies,
  // appid as a query param, input_json blobs, and protobuf. Check all of them.
  const appidFrom = (url, body) => {
    try {
      // Parse the query directly rather than via new URL(). The URL
      // constructor throws when the page has an opaque origin, and it needs a
      // base for relative URLs — neither is worth depending on here.
      const q = String(url).indexOf('?');
      const params = new URLSearchParams(q === -1 ? '' : String(url).slice(q + 1));
      const direct = params.get('appid');
      if (direct) return Number(direct);
      const inputJson = params.get('input_json');
      if (inputJson) {
        const m = /"appid"\s*:\s*(\d+)/.exec(inputJson);
        if (m) return Number(m[1]);
      }
      const proto = params.get('input_protobuf_encoded');
      if (proto) {
        const v = appidFromProtobuf(proto);
        if (v) return v;
      }
    } catch { /* malformed query — fall through to the body */ }

    if (body instanceof URLSearchParams) {
      const v = body.get('appid') || body.get('input_protobuf_encoded');
      if (v) return /^\d+$/.test(v) ? Number(v) : appidFromProtobuf(v);
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const v = body.get('appid');
      if (v) return Number(v);
    }
    if (typeof body === 'string') {
      const m = /(?:^|[&?])appid=(\d+)/.exec(body) || /"appid"\s*:\s*(\d+)/.exec(body);
      if (m) return Number(m[1]);
      const p = /input_protobuf_encoded=([^&]+)/.exec(body);
      if (p) return appidFromProtobuf(decodeURIComponent(p[1]));
    }
    return null;
  };

  const report = (kind, url, body) => {
    announce({ action: kind, appid: appidFrom(url, body), url: String(url) });
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
    let url, method;
    try {
      if (typeof input === 'string') { url = input; method = init?.method; }
      else { url = input?.url; method = init?.method || input?.method; }
    } catch { /* fall through to the unmodified call */ }

    const kind = classify(url, method);
    if (!kind) return origFetch.apply(this, arguments);

    const args = arguments;
    const self = this;
    const body = init?.body !== undefined ? init.body
      : (input instanceof Request ? null : undefined);

    // Only a confident removal is gated. An unrecognised mutation is reported
    // so the worker can diff, but never blocked — blocking something that
    // turned out to be an add would be worse than not prompting.
    if (kind !== 'remove' || !confirmEnabled) {
      try { report(kind, url, body); } catch { /* never break the page */ }
      return origFetch.apply(self, args);
    }

    const appid = appidFrom(url, body);
    return askToRemove(appid).then((confirmed) => {
      if (confirmed) {
        try { report('remove', url, body); } catch { /* same */ }
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

  // --- XHR and sendBeacon --------------------------------------------------
  //
  // Log-only. Neither can await a modal: XHR's send() is synchronous from the
  // caller's point of view, and sendBeacon returns a boolean. Steam's store
  // uses fetch for wishlist mutations, so these are here to make sure a
  // removal is still recorded if some corner of the site does otherwise.

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const kind = classify(url && String(url), method);
      if (kind) { this.__swgUrl = String(url); this.__swgKind = kind; }
    } catch { /* same */ }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__swgUrl) report(this.__swgKind, this.__swgUrl, body);
    } catch { /* same */ }
    return origSend.apply(this, arguments);
  };

  if (typeof navigator.sendBeacon === 'function') {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        const kind = classify(url && String(url), 'POST');
        if (kind) report(kind, String(url), data);
      } catch { /* same */ }
      return origBeacon(url, data);
    };
  }

})();
