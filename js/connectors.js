/* ===========================================================================
   connectors.js — marketplace connector registry
   Attaches to window.App.connectors

   This is the integration seam. Each connector currently SIMULATES publishing
   so the whole flow is demonstrable offline. To go live, replace `publish()`
   with a real API/automation call (see notes per connector + README).
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { slugify } = App.ui;

  const CONNECTORS = {
    ebay: {
      id: "ebay", label: "eBay", color: "#0064d2", short: "eB",
      hasOfficialApi: true,
      audience: "Largest general marketplace, global buyers",
      feeNote: "~13.25% final value fee + $0.35/order (category dependent)",
      priceFactor: 1.0,
      apiNote: "Official 'Sell' API (Inventory + Offer). Real cross-listing is possible here once you register an eBay developer app and complete OAuth. Replace publish() with calls to /sell/inventory/v1.",
      baseUrl: "https://www.ebay.com/itm/",
    },
    depop: {
      id: "depop", label: "Depop", color: "#ff2300", short: "De",
      hasOfficialApi: false, handoff: true,
      sellUrl: "https://www.depop.com/sell/",
      sellNote: "Depop listings are usually created in the Depop phone app — open it on your phone, or use the web sell page below.",
      audience: "Gen-Z fashion / streetwear / vintage, premium pricing",
      feeNote: "10% selling fee + payment processing",
      priceFactor: 1.12,
      apiNote: "No public API (Etsy-owned) - and OmniList does NOT automate Depop (that would break their rules). Instead it prepares a ready-to-post listing and opens Depop's sell page for you to post yourself.",
      baseUrl: "https://www.depop.com/products/",
    },
    vinted: {
      id: "vinted", label: "Vinted", color: "#09a7b0", short: "Vi",
      hasOfficialApi: false, handoff: true,
      sellUrl: "https://www.vinted.com/items/new",
      audience: "EU-heavy, no seller fees, value buyers",
      feeNote: "No seller fees (buyer pays Buyer Protection)",
      priceFactor: 0.9,
      apiNote: "No public API - and OmniList does NOT automate Vinted (that would break their rules). Instead it prepares a ready-to-post listing and opens Vinted's sell page so you post it yourself in one tap.",
      baseUrl: "https://www.vinted.com/items/",
    },
    facebook: {
      id: "facebook", label: "Facebook", color: "#1877f2", short: "FB",
      hasOfficialApi: false, handoff: true,
      sellUrl: "https://www.facebook.com/marketplace/create/item",
      sellNote: "Facebook Marketplace listings are created on Facebook (sign-in required). Local pickup has no selling fees.",
      audience: "Huge local + shipped audience, fee-free for local pickup",
      feeNote: "No fee for local pickup; ~10% for shipped orders",
      priceFactor: 1.0,
      apiNote: "No public listing API, and OmniList does NOT automate Facebook (against their rules). It prepares a ready-to-post listing and opens Marketplace's 'create item' page for you to post yourself.",
      baseUrl: "https://www.facebook.com/marketplace/item/",
    },
    sellpy: {
      id: "sellpy", label: "Sellpy", color: "#0e9f6e", short: "Sp",
      hasOfficialApi: false, handoff: true,
      sellUrl: "https://www.sellpy.com/",
      sellNote: "Sellpy is consignment: you order a free Sellpy bag, fill it, and they photograph, list & sell your items for you. This opens Sellpy to get started; the details below are for your reference.",
      audience: "Consignment - they photograph, list & sell for you (EU)",
      feeNote: "Sellpy takes a commission per item sold",
      priceFactor: 0.8,
      apiNote: "No public listing API. Sellpy is a managed consignment service, so there is nothing to automate - OmniList opens Sellpy and shows your item details so you can send it in.",
      baseUrl: "https://www.sellpy.com/",
    },
  };

  function list() { return App.store.MARKETS.map((id) => CONNECTORS[id]); }
  function byId(id) { return CONNECTORS[id]; }

  /* ---------- Publish ----------
     Returns a promise resolving to { status, url, message, listedAt }.
     eBay publishes for REAL via the backend when the seller account is connected
     (serve.ps1 + ebay.config.json + OAuth). Everything else is simulated. */
  function simulatedPublish(market, product, connection, onProgress) {
    const c = CONNECTORS[market];
    return new Promise((resolve) => {
      if (onProgress) onProgress("Authenticating " + c.label + "...");
      const t1 = 500 + Math.random() * 700;
      setTimeout(() => {
        if (onProgress) onProgress(c.hasOfficialApi ? "Uploading via API..." : "Running automation...");
        const t2 = 800 + Math.random() * 1400;
        setTimeout(() => {
          const fail = !c.hasOfficialApi && Math.random() < 0.12;
          if (fail) {
            resolve({ status: "error", message: "Automation step timed out - retry available", listedAt: Date.now() });
          } else {
            const slug = (connection.handle ? connection.handle.replace(/[@\s]/g, "") + "-" : "") + slugify(product.title);
            resolve({ status: "live", url: c.baseUrl + slug, message: c.hasOfficialApi ? "Published (demo)" : "Posted via automation (demo)", listedAt: Date.now() });
          }
        }, t2);
      }, t1);
    });
  }

  async function realEbayPublish(product, onProgress) {
    if (onProgress) onProgress("Publishing to eBay via API...");
    const data = await App.backend.ebayPublish({
      title: product.title,
      description: product.description || product.title,
      price: product.price,
      currency: product.currency || "USD",
      quantity: 1,
      condition: product.condition || "Good",
      brand: product.brand || "",
      images: product.photos || [],
      categoryId: product.ebayCategoryId || "",
      aspects: product.ebayAspects || {},
    });
    if (data && data.ok) {
      return { status: "live", url: data.url, message: "Published LIVE via eBay API (listing " + data.listingId + ")", listedAt: Date.now(), live: true };
    }
    let msg;
    if (data && data.missing) msg = "eBay account setup needed - missing: " + data.missing.join(", ");
    else if (data && data.error === "not_authorized") msg = "Connect your eBay seller account first";
    else msg = (data && (data.message || data.error)) || "publish failed";
    if (data && data.step) msg += " [step: " + data.step + "]";
    return { status: "error", message: "eBay: " + msg, listedAt: Date.now() };
  }

  // Handoff marketplaces (Vinted, Depop): no automation. Prepare a ready-to-post
  // draft for one-tap manual posting.
  function prepareHandoff(market, product, onProgress) {
    const c = CONNECTORS[market];
    return new Promise((resolve) => {
      if (onProgress) onProgress("Preparing " + c.label + " listing...");
      setTimeout(() => resolve({ status: "ready", message: "Prepared - tap 'Post on " + c.label + "' to finish", listedAt: Date.now(), handoff: true }), 450 + Math.random() * 500);
    });
  }

  async function publish(market, product, connection, onProgress) {
    if (!connection || !connection.connected) {
      return { status: "error", message: "Account not connected", listedAt: Date.now() };
    }
    if (market === "ebay") {
      try {
        const st = await App.backend.status();
        if (st && st.ebay && st.ebay.configured && st.ebay.userAuthorized) {
          return await realEbayPublish(product, onProgress);
        }
      } catch (e) { /* fall back to simulated */ }
    }
    if (CONNECTORS[market] && CONNECTORS[market].handoff) {
      return prepareHandoff(market, product, onProgress);
    }
    return simulatedPublish(market, product, connection, onProgress);
  }

  window.App.connectors = { list, byId, publish, CONNECTORS };
})();
