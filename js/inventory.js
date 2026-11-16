/* ===========================================================================
   inventory.js — the Dashboard:
     • sales & profit stats
     • "Take these down" panel (sold on one marketplace → delist the rest)
     • "Unsold for N days" nudges (price drop / relist / snooze)
     • search, status filters, sorting
     • bulk actions (mark sold, change price, re-push, delete)
     • listing cards, details, mark-sold and undo
   Attaches App.views.dashboard and window.App.inventory
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { el, money, moneyAuto, fmtDate, timeAgo, toast, modal, confirmDialog, prompt2 } = App.ui;
  const store = App.store;
  const connectors = App.connectors;
  const fees = App.fees;
  const V = App.views._;
  const DAY = 86400000;

  // Inventory view state survives re-renders (search text, filter, selection).
  const inv = { q: "", filter: "all", sort: "new", selecting: false, selected: new Set() };
  const refs = {};

  const has = (p, s) => store.MARKETS.some((m) => p.listings[m] && p.listings[m].status === s);
  const hasAny = (p, list) => list.some((s) => has(p, s));
  const isSold = (p) => !!p.sale;
  const sum = (arr, f) => arr.reduce((n, x) => n + (Number(f(x)) || 0), 0);
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const curOf = (p) => p.currency || fees.currency();
  function ageDays(p) { return Math.floor((Date.now() - (p.refreshedAt || p.createdAt || Date.now())) / DAY); }
  function isStale(p) { return !isSold(p) && hasAny(p, ["live", "ready"]) && ageDays(p) >= (store.settings().staleDays || 30); }
  function labelFor(m) { return m === "other" ? "in person / elsewhere" : (connectors.byId(m) || { label: m }).label; }

  const FILTERS = [
    ["all", "All", () => true],
    ["active", "Active", (p) => !isSold(p) && hasAny(p, ["live", "ready", "pending"])],
    ["drafts", "Drafts", (p) => !isSold(p) && !hasAny(p, ["live", "ready", "pending"])],
    ["ready", "Ready to post", (p) => !isSold(p) && has(p, "ready")],
    ["delist", "Take down", (p) => has(p, "needs_delist")],
    ["stale", "Stale", (p) => isStale(p)],
    ["sold", "Sold", (p) => isSold(p)],
  ];
  const SORTS = [["new", "Newest"], ["old", "Oldest"], ["price_desc", "Price: high → low"], ["price_asc", "Price: low → high"], ["profit", "Profit"]];
  function sortList(list) {
    const profitOf = (p) => (p.sale && p.sale.profit != null ? p.sale.profit : -1e9);
    const by = {
      new: (a, b) => b.createdAt - a.createdAt,
      old: (a, b) => a.createdAt - b.createdAt,
      price_desc: (a, b) => b.price - a.price,
      price_asc: (a, b) => a.price - b.price,
      profit: (a, b) => profitOf(b) - profitOf(a),
    };
    return list.slice().sort(by[inv.sort] || by.new);
  }

  /* ---------- Links & take-downs ---------- */
  function openUrl(p, m) {
    const l = p.listings[m] || {};
    const sell = connectors.linkFor(m, "sell");
    const own = App.ui.safeUrl(l.url);
    const url = own && own !== sell && !/\/items\/new|\/sell\/?$|\/create\/item/.test(own) ? own : connectors.linkFor(m, "manage");
    App.ui.openSafe(url);
  }

  /* ---------- Price changes on listings that are already up ---------- */
  // OmniList can't change a price on Vinted/Depop/etc. (no API), so a price
  // change flags every live listing with an "Update price" reminder instead of
  // re-preparing it (which would lose its URL and its take-down tracking).
  function openPriceUpdate(p0, m) {
    const p = store.getProduct(p0.id) || p0;
    const c = connectors.byId(m);
    const l = p.listings[m] || {};
    const cur = curOf(p);
    const clear = () => { const now = store.getProduct(p.id); if (now && now.listings[m]) store.setListing(p.id, m, Object.assign({}, now.listings[m], { priceChanged: false })); };
    const ebayBtn = el("button.btn.primary.block", { style: { display: "none" } }, "Update on eBay now");
    let updating = false;
    ebayBtn.addEventListener("click", async () => {
      if (updating) return;
      updating = true; ebayBtn.disabled = true; ebayBtn.textContent = "Updating eBay…";
      const res = await connectors.realEbayPublish(store.getProduct(p.id) || p);
      const now = store.getProduct(p.id);
      if (res.status === "live") {
        store.setListing(p.id, m, Object.assign(res, { priceChanged: false }));
        m0.close(); App.app.refreshIf("dashboard");
        toast("eBay updated", "New price " + moneyAuto(p.price, cur) + " is live.", "ok");
      } else {
        // Keep the listing live (it still is) and keep the reminder; only remember the ids.
        if (now && now.listings[m]) store.setListing(p.id, m, Object.assign({}, now.listings[m], connectors.ebayIds(res)));
        updating = false; ebayBtn.disabled = false; ebayBtn.textContent = "Update on eBay now";
        toast("eBay not updated", res.message || "Update failed", "err");
      }
    });
    if (m === "ebay" && l.offerId) connectors.ebayLiveAvailable().then((ok) => { if (ok) ebayBtn.style.display = ""; });
    const m0 = modal({
      title: "Update price on " + c.label,
      body: el(".stack", [
        el("div", ["You changed “" + p.title + "” to ", el("strong", moneyAuto(p.price, cur)), ". It's still listed on " + c.label + " at the old price."]),
        ebayBtn,
        el("button.btn.block", { onClick: () => openUrl(p, m) }, "Open " + c.label + " ↗"),
        el(".small.muted", "Change the price on " + c.label + ", then tap “I've updated it”."),
      ]),
      actions: [
        { label: "Close" },
        { label: "I've updated it", kind: "primary", onClick: (close) => { clear(); close(); App.app.rerender(); toast("Price reminder cleared", c.label + " marked as up to date.", "ok"); } },
      ],
    });
  }
  function openDelist(p, m) {
    const c = connectors.byId(m);
    modal({
      title: "Take down from " + c.label,
      body: el(".stack", [
        el("div", "“" + p.title + "” sold " + (p.sale ? "on " + labelFor(p.sale.market) : "elsewhere") + ". Remove it from " + c.label + " so nobody else can buy it."),
        el("button.btn.primary.block", { onClick: () => openUrl(p, m) }, "Open " + c.label + " ↗"),
        el(".small.muted", "OmniList doesn't remove listings for you. End or delete it on " + c.label + ", then tap “Mark as taken down”."),
      ]),
      actions: [
        { label: "Close" },
        { label: "Mark as taken down", kind: "primary", onClick: (close) => { store.markDelisted(p.id, m); close(); toast("Taken down", c.label + " listing cleared.", "ok"); App.app.rerender(); } },
      ],
    });
  }

  /* ---------- Mark sold ---------- */
  function markSoldFlow(p) {
    const cur = curOf(p);
    const options = store.MARKETS.filter((m) => p.listings[m] && ["skipped", "delisted"].indexOf(p.listings[m].status) === -1);
    const def = options.find((m) => p.listings[m].status === "live") || options[0] || "other";
    const marketSel = el("select", options.map((m) => el("option", { value: m }, connectors.byId(m).label)).concat([el("option", { value: "other" }, "In person / elsewhere")]));
    marketSel.value = def;
    const priceIn = el("input", { type: "number", min: "0", step: "0.01", value: p.price });
    const shipIn = el("input", { type: "number", min: "0", step: "0.01", value: "0" });
    const readyBox = el(".stack", { style: { gap: "6px" } });
    const preview = el(".net-preview");
    const posted = new Set();
    const cost = p.cost == null || p.cost === "" ? null : Number(p.cost);

    function draw() {
      App.ui.clear(readyBox); App.ui.clear(preview);
      const market = marketSel.value;
      const readies = store.MARKETS.filter((m) => m !== market && p.listings[m] && p.listings[m].status === "ready");
      if (readies.length) {
        readyBox.appendChild(el(".small.muted", "Prepared but never marked as posted — tick any you did post, so they go on the take-down list:"));
        readies.forEach((m) => {
          const cb = el("input", { type: "checkbox", checked: posted.has(m), onchange: (e) => { if (e.target.checked) posted.add(m); else posted.delete(m); } });
          readyBox.appendChild(el("label.check-row", [cb, el("span", connectors.byId(m).label)]));
        });
      }
      const ship = Number(shipIn.value) || 0;
      const r = fees.calc(market, Number(priceIn.value), { shipping: ship, cost });
      preview.appendChild(el(".net-row", [el("span.grow", "Fees (" + fees.region() + ")"), el("span", "−" + moneyAuto(r.fee, cur))]));
      if (ship) preview.appendChild(el(".net-row", [el("span.grow", "Shipping you paid"), el("span", "−" + moneyAuto(ship, cur))]));
      preview.appendChild(el(".net-row", [el("span.grow", el("strong", "You keep")), el("strong", moneyAuto(r.net, cur))]));
      preview.appendChild(el(".net-row", [
        el("span.grow", cost == null ? "Profit — add a cost to the item to track it" : "Profit after " + moneyAuto(cost, cur) + " cost"),
        r.profit == null ? el("span.muted", "—") : el("strong", { style: { color: r.profit >= 0 ? "var(--success)" : "var(--danger)" } }, V.signed(r.profit, cur)),
      ]));
    }
    marketSel.addEventListener("change", draw);
    priceIn.addEventListener("input", draw);
    shipIn.addEventListener("input", draw);
    draw();

    modal({
      title: "Mark as sold",
      body: el(".stack", [
        el("div", { style: { fontWeight: "600" } }, p.title),
        el("label.field", [el("span.lab", "Sold on"), marketSel]),
        el(".form-grid", [el("label.field", [el("span.lab", "Sold price (" + cur + ")"), priceIn]), el("label.field", [el("span.lab", "Shipping you paid"), shipIn])]),
        readyBox,
        preview,
      ]),
      actions: [
        { label: "Cancel" },
        { label: "Mark sold", kind: "primary", onClick: (close) => {
          const price = Number(priceIn.value);
          if (!(price > 0)) { toast("Enter the sold price", "It must be more than 0.", "warn"); return; }
          const n = store.markSold(p.id, { market: marketSel.value, price, shipping: Number(shipIn.value) || 0, postedReady: Array.from(posted) });
          close(); App.app.rerender();
          toast("Marked sold", n ? plural(n, "other listing") + " to take down — see the top of your dashboard." : "Nothing else to take down.", n ? "warn" : "ok");
        } },
      ],
    });
  }

  async function undoSale(p) {
    if (await confirmDialog("Undo this sale?", "Puts every marketplace back the way it was before you marked it sold.", "Undo sale")) { store.undoSale(p.id); App.app.rerender(); toast("Sale undone", p.title + " is back in your inventory.", "ok"); }
  }

  // Returns how many live listings now carry an "Update price" reminder.
  function changePrice(p, price) {
    const np = Math.max(0.01, fees.round2(price));
    if (np === p.price) return 0;
    const listings = Object.assign({}, p.listings);
    let flagged = 0;
    store.MARKETS.forEach((m) => {
      if (listings[m] && listings[m].status === "live") { listings[m] = Object.assign({}, listings[m], { priceChanged: true }); flagged++; }
    });
    store.updateProduct(p.id, {
      price: np,
      refreshedAt: Date.now(),
      listings,
      priceHistory: (p.priceHistory || []).concat([{ price: p.price, at: Date.now() }]),
    });
    return flagged;
  }
  function priceNote(flagged) {
    return flagged ? plural(flagged, "live listing") + " now show “Update price” — change the price there too." : "Prepared listings already use the new price.";
  }

  async function editItem(p) {
    const sold = !!p.sale;
    const fields = sold ? [] : [{ name: "price", label: "Price (" + curOf(p) + ")", value: String(p.price) }];
    fields.push({ name: "cost", label: "Cost — what you paid (blank = unknown)", value: p.cost == null ? "" : String(p.cost) });
    const r = await prompt2(sold ? "Edit cost" : "Edit price & cost", fields, "Save");
    if (!r) return;
    const price = sold ? p.price : Number(String(r.price).replace(",", "."));
    const cost = String(r.cost).trim() === "" ? null : Number(String(r.cost).replace(",", "."));
    if (!(price > 0) || (cost != null && !(cost >= 0))) { toast("Check the numbers", "Price must be above 0 and cost can't be negative.", "warn"); return; }
    const parts = [];
    let flagged = 0;
    if (!sold && price !== p.price) { flagged = changePrice(p, price); parts.push("price"); }
    if (cost !== p.cost) {
      store.updateProduct(p.id, { cost });
      if (sold) { p.sale.cost = cost; p.sale.profit = cost == null ? null : fees.round2(p.sale.net - cost); store.save(); }
      parts.push("cost");
    }
    App.app.rerender();
    if (!parts.length) { toast("No changes", "Nothing was different.", "ok"); return; }
    toast("Saved", (parts.length === 2 ? "Price and cost" : parts[0] === "price" ? "Price" : sold ? "Cost (and the sale's profit)" : "Cost") + " updated." + (parts.indexOf("price") !== -1 ? " " + priceNote(flagged) : ""), flagged ? "warn" : "ok");
  }

  /* ---------- Listing card & details ---------- */
  function btn(label, fn, title) { return el("button.btn.sm.ghost", { title: title || null, onClick: (e) => { e.stopPropagation(); fn(); } }, label); }

  function listingCard(p) {
    const cur = curOf(p);
    const selected = inv.selected.has(p.id);
    const thumb = el(".listing-thumb");
    if (p.photos && p.photos[0]) thumb.style.backgroundImage = "url(" + p.photos[0] + ")";
    else thumb.appendChild(el(".ph", V.iconFor(p.category)));
    thumb.appendChild(el(".listing-price", moneyAuto(p.price, cur)));
    if (p.sale) thumb.appendChild(el(".sold-ribbon", "SOLD"));
    if (inv.selecting) thumb.appendChild(el(".sel-box" + (selected ? ".on" : ""), selected ? "✓" : ""));

    const meta = [];
    if (p.sale) {
      meta.push(el("span", "Sold on " + labelFor(p.sale.market) + " · " + moneyAuto(p.sale.price, cur)));
      if (p.sale.profit != null) meta.push(el("span", { style: { color: p.sale.profit >= 0 ? "var(--success)" : "var(--danger)", fontWeight: "600" } }, V.signed(p.sale.profit, cur) + " profit"));
    } else {
      if (p.cost != null && p.cost !== "") meta.push(el("span", "Cost " + moneyAuto(p.cost, cur)));
      if (isStale(p)) meta.push(el("span.stale-badge", "💤 " + ageDays(p) + "d unsold"));
    }

    const acts = p.sale
      ? [btn("Details", () => openListingDetail(p)), btn("↩ Undo sale", () => undoSale(p))]
      : [btn("Details", () => openListingDetail(p)), btn("✓ Sold", () => markSoldFlow(p), "Mark as sold")].concat(V.repushTargets(p).length ? [btn("↻ Re-push", () => V.republish(p), "Post the drafts / failed / prepared listings again")] : []);
    acts.push(el("button.btn.sm.ghost", { style: { marginLeft: "auto" }, title: "Delete", onClick: async (e) => {
      e.stopPropagation();
      if (await confirmDialog("Delete listing?", "“" + p.title + "” will be removed.", "Delete", "danger")) { store.removeProduct(p.id); inv.selected.delete(p.id); App.app.rerender(); }
    } }, "🗑"));

    const card = el(".listing-card" + (inv.selecting ? ".selectable" : "") + (selected ? ".selected" : ""), [
      thumb,
      el(".listing-body", [
        el(".listing-title", p.title),
        el(".listing-sub", [p.brand, p.condition, p.size].filter(Boolean).join(" · ") || "—"),
        meta.length ? el(".listing-meta", meta) : null,
        el(".listing-chips", store.MARKETS.map((m) => V.statusChip(m, p.listings && p.listings[m], p))),
        inv.selecting ? null : el(".listing-acts", acts),
      ]),
    ]);
    if (inv.selecting) card.addEventListener("click", () => { if (inv.selected.has(p.id)) inv.selected.delete(p.id); else inv.selected.add(p.id); drawInventory(); });
    return card;
  }

  function openListingDetail(p) {
    const cur = curOf(p);
    const rows = store.MARKETS.map((m) => { const api = V.pubRow(m, p); api.setResult((p.listings && p.listings[m]) || { status: "draft" }); return api.node; });
    const s = p.sale;
    const saleBox = s ? el(".net-preview", [
      el(".net-row", [el("span.grow", "Sold on " + labelFor(s.market) + " · " + fmtDate(s.at)), el("strong", moneyAuto(s.price, cur))]),
      el(".net-row", [el("span.grow", "Fees"), el("span", "−" + moneyAuto(s.fee, cur))]),
      s.shipping ? el(".net-row", [el("span.grow", "Shipping you paid"), el("span", "−" + moneyAuto(s.shipping, cur))]) : null,
      el(".net-row", [el("span.grow", "You kept"), el("strong", moneyAuto(s.net, cur))]),
      s.profit != null ? el(".net-row", [el("span.grow", "Profit after " + moneyAuto(s.cost, cur) + " cost"), el("strong", { style: { color: s.profit >= 0 ? "var(--success)" : "var(--danger)" } }, V.signed(s.profit, cur))])
        : el(".net-row", [el("span.grow.muted", "Add a cost (Edit) to see profit")]),
    ]) : null;
    const body = el(".stack", [
      (p.photos && p.photos.length) ? el(".photo-grid", p.photos.map((src) => el(".photo-tile", { style: { backgroundImage: "url(" + src + ")" } }))) : null,
      el("div", [el("div", { style: { fontWeight: "700", fontSize: "16px" } }, p.title), el(".small.muted", [p.brand, p.condition, p.size, p.color].filter(Boolean).join(" · ") || "—")]),
      el(".row.between", [
        el("div", [el("div", { style: { fontWeight: "750", fontSize: "20px" } }, moneyAuto(p.price, cur)), el(".small.muted", p.cost != null && p.cost !== "" ? "Cost " + moneyAuto(p.cost, cur) : "No cost recorded")]),
        el(".small.muted", "Created " + fmtDate(p.createdAt)),
      ]),
      p.description ? el(".small.muted", p.description) : null,
      saleBox,
      el("div", { style: { fontWeight: "650", marginTop: "4px" } }, "Marketplace status"),
      el(".stack", rows),
    ]);
    const actions = [{ label: "✎ Edit", onClick: (close) => { close(); editItem(p); } }];
    if (s) actions.push({ label: "↩ Undo sale", onClick: (close) => { close(); undoSale(p); } });
    else actions.push({ label: "✓ Mark sold", kind: "primary", onClick: (close) => { close(); markSoldFlow(p); } });
    actions.push({ label: "Close" });
    modal({ title: "Listing details", body, actions, onClose: () => App.app.refreshIf("dashboard") });
  }

  /* ---------- Attention panels ---------- */
  function delistPanel(all) {
    const rows = [];
    all.forEach((p) => store.MARKETS.forEach((m) => { if (p.listings[m] && p.listings[m].status === "needs_delist") rows.push([p, m]); }));
    if (!rows.length) return null;
    return el(".attention.attention-danger", [
      el(".att-head", [el("strong", "⚠ Take these down — the item already sold"), el("span.small.muted", plural(rows.length, "listing"))]),
      el(".stack", { style: { gap: "8px" } }, rows.slice(0, 6).map(([p, m]) => {
        const c = connectors.byId(m);
        return el(".att-row", [
          el(".mkt-logo.sm", { style: { background: c.color } }, c.short),
          el(".grow", [el("div", { style: { fontWeight: "600" } }, p.title), el(".small.muted", "Still up on " + c.label + " · sold " + (p.sale ? "on " + labelFor(p.sale.market) + " " + timeAgo(p.sale.at) : "elsewhere"))]),
          el("button.btn.sm", { onClick: () => openUrl(p, m) }, "Open ↗"),
          el("button.btn.sm.primary", { onClick: () => { store.markDelisted(p.id, m); App.app.rerender(); } }, "Done"),
        ]);
      })),
      rows.length > 6 ? el("button.btn.sm.ghost", { style: { marginTop: "8px" }, onClick: () => { inv.filter = "delist"; drawInventory(); refs.chips.scrollIntoView({ behavior: "smooth" }); } }, "Show all " + rows.length) : null,
    ]);
  }

  function stalePanel(unsold) {
    const days = store.settings().staleDays || 30;
    const stale = unsold.filter(isStale).sort((a, b) => ageDays(b) - ageDays(a));
    if (!stale.length) return null;
    return el(".attention.attention-warn", [
      el(".att-head", [el("strong", "💤 Unsold for " + days + "+ days — try a price drop or a relist"), el("span.small.muted", plural(stale.length, "item"))]),
      el(".stack", { style: { gap: "8px" } }, stale.slice(0, 5).map((p) => {
        const cur = curOf(p);
        const old = p.price;
        const np = fees.round2(old * 0.9);
        return el(".att-row", [
          el(".grow", [el("div", { style: { fontWeight: "600" } }, p.title), el(".small.muted", ageDays(p) + " days · " + moneyAuto(old, cur))]),
          el("button.btn.sm", { title: "Lower the price by 10%", onClick: () => { const f = changePrice(p, np); App.app.rerender(); toast("Price dropped", moneyAuto(old, cur) + " → " + moneyAuto(np, cur) + ". " + priceNote(f), f ? "warn" : "ok"); } }, "−10% → " + moneyAuto(np, cur)),
          V.repushTargets(p).length ? el("button.btn.sm", { onClick: () => V.republish(p) }, "↻ Relist") : null,
          el("button.btn.sm.ghost", { title: "Hide for another " + days + " days", onClick: () => { store.updateProduct(p.id, { refreshedAt: Date.now() }); App.app.rerender(); } }, "Snooze"),
        ]);
      })),
      stale.length > 5 ? el("button.btn.sm.ghost", { style: { marginTop: "8px" }, onClick: () => { inv.filter = "stale"; drawInventory(); refs.chips.scrollIntoView({ behavior: "smooth" }); } }, "Show all " + stale.length) : null,
    ]);
  }

  /* ---------- Bulk actions ---------- */
  function selectedProducts() { return Array.from(inv.selected).map((id) => store.getProduct(id)).filter(Boolean); }
  function endSelecting() { inv.selecting = false; inv.selected.clear(); App.app.rerender(); }

  // One bulk action at a time: a double-click (or a second action while a
  // re-push is still running) is ignored instead of running twice.
  let bulkBusy = false;
  function bulk(fn) {
    return async function () {
      if (bulkBusy) { toast("Still working", "Wait for the current bulk action to finish.", "warn"); return; }
      bulkBusy = true;
      try { await fn(); } finally { bulkBusy = false; }
    };
  }

  function bulkSold() {
    const ps = selectedProducts().filter((p) => !p.sale);
    if (!ps.length) { toast("Nothing to mark", "The selected items are already sold.", "warn"); return Promise.resolve(); }
    const sel = el("select", store.MARKETS.map((m) => el("option", { value: m }, connectors.byId(m).label)).concat([el("option", { value: "other" }, "In person / elsewhere")]));
    const readyCount = () => ps.reduce((n, p) => n + store.MARKETS.filter((m) => m !== sel.value && p.listings[m] && p.listings[m].status === "ready").length, 0);
    const postedCb = el("input", { type: "checkbox" });
    const readyRow = el("label.check-row", [postedCb, el("span")]);
    function drawReady() {
      const n = readyCount();
      readyRow.style.display = n ? "" : "none";
      readyRow.lastChild.textContent = "I also posted the " + plural(n, "“Ready to post” listing") + " — put them on the take-down list";
    }
    sel.addEventListener("change", drawReady);
    drawReady();
    return new Promise((resolve) => {
      let done = false;
      modal({
        title: "Mark " + plural(ps.length, "item") + " sold",
        body: el(".stack", [
          el("label.field", [el("span.lab", "Sold on"), sel]),
          readyRow,
          el(".small.muted", "Each item is recorded at its listed price with no shipping cost. Open an item afterwards to adjust it."),
        ]),
        actions: [{ label: "Cancel" }, { label: "Mark sold", kind: "primary", onClick: (close) => {
          if (done) return;
          done = true;
          let n = 0;
          ps.forEach((p) => {
            const postedReady = postedCb.checked ? store.MARKETS.filter((m) => m !== sel.value && p.listings[m] && p.listings[m].status === "ready") : [];
            n += store.markSold(p.id, { market: sel.value, price: p.price, shipping: 0, postedReady });
          });
          close(); endSelecting();
          toast("Marked " + plural(ps.length, "item") + " sold", n ? plural(n, "listing") + " to take down." : "Nothing left to take down.", n ? "warn" : "ok");
        } }],
        onClose: () => resolve(),
      });
    });
  }
  async function bulkPrice() {
    const ps = selectedProducts().filter((p) => !p.sale);
    if (!ps.length) { toast("Nothing to change", "Sold items keep their sold price.", "warn"); return; }
    const r = await prompt2("Change the price of " + plural(ps.length, "item"), [{ name: "pct", label: "Change by % (e.g. -10 drops 10%, 5 raises 5%)", value: "-10" }], "Apply");
    if (!r) return;
    const pct = parseFloat(String(r.pct).replace(",", "."));
    if (!isFinite(pct) || pct <= -100) { toast("Enter a percentage", "For example -10.", "warn"); return; }
    let flagged = 0;
    ps.forEach((p) => { flagged += changePrice(p, p.price * (1 + pct / 100)); });
    endSelecting();
    toast("Prices updated", plural(ps.length, "item") + (pct < 0 ? " lowered " : " raised ") + Math.abs(pct) + "%. " + priceNote(flagged), flagged ? "warn" : "ok");
  }
  async function bulkRepush() {
    const ps = selectedProducts().filter((p) => !p.sale && V.repushTargets(p).length);
    const skipped = inv.selected.size - ps.length;
    endSelecting();
    if (!ps.length) { toast("Nothing to re-push", "The selected items are already live (or sold). Price changes show an “Update price” reminder.", "warn"); return; }
    toast("Re-pushing " + plural(ps.length, "item") + "…", (skipped ? plural(skipped, "item") + " already live or sold skipped. " : "") + "Keep this tab open until it finishes.", "ok");
    let live = 0, ready = 0, failed = 0;
    for (const p0 of ps) {
      const p = store.getProduct(p0.id);
      if (!p) continue;
      let targets = V.repushTargets(p);
      if (targets.indexOf("ebay") !== -1 && !(await V.ensureEbayReady(p))) targets = targets.filter((m) => m !== "ebay");
      if (!targets.length) continue;
      store.updateProduct(p.id, { refreshedAt: Date.now() });
      const results = await Promise.all(targets.map((m) => { store.setListing(p.id, m, V.pendingListing(p, m)); return V.publishOne(p, m); }));
      results.forEach((r) => { if (r.status === "live") live++; else if (r.status === "ready") ready++; else if (r.status === "error") failed++; });
    }
    App.app.refreshIf("dashboard");
    toast("Re-push complete", [live && live + " live", ready && ready + " ready to post", failed && failed + " failed"].filter(Boolean).join(", ") || "done", failed ? "warn" : "ok");
  }
  async function bulkDelete() {
    const ps = selectedProducts();
    if (!ps.length) return;
    if (!(await confirmDialog("Delete " + plural(ps.length, "item") + "?", "This can't be undone (unless you have a backup).", "Delete", "danger"))) return;
    ps.forEach((p) => store.removeProduct(p.id));
    endSelecting();
    toast("Deleted", plural(ps.length, "item") + " removed.", "ok");
  }
  const runBulkSold = bulk(bulkSold), runBulkPrice = bulk(bulkPrice), runBulkRepush = bulk(bulkRepush), runBulkDelete = bulk(bulkDelete);

  function drawBulkBar() {
    App.ui.clear(refs.bulk);
    if (!inv.selecting) return;
    const n = inv.selected.size;
    refs.bulk.appendChild(el(".bulk-bar", [
      el("strong", n + " selected"),
      el("button.btn.sm.ghost", { onClick: () => {
        const vis = refs.visible || [];
        const allOn = vis.length && vis.every((id) => inv.selected.has(id));
        vis.forEach((id) => { if (allOn) inv.selected.delete(id); else inv.selected.add(id); });
        drawInventory();
      } }, "Select all shown"),
      el(".spacer"),
      el("button.btn.sm", { disabled: !n, onClick: runBulkSold }, "✓ Mark sold"),
      el("button.btn.sm", { disabled: !n, onClick: runBulkPrice }, "％ Change price"),
      el("button.btn.sm", { disabled: !n, onClick: runBulkRepush }, "↻ Re-push"),
      el("button.btn.sm.danger", { disabled: !n, onClick: runBulkDelete }, "🗑 Delete"),
    ]));
  }

  /* ---------- Inventory grid ---------- */
  function drawInventory() {
    if (!refs.grid) return;
    const all = store.products();
    const f = FILTERS.find((x) => x[0] === inv.filter) || FILTERS[0];
    const q = inv.q.trim().toLowerCase();

    App.ui.clear(refs.chips);
    FILTERS.forEach(([key, label, fn]) => {
      const n = all.filter(fn).length;
      if (key !== "all" && key !== inv.filter && !n) return; // hide empty filters
      refs.chips.appendChild(el("button.fchip" + (inv.filter === key ? ".active" : "") + (key === "delist" && n ? ".alert" : ""), { onClick: () => { inv.filter = key; drawInventory(); } }, [label, el("span.count", String(n))]));
    });

    let list = all.filter(f[2]);
    if (q) list = list.filter((p) => (p.title + " " + (p.brand || "")).toLowerCase().indexOf(q) !== -1);
    list = sortList(list);
    refs.visible = list.map((p) => p.id);

    App.ui.clear(refs.grid);
    if (!list.length) {
      refs.grid.appendChild(el(".card", el(".empty", { style: { padding: "30px 20px" } }, [
        el(".big", "🔍"), el("h3", "Nothing here"),
        el("p", q ? "No items match “" + inv.q + "”." : "No items in this view."),
        el("button.btn.sm", { style: { marginTop: "8px" }, onClick: () => { inv.q = ""; inv.filter = "all"; App.app.rerender(); } }, "Show everything"),
      ])));
    } else {
      refs.grid.appendChild(el(".grid.cols-3", list.map(listingCard)));
    }
    drawBulkBar();
  }

  /* ---------- Dashboard ---------- */
  function statCard(icon, label, value, delta) {
    return el(".stat", [el(".label", [el("span", icon), label]), el(".value", String(value)), delta ? el(".delta", delta) : null]);
  }
  function welcome() {
    const step = (n, title, href, cta) => el("a.empty-step", { href }, [el(".n", n), el("div", { style: { fontWeight: "650" } }, title), el(".small.muted", cta + " →")]);
    return el(".card.pad-lg", el(".empty", [
      el(".big", "👋"),
      el("h3", "Welcome to OmniList"),
      el("p", "List an item once, post it everywhere, and see what you actually make after fees."),
      el(".empty-steps", [
        step("1", "Connect where you sell", "#/marketplaces", "Marketplaces"),
        step("2", "List your first item", "#/new", "New listing"),
        step("3", "Check what something's worth", "#/appraise", "Scan & appraise"),
      ]),
      store.allProducts().length ? null : el("button.btn.ghost.sm", { style: { marginTop: "16px" }, onClick: () => {
        store.loadDemo(); App.app.renderChrome(); App.app.rerender();
        toast("Demo data loaded", "Clear it any time in Settings.", "ok");
      } }, "Or explore with demo data"),
    ]));
  }

  function dashboard() {
    const root = el(".view");
    const account = store.activeAccount();
    const cur = fees.currency();
    const all = store.products();
    inv.selected.forEach((id) => { if (!all.find((p) => p.id === id)) inv.selected.delete(id); });
    const unsold = all.filter((p) => !isSold(p));
    const sold = all.filter(isSold);
    const inCur = (p) => curOf(p) === cur;
    const connected = store.MARKETS.filter((m) => account.connections[m].connected).length;
    const withProfit = sold.filter((p) => inCur(p) && p.sale.profit != null);
    const profit = sum(withProfit, (p) => p.sale.profit);
    const otherCur = all.filter((p) => !inCur(p)).length;

    root.appendChild(el(".page-head", [
      el("div", [el("h2", "Dashboard"), el("p", account.name + " · " + connected + "/" + store.MARKETS.length + " marketplaces connected")]),
      el("button.btn.primary", { onClick: () => V.go("#/new") }, "＋ New listing"),
    ]));
    if (!all.length) { root.appendChild(welcome()); return root; }

    root.appendChild(el(".grid.cols-4", [
      statCard("📦", "Active listings", unsold.length, plural(unsold.filter(isStale).length, "stale item")),
      statCard(cur === "GBP" ? "💷" : "💶", "Inventory value", money(sum(unsold.filter(inCur), (p) => p.price), cur), "unsold, at list price"),
      statCard("✅", "Sold", sold.length, moneyAuto(sum(sold.filter(inCur), (p) => p.sale.price), cur) + " revenue"),
      statCard("💰", "Net profit", withProfit.length ? V.signed(profit, cur) : "—", withProfit.length ? "after fees, shipping & cost" : "add item costs to track profit"),
    ]));
    if (otherCur) root.appendChild(el(".small.muted", { style: { marginTop: "8px" } }, plural(otherCur, "item") + " priced in another currency " + (otherCur === 1 ? "isn't" : "aren't") + " included in these totals (your region is " + fees.region() + ", " + cur + ")."));

    const dp = delistPanel(all); if (dp) root.appendChild(dp);
    const sp = stalePanel(unsold); if (sp) root.appendChild(sp);

    // Toolbar: search · sort · select
    const search = el("input", { type: "search", placeholder: "Search title or brand…", value: inv.q });
    search.addEventListener("input", () => { inv.q = search.value; drawInventory(); });
    const sortSel = el("select.sort-sel", SORTS.map(([v, l]) => el("option", { value: v }, l)));
    sortSel.value = inv.sort;
    sortSel.addEventListener("change", () => { inv.sort = sortSel.value; drawInventory(); });
    const selBtn = el("button.btn.sm" + (inv.selecting ? ".primary" : ""), { onClick: () => {
      inv.selecting = !inv.selecting; inv.selected.clear();
      selBtn.textContent = inv.selecting ? "Done selecting" : "☑ Select";
      selBtn.classList.toggle("primary", inv.selecting);
      drawInventory();
    } }, inv.selecting ? "Done selecting" : "☑ Select");

    root.appendChild(el(".page-head", { style: { marginTop: "26px", marginBottom: "12px" } }, [el("h3", { style: { margin: "0" } }, "Your listings"), el("span.small.muted", plural(all.length, "item"))]));
    root.appendChild(el(".inv-toolbar", el(".row.wrap", { style: { gap: "8px" } }, [el(".grow", { style: { minWidth: "200px" } }, search), sortSel, selBtn])));
    refs.chips = el(".filter-chips");
    refs.grid = el("div");
    refs.bulk = el("div");
    root.appendChild(refs.chips);
    root.appendChild(refs.grid);
    root.appendChild(refs.bulk);
    drawInventory();

    const aprs = store.appraisals();
    if (aprs.length) {
      root.appendChild(el("h3", { style: { margin: "26px 0 12px" } }, "Recent appraisals"));
      root.appendChild(el(".card", { style: { padding: "4px 0" } }, aprs.slice(0, 5).map((a) => el(".comp", [
        el(".c-title", [el("div.t", App.ui.composeTitle(a.brand, a.query)), el("div.s", timeAgo(a.createdAt) + (a.result.mode === "live" ? (a.result.verdict ? " · " + a.result.verdict.call : "") : " · demo"))]),
        el("div.c-price", money(a.result.aggregate.median, a.result.currency)),
      ]))));
    }
    return root;
  }

  App.views.dashboard = dashboard;
  window.App.inventory = { openDelist, openPriceUpdate, markSoldFlow, openListingDetail, undoSale, isStale, ageDays };
})();
