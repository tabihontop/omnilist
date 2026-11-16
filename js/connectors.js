/* ===========================================================================
   connectors.js — marketplace connector registry + publishing
   Attaches to window.App.connectors

   eBay publishes for REAL through the local backend (serve.ps1 + your eBay keys
   + seller login). Everywhere else — and eBay whenever that backend isn't
   available — OmniList prepares the listing ("Ready to post") and the seller
   posts it themselves. Nothing is ever reported as live unless it is.
   =========================================================================== */
(function () {
  window.App = window.App || {};

  const CONNECTORS = {
    ebay: {
      id: "ebay", label: "eBay", color: "#0064d2", short: "eB",
      hasOfficialApi: true,
      audience: "Largest general marketplace, global buyers",
      priceFactor: 1.0,
      apiNote: "eBay has an official selling API. In the desktop version (start.bat) with your eBay keys, OmniList publishes and updates eBay listings for you. Here, it prepares the listing so you post it yourself.",
      baseUrl: "https://www.ebay.com/itm/",
    },
    depop: {
      id: "depop", label: "Depop", color: "#ff2300", short: "De",
      hasOfficialApi: false, handoff: true,
      sellNote: "Depop listings are usually created in the Depop phone app — open it on your phone, or use the web sell page below.",
      audience: "Gen-Z fashion / streetwear / vintage, premium pricing",
      priceFactor: 1.12,
      apiNote: "No public API — and OmniList does NOT automate Depop (that would break their rules). Instead it prepares a ready-to-post listing and opens Depop's sell page for you to post yourself.",
      baseUrl: "https://www.depop.com/products/",
    },
    vinted: {
      id: "vinted", label: "Vinted", color: "#09a7b0", short: "Vi",
      hasOfficialApi: false, handoff: true,
      audience: "EU-heavy, no seller fees, value buyers",
      priceFactor: 0.9,
      apiNote: "No public API — and OmniList does NOT automate Vinted (that would break their rules). Instead it prepares a ready-to-post listing and opens Vinted's sell page so you post it yourself in one tap.",
      baseUrl: "https://www.vinted.com/items/",
    },
    facebook: {
      id: "facebook", label: "Facebook", color: "#1877f2", short: "FB",
      hasOfficialApi: false, handoff: true,
      sellNote: "Facebook Marketplace listings are created on Facebook (sign-in required). Local pickup has no selling fees.",
      audience: "Huge local + shipped audience, fee-free for local pickup",
      priceFactor: 1.0,
      apiNote: "No public listing API, and OmniList does NOT automate Facebook (against their rules). It prepares a ready-to-post listing and opens Marketplace's 'create item' page for you to post yourself.",
      baseUrl: "https://www.facebook.com/marketplace/item/",
    },
    sellpy: {
      id: "sellpy", label: "Sellpy", color: "#0e9f6e", short: "Sp",
      hasOfficialApi: false, handoff: true,
      sellNote: "Sellpy is consignment: you order a free Sellpy bag, fill it, and they photograph, list & sell your items for you. This opens Sellpy to get started; the details below are for your reference.",
      audience: "Consignment - they photograph, list & sell for you (EU)",
      priceFactor: 0.8,
      apiNote: "No public listing API. Sellpy is a managed consignment service, so there is nothing to automate - OmniList opens Sellpy and shows your item details so you can send it in.",
      baseUrl: "https://www.sellpy.com/",
    },
  };

  // Where to send the seller to post ("sell") or to find/remove a listing ("manage").
  const LINKS = {
    ebay: { sell: { EU: "https://www.ebay.de/sl/sell", UK: "https://www.ebay.co.uk/sl/sell" }, manage: { EU: "https://www.ebay.de/sh/lst/active", UK: "https://www.ebay.co.uk/sh/lst/active" } },
    depop: { sell: { EU: "https://www.depop.com/sell/", UK: "https://www.depop.com/sell/" }, manage: { EU: "https://www.depop.com/", UK: "https://www.depop.com/" } },
    vinted: { sell: { EU: "https://www.vinted.com/items/new", UK: "https://www.vinted.co.uk/items/new" }, manage: { EU: "https://www.vinted.com/", UK: "https://www.vinted.co.uk/" } },
    facebook: { sell: { EU: "https://www.facebook.com/marketplace/create/item", UK: "https://www.facebook.com/marketplace/create/item" }, manage: { EU: "https://www.facebook.com/marketplace/you/selling", UK: "https://www.facebook.com/marketplace/you/selling" } },
    sellpy: { sell: { EU: "https://www.sellpy.com/", UK: "https://www.sellpy.com/" }, manage: { EU: "https://www.sellpy.com/", UK: "https://www.sellpy.com/" } },
  };
  function linkFor(id, kind) {
    const r = App.fees ? App.fees.region() : "EU";
    const l = LINKS[id] && LINKS[id][kind];
    if (l) return l[r] || l.EU;
    const c = CONNECTORS[id];
    return (c && c.baseUrl) || "#";
  }

  function list() { return App.store.MARKETS.map((id) => CONNECTORS[id]); }
  function byId(id) { return CONNECTORS[id]; }

  // eBay identifiers that must survive retries/updates so OmniList never
  // creates a second eBay listing for the same item.
  const EBAY_IDS = ["sku", "offerId", "listingId", "images"];
  function ebayIds(listing) {
    const out = {};
    if (listing) EBAY_IDS.forEach((k) => { if (listing[k] != null) out[k] = listing[k]; });
    return out;
  }

  async function ebayLiveAvailable() {
    try {
      const st = await App.backend.status();
      return !!(st && st.ok && st.ebay && st.ebay.configured && st.ebay.userAuthorized);
    } catch (e) { return false; }
  }

  async function realEbayPublish(product, onProgress) {
    if (onProgress) onProgress("Publishing to eBay via API...");
    const prev = ebayIds(product.listings && product.listings.ebay);
    const data = await App.backend.ebayPublish({
      title: product.title,
      description: product.description || product.title,
      price: product.price,
      currency: product.currency || App.fees.currency(),
      quantity: 1,
      condition: product.condition || "Good",
      brand: product.brand || "",
      images: prev.images && prev.images.length ? prev.images : (product.photos || []),
      categoryId: product.ebayCategoryId || "",
      aspects: product.ebayAspects || {},
      sku: prev.sku || "",
      offerId: prev.offerId || "",
    });
    const ids = Object.assign({}, prev);
    if (data && data.sku) ids.sku = data.sku;
    if (data && data.offerId) ids.offerId = data.offerId;
    if (data && Array.isArray(data.imageUrls) && data.imageUrls.length) ids.images = data.imageUrls.filter((u) => App.ui.safeUrl(u));
    if (data && data.ok && data.listingId) {
      ids.listingId = data.listingId;
      return Object.assign(ids, {
        status: "live", url: App.ui.safeUrl(data.url),
        message: (data.updated ? "Updated on eBay" : "Published on eBay") + " (listing " + data.listingId + ")",
        listedAt: Date.now(), live: true,
      });
    }
    let msg;
    if (data && data.missing) msg = "eBay account setup needed - missing: " + data.missing.join(", ");
    else if (data && data.error === "not_authorized") msg = "Connect your eBay seller account first";
    else msg = (data && (data.message || data.error)) || "publish failed";
    if (data && data.step) msg += " [step: " + data.step + "]";
    return Object.assign(ids, { status: "error", message: "eBay: " + msg, listedAt: Date.now() });
  }

  // Prepare a ready-to-post draft for one-tap manual posting (no automation).
  function prepareHandoff(market, product, onProgress) {
    const c = CONNECTORS[market];
    const keep = market === "ebay" ? ebayIds(product.listings && product.listings.ebay) : {};
    return new Promise((resolve) => {
      if (onProgress) onProgress("Preparing " + c.label + " listing...");
      setTimeout(() => resolve(Object.assign(keep, { status: "ready", message: "Prepared - tap 'Post on " + c.label + "' to finish", listedAt: Date.now(), handoff: true })), 300 + Math.random() * 300);
    });
  }

  // Returns a promise resolving to { status, url, message, listedAt, ... }.
  async function publish(market, product, connection, onProgress) {
    if (!connection || !connection.connected) {
      return { status: "error", message: "Account not connected", listedAt: Date.now() };
    }
    if (market === "ebay" && (await ebayLiveAvailable())) return realEbayPublish(product, onProgress);
    return prepareHandoff(market, product, onProgress);
  }

  window.App.connectors = { list, byId, publish, linkFor, ebayIds, ebayLiveAvailable, realEbayPublish, CONNECTORS };
})();
