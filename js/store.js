/* ===========================================================================
   store.js — localStorage-backed app state + pub/sub
   Attaches to window.App.store

   State shape (version 2):
   {
     version, activeAccountId,
     accounts: [{ id, name, connections: { ebay:{connected,handle,since}, ... } }],
     products: [{ id, accountId, title, brand, category, condition, size, color,
                  description, price, currency, cost, photos:[dataURL],
                  createdAt, refreshedAt, priceHistory:[{price,at}],
                  listings: { ebay:{status,url,message,listedAt}, ... },
                  sale: { market, price, shipping, fee, net, cost, profit, at, prev } }],
     appraisals: [{ id, accountId, query, brand, category, condition, shopPrice,
                    image, createdAt, result }],
     settings: { region:"EU"|"UK", staleDays, feeOverrides:{ EU:{}, UK:{} } }
   }
   Listing statuses: draft, pending, ready, live, error, skipped,
                     sold, needs_delist, delisted
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const KEY = "omnilist.state.v1";
  const MARKETS = ["ebay", "depop", "vinted", "facebook", "sellpy"];
  const DAY = 86400000;

  let state = null;
  const listeners = new Set();

  function defaultSettings() { return { region: "EU", staleDays: 30, feeOverrides: { EU: {}, UK: {} } }; }
  function blankConnections() { const c = {}; MARKETS.forEach((m) => { c[m] = { connected: false }; }); return c; }

  /* ---------- Fresh start for new visitors ---------- */
  function emptyState() {
    return {
      version: 2, activeAccountId: "acc_1",
      accounts: [{ id: "acc_1", name: "My Shop", connections: blankConnections() }],
      products: [], appraisals: [], settings: defaultSettings(),
    };
  }

  /* ---------- Demo data (Settings → Load demo data) ---------- */
  function demoState() {
    const now = Date.now();
    const conn = (handle, days) => ({ connected: true, handle, since: now - days * DAY });
    const accounts = [
      {
        id: "acc_main",
        name: "Alex's Closet",
        connections: { ebay: conn("alex_resells", 220), depop: conn("@alexcloset", 140), vinted: conn("alexcloset", 90), facebook: conn("alex.resells", 30), sellpy: conn("alexcloset", 20) },
      },
      {
        id: "acc_vintage",
        name: "Retro Finds Co.",
        connections: { ebay: conn("retrofinds_co", 60), depop: conn("@retrofinds", 40), vinted: { connected: false }, facebook: conn("retrofinds", 15), sellpy: { connected: false } },
      },
    ];
    const mk = (id, accountId, o) => Object.assign({
      id, accountId, currency: "EUR", photos: [], brand: "", category: "Clothing",
      condition: "Good", size: "", color: "", description: "", cost: null, createdAt: now,
      listings: {},
    }, o);
    const live = (url, days) => ({ status: "live", url, message: "Listed", listedAt: now - days * DAY });
    const ready = (label, days) => ({ status: "ready", message: "Prepared - tap 'Post on " + label + "' to finish", listedAt: now - days * DAY });
    const products = [
      mk("p1", "acc_main", {
        title: "Nike Air Max 90 — White/Grey", brand: "Nike", category: "Shoes", condition: "Like new",
        size: "US 10", color: "White", price: 95, cost: 30, createdAt: now - 2 * DAY,
        description: "Worn twice, box included. No flaws.",
        listings: {
          ebay: live("https://www.ebay.com/itm/nike-air-max-90-white-grey", 2),
          depop: live("https://www.depop.com/products/alexcloset-nike-air-max-90", 2),
          vinted: ready("Vinted", 1), facebook: ready("Facebook", 1), sellpy: ready("Sellpy", 1),
        },
      }),
      mk("p2", "acc_main", {
        title: "Levi's 501 Vintage Denim Jacket", brand: "Levi's", category: "Clothing", condition: "Good",
        size: "M", color: "Blue", price: 64, cost: 12, createdAt: now - 5 * DAY,
        description: "Classic trucker jacket, broken-in fade.",
        listings: {
          ebay: live("https://www.ebay.com/itm/levis-501-denim-jacket", 5),
          depop: live("https://www.depop.com/products/alexcloset-levis-jacket", 5),
          vinted: live("https://www.vinted.com/items/levis-501-jacket", 4),
        },
      }),
      mk("p3", "acc_main", {
        title: "Sony WH-1000XM4 Headphones", brand: "Sony", category: "Electronics", condition: "Good",
        color: "Black", price: 148, cost: 60, createdAt: now - 9 * DAY,
        description: "Great noise cancelling. Minor wear on headband.",
        listings: {
          ebay: live("https://www.ebay.com/itm/sony-wh-1000xm4", 9),
          depop: ready("Depop", 9),
          vinted: { status: "skipped", message: "Not targeted" },
        },
      }),
      mk("p5", "acc_main", {
        title: "Dr. Martens 1460 Boots", brand: "Dr. Martens", category: "Shoes", condition: "Good",
        size: "UK 8", color: "Black", price: 80, cost: 25, createdAt: now - 46 * DAY,
        description: "Classic 8-eye boots, well looked after.",
        listings: {
          ebay: live("https://www.ebay.com/itm/dr-martens-1460", 46),
          vinted: live("https://www.vinted.com/items/dr-martens-1460", 45),
          facebook: ready("Facebook", 45),
        },
      }),
      mk("p6", "acc_main", {
        title: "Patagonia Better Sweater Fleece", brand: "Patagonia", category: "Clothing", condition: "Like new",
        size: "L", color: "Grey", price: 58, cost: 15, createdAt: now - 12 * DAY,
        description: "Barely worn, no pilling.",
        listings: {
          ebay: { status: "needs_delist", url: "https://www.ebay.com/itm/patagonia-better-sweater", message: "Sold elsewhere - take this down", listedAt: now - 12 * DAY },
          depop: { status: "needs_delist", url: "https://www.depop.com/products/alexcloset-patagonia", message: "Sold elsewhere - take this down", listedAt: now - 12 * DAY },
          vinted: { status: "sold", message: "Sold", url: "https://www.vinted.com/items/patagonia-fleece", listedAt: now - 11 * DAY, soldAt: now - 3 * DAY },
        },
        sale: {
          market: "vinted", price: 58, shipping: 0, fee: 0, net: 58, cost: 15, profit: 43, at: now - 3 * DAY,
          prev: {
            ebay: live("https://www.ebay.com/itm/patagonia-better-sweater", 12),
            depop: live("https://www.depop.com/products/alexcloset-patagonia", 12),
            vinted: live("https://www.vinted.com/items/patagonia-fleece", 11),
          },
        },
      }),
      mk("p7", "acc_main", {
        title: "Ralph Lauren Polo Shirt", brand: "Ralph Lauren", category: "Clothing", condition: "Good",
        size: "M", color: "Navy", price: 35, cost: 6, createdAt: now - 20 * DAY,
        listings: {
          ebay: { status: "sold", message: "Sold", url: "https://www.ebay.com/itm/ralph-lauren-polo", listedAt: now - 20 * DAY, soldAt: now - 8 * DAY },
          depop: { status: "delisted", message: "Taken down", listedAt: now - 20 * DAY },
          vinted: { status: "delisted", message: "Taken down", listedAt: now - 19 * DAY },
        },
        sale: {
          market: "ebay", price: 35, shipping: 3.5, fee: 0, net: 31.5, cost: 6, profit: 25.5, at: now - 8 * DAY,
          prev: {
            ebay: live("https://www.ebay.com/itm/ralph-lauren-polo", 20),
            depop: live("https://www.depop.com/products/alexcloset-polo", 20),
            vinted: live("https://www.vinted.com/items/ralph-lauren-polo", 19),
          },
        },
      }),
      mk("p4", "acc_vintage", {
        title: "Vintage Carhartt Detroit Jacket", brand: "Carhartt", category: "Clothing", condition: "Good",
        size: "L", color: "Brown", price: 120, cost: 35, createdAt: now - 1 * DAY,
        description: "90s blanket-lined Detroit jacket. Heavy patina.",
        listings: {
          ebay: live("https://www.ebay.com/itm/carhartt-detroit-jacket", 1),
          depop: live("https://www.depop.com/products/retrofinds-carhartt", 1),
        },
      }),
    ];
    return { version: 2, activeAccountId: "acc_main", accounts, products, appraisals: [], settings: defaultSettings() };
  }

  /* ---------- Persistence ---------- */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { state = JSON.parse(raw); normalize(); return; }
    } catch (e) { console.warn("Failed to load state", e); }
    state = emptyState();
    save(true);
  }
  function normalize() {
    if (!state || !Array.isArray(state.accounts) || !state.accounts.length) { state = emptyState(); return; }
    state.products = Array.isArray(state.products) ? state.products : [];
    state.appraisals = Array.isArray(state.appraisals) ? state.appraisals : [];
    state.settings = Object.assign(defaultSettings(), state.settings || {});
    state.settings.feeOverrides = Object.assign({ EU: {}, UK: {} }, state.settings.feeOverrides || {});
    state.accounts.forEach((a) => {
      a.connections = a.connections || {};
      MARKETS.forEach((m) => { a.connections[m] = a.connections[m] || { connected: false }; });
    });
    state.products.forEach((p) => { p.listings = p.listings || {}; });
    if (!state.accounts.find((a) => a.id === state.activeAccountId)) state.activeAccountId = state.accounts[0].id;
    state.version = 2;
  }
  function save(silent) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) {
      console.warn("Save failed", e);
      if (window.App.ui) App.ui.toast("Storage full", "Couldn't save — try fewer/smaller photos, or export a backup and clear old items.", "warn");
    }
    if (!silent) emit();
  }
  function emit() { listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ---------- Settings ---------- */
  function settings() { return state.settings; }
  function updateSettings(patch) { Object.assign(state.settings, patch); save(); }
  function setFeeOverride(region, market, ov) {
    state.settings.feeOverrides[region] = state.settings.feeOverrides[region] || {};
    state.settings.feeOverrides[region][market] = ov; save();
  }
  function resetFees(region) { state.settings.feeOverrides[region] = {}; save(); }

  /* ---------- Accounts ---------- */
  function accounts() { return state.accounts; }
  function activeAccount() { return state.accounts.find((a) => a.id === state.activeAccountId) || state.accounts[0]; }
  function setActiveAccount(id) { state.activeAccountId = id; save(); }
  function addAccount(name) {
    const a = { id: App.ui.uid("acc"), name: name || "New account", connections: blankConnections() };
    state.accounts.push(a); state.activeAccountId = a.id; save(); return a;
  }
  function renameAccount(id, name) { const a = state.accounts.find((x) => x.id === id); if (a) { a.name = name; save(); } }
  function removeAccount(id) {
    if (state.accounts.length <= 1) { App.ui.toast("Can't delete", "You need at least one account.", "warn"); return; }
    state.accounts = state.accounts.filter((a) => a.id !== id);
    state.products = state.products.filter((p) => p.accountId !== id);
    state.appraisals = state.appraisals.filter((p) => p.accountId !== id);
    if (state.activeAccountId === id) state.activeAccountId = state.accounts[0].id;
    save();
  }
  function setConnection(accountId, market, conn) {
    const a = state.accounts.find((x) => x.id === accountId); if (!a) return;
    a.connections[market] = conn; save();
  }

  /* ---------- Products ---------- */
  function allProducts() { return state.products; }
  function products(accountId) {
    accountId = accountId || state.activeAccountId;
    return state.products.filter((p) => p.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt);
  }
  function getProduct(id) { return state.products.find((p) => p.id === id); }
  function addProduct(p) {
    p.id = p.id || App.ui.uid("p");
    p.accountId = p.accountId || state.activeAccountId;
    p.createdAt = p.createdAt || Date.now();
    p.listings = p.listings || {};
    state.products.push(p); save(); return p;
  }
  function updateProduct(id, patch) { const p = getProduct(id); if (p) { Object.assign(p, patch); save(); } return p; }
  function setListing(productId, market, result) {
    const p = getProduct(productId); if (!p) return;
    p.listings = p.listings || {}; p.listings[market] = result; save();
  }
  function removeProduct(id) { state.products = state.products.filter((p) => p.id !== id); save(); }

  /* ---------- Sales & take-downs ---------- */
  // Records a sale on `market` ("other" = in person / elsewhere). Every other
  // listing that is up (live/pending, or a prepared "ready" one the seller says
  // they posted) becomes "needs_delist". Returns how many need taking down.
  function markSold(id, opts) {
    const p = getProduct(id); if (!p) return 0;
    const market = opts.market;
    const posted = opts.postedReady || [];
    const price = Number(opts.price) || 0;
    const shipping = Number(opts.shipping) || 0;
    const cost = p.cost == null || p.cost === "" ? null : Number(p.cost);
    const c = App.fees.calc(market, price, { shipping, cost });
    const prev = JSON.parse(JSON.stringify(p.listings || {}));
    const at = Date.now();
    let toTakeDown = 0;
    MARKETS.forEach((m) => {
      const l = p.listings[m];
      if (m === market) { p.listings[m] = Object.assign({}, l || {}, { status: "sold", message: "Sold", soldAt: at }); return; }
      if (!l) return;
      if (l.status === "live" || l.status === "pending" || (l.status === "ready" && posted.indexOf(m) !== -1)) {
        p.listings[m] = Object.assign({}, l, { status: "needs_delist", message: "Sold elsewhere - take this down" });
        toTakeDown++;
      } else if (l.status === "ready" || l.status === "draft" || l.status === "error") {
        p.listings[m] = Object.assign({}, l, { status: "skipped", message: "Sold before it was posted here" });
      }
    });
    p.sale = { market, price, shipping, fee: c.fee, net: c.net, cost, profit: c.profit, at, prev };
    save();
    return toTakeDown;
  }
  function undoSale(id) {
    const p = getProduct(id); if (!p || !p.sale) return;
    p.listings = p.sale.prev || p.listings;
    delete p.sale;
    save();
  }
  function markDelisted(id, market) {
    const p = getProduct(id); if (!p) return;
    const l = p.listings[market] || {};
    p.listings[market] = Object.assign({}, l, { status: "delisted", message: "Taken down", delistedAt: Date.now() });
    save();
  }

  /* ---------- Appraisals ---------- */
  function appraisals(accountId) {
    accountId = accountId || state.activeAccountId;
    return state.appraisals.filter((a) => a.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt);
  }
  function addAppraisal(a) {
    a.id = a.id || App.ui.uid("apr");
    a.accountId = a.accountId || state.activeAccountId;
    a.createdAt = a.createdAt || Date.now();
    state.appraisals.unshift(a); save(); return a;
  }

  /* ---------- Draft (prefill New Listing from an appraisal) ---------- */
  let draft = null;
  function setDraft(d) { draft = d; }
  function takeDraft() { const d = draft; draft = null; return d; }

  /* ---------- Whole-state operations (Settings) ---------- */
  function loadDemo() { const region = state && state.settings ? state.settings.region : "EU"; state = demoState(); state.settings.region = region; save(); }
  function clearAll() { const region = state && state.settings ? state.settings.region : "EU"; state = emptyState(); state.settings.region = region; save(); }
  function exportState() { return JSON.parse(JSON.stringify(state)); }
  function replaceState(obj) {
    if (!obj || !Array.isArray(obj.accounts) || !obj.accounts.length || !Array.isArray(obj.products)) throw new Error("That file isn't an OmniList backup.");
    state = obj; normalize(); save();
  }
  function getState() { return state; }

  load();

  window.App.store = {
    MARKETS, getState, subscribe, save,
    settings, updateSettings, setFeeOverride, resetFees,
    accounts, activeAccount, setActiveAccount, addAccount, renameAccount, removeAccount, setConnection,
    allProducts, products, getProduct, addProduct, updateProduct, setListing, removeProduct,
    markSold, undoSale, markDelisted,
    appraisals, addAppraisal,
    setDraft, takeDraft,
    loadDemo, resetDemo: loadDemo, clearAll, exportState, replaceState,
  };
})();
