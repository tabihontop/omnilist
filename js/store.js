/* ===========================================================================
   store.js — localStorage-backed app state + pub/sub
   Attaches to window.App.store

   State shape:
   {
     version, activeAccountId,
     accounts: [{ id, name, connections: { ebay:{connected,handle,since}, ... } }],
     products: [{ id, accountId, title, brand, category, condition, size, color,
                  description, price, currency, photos:[dataURL],
                  createdAt, listings: { ebay:{status,url,message,listedAt}, ... } }],
     appraisals: [{ id, accountId, query, brand, category, condition, image,
                    createdAt, result }]
   }
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const KEY = "omnilist.state.v1";
  const MARKETS = ["ebay", "depop", "vinted", "facebook", "sellpy"];

  let state = null;
  const listeners = new Set();

  /* ---------- Demo seed ---------- */
  function seed() {
    const now = Date.now();
    const day = 86400000;
    const conn = (handle, days) => ({ connected: true, handle, since: now - days * day });
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
      id, accountId, currency: "USD", photos: [], brand: "", category: "Clothing",
      condition: "Good", size: "", color: "", description: "", createdAt: now,
      listings: {},
    }, o);
    const live = (url, days) => ({ status: "live", url, message: "Listed", listedAt: now - days * day });
    const products = [
      mk("p1", "acc_main", {
        title: "Nike Air Max 90 — White/Grey", brand: "Nike", category: "Shoes", condition: "Like new",
        size: "US 10", color: "White", price: 95, createdAt: now - 2 * day,
        description: "Worn twice, box included. No flaws.",
        listings: {
          ebay: live("https://www.ebay.com/itm/nike-air-max-90-white-grey", 2),
          depop: live("https://www.depop.com/products/alexcloset-nike-air-max-90", 2),
          vinted: { status: "ready", message: "Prepared - tap 'Post on Vinted' to finish", listedAt: now - 1 * day },
          facebook: { status: "ready", message: "Prepared - tap 'Post on Facebook' to finish", listedAt: now - 1 * day },
          sellpy: { status: "ready", message: "Prepared - tap 'Post on Sellpy' to finish", listedAt: now - 1 * day },
        },
      }),
      mk("p2", "acc_main", {
        title: "Levi's 501 Vintage Denim Jacket", brand: "Levi's", category: "Clothing", condition: "Good",
        size: "M", color: "Blue", price: 64, createdAt: now - 5 * day,
        description: "Classic trucker jacket, broken-in fade.",
        listings: {
          ebay: live("https://www.ebay.com/itm/levis-501-denim-jacket", 5),
          depop: live("https://www.depop.com/products/alexcloset-levis-jacket", 5),
          vinted: live("https://www.vinted.com/items/levis-501-jacket", 4),
        },
      }),
      mk("p3", "acc_main", {
        title: "Sony WH-1000XM4 Headphones", brand: "Sony", category: "Electronics", condition: "Good",
        color: "Black", price: 148, createdAt: now - 9 * day,
        description: "Great noise cancelling. Minor wear on headband.",
        listings: {
          ebay: live("https://www.ebay.com/itm/sony-wh-1000xm4", 9),
          depop: { status: "ready", message: "Prepared - tap 'Post on Depop' to finish", listedAt: now - 9 * day },
          vinted: { status: "skipped", message: "Not targeted" },
        },
      }),
      mk("p4", "acc_vintage", {
        title: "Vintage Carhartt Detroit Jacket", brand: "Carhartt", category: "Clothing", condition: "Good",
        size: "L", color: "Brown", price: 120, createdAt: now - 1 * day,
        description: "90s blanket-lined Detroit jacket. Heavy patina.",
        listings: {
          ebay: live("https://www.ebay.com/itm/carhartt-detroit-jacket", 1),
          depop: live("https://www.depop.com/products/retrofinds-carhartt", 1),
        },
      }),
    ];
    return { version: 1, activeAccountId: "acc_main", accounts, products, appraisals: [] };
  }

  /* ---------- Persistence ---------- */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { state = JSON.parse(raw); normalize(); return; }
    } catch (e) { console.warn("Failed to load state", e); }
    state = seed();
    save(true);
  }
  function normalize() {
    if (!state.accounts || !state.accounts.length) state = seed();
    state.products = state.products || [];
    state.appraisals = state.appraisals || [];
    state.accounts.forEach((a) => {
      a.connections = a.connections || {};
      MARKETS.forEach((m) => { a.connections[m] = a.connections[m] || { connected: false }; });
    });
    if (!state.accounts.find((a) => a.id === state.activeAccountId)) state.activeAccountId = state.accounts[0].id;
  }
  function save(silent) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) {
      console.warn("Save failed", e);
      if (window.App.ui) App.ui.toast("Storage full", "Couldn't save — try fewer/smaller photos.", "warn");
    }
    if (!silent) emit();
  }
  function emit() { listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ---------- Accounts ---------- */
  function accounts() { return state.accounts; }
  function activeAccount() { return state.accounts.find((a) => a.id === state.activeAccountId) || state.accounts[0]; }
  function setActiveAccount(id) { state.activeAccountId = id; save(); }
  function addAccount(name) {
    const a = { id: App.ui.uid("acc"), name: name || "New account", connections: {} };
    MARKETS.forEach((m) => (a.connections[m] = { connected: false }));
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

  function resetDemo() { state = seed(); save(); }
  function getState() { return state; }

  load();

  window.App.store = {
    MARKETS, getState, subscribe, save,
    accounts, activeAccount, setActiveAccount, addAccount, renameAccount, removeAccount, setConnection,
    allProducts, products, getProduct, addProduct, updateProduct, setListing, removeProduct,
    appraisals, addAppraisal,
    setDraft, takeDraft, resetDemo,
  };
})();
