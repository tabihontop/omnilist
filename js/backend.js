/* ===========================================================================
   backend.js — thin client for the local PowerShell backend (/api/*)
   Attaches to window.App.backend

   When the app is served by serve.ps1, these endpoints are live. On the hosted
   site (or file://) /api/* doesn't exist: every call fails gracefully and the
   app treats eBay as a manual "handoff" marketplace.
   Every request carries X-OmniList-Marketplace (EBAY_DE for the EU region,
   EBAY_GB for the UK) unless ebay.config.json pins a marketplace.
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const OK_TTL = 60000;    // re-check a working backend every minute
  const FAIL_TTL = 10000;  // re-check a missing/failed backend after 10 s
  let cache = null;

  function marketplace() { return App.fees && App.fees.region() === "UK" ? "EBAY_GB" : "EBAY_DE"; }
  function headers(extra) { return Object.assign({ "X-OmniList-Marketplace": marketplace() }, extra || {}); }

  function status() {
    const now = Date.now();
    if (cache && now - cache.at < cache.ttl) return cache.promise;
    const entry = { at: now, ttl: OK_TTL };
    entry.promise = (async () => {
      try {
        const r = await fetch("/api/status", { cache: "no-store", headers: headers() });
        const d = r.ok ? await r.json().catch(() => null) : null;
        if (!d || d.ok !== true || !d.ebay) { entry.ttl = FAIL_TTL; return { ok: false, offline: true }; }
        return d;
      } catch (e) {
        entry.ttl = FAIL_TTL;
        return { ok: false, offline: true };
      }
    })();
    cache = entry;
    return entry.promise;
  }
  function resetStatus() { cache = null; }

  async function ebaySearch(q, limit) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch("/api/ebay/search?limit=" + (limit || 8) + "&q=" + encodeURIComponent(q), { signal: ctrl.signal, cache: "no-store", headers: headers() });
      clearTimeout(timer);
      const data = await r.json().catch(() => null);
      if (!r.ok || !data || !data.ok) {
        return { ok: false, error: (data && data.error) || ("http_" + r.status), message: data && (data.message || data.hint) };
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: "offline", message: String(e && e.message || e) };
    }
  }

  async function getJson(url) {
    try { const r = await fetch(url, { cache: "no-store", headers: headers() }); const d = await r.json().catch(() => null); return d || { ok: false, error: "http_" + r.status }; }
    catch (e) { return { ok: false, error: "offline", message: String(e && e.message || e) }; }
  }
  async function postJson(url, body) {
    try {
      const r = await fetch(url, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => null);
      return d || { ok: false, error: "http_" + r.status };
    } catch (e) { return { ok: false, error: "offline", message: String(e && e.message || e) }; }
  }

  // ----- Seller OAuth + publishing -----
  function ebayAuthUrl() { return getJson("/api/ebay/auth/url"); }
  function ebayAuthExchange(redirect) { resetStatus(); return postJson("/api/ebay/auth/exchange", { redirect }); }
  function ebayAuthDisconnect() { resetStatus(); return postJson("/api/ebay/auth/disconnect", {}); }
  function ebayAccount() { return getJson("/api/ebay/account"); }
  function ebayPublish(listing) { return postJson("/api/ebay/publish", listing); }
  function ebayAspects(query) { return getJson("/api/ebay/aspects?q=" + encodeURIComponent(query)); }
  function ebayCreateLocation(loc) { return postJson("/api/ebay/location/create", loc); }

  window.App.backend = { status, resetStatus, marketplace, ebaySearch, ebayAuthUrl, ebayAuthExchange, ebayAuthDisconnect, ebayAccount, ebayPublish, ebayAspects, ebayCreateLocation };
})();
