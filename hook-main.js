// Runs in the page's own JS world so it can see Steam's fetch/XHR traffic.
//
// Goal: pull the appid straight out of the wishlist mutation request, so a
// removal is logged from the request itself rather than inferred from a later
// snapshot diff. The diff remains as a backstop for removals made outside this
// browser, and for the case where Steam changes these endpoints.
(() => {
  const WISHLIST_CALL = /(removefromwishlist|addtowishlist|RemoveFromWishlist|AddToWishlist)/i;

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
    const action = /remove/i.test(url) ? 'remove' : 'add';
    const appid = appidFrom(url, body);
    // appid null means we saw the call but couldn't read it — tell the worker
    // anyway so it falls back to a diff.
    announce({ action, appid, url: String(url) });
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url && WISHLIST_CALL.test(url)) {
        const body = init?.body;
        if (body === undefined && input instanceof Request) {
          // Body lives on the Request; read a clone so the real call is
          // unaffected. Fire-and-forget — never block or reject the fetch.
          input.clone().text().then((text) => report(url, text)).catch(() => report(url, null));
        } else {
          report(url, body);
        }
      }
    } catch { /* same */ }
    return origFetch.apply(this, arguments);
  };

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
