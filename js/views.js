/* ===========================================================================
   views.js — New Listing, Appraise, Marketplaces and Accounts screens, plus the
   shared publish / handoff components. The Dashboard (inventory, sales,
   take-downs, bulk actions) lives in inventory.js; Settings in settings.js.
   Attaches to window.App.views (shared helpers on App.views._)
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { el, money, moneyAuto, timeAgo, toast, modal, confirmDialog, prompt2, fileToDataURL, resizeImage, safeUrl } = App.ui;
  const store = App.store;
  const connectors = App.connectors;
  const fees = App.fees;

  const CATEGORIES = ["Clothing", "Shoes", "Accessories", "Bags", "Electronics", "Home", "Toys & Games", "Books", "Beauty", "Other"];
  const CONDITIONS = ["New", "Like new", "Good", "Fair", "Poor"];
  const CURRENCIES = ["EUR", "GBP", "USD"];
  // Re-push only ever touches listings that are NOT up on a marketplace.
  // Live listings are never re-prepared (that would lose their URL and break
  // take-down tracking); price changes on them get an "Update price" reminder.
  const REPUSHABLE = ["draft", "error", "ready", "pending"];

  function go(route) { location.hash = route; }
  function selectEl(options, value) {
    const s = el("select", options.map((o) => el("option", { value: o, selected: o === value }, o)));
    s.value = value;
    return s;
  }
  function iconFor(cat) {
    return ({ Clothing: "🧥", Shoes: "👟", Accessories: "⌚", Bags: "👜", Electronics: "🎧", Home: "🏠", "Toys & Games": "🎮", Books: "📚", Beauty: "💄" }[cat]) || "📦";
  }
  const LABELS = { live: "Live", ready: "Ready to post", pending: "Pending", error: "Failed", skipped: "Not posted", draft: "Draft", sold: "Sold", needs_delist: "Take down!", delisted: "Taken down" };
  const COLORS = { live: "var(--success)", ready: "#4dabf7", pending: "var(--warn)", error: "var(--danger)", sold: "var(--success)", needs_delist: "var(--danger)" };
  function statusLabel(s) { return LABELS[s] || s; }
  function statusColorVar(s) { return COLORS[s] || "var(--muted)"; }
  function signed(n, cur) { return (n >= 0 ? "+" : "") + moneyAuto(n, cur); }
  function repushTargets(p) { return store.MARKETS.filter((m) => p.listings[m] && REPUSHABLE.indexOf(p.listings[m].status) !== -1); }
  // Disables buttons while an async handler runs so a double-click can't run it twice.
  function guard(buttons, fn) {
    let busy = false;
    return async function () {
      if (busy) return;
      busy = true;
      buttons().forEach((b) => { if (b) b.disabled = true; });
      try { return await fn.apply(this, arguments); }
      finally { busy = false; buttons().forEach((b) => { if (b) b.disabled = false; }); }
    };
  }
  function refreshDashboard() { App.app.refreshIf("dashboard"); }

  /* ---------- shared: marketplace status chip ---------- */
  function statusChip(marketId, lst, product) {
    const c = connectors.byId(marketId);
    const s = (lst && lst.status) || "skipped";
    let action = null, text = statusLabel(s), title = (lst && lst.message) || statusLabel(s), color = statusColorVar(s);
    if (product && s === "ready") { action = () => openHandoff(product, marketId); text = "Post now ↗"; title = "Tap to post on " + c.label; }
    else if (product && s === "needs_delist") { action = () => App.inventory.openDelist(product, marketId); text = "Take down ↗"; title = "Sold elsewhere — take this listing down"; }
    else if (product && s === "live" && lst.priceChanged) { action = () => App.inventory.openPriceUpdate(product, marketId); text = "Update price ↗"; title = "You changed the price — update it on " + c.label; color = "var(--warn)"; }
    return el("span.chip" + (s === "needs_delist" ? ".chip-alert" : ""), {
      title,
      style: action ? { cursor: "pointer" } : null,
      onClick: action ? (e) => { e.stopPropagation(); action(); } : null,
    }, [
      el("span.mkt-dot", { style: { background: c.color } }),
      el("span", { style: { fontWeight: "600" } }, c.label),
      el("span.small", { style: { color } }, text),
    ]);
  }

  /* ---------- shared: publish engine ---------- */
  // "pending" placeholder that keeps eBay's sku/offerId so a retry updates the
  // same eBay listing instead of creating a duplicate.
  function pendingListing(product, market) {
    const keep = market === "ebay" ? connectors.ebayIds(product.listings[market]) : {};
    return Object.assign(keep, { status: "pending", message: "Queued…", listedAt: Date.now() });
  }
  function publishOne(product, market, onProgress) {
    const acc = store.accounts().find((a) => a.id === product.accountId) || store.activeAccount();
    const conn = acc.connections[market];
    return connectors.publish(market, product, conn, onProgress).then((res) => {
      store.setListing(product.id, market, res);
      return res;
    });
  }

  function pubRow(market, product) {
    const c = connectors.byId(market);
    const msgEl = el(".pub-msg", "Queued…");
    const right = el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } });
    right.appendChild(el(".spinner"));
    const node = el(".pub-row", [
      el(".mkt-logo", { style: { background: c.color } }, c.short),
      el(".grow", [el("div", { style: { fontWeight: "600" } }, c.label), msgEl]),
      right,
    ]);
    const api = {
      node,
      setMsg(s) { msgEl.textContent = s; },
      setResult(res) {
        App.ui.clear(right);
        if (res.status === "live") {
          if (res.priceChanged) right.appendChild(el("button.btn.sm", { onClick: () => App.inventory.openPriceUpdate(product, market) }, "Update price"));
          right.appendChild(el("span.badge.ok", "✓ Live"));
          App.ui.clear(msgEl);
          msgEl.appendChild(document.createTextNode(res.message || "Published"));
          const href = safeUrl(res.url);
          if (href) { msgEl.appendChild(document.createTextNode(" · ")); msgEl.appendChild(el("a", { href, target: "_blank", rel: "noopener noreferrer" }, "View ↗")); }
        } else if (res.status === "pending") {
          right.appendChild(el("span.badge.warn", "Pending"));
          api.setMsg(res.message || "Pending");
        } else if (res.status === "ready") {
          right.appendChild(el("button.btn.sm.primary", { onClick: () => openHandoff(product, market) }, "Post on " + c.label + " ↗"));
          api.setMsg(res.message || "Ready to post");
        } else if (res.status === "sold") {
          right.appendChild(el("span.badge.ok", "✓ Sold"));
          api.setMsg("Sold here");
        } else if (res.status === "needs_delist") {
          right.appendChild(el("button.btn.sm.danger", { onClick: () => App.inventory.openDelist(product, market) }, "Take down ↗"));
          api.setMsg(res.message || "Sold elsewhere - take this down");
        } else if (res.status === "delisted") {
          right.appendChild(el("span.badge", "Taken down"));
          api.setMsg(res.message || "Taken down");
        } else if (res.status === "error") {
          right.appendChild(el("button.btn.sm", { onClick: () => repost("↻ Retrying…") }, "↻ Retry"));
          api.setMsg(res.message || "Failed");
          right.insertBefore(el("span.badge.err", "Failed"), right.firstChild);
        } else if (product.sale) {
          right.appendChild(el("span.badge", "—"));
          api.setMsg(res.message || statusLabel(res.status));
        } else {
          right.appendChild(el("button.btn.sm", { onClick: () => repost("Posting…") }, "Post"));
          api.setMsg(statusLabel(res.status));
        }
      },
    };
    let reposting = false;
    function repost(msg) {
      if (reposting) return;
      reposting = true;
      App.ui.clear(right);
      right.appendChild(el(".spinner"));
      api.setMsg(msg);
      store.setListing(product.id, market, pendingListing(product, market));
      publishOne(product, market, api.setMsg).then((r) => { reposting = false; api.setResult(r); });
    }
    return api;
  }

  function runPublishUI(product, marketIds) {
    const rows = marketIds.map((m) => pubRow(m, product));
    const container = el(".stack", rows.map((r) => r.node));
    const promise = Promise.all(marketIds.map((m, i) => {
      store.setListing(product.id, m, pendingListing(product, m));
      return publishOne(product, m, (stage) => rows[i].setMsg(stage)).then((res) => {
        rows[i].setResult(res);
        return { m, res };
      });
    }));
    return { node: container, promise };
  }

  function summarize(results, verb) {
    const live = results.filter((r) => r.res.status === "live").length;
    const ready = results.filter((r) => r.res.status === "ready").length;
    const err = results.filter((r) => r.res.status === "error").length;
    const parts = [];
    if (live) parts.push(live + " live");
    if (ready) parts.push(ready + " ready to post");
    if (err) parts.push(err + " failed");
    toast(verb + " complete", parts.join(", ") || "done", err ? "warn" : "ok");
  }

  // One re-push per item at a time (a double-click must not run it twice).
  const repushing = new Set();
  async function republish(p) {
    if (repushing.has(p.id)) return;
    repushing.add(p.id);
    try { await republishNow(p); } finally { repushing.delete(p.id); }
  }
  async function republishNow(p) {
    if (p.sale) { toast("Already sold", "Undo the sale first if you want to list it again.", "warn"); return; }
    let targets = repushTargets(p);
    if (!targets.length) {
      const live = store.MARKETS.filter((m) => p.listings[m] && p.listings[m].status === "live");
      toast("Nothing to re-push", live.length ? "It's already live everywhere it's listed. Price changes show an “Update price” reminder on each marketplace." : "This item isn't targeting any marketplace.", "warn");
      return;
    }
    if (targets.indexOf("ebay") !== -1) {
      const ok = await ensureEbayReady(p);
      if (!ok) { store.setListing(p.id, "ebay", { status: "skipped", message: "Skipped - item specifics not provided" }); targets = targets.filter((m) => m !== "ebay"); }
    }
    if (!targets.length) { refreshDashboard(); return; }
    store.updateProduct(p.id, { refreshedAt: Date.now() }); // a relist restarts the "stale" clock
    const { node, promise } = runPublishUI(p, targets);
    let open = true;
    modal({ title: "Re-pushing " + p.title, body: node, actions: [{ label: "Done", kind: "primary" }], onClose: () => { open = false; refreshDashboard(); } });
    await promise.then((r) => { summarize(r, "Re-push"); if (!open) refreshDashboard(); });
  }

  // For eBay live publishing: resolve category + collect any required item specifics.
  // Returns true to proceed, false if the user skipped eBay.
  async function ensureEbayReady(product) {
    if (!(await connectors.ebayLiveAvailable())) return true; // eBay will be a manual handoff
    if (product.ebayCategoryId && product.ebayAspects && Object.keys(product.ebayAspects).length) return true; // already prepared
    const r = await App.backend.ebayAspects(product.title);
    if (!r || !r.ok || !r.categoryId) return true; // let the publish call surface any issue
    const required = (r.aspects || []).filter((a) => a.required);
    if (!required.length) { store.updateProduct(product.id, { ebayCategoryId: r.categoryId, ebayAspects: product.ebayAspects || {} }); return true; }
    const collected = await collectAspects(required, product);
    if (collected === null) return false;
    store.updateProduct(product.id, { ebayCategoryId: r.categoryId, ebayAspects: Object.assign({}, product.ebayAspects || {}, collected) });
    return true;
  }

  function collectAspects(required, product) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const inputs = {};
      const guess = (name) => { const n = name.toLowerCase(); if (n.indexOf("brand") !== -1) return product.brand || ""; if (n.indexOf("size") !== -1) return product.size || ""; if (n.indexOf("colour") !== -1 || n.indexOf("color") !== -1) return product.color || ""; return ""; };
      const fields = required.map((a) => {
        let input;
        if (a.mode === "SELECTION_ONLY" && a.values && a.values.length) {
          input = el("select", [el("option", { value: "" }, "Select...")].concat(a.values.slice(0, 100).map((v) => el("option", { value: v }, v))));
          const g = guess(a.name); if (g && a.values.indexOf(g) !== -1) input.value = g;
        } else {
          input = el("input", { type: "text", value: guess(a.name), placeholder: "e.g., ..." });
        }
        inputs[a.name] = input;
        return el("label.field", [el("span.lab", a.name + " *" + (a.cardinality === "MULTI" ? "  (comma-separate for multiple)" : "")), input]);
      });
      modal({
        title: "eBay item specifics",
        body: el(".stack", [el(".small.muted", "This eBay category requires these details to publish:"), el(".stack", fields)]),
        actions: [
          { label: "Skip eBay", onClick: (c) => { finish(null); c(); } },
          { label: "Continue", kind: "primary", onClick: (c) => {
            const out = {}; let missing = false;
            required.forEach((a) => { const raw = (inputs[a.name].value || "").trim(); if (!raw) missing = true; out[a.name] = a.cardinality === "MULTI" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw]; });
            if (missing) { toast("Fill all fields", "All listed item specifics are required by eBay.", "warn"); return; }
            finish(out); c();
          } },
        ],
        onClose: () => finish(null),
      });
    });
  }

  /* ---------- Handoff: one-tap manual posting (no automation) ---------- */
  function copyText(text, ev) {
    const flash = () => { if (ev && ev.target) { const b = ev.target; const old = b.textContent; b.textContent = "Copied!"; setTimeout(() => { b.textContent = old; }, 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(flash).catch(() => fallbackCopy(text, flash)); }
    else fallbackCopy(text, flash);
  }
  function fallbackCopy(text, done) {
    const ta = el("textarea", { style: { position: "fixed", top: "-1000px", opacity: "0" } });
    ta.value = text; document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove(); if (done) done();
  }
  async function askListingUrl(label) {
    for (;;) {
      const r = await prompt2("Mark " + label + " as posted", [{ name: "url", label: label + " listing URL (optional — makes taking it down later one tap)", placeholder: "https://..." }], "Save");
      if (!r) return null;
      if (!r.url) return { url: null };
      const u = safeUrl(r.url);
      if (u) return { url: u };
      toast("That isn't a web address", "Paste the listing's address (starting with https://), or leave it empty.", "warn");
    }
  }
  function openHandoff(product, marketId) {
    const c = connectors.byId(marketId);
    const fields = [
      ["Title", product.title], ["Price", moneyAuto(product.price, product.currency || fees.currency())],
      ["Brand", product.brand], ["Size", product.size], ["Color", product.color],
      ["Condition", product.condition], ["Description", product.description],
    ].filter((f) => f[1]);
    const copyAll = fields.map((f) => f[0] + ": " + f[1]).join("\n");
    const photos = (product.photos || []).filter((s) => /^data:image\//.test(s));
    const why = c.hasOfficialApi
      ? [el("strong", "eBay isn't connected here"), ", so OmniList prepared the listing for you. (The desktop version with your eBay keys posts it automatically.) Open eBay, drop in these details + photos, and post."]
      : [el("strong", c.label + " has no public API"), ", so OmniList won't auto-post it (that breaks their rules). Open " + c.label + ", drop in these details + photos, and tap post."];
    const body = el(".stack", [
      el(".note.info", [el("span.ni", "ℹ️"), el("span", why)]),
      c.sellNote ? el(".small.muted", c.sellNote) : null,
      el("button.btn.primary.block", { onClick: () => App.ui.openSafe(connectors.linkFor(marketId, "sell")) }, "Open " + c.label + " new listing ↗"),
      photos.length ? el("div", [
        el(".small.muted", { style: { margin: "6px 0 6px" } }, "Photos — download, then upload to " + c.label),
        el(".photo-grid", photos.map((src, i) => el(".photo-tile", { style: { backgroundImage: "url(" + src + ")" } },
          el("a.rm", { href: src, download: c.id + "-" + (i + 1) + ".jpg", title: "Download photo", style: { textDecoration: "none" } }, "⬇")))),
      ]) : null,
      el(".row.between", [el(".small.muted", "Listing details"), el("button.btn.sm", { onClick: (e) => copyText(copyAll, e) }, "Copy all")]),
      el(".stack", fields.map((f) => el(".pub-row", [
        el(".grow", [el(".small.muted", f[0]), el("div", { style: { fontWeight: "600", whiteSpace: "pre-wrap" } }, String(f[1]))]),
        el("button.btn.sm", { onClick: (e) => copyText(String(f[1]), e) }, "Copy"),
      ]))),
    ]);
    modal({
      title: "Post on " + c.label,
      body,
      actions: [
        { label: "Mark as posted", onClick: async (close) => {
          close();
          const r = await askListingUrl(c.label);
          if (!r) return;
          const keep = marketId === "ebay" ? connectors.ebayIds(product.listings.ebay) : {};
          store.setListing(product.id, marketId, Object.assign(keep, { status: "live", message: "Posted manually on " + c.label, url: r.url, listedAt: Date.now() }));
          refreshDashboard();
          toast("Marked as posted", c.label + " listing set to live.", "ok");
        } },
        { label: "Close" },
      ],
    });
  }

  /* ============================ NEW LISTING ============================ */
  function newListing() {
    const root = el(".view");
    const draft = store.takeDraft() || {};
    const account = store.activeAccount();
    const photos = (draft.photos || []).slice();

    const titleIn = el("input", { type: "text", value: draft.title || "", placeholder: "e.g., Nike Air Max 90 — White/Grey" });
    const brandIn = el("input", { type: "text", value: draft.brand || "", placeholder: "e.g., Nike" });
    const catSel = selectEl(CATEGORIES, draft.category || "Clothing");
    const condSel = selectEl(CONDITIONS, draft.condition || "Good");
    const sizeIn = el("input", { type: "text", value: draft.size || "", placeholder: "e.g., US 10 / M" });
    const colorIn = el("input", { type: "text", value: draft.color || "", placeholder: "e.g., White" });
    const priceIn = el("input", { type: "number", value: draft.price || "", placeholder: "0", min: "0", step: "0.01" });
    const curSel = selectEl(CURRENCIES, draft.currency || fees.currency());
    const costIn = el("input", { type: "number", value: draft.cost != null ? draft.cost : "", placeholder: "What you paid", min: "0", step: "0.01" });
    const descIn = el("textarea", { placeholder: "Condition details, measurements, flaws…" });
    descIn.value = draft.description || "";

    const photoGrid = el(".photo-grid");
    const fileInput = el("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, style: { display: "none" }, onchange: async (e) => { await addPhotos(e.target.files); e.target.value = ""; } });
    async function addPhotos(files) {
      if (store.saveFailed()) { toast("Storage is full", "Free up space (delete items/photos or download a backup) before adding photos.", "err"); return; }
      for (const f of files) { if (!f.type || !f.type.startsWith("image/")) continue; const raw = await fileToDataURL(f); photos.push(await resizeImage(raw, 1024, 0.72)); }
      drawPhotos();
    }
    function drawPhotos() {
      App.ui.clear(photoGrid);
      photos.forEach((src, i) => photoGrid.appendChild(el(".photo-tile", { style: { backgroundImage: "url(" + src + ")" } },
        el("button.rm", { title: "Remove", onClick: () => { photos.splice(i, 1); drawPhotos(); } }, "✕"))));
      photoGrid.appendChild(el(".photo-add", { onClick: () => fileInput.click() }, [el("div", { style: { fontSize: "22px" } }, "＋"), el("div", "Add photo")]));
    }
    drawPhotos();

    const targetState = {};
    const targetRows = store.MARKETS.map((m) => {
      const c = connectors.byId(m);
      const conn = account.connections[m];
      targetState[m] = !!conn.connected;
      const check = el("input", { type: "checkbox", checked: !!conn.connected, disabled: !conn.connected, onchange: (e) => { targetState[m] = e.target.checked; drawNet(); } });
      return el(".mkt-target" + (conn.connected ? "" : ".disabled"), [
        el(".mkt-logo", { style: { background: c.color } }, c.short),
        el(".grow", [
          el(".row", { style: { gap: "8px" } }, [el("span", { style: { fontWeight: "600" } }, c.label), c.hasOfficialApi ? el("span.badge.api", "API") : el("span.badge.api", "Manual")]),
          el(".small.muted", conn.connected ? "@" + (conn.handle || "connected") : "Not connected"),
        ]),
        conn.connected ? el("label.switch", [check, el("span.slider")]) : el("a.btn.sm", { href: "#/marketplaces" }, "Connect"),
      ]);
    });

    // "What you'd keep" — net after each marketplace's fee, before you publish.
    const netBox = el(".net-preview");
    function drawNet() {
      App.ui.clear(netBox);
      const price = Number(priceIn.value);
      const cost = costIn.value.trim() === "" ? null : Number(costIn.value);
      const cur = curSel.value;
      const ms = store.MARKETS.filter((m) => targetState[m] && account.connections[m].connected);
      if (!(price > 0) || !ms.length) { netBox.appendChild(el(".small.muted", "Enter a price to see what you'd keep on each marketplace after fees.")); return; }
      if (cur !== fees.currency()) { netBox.appendChild(el(".small.muted", "Fees are only calculated for " + fees.currency() + " (your region in Settings).")); return; }
      netBox.appendChild(el(".small.muted", "What you'd keep (" + fees.region() + " fees — edit in Settings)"));
      ms.forEach((m) => {
        const c = connectors.byId(m);
        const r = fees.calc(m, price, { cost: cost !== null && cost >= 0 ? cost : null });
        netBox.appendChild(el(".net-row", [
          el("span.mkt-dot", { style: { background: c.color } }),
          el("span.grow", c.label),
          el("span.small.muted", "fee " + moneyAuto(r.fee, cur)),
          el("strong", moneyAuto(r.net, cur)),
          r.profit != null ? el("span.small", { style: { color: r.profit >= 0 ? "var(--success)" : "var(--danger)", minWidth: "56px", textAlign: "right" } }, signed(r.profit, cur)) : null,
        ]));
      });
    }
    [priceIn, costIn].forEach((i) => i.addEventListener("input", drawNet));
    curSel.addEventListener("change", drawNet);
    drawNet();

    let publishBtn = null, draftBtn = null;
    const submit = guard(() => [publishBtn, draftBtn], async (post) => {
      const title = titleIn.value.trim();
      const price = Number(priceIn.value);
      const costRaw = costIn.value.trim();
      const cost = costRaw === "" ? null : Number(costRaw);
      if (!title) { toast("Title required", "Give your item a title.", "warn"); titleIn.focus(); return; }
      if (!(price > 0)) { toast("Price required", "Set a price greater than 0.", "warn"); priceIn.focus(); return; }
      if (cost !== null && !(cost >= 0)) { toast("Check the cost", "Cost can't be negative — leave it empty if you don't know it.", "warn"); costIn.focus(); return; }
      const targets = store.MARKETS.filter((m) => targetState[m] && account.connections[m].connected);
      if (post && !targets.length) { toast("No marketplace selected", "Enable a connected marketplace, or save as draft.", "warn"); return; }

      const listings = {};
      store.MARKETS.forEach((m) => {
        if (!targets.includes(m)) listings[m] = { status: "skipped", message: "Not targeted" };
        else if (post) listings[m] = { status: "pending", message: "Queued…", listedAt: Date.now() };
        else listings[m] = { status: "draft", message: "Draft - not posted", listedAt: Date.now() };
      });
      const product = store.addProduct({
        title, brand: brandIn.value.trim(), category: catSel.value, condition: condSel.value,
        size: sizeIn.value.trim(), color: colorIn.value.trim(), description: descIn.value.trim(),
        price, currency: curSel.value, cost, photos: photos.slice(), listings,
      });
      if (!post) {
        if (store.saveFailed()) toast("Draft kept in this tab only", "Storage is full, so it isn't saved yet — see the red banner.", "warn");
        else toast("Saved as draft", "Listing saved without posting.", "ok");
        go("#/"); return;
      }

      let publishTargets = targets.slice();
      if (publishTargets.indexOf("ebay") !== -1) {
        const ok = await ensureEbayReady(product);
        if (!ok) { store.setListing(product.id, "ebay", { status: "skipped", message: "Skipped - item specifics not provided" }); publishTargets = publishTargets.filter((m) => m !== "ebay"); }
      }
      go("#/");
      if (!publishTargets.length) { refreshDashboard(); toast("Nothing published", "eBay needed item specifics and no other marketplace was selected.", "warn"); return; }
      const { node, promise } = runPublishUI(product, publishTargets);
      let open = true;
      modal({
        title: "Publishing to " + publishTargets.length + " marketplace" + (publishTargets.length > 1 ? "s" : ""),
        body: el(".stack", [el(".small.muted", "Posting " + title + ". You can close this - it keeps running."), node]),
        actions: [{ label: "Done", kind: "primary" }],
        onClose: () => { open = false; refreshDashboard(); },
      });
      promise.then((r) => { summarize(r, "Publish"); if (!open) refreshDashboard(); });
    });
    publishBtn = el("button.btn.primary.lg.block", { onClick: () => submit(true) }, "🚀 Publish to selected");
    draftBtn = el("button.btn.ghost.block", { style: { marginTop: "10px" }, onClick: () => submit(false) }, "Save as draft");

    root.appendChild(el(".page-head", [el("div", [el("h2", "List a new item"), el("p", "Fill it in once — OmniList pushes it to every marketplace you select.")])]));
    root.appendChild(el(".grid.cols-2", [
      el(".stack", [
        el(".card", [el("div", { style: { fontWeight: "650", marginBottom: "12px" } }, "Photos"), photoGrid, fileInput, el(".hint", "First photo is the cover. Images are auto-resized to save space.")]),
        el(".card", [
          el("div", { style: { fontWeight: "650", marginBottom: "12px" } }, "Details"),
          el("label.field", [el("span.lab", "Title *"), titleIn]),
          el(".form-grid", { style: { marginTop: "12px" } }, [
            el("label.field", [el("span.lab", "Brand"), brandIn]),
            el("label.field", [el("span.lab", "Category"), catSel]),
          ]),
          el(".form-grid", { style: { marginTop: "12px" } }, [
            el("label.field", [el("span.lab", "Condition"), condSel]),
            el("label.field", [el("span.lab", "Size"), sizeIn]),
          ]),
          el(".form-grid", { style: { marginTop: "12px" } }, [
            el("label.field", [el("span.lab", "Color"), colorIn]),
            el("label.field", [el("span.lab", "Price *"), el(".row", { style: { gap: "8px" } }, [priceIn, curSel])]),
          ]),
          el("label.field", { style: { marginTop: "12px" } }, [el("span.lab", "Cost — what you paid (for profit tracking)"), costIn]),
          el("label.field", { style: { marginTop: "12px" } }, [el("span.lab", "Description"), descIn]),
        ]),
      ]),
      el(".stack", [
        el(".card", [
          el("div", { style: { fontWeight: "650", marginBottom: "12px" } }, "Post to"),
          el(".stack", targetRows),
          el(".note.warn", { style: { marginTop: "12px" } }, [el("span.ni", "⚠️"), el("span", "OmniList never automates a marketplace. eBay posts through its official API when you run the desktop version with your eBay keys; everywhere else (and eBay on this site) it prepares a ready-to-post listing you finish in one tap.")]),
        ]),
        el(".card", [el("div", { style: { fontWeight: "650", marginBottom: "10px" } }, "Your take"), netBox]),
        el(".card", [
          publishBtn,
          draftBtn,
          el(".hint", { style: { marginTop: "10px" } }, "Re-push or fix individual marketplaces anytime from the listing's Details."),
        ]),
      ]),
    ]));
    setTimeout(() => titleIn.focus(), 30);
    return root;
  }

  /* ============================ APPRAISE / SCAN ============================ */
  function appraise() {
    const root = el(".view");
    let stream = null, captured = null;

    const stage = el(".cam-stage");
    const video = el("video", { autoplay: true, playsinline: true });
    video.muted = true;
    const camBtns = el(".row.wrap", { style: { marginTop: "12px" } });

    function showEmpty() {
      App.ui.clear(stage);
      stage.appendChild(el(".cam-empty", [
        el("div", { style: { fontSize: "34px" } }, "📷"),
        el("div", "Point your camera at the item, or upload a photo"),
        el("div.small.muted", "The camera needs https (the live site) or localhost."),
      ]));
    }
    function showCaptured(src) { App.ui.clear(stage); stage.appendChild(el("img", { src })); }
    function stopCamera() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
    function storageFull() {
      if (!store.saveFailed()) return false;
      toast("Storage is full", "Free up space (delete items/photos or download a backup) before adding photos.", "err");
      return true;
    }
    async function startCamera() {
      if (storageFull()) return;
      captured = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        App.ui.clear(stage);
        stage.appendChild(video); video.srcObject = stream; await video.play();
        stage.appendChild(el(".scan-frame")); stage.appendChild(el(".scan-line"));
        setCamButtons("live");
      } catch (e) {
        toast("Camera unavailable", e && e.name === "NotAllowedError" ? "Permission denied — use Upload." : "Use Upload instead.", "warn");
        showEmpty(); setCamButtons("idle");
      }
    }
    function capture() {
      if (!stream) return;
      const c = document.createElement("canvas");
      c.width = video.videoWidth || 1024; c.height = video.videoHeight || 768;
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      resizeImage(c.toDataURL("image/jpeg", 0.85), 1024, 0.78).then((small) => { captured = small; stopCamera(); showCaptured(small); setCamButtons("captured"); });
    }
    async function onUpload(file) {
      if (storageFull()) return;
      const small = await resizeImage(await fileToDataURL(file), 1024, 0.78);
      captured = small; stopCamera(); showCaptured(small); setCamButtons("captured");
    }
    function setCamButtons(mode) {
      App.ui.clear(camBtns);
      const uploadInput = el("input", { type: "file", accept: "image/*", capture: "environment", style: { display: "none" }, onchange: (e) => { if (e.target.files[0]) onUpload(e.target.files[0]); } });
      if (mode === "live") {
        camBtns.appendChild(el("button.btn.primary", { onClick: capture }, "◉ Capture"));
        camBtns.appendChild(el("button.btn.ghost", { onClick: () => { stopCamera(); showEmpty(); setCamButtons("idle"); } }, "Stop"));
      } else if (mode === "captured") {
        camBtns.appendChild(el("button.btn.ghost", { onClick: startCamera }, "↻ Retake"));
      } else {
        camBtns.appendChild(el("button.btn.primary", { onClick: startCamera }, "▶ Start camera"));
      }
      camBtns.appendChild(el("button.btn", { onClick: () => uploadInput.click() }, "⬆ Upload photo"));
      camBtns.appendChild(uploadInput);
    }
    showEmpty(); setCamButtons("idle");
    App.views.cleanup = stopCamera;

    const qIn = el("input", { type: "text", placeholder: "e.g., Nike Air Max 90 white size 10" });
    const bIn = el("input", { type: "text", placeholder: "e.g., Nike" });
    const catSel = selectEl(CATEGORIES, "Shoes");
    const condSel = selectEl(CONDITIONS, "Good");
    const shopIn = el("input", { type: "number", min: "0", step: "0.01", placeholder: "e.g. 8 — leave blank to skip the Buy/Pass call" });
    const resultArea = el("div");
    const historyArea = el("div");
    let appraiseBtn = null;

    const runAppraise = guard(() => [appraiseBtn], async () => {
      const query = qIn.value.trim();
      if (!query) { toast("Add a description", "Tell the app what the item is.", "warn"); qIn.focus(); return; }
      const shopRaw = shopIn.value.trim();
      const shopPrice = shopRaw === "" ? null : Number(shopRaw);
      if (shopPrice !== null && !(shopPrice >= 0)) { toast("Check the shop price", "It can't be negative — leave it empty to skip the Buy/Pass call.", "warn"); shopIn.focus(); return; }
      const input = { query, brand: bIn.value.trim(), category: catSel.value, condition: condSel.value, shopPrice };
      App.ui.clear(resultArea);
      resultArea.appendChild(el(".card", el(".row", [el(".spinner"), el("div", [el("div", { style: { fontWeight: "600" } }, "Appraising…"), el(".small.muted", "Looking for comparable listings")])])));
      const result = await App.appraisal.appraise(input);
      App.ui.clear(resultArea);
      resultArea.appendChild(renderAppraisalResult(input, result, captured));
      store.addAppraisal({ query: input.query, brand: input.brand, category: input.category, condition: input.condition, shopPrice, image: captured, result });
      renderHistory();
    });
    appraiseBtn = el("button.btn.primary.lg.block", { style: { marginTop: "16px" }, onClick: () => runAppraise() }, "🔎 Appraise value");

    function renderHistory() {
      App.ui.clear(historyArea);
      const aprs = store.appraisals();
      if (!aprs.length) return;
      historyArea.appendChild(el("h3", { style: { margin: "20px 0 10px" } }, "Recent appraisals"));
      historyArea.appendChild(el(".card", { style: { padding: "4px 0" } }, aprs.slice(0, 8).map((a) => el(".comp", { style: { cursor: "pointer" }, onClick: () => {
        App.ui.clear(resultArea);
        resultArea.appendChild(renderAppraisalResult({ query: a.query, brand: a.brand, category: a.category, condition: a.condition, shopPrice: a.shopPrice == null ? null : a.shopPrice }, a.result, a.image));
        window.scrollTo({ top: 0, behavior: "smooth" });
      } }, [
        el(".photo-tile", { style: { width: "42px", height: "42px", flex: "none", backgroundImage: a.image ? "url(" + a.image + ")" : "none" } }),
        el(".c-title", [el("div.t", App.ui.composeTitle(a.brand, a.query)), el("div.s", timeAgo(a.createdAt) + historyTag(a.result))]),
        el("div.c-price", money(a.result.aggregate.median, a.result.currency)),
      ]))));
    }

    root.appendChild(el(".page-head", [el("div", [el("h2", "Scan & appraise"), el("p", "Check what similar items are listed for before you buy or list.")])]));
    const ebayStatusChip = el("div", { style: { marginBottom: "12px" } }, el("span.small.muted", "Checking for live price data…"));
    App.backend.status().then((st) => {
      App.ui.clear(ebayStatusChip);
      if (st && st.ok && st.ebay && st.ebay.configured) ebayStatusChip.appendChild(el("span.badge.ok", "🟢 Live eBay prices — " + st.ebay.environment + " (" + st.ebay.marketplace + ")"));
      else if (st && st.ok) ebayStatusChip.appendChild(el("span.badge.auto", "Demo mode — add your eBay keys (EBAY_SETUP.md) for live prices."));
      else ebayStatusChip.appendChild(el("span.badge", "Demo mode — live prices need the desktop version (start.bat) with your eBay keys."));
    });
    root.appendChild(ebayStatusChip);
    root.appendChild(el(".grid.cols-2", [
      el(".card", [el("div", { style: { fontWeight: "650", marginBottom: "10px" } }, "1 · Capture the item"), stage, camBtns]),
      el(".card", [
        el("div", { style: { fontWeight: "650", marginBottom: "10px" } }, "2 · Describe it"),
        el("label.field", [el("span.lab", "What is it? *"), qIn]),
        el(".form-grid", { style: { marginTop: "12px" } }, [el("label.field", [el("span.lab", "Brand"), bIn]), el("label.field", [el("span.lab", "Category"), catSel])]),
        el(".form-grid", { style: { marginTop: "12px" } }, [
          el("label.field", [el("span.lab", "Condition"), condSel]),
          el("label.field", [el("span.lab", "Shop price (" + fees.currency() + ")"), shopIn]),
        ]),
        appraiseBtn,
      ]),
    ]));
    root.appendChild(el("div", { style: { marginTop: "18px" } }, resultArea));
    root.appendChild(historyArea);
    renderHistory();
    return root;
  }

  // Older saved appraisals have no mode; they were never live-only, so treat as demo.
  function isLive(result) { return !!result && result.mode === "live"; }
  function historyTag(result) { return isLive(result) && result.verdict ? " · " + result.verdict.call : isLive(result) ? "" : " · demo"; }

  function renderComps(result) {
    const wrap = el("div");
    const tabsBar = el(".tabs");
    const body = el(".card", { style: { padding: "4px 0" } });
    let active = result.sources[0].id;
    function draw() {
      App.ui.clear(tabsBar); App.ui.clear(body);
      result.sources.forEach((s) => tabsBar.appendChild(el(".tab" + (s.id === active ? ".active" : ""), { onClick: () => { active = s.id; draw(); } }, [
        el("span", s.label + " (" + s.stats.count + ")"),
        s.live ? el("span.badge.ok", { style: { marginLeft: "6px", padding: "1px 6px" } }, "LIVE") : null,
      ])));
      const src = result.sources.find((s) => s.id === active);
      src.comps.forEach((cmp) => {
        const href = safeUrl(cmp.url);
        body.appendChild(el(".comp", [
          el(".c-title", [el("div.t", cmp.title), el("div.s", cmp.when)]),
          el("div.c-price", moneyAuto(cmp.price, result.currency)),
          href ? el("a.btn.sm.ghost", { href, target: "_blank", rel: "noopener noreferrer" }, "↗") : null,
        ]));
      });
      body.appendChild(el(".comp", { style: { background: "var(--bg-2)" } }, [
        el(".c-title", el("div.t", { style: { color: "var(--muted)" } }, src.label + " range")),
        el("div.c-price", { style: { color: "var(--muted)" } }, moneyAuto(src.stats.low, result.currency) + " – " + moneyAuto(src.stats.high, result.currency)),
      ]));
    }
    draw();
    wrap.appendChild(tabsBar); wrap.appendChild(body);
    return wrap;
  }

  function appraisalBanner(result) {
    if (isLive(result)) {
      return el(".note.info", [el("span.ni", "🟢"), el("span", [
        el("strong", "Live eBay data" + (result.marketplace ? " (" + result.marketplace + ")" : "") + ". "),
        "Every number below comes from " + result.sources[0].stats.count + " current eBay listings — asking prices, not sold prices.",
      ])]);
    }
    const why = result.backendConfigured && result.ebayError ? [el("br"), el("span.muted", "eBay request failed: " + String(result.ebayError))] : [];
    return el(".note.warn", [el("span.ni", "⚠️"), el("span", [
      el("strong", "Demo data — not real prices. "),
      "These numbers are generated from the words you typed, only to show how the screen works. There's no Buy/Pass call in demo mode. Live eBay prices need the desktop version (start.bat) with your eBay keys.",
    ].concat(why))]);
  }

  function verdictCard(v, result) {
    const cur = result.currency;
    const kind = v.call === "BUY" ? "buy" : v.call === "MAYBE" ? "maybe" : "pass";
    const label = v.call === "BUY" ? "✅ BUY" : v.call === "MAYBE" ? "🤔 MAYBE" : "⛔ PASS";
    return el(".verdict.verdict-" + kind, [
      el(".verdict-call", label),
      el(".verdict-score", [el("span.big", String(v.score)), el("span.small.muted", "/100 resale score")]),
      el("ul.verdict-reasons", [
        el("li", "Best on " + v.bestLabel + ": " + signed(v.profit, cur) + " after fees vs. " + moneyAuto(v.cost, cur) + " paid"),
        el("li", "Return on cost: " + (v.roi == null ? "free find" : Math.round(v.roi * 100) + "%")),
        el("li", "Price confidence: " + result.aggregate.confidence + "%"),
      ]),
      el(".small.muted.rule", "Rule: BUY when your best connected marketplace nets ≥ " + moneyAuto(v.min, cur) + " profit, ≥ 50% return and ≥ 50% confidence. MAYBE if it's still profitable. Otherwise PASS. Based on asking prices — not a guarantee."),
    ]);
  }
  function verdictNote(result, input) {
    if (!isLive(result)) return null;
    if (result.verdict) return verdictCard(result.verdict, result);
    if (result.verdictBlocked === "currency") {
      return el(".note.warn", [el("span.ni", "💱"), el("span", [el("strong", "No Buy/Pass call: "), "these eBay prices are in " + result.currency + " but your region uses " + result.regionCurrency + ". Change your region in Settings, or remove marketplaceId from ebay.config.json so eBay follows your region."])]);
    }
    if (result.verdictBlocked === "no_connected") {
      return el(".note.warn", [el("span.ni", "🔗"), el("span", [el("strong", "No Buy/Pass call: "), "connect at least one marketplace you sell on (Marketplaces screen)."])]);
    }
    if (input.shopPrice == null) return el(".note.info", [el("span.ni", "💡"), el("span", [el("strong", "Want a Buy / Pass call? "), "Enter the shop price and appraise again."])]);
    return el(".note.warn", [el("span.ni", "ℹ️"), el("span", "Not enough data for a Buy/Pass call.")]);
  }

  function recCard(pm, input, result) {
    const cur = result.currency;
    const live = isLive(result);
    const best = live && result.verdict && result.verdict.best === pm.id;
    const hasFees = typeof pm.fee === "number" && typeof pm.net === "number";
    return el(".rec-card" + (best ? ".rec-best" : ""), { style: live && pm.connected === false ? { opacity: "0.6" } : null }, [
      el(".row", [
        el("span.mkt-dot", { style: { background: pm.color } }), el("strong", pm.label),
        best ? el("span.badge.ok", { style: { marginLeft: "auto" } }, "Best")
          : live && pm.connected === false ? el("span.badge", { style: { marginLeft: "auto" } }, "Not connected") : null,
      ]),
      el(".price", { style: { margin: "6px 0 4px" } }, money(pm.price, cur)),
      hasFees ? el(".rec-line", [el("span", "Fees"), el("span", "−" + moneyAuto(pm.fee, cur))]) : null,
      hasFees ? el(".rec-line", [el("span", "You keep"), el("strong", moneyAuto(pm.net, cur))]) : null,
      live && typeof pm.profit === "number" ? el(".rec-line", [el("span", "Profit"), el("strong", { style: { color: pm.profit >= 0 ? "var(--success)" : "var(--danger)" } }, signed(pm.profit, cur))]) : null,
      el(".small.muted", { style: { marginTop: "6px" } }, pm.rationale),
    ]);
  }

  function renderAppraisalResult(input, result, image) {
    const a = result.aggregate;
    const live = isLive(result);
    return el(".stack", [
      appraisalBanner(result),
      verdictNote(result, input),
      el(".card.pad-lg", [
        image ? el(".row", { style: { gap: "16px", alignItems: "center" } }, [
          el(".photo-tile", { style: { width: "84px", height: "84px", flex: "none", backgroundImage: "url(" + image + ")" } }),
          valueHero(a, result, live),
        ]) : valueHero(a, result, live),
        live && typeof a.confidence === "number" ? el("div", { style: { marginTop: "14px" } }, [
          el(".row.between.small.muted", [el("span", "Confidence (how tightly the listings agree)"), el("span", a.confidence + "%")]),
          el(".conf-meter", { style: { marginTop: "6px" } }, el(".conf-fill", { style: { width: a.confidence + "%" } })),
        ]) : null,
        el(".row", { style: { marginTop: "16px", justifyContent: "center" } }, el("button.btn.primary", { onClick: () => createListingFromAppraisal(input, result, image) }, "＋ Create listing from this")),
      ]),
      el("div", [
        el("h3", { style: { margin: "4px 0 10px" } }, live ? "Suggested price on each marketplace" : "Demo: how prices would split per marketplace"),
        el(".grid.cols-3", result.perMarketplace.map((pm) => recCard(pm, input, result))),
      ]),
      el("div", [el("h3", { style: { margin: "4px 0 10px" } }, live ? "Comparable eBay listings" : "Demo listings"), renderComps(result)]),
    ]);
  }
  function valueHero(a, result, live) {
    const cur = result.currency;
    return el(".value-hero", { style: { flex: "1" } }, [
      live ? null : el("span.badge.auto", "DEMO EXAMPLE"),
      el(".est", moneyAuto(a.median, cur)),
      el(".range", (live ? "Typical asking price " : "Demo range ") + moneyAuto(a.low, cur) + " – " + moneyAuto(a.high, cur) + "  ·  Quick-sale " + moneyAuto(a.quickSale, cur)),
    ]);
  }
  function createListingFromAppraisal(input, result, image) {
    store.setDraft({
      title: App.ui.composeTitle(input.brand, input.query),
      brand: input.brand || "", category: input.category || "Clothing", condition: input.condition || "Good",
      // Never pre-fill a price from demo numbers.
      price: isLive(result) && result.currency === fees.currency() ? result.aggregate.median : "",
      currency: fees.currency(), cost: input.shopPrice == null ? null : input.shopPrice,
      photos: image ? [image] : [],
    });
    go("#/new");
  }

  /* ============================ MARKETPLACES ============================ */
  function ebayLiveBadge(c) {
    if (c.id !== "ebay") return null;
    const slot = el("span");
    App.backend.status().then((st) => {
      if (st && st.ok && st.ebay && st.ebay.configured) { App.ui.clear(slot); slot.appendChild(el("span.badge.ok", "🟢 Live (" + st.ebay.environment + ")")); }
    });
    return slot;
  }

  // eBay seller OAuth + real-publishing readiness.
  function ebaySellerSection(c) {
    if (c.id !== "ebay") return null;
    const box = el("div", { style: { marginTop: "14px", paddingTop: "14px", borderTop: "1px solid var(--border)" } });
    box.appendChild(el(".small", { style: { fontWeight: "600", marginBottom: "8px" } }, "Live publishing (real eBay listings)"));
    const slot = el("div", el(".row", [el(".spinner"), el(".small.muted", "Checking eBay connection...")]));
    box.appendChild(slot);
    refreshEbaySeller(slot);
    return box;
  }
  async function refreshEbaySeller(slot) {
    App.ui.clear(slot);
    const st = await App.backend.status();
    if (!st || !st.ok) {
      slot.appendChild(el(".small.muted", "Available in the desktop version (start.bat) with your eBay keys. Here, eBay listings are prepared for you to post yourself.")); return;
    }
    const e = st.ebay || {};
    if (!e.configured) { slot.appendChild(el(".note.warn", [el("span.ni", "⚠️"), el("span", "Add your app keys to ebay.config.json first (see EBAY_SETUP.md).")])); return; }
    if (!e.redirectConfigured) { slot.appendChild(el(".note.warn", [el("span.ni", "⚠️"), el("span", "Add your RuName (redirectUri) to ebay.config.json to enable seller login (see EBAY_SETUP.md).")])); return; }
    if (!e.userAuthorized) {
      slot.appendChild(el(".small.muted", { style: { marginBottom: "8px" } }, "Connect your eBay seller account to publish real listings (" + e.environment + ", " + e.marketplace + ")."));
      slot.appendChild(el("button.btn.sm.primary", { onClick: () => connectEbaySeller(slot) }, "Connect eBay seller account"));
      return;
    }
    slot.appendChild(el(".row.between", [
      el("span.badge.ok", "✓ Seller connected (" + e.environment + ", " + e.marketplace + ")"),
      el("button.btn.sm.danger", { onClick: async () => { await App.backend.ebayAuthDisconnect(); refreshEbaySeller(slot); } }, "Disconnect"),
    ]));
    const readiness = el(".small.muted", { style: { marginTop: "8px" } }, "Checking account readiness...");
    slot.appendChild(readiness);
    const acct = await App.backend.ebayAccount();
    App.ui.clear(readiness);
    if (acct && acct.ok) {
      if (acct.ready) { readiness.appendChild(el("span.badge.ok", "✓ Ready to publish")); }
      else {
        readiness.appendChild(el(".note.warn", [el("span.ni", "⚠️"), el("span", "Set these up before publishing: " + acct.missing.join(", ") + ".")]));
        if (acct.missing.some((m) => /location/i.test(m))) {
          readiness.appendChild(el("button.btn.sm", { style: { marginTop: "8px" }, onClick: () => createLocationFlow(slot) }, "＋ Create default location"));
        }
      }
    } else {
      readiness.appendChild(el(".small.muted", "Couldn't check policies: " + ((acct && (acct.message || acct.error)) || "error")));
    }
  }
  async function createLocationFlow(slot) {
    const r = await prompt2("Create inventory location", [
      { name: "country", label: "Country code (US, GB, DE, ...)", value: fees.region() === "UK" ? "GB" : "DE" },
      { name: "postalCode", label: "Postal / ZIP code", placeholder: "e.g., 10115" },
      { name: "city", label: "City (optional)", placeholder: "" },
      { name: "state", label: "State / Province (optional)", placeholder: "" },
    ], "Create");
    if (!r) return;
    if (!r.country || !r.postalCode) { toast("Missing info", "Country and postal code are required.", "warn"); return; }
    const res = await App.backend.ebayCreateLocation(r);
    if (res && res.ok) { toast("Location created", "eBay inventory location is set.", "ok"); refreshEbaySeller(slot); }
    else { toast("Couldn't create location", (res && (res.message || res.error)) || "error", "err"); }
  }
  async function connectEbaySeller(slot) {
    const u = await App.backend.ebayAuthUrl();
    if (!u || !u.ok || !safeUrl(u.url)) { toast("Can't start eBay login", (u && (u.message || u.error)) || "error", "err"); return; }
    App.ui.openSafe(u.url);
    const r = await prompt2("Finish eBay connection",
      [{ name: "redirect", label: "After you sign in and click 'I agree', eBay opens a page. Copy that page's full address from the address bar and paste it here:", type: "textarea" }],
      "Connect");
    if (!r || !r.redirect) return;
    const ex = await App.backend.ebayAuthExchange(r.redirect.trim());
    if (ex && ex.ok) { toast("eBay seller connected", "Live publishing is on.", "ok"); refreshEbaySeller(slot); }
    else { toast("Connection failed", (ex && (ex.message || ex.error)) || "Could not exchange the code.", "err"); }
  }
  function marketplaceCard(c, account) {
    const conn = account.connections[c.id];
    const actions = el("div", { style: { marginTop: "14px" } });
    if (conn.connected) {
      actions.appendChild(el(".row.between", [
        el(".small", [el("span.muted", "Connected as "), el("strong", "@" + (conn.handle || "account"))]),
        el("button.btn.sm.danger", { onClick: async () => {
          if (await confirmDialog("Disconnect " + c.label + "?", "This unlinks " + c.label + " from " + account.name + ".", "Disconnect", "danger")) { store.setConnection(account.id, c.id, { connected: false }); App.app.rerender(); }
        } }, "Disconnect"),
      ]));
    } else {
      actions.appendChild(el("button.btn.sm.primary", { onClick: async () => {
        const r = await prompt2("Connect " + c.label, [{ name: "handle", label: c.label + " username / handle", placeholder: "yourhandle" }], "Connect");
        if (r) { store.setConnection(account.id, c.id, { connected: true, handle: (r.handle || "account").replace(/^@/, ""), since: Date.now() }); toast(c.label + " connected", "Linked to " + account.name, "ok"); App.app.rerender(); }
      } }, "Connect " + c.label));
    }
    const f = fees.feeFor(c.id);
    return el(".card", [
      el(".row.between", [
        el(".row", [el(".mkt-logo", { style: { background: c.color, width: "40px", height: "40px" } }, c.short), el("div", [el("div", { style: { fontWeight: "700", fontSize: "16px" } }, c.label), el(".small.muted", c.audience)])]),
        el(".row", { style: { gap: "8px" } }, [
          c.hasOfficialApi ? el("span.badge.api", "🔌 Official API") : el("span.badge.api", "🙌 1-tap manual"),
          ebayLiveBadge(c),
        ]),
      ]),
      el(".small.muted", { style: { marginTop: "12px" } }, c.apiNote),
      el("div", { style: { marginTop: "10px" } }, el("span.badge", "💸 " + fees.region() + " fee used: " + f.pct + "%" + (f.fixed ? " + " + moneyAuto(f.fixed, fees.currency()) : "") + (f.overridden ? " (edited)" : ""))),
      actions,
      ebaySellerSection(c),
    ]);
  }
  function marketplaces() {
    const root = el(".view");
    const account = store.activeAccount();
    root.appendChild(el(".page-head", [el("div", [el("h2", "Marketplaces"), el("p", "Connect " + account.name + "’s marketplace accounts. Each profile links independently.")])]));
    root.appendChild(el(".note.info", { style: { marginBottom: "16px" } }, [el("span.ni", "ℹ️"), el("span", [el("strong", "How linking works. "), "Connecting tells OmniList you sell there. eBay can publish automatically in the desktop version with your eBay keys; everything else is a one-tap handoff. Fees are editable in Settings."])]));
    root.appendChild(el(".grid.cols-3", connectors.list().map((c) => marketplaceCard(c, account))));
    return root;
  }

  /* ============================ ACCOUNTS ============================ */
  function accountCard(a) {
    const active = a.id === store.getState().activeAccountId;
    const connCount = store.MARKETS.filter((m) => a.connections[m].connected).length;
    const prodCount = store.allProducts().filter((p) => p.accountId === a.id).length;
    return el(".card", { style: active ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" } : null }, [
      el(".row", [
        el(".avatar", { style: { background: App.ui.colorFor(a.name), width: "44px", height: "44px", fontSize: "16px" } }, App.ui.initials(a.name)),
        el("div", [el("div", { style: { fontWeight: "700", fontSize: "16px" } }, a.name), el(".small.muted", connCount + "/" + store.MARKETS.length + " connected · " + prodCount + " listing" + (prodCount === 1 ? "" : "s"))]),
      ]),
      el(".listing-chips", { style: { marginTop: "12px" } }, store.MARKETS.map((m) => {
        const c = connectors.byId(m); const on = a.connections[m].connected;
        return el("span.chip", { style: on ? null : { opacity: "0.55" } }, [el("span.mkt-dot", { style: { background: c.color } }), c.label, el("span.small", { style: { color: on ? "var(--success)" : "var(--muted)" } }, on ? "on" : "off")]);
      })),
      el(".row.wrap", { style: { marginTop: "14px", gap: "8px" } }, [
        active ? el("span.badge.ok", "● Active") : el("button.btn.sm.primary", { onClick: () => App.app.switchAccount(a.id) }, "Switch to"),
        el("button.btn.sm.ghost", { onClick: async () => { const r = await prompt2("Rename account", [{ name: "name", label: "Account name", value: a.name }], "Save"); if (r && r.name) { store.renameAccount(a.id, r.name); App.app.renderChrome(); App.app.rerender(); } } }, "Rename"),
        el("button.btn.sm.danger", { onClick: async () => { if (await confirmDialog("Delete " + a.name + "?", "This removes the profile and its " + prodCount + " listings.", "Delete", "danger")) { store.removeAccount(a.id); App.app.renderChrome(); App.app.rerender(); } } }, "Delete"),
      ]),
    ]);
  }
  function addAccountFlow() {
    prompt2("Add account", [{ name: "name", label: "Account / profile name", placeholder: "e.g., Sneaker Vault" }], "Create").then((r) => {
      if (r && r.name) { store.addAccount(r.name); toast("Account created", "Now connect its marketplaces.", "ok"); App.app.renderChrome(); go("#/marketplaces"); }
    });
  }
  function accounts() {
    const root = el(".view");
    root.appendChild(el(".page-head", [
      el("div", [el("h2", "Accounts"), el("p", "Switch between seller profiles. Each has its own marketplace connections and listings.")]),
      el("button.btn.primary", { onClick: addAccountFlow }, "＋ Add account"),
    ]));
    root.appendChild(el(".note.info", { style: { marginBottom: "16px" } }, [el("span.ni", "👤"), el("span", "Use separate profiles for different stores or personas. The active profile (top-right) is what New Listing and Appraise act on.")]));
    root.appendChild(el(".grid.cols-3", store.accounts().map((a) => accountCard(a))));
    return root;
  }

  window.App.views = {
    newListing, appraise, marketplaces, accounts, cleanup: null,
    _: { CATEGORIES, CONDITIONS, CURRENCIES, REPUSHABLE, go, selectEl, iconFor, statusLabel, statusColorVar, signed, guard, repushTargets, refreshDashboard, statusChip, pendingListing, publishOne, pubRow, runPublishUI, summarize, republish, ensureEbayReady, openHandoff },
  };
})();
