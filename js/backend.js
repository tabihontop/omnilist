/* ===========================================================================
   backend.js — thin client for the local PowerShell backend (/api/*)
   Attaches to window.App.backend

   When the app is served by serve.ps1, these endpoints are live. When opened
   via file:// (no server) or the backend is unreachable, calls fail gracefully
   and the app falls back to simulated data.
   =========================================================================== */
(function () {
  window.App = window.App || {};
  let statusCache = null;

  function status() {
    if (statusCache) return statusCache;
    statusCache = (async () => {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        if (!r.ok) return { ok: false };
        return await r.json();
      } catch (e) {
        return { ok: false, offline: true };
      }
    })();
    return statusCache;
  }
  function resetStatus() { statusCache = null; }

  async function ebaySearch(q, limit) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch("/api/ebay/search?limit=" + (limit || 8) + "&q=" + encodeURIComponent(q), { signal: ctrl.signal, cache: "no-store" });
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
    try { const r = await fetch(url, { cache: "no-store" }); const d = await r.json().catch(() => null); return d || { ok: false, error: "http_" + r.status }; }
    catch (e) { return { ok: false, error: "offline", message: String(e && e.message || e) }; }
  }
  async function postJson(url, body) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => null);
      return d || { ok: false, error: "http_" + r.status };
    } catch (e) { return { ok: false, error: "offline", message: String(e && e.message || e) }; }
  }

  // ----- Phase 2: seller OAuth + publishing -----
  function ebayAuthUrl() { return getJson("/api/ebay/auth/url"); }
  function ebayAuthExchange(redirect) { resetStatus(); return postJson("/api/ebay/auth/exchange", { redirect }); }
  function ebayAuthDisconnect() { resetStatus(); return postJson("/api/ebay/auth/disconnect", {}); }
  function ebayAccount() { return getJson("/api/ebay/account"); }
  function ebayPublish(listing) { return postJson("/api/ebay/publish", listing); }
  function ebayAspects(query) { return getJson("/api/ebay/aspects?q=" + encodeURIComponent(query)); }
  function ebayCreateLocation(loc) { return postJson("/api/ebay/location/create", loc); }

  window.App.backend = { status, resetStatus, ebaySearch, ebayAuthUrl, ebayAuthExchange, ebayAuthDisconnect, ebayAccount, ebayPublish, ebayAspects, ebayCreateLocation };
})();
