/* ===========================================================================
   app.js — shell (sidebar + topbar), hash router, account switcher, bootstrap
   Attaches to window.App.app
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { el, clear } = App.ui;
  const store = App.store;

  const ROUTES = [
    { key: "dashboard",    path: "#/",             label: "Dashboard",    icon: "🏠", render: () => App.views.dashboard() },
    { key: "new",          path: "#/new",          label: "New Listing",  icon: "➕", render: () => App.views.newListing() },
    { key: "appraise",     path: "#/appraise",     label: "Appraise",     icon: "🔎", render: () => App.views.appraise() },
    { key: "marketplaces", path: "#/marketplaces", label: "Marketplaces", icon: "🛒", render: () => App.views.marketplaces() },
    { key: "accounts",     path: "#/accounts",     label: "Accounts",     icon: "👤", render: () => App.views.accounts() },
  ];

  let viewEl, titleEl, acctWrap;
  const navItems = {};

  function currentRoute() {
    const h = location.hash || "#/";
    return ROUTES.find((r) => r.path === h) || ROUTES[0];
  }
  function navigate(path) { location.hash = path; }

  function rerender() {
    if (App.views.cleanup) { try { App.views.cleanup(); } catch (e) { /* noop */ } App.views.cleanup = null; }
    const r = currentRoute();
    clear(viewEl);
    viewEl.appendChild(r.render());
    titleEl.textContent = r.label;
    Object.keys(navItems).forEach((k) => navItems[k].classList.toggle("active", k === r.key));
    window.scrollTo(0, 0);
  }

  function switchAccount(id) {
    store.setActiveAccount(id);
    renderChrome();
    rerender();
    App.ui.toast("Switched account", store.activeAccount().name, "ok");
  }

  /* ---------- account switcher ---------- */
  function buildAcctSwitcher() {
    const a = store.activeAccount();
    const btn = el("button.acct-btn", [
      el(".avatar", { style: { background: App.ui.colorFor(a.name) } }, App.ui.initials(a.name)),
      el("span.acct-name", a.name),
      el("span.caret", "▾"),
    ]);
    const wrap = el(".acct-switcher", [btn]);
    let dd = null;
    function close() { if (dd) { dd.remove(); dd = null; document.removeEventListener("click", onDoc); } }
    function onDoc(e) { if (!wrap.contains(e.target)) close(); }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dd) { close(); return; }
      dd = buildDropdown(close);
      wrap.appendChild(dd);
      setTimeout(() => document.addEventListener("click", onDoc), 0);
    });
    return wrap;
  }
  function buildDropdown(close) {
    const dd = el(".dropdown");
    dd.appendChild(el(".dd-head", "Switch account"));
    store.accounts().forEach((a) => {
      const active = a.id === store.getState().activeAccountId;
      dd.appendChild(el(".dd-item" + (active ? ".active" : ""), { onClick: () => { close(); if (!active) switchAccount(a.id); } }, [
        el(".avatar", { style: { background: App.ui.colorFor(a.name) } }, App.ui.initials(a.name)),
        el(".grow", [el("div", { style: { fontWeight: "600" } }, a.name), el(".dd-meta", store.MARKETS.filter((m) => a.connections[m].connected).length + "/" + store.MARKETS.length + " connected")]),
        active ? el("span.small", { style: { color: "var(--success)" } }, "●") : null,
      ]));
    });
    dd.appendChild(el(".dd-sep"));
    dd.appendChild(el(".dd-item", { onClick: () => { close(); navigate("#/accounts"); } }, [el("span.ico", "👤"), "Manage accounts"]));
    dd.appendChild(el(".dd-item", { onClick: () => { close(); addQuick(); } }, [el("span.ico", "＋"), "Add account"]));
    dd.appendChild(el(".dd-sep"));
    dd.appendChild(el(".dd-item", { onClick: async () => {
      close();
      if (await App.ui.confirmDialog("Reset demo data?", "Restores the original sample accounts & listings and clears your changes.", "Reset", "danger")) {
        store.resetDemo(); renderChrome(); navigate("#/"); rerender(); App.ui.toast("Demo reset", "Sample data restored.", "ok");
      }
    } }, [el("span.ico", "↺"), "Reset demo data"]));
    return dd;
  }
  function addQuick() {
    App.ui.prompt2("Add account", [{ name: "name", label: "Account / profile name", placeholder: "e.g., Sneaker Vault" }], "Create").then((r) => {
      if (r && r.name) { store.addAccount(r.name); renderChrome(); navigate("#/marketplaces"); App.ui.toast("Account created", "Now connect its marketplaces.", "ok"); }
    });
  }
  function renderChrome() { clear(acctWrap); acctWrap.appendChild(buildAcctSwitcher()); }

  /* ---------- shell ---------- */
  function build() {
    const appRoot = document.getElementById("app");
    clear(appRoot);

    const nav = el(".stack", { style: { gap: "4px" } });
    ROUTES.forEach((r) => {
      const item = el(".nav-item", { onClick: () => navigate(r.path) }, [el("span.ico", r.icon), el("span", r.label)]);
      navItems[r.key] = item;
      nav.appendChild(item);
    });
    const sidebar = el(".sidebar", [
      el(".brand", [el(".brand-logo", "◆"), el("div", [el(".brand-name", "OmniList"), el(".brand-sub", "Cross-list & appraise")])]),
      nav,
      el(".nav-spacer"),
      el(".nav-foot", [el("div", "Prototype · demo connectors"), el("a", { href: "#/marketplaces" }, "How real APIs plug in →")]),
    ]);

    titleEl = el("h1", "Dashboard");
    acctWrap = el("div");
    const topbar = el(".topbar", [
      titleEl,
      el(".spacer"),
      el("button.btn.sm", { onClick: () => navigate("#/appraise") }, "🔎 Scan"),
      el("button.btn.primary.sm", { onClick: () => navigate("#/new") }, "＋ New"),
      acctWrap,
    ]);

    viewEl = el("div#view");
    appRoot.appendChild(el(".shell", [sidebar, el(".main", [topbar, viewEl])]));
    renderChrome();
  }

  function boot() {
    build();
    rerender();
    window.addEventListener("hashchange", rerender);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.App.app = { navigate, rerender, renderChrome, switchAccount };
})();
