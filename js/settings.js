/* ===========================================================================
   settings.js — Settings screen: region & fee table, stale threshold,
   install-as-app, and your data (JSON backup/restore, CSV exports, demo,
   clear). Attaches App.views.settings
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { el, toast, confirmDialog, moneyAuto } = App.ui;
  const store = App.store;
  const fees = App.fees;
  const connectors = App.connectors;

  const localDate = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const stamp = () => localDate(new Date());
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name, style: { display: "none" } });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function csv(rows) {
    return rows.map((r) => r.map((v) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\r\n");
  }
  const day = (ts) => (ts ? localDate(new Date(ts)) : "");
  const accountNames = () => Object.fromEntries(store.accounts().map((a) => [a.id, a.name]));
  const label = (m) => (m === "other" ? "In person / elsewhere" : (connectors.byId(m) || { label: m }).label);

  function exportBackup() {
    download("omnilist-backup-" + stamp() + ".json", JSON.stringify(store.exportState(), null, 2), "application/json");
    toast("Backup downloaded", "Keep it somewhere safe — it restores everything, photos included.", "ok");
  }
  function exportInventory() {
    const acc = accountNames();
    const head = ["Account", "Title", "Brand", "Category", "Condition", "Size", "Color", "Price", "Currency", "Cost", "Status", "Created"].concat(store.MARKETS.map(label));
    const rows = store.allProducts().map((p) => [acc[p.accountId] || "", p.title, p.brand, p.category, p.condition, p.size, p.color, p.price, p.currency, p.cost, p.sale ? "Sold" : "Unsold", day(p.createdAt)]
      .concat(store.MARKETS.map((m) => (p.listings[m] && p.listings[m].status) || "")));
    download("omnilist-inventory-" + stamp() + ".csv", "﻿" + csv([head].concat(rows)), "text/csv;charset=utf-8");
  }
  function exportSales() {
    const acc = accountNames();
    const sold = store.allProducts().filter((p) => p.sale).sort((a, b) => b.sale.at - a.sale.at);
    if (!sold.length) { toast("No sales yet", "Mark an item sold to see it here.", "warn"); return; }
    const head = ["Account", "Title", "Sold on", "Date", "Sold price", "Currency", "Fees", "Shipping", "You kept", "Cost", "Profit"];
    const rows = sold.map((p) => [acc[p.accountId] || "", p.title, label(p.sale.market), day(p.sale.at), p.sale.price, p.currency, p.sale.fee, p.sale.shipping, p.sale.net, p.sale.cost, p.sale.profit]);
    download("omnilist-sales-" + stamp() + ".csv", "﻿" + csv([head].concat(rows)), "text/csv;charset=utf-8");
  }
  function importBackup(file) {
    const r = new FileReader();
    r.onload = async () => {
      let obj;
      try { obj = JSON.parse(r.result); } catch (e) { toast("Couldn't read that file", "It isn't valid JSON.", "err"); return; }
      const n = Array.isArray(obj && obj.products) ? obj.products.length : 0;
      if (!(await confirmDialog("Restore this backup?", "It replaces everything currently in OmniList on this device with the backup (" + n + " items).", "Restore", "danger"))) return;
      try { store.replaceState(obj); } catch (e) { toast("Couldn't restore", e.message, "err"); return; }
      App.app.renderChrome(); location.hash = "#/"; App.app.rerender();
      toast("Backup restored", n + " items loaded.", "ok");
    };
    r.readAsText(file);
  }

  function section(title, sub, children) {
    return el(".card", [el("div", { style: { fontWeight: "650" } }, title), sub ? el(".small.muted", { style: { margin: "2px 0 12px" } }, sub) : null].concat(children));
  }

  function settings() {
    const root = el(".view");
    const s = store.settings();
    const r = s.region;
    root.appendChild(el(".page-head", [el("div", [el("h2", "Settings"), el("p", "Region & fees, reminders, installing the app, and your data.")])]));

    // Region
    const regionSel = el("select", [el("option", { value: "EU" }, "EU (€)"), el("option", { value: "UK" }, "UK (£)")]);
    regionSel.value = r;
    regionSel.addEventListener("change", () => {
      store.updateSettings({ region: regionSel.value });
      toast("Region: " + regionSel.value, "New listings and estimates now use " + fees.currency() + " and " + regionSel.value + " fees.", "ok");
      App.app.rerender();
    });

    // Fee table
    const tbody = el("tbody", store.MARKETS.map((m) => {
      const c = connectors.byId(m);
      const f = fees.feeFor(m, r);
      const pct = el("input", { type: "number", step: "0.1", min: "0", max: "100", value: f.pct });
      const fixed = el("input", { type: "number", step: "0.01", min: "0", value: f.fixed });
      const flag = el("span.badge", { style: { display: f.overridden ? "" : "none", marginLeft: "6px" } }, "edited");
      const save = () => {
        store.setFeeOverride(r, m, { pct: Math.max(0, Math.min(100, Number(pct.value) || 0)), fixed: Math.max(0, Number(fixed.value) || 0) });
        flag.style.display = "";
      };
      pct.addEventListener("change", save);
      fixed.addEventListener("change", save);
      return el("tr", [
        el("td", [el(".row", { style: { gap: "8px" } }, [el("span.mkt-dot", { style: { background: c.color } }), el("strong", c.label), flag])]),
        el("td", el(".row", { style: { gap: "6px" } }, [pct, el("span.muted", "%")])),
        el("td", el(".row", { style: { gap: "6px" } }, [el("span.muted", "+"), fixed])),
        el("td.small.muted", { style: { minWidth: "260px" } }, [f.note + " ", f.src ? el("a", { href: f.src, target: "_blank", rel: "noopener" }, "Source ↗") : null]),
      ]);
    }));
    const feeTable = el(".table-wrap", el("table.tbl.fee-table", [
      el("thead", el("tr", [el("th", "Marketplace"), el("th", "% of sale"), el("th", "Fixed per sale"), el("th", "Notes")])),
      tbody,
    ]));

    // Stale reminder
    const staleIn = el("input", { type: "number", min: "7", max: "365", step: "1", value: s.staleDays, style: { maxWidth: "120px" } });
    staleIn.addEventListener("change", () => {
      const d = Math.max(7, Math.min(365, Math.round(Number(staleIn.value) || 30)));
      staleIn.value = d; store.updateSettings({ staleDays: d });
      toast("Saved", "Items unsold for " + d + "+ days will be flagged.", "ok");
    });

    // Install
    const pwa = App.pwa || {};
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    let installBody;
    if (pwa.installed) installBody = el("span.badge.ok", "✓ Running as an installed app");
    else if (pwa.canInstall && pwa.canInstall()) installBody = el("button.btn.primary", { onClick: async () => { await pwa.install(); App.app.rerender(); } }, "⬇ Install OmniList");
    else if (isIOS) installBody = el(".small", "On iPhone/iPad: open this page in Safari, tap the Share button, then “Add to Home Screen”.");
    else installBody = el(".small", "In Chrome or Edge, use the install icon in the address bar (or the browser menu → “Install app”). On Android: menu → “Add to Home screen”.");

    // Data
    const fileIn = el("input", { type: "file", accept: "application/json,.json", style: { display: "none" }, onchange: (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; } });
    const counts = store.allProducts().length + " items · " + store.accounts().length + " account" + (store.accounts().length === 1 ? "" : "s");

    root.appendChild(el(".stack", [
      section("Region", "Sets the default currency and which fee table is used. Existing items keep their own currency.", [el("label.field", { style: { maxWidth: "220px" } }, [el("span.lab", "Where you sell"), regionSel])]),
      section("Marketplace fees (" + r + ")", "Used for “what you'd keep”, profit and the Buy/Pass call. Defaults assume a private (non-business) seller and come from third-party fee guides checked Oct 2026 — fees change, so check each marketplace's own fee page and edit here.", [
        feeTable,
        el(".row", { style: { marginTop: "12px" } }, [
          el("button.btn.sm", { onClick: () => { store.resetFees(r); App.app.rerender(); toast("Fees reset", r + " defaults restored.", "ok"); } }, "Reset " + r + " fees to defaults"),
          el("span.small.muted", "Example: a " + moneyAuto(50, fees.currency(r)) + " sale on Depop keeps " + moneyAuto(fees.calc("depop", 50, { region: r }).net, fees.currency(r)) + "."),
        ]),
      ]),
      section("Stale listing reminder", "Items that are still listed but unsold after this many days get a price-drop / relist nudge on the dashboard.", [el("label.field", [el("span.lab", "Days"), staleIn])]),
      section("Install as an app", "Add OmniList to your home screen: it opens full-screen like a native app and keeps working offline after your first visit.", [installBody]),
      section("Your data", "Everything lives in this browser only (" + counts + "). Back it up — clearing site data or switching phones would lose it.", [
        el(".row.wrap", { style: { gap: "8px" } }, [
          el("button.btn.primary", { onClick: exportBackup }, "⬇ Download backup (.json)"),
          el("button.btn", { onClick: () => fileIn.click() }, "⬆ Restore from backup"),
          fileIn,
          el("button.btn", { onClick: exportInventory }, "Inventory (.csv)"),
          el("button.btn", { onClick: exportSales }, "Sales & profit (.csv)"),
        ]),
        el(".row.wrap", { style: { gap: "8px", marginTop: "14px", paddingTop: "14px", borderTop: "1px solid var(--border-soft)" } }, [
          el("button.btn.ghost", { onClick: async () => {
            if (await confirmDialog("Load demo data?", "Replaces everything on this device with sample accounts and listings. Download a backup first if you want to keep your data.", "Load demo", "danger")) {
              store.loadDemo(); App.app.renderChrome(); location.hash = "#/"; App.app.rerender(); toast("Demo data loaded", "", "ok");
            }
          } }, "Load demo data"),
          el("button.btn.danger", { onClick: async () => {
            if (await confirmDialog("Clear all data?", "Deletes every account, listing, sale and appraisal on this device. This can't be undone without a backup.", "Clear everything", "danger")) {
              store.clearAll(); App.app.renderChrome(); location.hash = "#/"; App.app.rerender(); toast("All data cleared", "You're starting fresh.", "ok");
            }
          } }, "Clear all data"),
        ]),
      ]),
    ]));
    return root;
  }

  App.views.settings = settings;
})();
