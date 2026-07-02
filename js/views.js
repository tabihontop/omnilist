/* ===========================================================================
   views.js — all screen renderers + shared components
   Attaches to window.App.views (each fn returns a DOM node)
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { el, money, fmtDate, timeAgo, toast, modal, confirmDialog, prompt2, fileToDataURL, resizeImage } = App.ui;
  const store = App.store;
  const connectors = App.connectors;

  const CATEGORIES = ["Clothing", "Shoes", "Accessories", "Bags", "Electronics", "Home", "Toys & Games", "Books", "Beauty", "Other"];
  const CONDITIONS = ["New", "Like new", "Good", "Fair", "Poor"];
  const CURRENCIES = ["USD", "EUR", "GBP"];

  function go(route) { location.hash = route; }
  function selectEl(options, value) {
    const s = el("select", options.map((o) => el("option", { value: o, selected: o === value }, o)));
    s.value = value;
    return s;
  }
  function iconFor(cat) {
    return ({ Clothing: "🧥", Shoes: "👟", Accessories: "⌚", Bags: "👜", Electronics: "🎧", Home: "🏠", "Toys & Games": "🎮", Books: "📚", Beauty: "💄" }[cat]) || "📦";
  }
  function statusLabel(s) { return ({ live: "Live", ready: "Ready to post", pending: "Pending", error: "Failed", skipped: "Not posted", draft: "Draft" }[s]) || s; }
  function statusColorVar(s) { return ({ live: "var(--success)", ready: "#4dabf7", pending: "var(--warn)", error: "var(--danger)" }[s]) || "var(--muted)"; }

  /* ---------- shared: marketplace status chip ---------- */
  function statusChip(marketId, lst, product) {
    const c = connectors.byId(marketId);
    const s = (lst && lst.status) || "skipped";
    const clickable = product && s === "ready" && connectors.byId(marketId).handoff;
    return el("span.chip", {
      title: clickable ? ("Tap to post on " + c.label) : ((lst && lst.message) || statusLabel(s)),
      style: clickable ? { cursor: "pointer" } : null,
      onClick: clickable ? () => openHandoff(product, marketId) : null,
    }, [
      el("span.mkt-dot", { style: { background: c.color } }),
      el("span", { style: { fontWeight: "600" } }, c.label),
      el("span.small", { style: { color: statusColorVar(s) } }, clickable ? "Post now ↗" : statusLabel(s)),
    ]);
  }

  /* ---------- shared: publish engine ---------- */
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
          right.appendChild(el("span.badge.ok", "✓ Live"));
          App.ui.clear(msgEl);
          msgEl.appendChild(document.createTextNode((res.message || "Published") + " · "));
          msgEl.appendChild(el("a", { href: res.url || "#", target: "_blank", rel: "noopener" }, "View ↗"));
        } else if (res.status === "pending") {
          right.appendChild(el("span.badge.warn", "Pending"));
          api.setMsg(res.message || "Pending");
        } else if (res.status === "ready") {
          right.appendChild(el("button.btn.sm.primary", { onClick: () => openHandoff(product, market) }, "Post on " + connectors.byId(market).label + " ↗"));
          api.setMsg(res.message || "Ready to post");
        } else if (res.status === "error") {
          right.appendChild(el("button.btn.sm", { onClick: () => repost("↻ Retrying…") }, "↻ Retry"));
          api.setMsg(res.message || "Failed");
          right.insertBefore(el("span.badge.err", "Failed"), right.firstChild);
        } else {
          right.appendChild(el("button.btn.sm", { onClick: () => repost("Posting…") }, "Post"));
          api.setMsg(statusLabel(res.status));
        }
      },
    };
    function repost(msg) {
      App.ui.clear(right);
      right.appendChild(el(".spinner"));
      api.setMsg(msg);
      store.setListing(product.id, market, { status: "pending", message: "Queued…", listedAt: Date.now() });
      publishOne(product, market, api.setMsg).then((r) => api.setResult(r));
    }
    return api;
  }

  function runPublishUI(product, marketIds) {
    const rows = marketIds.map((m) => pubRow(m, product));
    const container = el(".stack", rows.map((r) => r.node));
    const promise = Promise.all(marketIds.map((m, i) => {
      store.setListing(product.id, m, { status: "pending", message: "Queued…", listedAt: Date.now() });
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

  async function republish(p) {
    let targets = store.MARKETS.filter((m) => p.listings[m] && p.listings[m].status !== "skipped");
    if (!targets.length) { toast("Nothing to re-push", "This item isn't targeting any marketplace.", "warn"); return; }
    if (targets.indexOf("ebay") !== -1) {
      const ok = await ensureEbayReady(p);
      if (!ok) { store.setListing(p.id, "ebay", { status: "skipped", message: "Skipped - item specifics not provided" }); targets = targets.filter((m) => m !== "ebay"); }
    }
    if (!targets.length) { App.app.rerender(); return; }
    const { node, promise } = runPublishUI(p, targets);
    modal({ title: "Re-pushing " + p.title, body: node, actions: [{ label: "Done", kind: "primary", onClick: (c) => { c(); App.app.rerender(); } }] });
    promise.then((r) => summarize(r, "Re-push"));
  }

  // For eBay live publishing: resolve category + collect any required item specifics.
  // Returns true to proceed, false if the user skipped eBay.
  async function ensureEbayReady(product) {
    let st;
    try { st = await App.backend.status(); } catch (e) { return true; }
    if (!(st && st.ebay && st.ebay.configured && st.ebay.userAuthorized)) return true; // simulated mode
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

  /* ---------- shared: listing card + detail ---------- */
  function listingCard(p) {
    const thumb = el(".listing-thumb");
    if (p.photos && p.photos[0]) thumb.style.backgroundImage = "url(" + p.photos[0] + ")";
    else thumb.appendChild(el(".ph", iconFor(p.category)));
    thumb.appendChild(el(".listing-price", money(p.price, p.currency)));
    return el(".listing-card", [
      thumb,
      el(".listing-body", [
        el(".listing-title", p.title),
        el(".listing-sub", [p.brand, p.condition, p.size].filter(Boolean).join(" · ") || "—"),
        el(".listing-chips", store.MARKETS.map((m) => statusChip(m, p.listings && p.listings[m], p))),
        el(".listing-acts", [
          el("button.btn.sm.ghost", { onClick: () => openListingDetail(p) }, "Details"),
          el("button.btn.sm.ghost", { onClick: () => republish(p) }, "↻ Re-push"),
          el("button.btn.sm.ghost", { style: { marginLeft: "auto" }, onClick: async () => {
            if (await confirmDialog("Delete listing?", "“" + p.title + "” will be removed.", "Delete", "danger")) { store.removeProduct(p.id); App.app.rerender(); }
          } }, "🗑"),
        ]),
      ]),
    ]);
  }

  function openListingDetail(p) {
    const rows = store.MARKETS.map((m) => { const api = pubRow(m, p); api.setResult((p.listings && p.listings[m]) || { status: "draft" }); return api.node; });
    const body = el(".stack", [
      (p.photos && p.photos.length) ? el(".photo-grid", p.photos.map((src) => el(".photo-tile", { style: { backgroundImage: "url(" + src + ")" } }))) : null,
      el("div", [el("div", { style: { fontWeight: "700", fontSize: "16px" } }, p.title), el(".small.muted", [p.brand, p.condition, p.size, p.color].filter(Boolean).join(" · ") || "—")]),
      el(".row.between", [el("div", { style: { fontWeight: "750", fontSize: "20px" } }, money(p.price, p.currency)), el(".small.muted", "Created " + fmtDate(p.createdAt))]),
      p.description ? el(".small.muted", p.description) : null,
      el("div", { style: { fontWeight: "650", marginTop: "4px" } }, "Marketplace status"),
      el(".stack", rows),
    ]);
    modal({ title: "Listing details", body, actions: [{ label: "Close" }], onClose: () => App.app.rerender() });
  }

  /* ---------- Vinted: one-tap manual handoff (no automation) ---------- */
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
  function openHandoff(product, marketId) {
    const c = connectors.byId(marketId);
    const fields = [
      ["Title", product.title], ["Price", App.ui.money(product.price, product.currency)],
      ["Brand", product.brand], ["Size", product.size], ["Color", product.color],
      ["Condition", product.condition], ["Description", product.description],
    ].filter((f) => f[1]);
    const copyAll = fields.map((f) => f[0] + ": " + f[1]).join("\n");
    const photos = product.photos || [];
    const body = el(".stack", [
      el(".note.info", [el("span.ni", "ℹ️"), el("span", [el("strong", c.label + " has no public API"), ", so OmniList won't auto-post it (that breaks their rules). Open " + c.label + ", drop in these details + photos, and tap post."])]),
      c.sellNote ? el(".small.muted", c.sellNote) : null,
      el("button.btn.primary.block", { onClick: () => window.open(c.sellUrl || "#", "_blank", "noopener") }, "Open " + c.label + " new listing ↗"),
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
          const r = await prompt2("Mark " + c.label + " as posted", [{ name: "url", label: c.label + " listing URL (optional)", placeholder: "https://..." }], "Save");
          store.setListing(product.id, marketId, { status: "live", message: "Posted manually on " + c.label, url: (r && r.url) || (c.sellUrl || "#"), listedAt: Date.now() });
          App.app.rerender();
          toast("Marked as posted", c.label + " listing set to live.", "ok");
        } },
        { label: "Close" },
      ],
    });
  }

  /* ============================ DASHBOARD ============================ */
  function statCard(icon, label, value, delta) {
    return el(".stat", [el(".label", [el("span", icon), label]), el(".value", String(value)), delta ? el(".delta", delta) : null]);
  }
  function dashboard() {
    const root = el(".view");
    const account = store.activeAccount();
    const ps = store.products();
    const livePlacements = ps.reduce((n, p) => n + store.MARKETS.filter((m) => p.listings[m] && p.listings[m].status === "live").length, 0);
    const connected = store.MARKETS.filter((m) => account.connections[m].connected).length;
    const invValue = ps.reduce((n, p) => n + (Number(p.price) || 0), 0);
    const aprs = store.appraisals();

    root.appendChild(el(".page-head", [
      el("div", [el("h2", "Dashboard"), el("p", account.name + " · list once, sell everywhere")]),
      el("button.btn.primary", { onClick: () => go("#/new") }, "＋ New listing"),
    ]));
    root.appendChild(el(".grid.cols-4", [
      statCard("📦", "Active listings", ps.length),
      statCard("🟢", "Live placements", livePlacements, "across " + connected + " marketplace" + (connected === 1 ? "" : "s")),
      statCard("🔗", "Connected", connected + "/" + store.MARKETS.length, "marketplaces"),
      statCard("💰", "Inventory value", money(invValue)),
    ]));

    root.appendChild(el(".page-head", { style: { marginTop: "26px", marginBottom: "12px" } }, [
      el("h3", { style: { margin: "0" } }, "Your listings"),
      ps.length ? el("span.small.muted", ps.length + " item" + (ps.length === 1 ? "" : "s")) : null,
    ]));
    if (!ps.length) {
      root.appendChild(el(".card", el(".empty", [
        el(".big", "🪄"),
        el("h3", "No listings yet"),
        el("p", "Upload a product once and push it to every connected marketplace at the same time."),
        el("button.btn.primary", { style: { marginTop: "12px" }, onClick: () => go("#/new") }, "Create your first listing"),
      ])));
    } else {
      root.appendChild(el(".grid.cols-3", ps.map((p) => listingCard(p))));
    }

    if (aprs.length) {
      root.appendChild(el("h3", { style: { margin: "26px 0 12px" } }, "Recent appraisals"));
      root.appendChild(el(".card", { style: { padding: "4px 0" } }, aprs.slice(0, 5).map((a) => el(".comp", [
        el(".c-title", [el("div.t", App.ui.composeTitle(a.brand, a.query)), el("div.s", timeAgo(a.createdAt))]),
        el("div.c-price", money(a.result.aggregate.median, a.result.currency)),
      ]))));
    }
    return root;
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
    const priceIn = el("input", { type: "number", value: draft.price || "", placeholder: "0", min: "0", step: "1" });
    const curSel = selectEl(CURRENCIES, draft.currency || "USD");
    const descIn = el("textarea", { placeholder: "Condition details, measurements, flaws…" });
    descIn.value = draft.description || "";

    const photoGrid = el(".photo-grid");
    const fileInput = el("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, style: { display: "none" }, onchange: async (e) => { await addPhotos(e.target.files); e.target.value = ""; } });
    async function addPhotos(files) {
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
      const check = el("input", { type: "checkbox", checked: !!conn.connected, disabled: !conn.connected, onchange: (e) => { targetState[m] = e.target.checked; } });
      return el(".mkt-target" + (conn.connected ? "" : ".disabled"), [
        el(".mkt-logo", { style: { background: c.color } }, c.short),
        el(".grow", [
          el(".row", { style: { gap: "8px" } }, [el("span", { style: { fontWeight: "600" } }, c.label), c.hasOfficialApi ? el("span.badge.api", "API") : (c.handoff ? el("span.badge.api", "Manual") : el("span.badge.auto", "Auto"))]),
          el(".small.muted", conn.connected ? "@" + (conn.handle || "connected") : "Not connected"),
        ]),
        conn.connected ? el("label.switch", [check, el("span.slider")]) : el("a.btn.sm", { href: "#/marketplaces" }, "Connect"),
      ]);
    });

    async function submit(post) {
      const title = titleIn.value.trim();
      const price = Number(priceIn.value);
      if (!title) { toast("Title required", "Give your item a title.", "warn"); titleIn.focus(); return; }
      if (!(price > 0)) { toast("Price required", "Set a price greater than 0.", "warn"); priceIn.focus(); return; }
      const targets = store.MARKETS.filter((m) => targetState[m] && account.connections[m].connected);
      if (post && !targets.length) { toast("No marketplace selected", "Enable a connected marketplace, or save as draft.", "warn"); return; }

      const listings = {};
      store.MARKETS.forEach((m) => { listings[m] = targets.includes(m) ? { status: "pending", message: "Queued…", listedAt: Date.now() } : { status: "skipped", message: "Not targeted" }; });
      const product = store.addProduct({
        title, brand: brandIn.value.trim(), category: catSel.value, condition: condSel.value,
        size: sizeIn.value.trim(), color: colorIn.value.trim(), description: descIn.value.trim(),
        price, currency: curSel.value, photos: photos.slice(), listings,
      });
      if (!post) { toast("Saved as draft", "Listing saved without posting.", "ok"); go("#/"); return; }

      let publishTargets = targets.slice();
      if (publishTargets.indexOf("ebay") !== -1) {
        const ok = await ensureEbayReady(product);
        if (!ok) { store.setListing(product.id, "ebay", { status: "skipped", message: "Skipped - item specifics not provided" }); publishTargets = publishTargets.filter((m) => m !== "ebay"); }
      }
      go("#/");
      if (!publishTargets.length) { App.app.rerender(); toast("Nothing published", "eBay needed item specifics and no other marketplace was selected.", "warn"); return; }
      const { node, promise } = runPublishUI(product, publishTargets);
      modal({
        title: "Publishing to " + publishTargets.length + " marketplace" + (publishTargets.length > 1 ? "s" : ""),
        body: el(".stack", [el(".small.muted", "Posting " + title + ". You can close this - it keeps running."), node]),
        actions: [{ label: "Done", kind: "primary", onClick: (c) => { c(); App.app.rerender(); } }],
      });
      promise.then((r) => summarize(r, "Publish"));
    }

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
            el("label.field", [el("span.lab", "Price"), el(".row", { style: { gap: "8px" } }, [priceIn, curSel])]),
          ]),
          el("label.field", { style: { marginTop: "12px" } }, [el("span.lab", "Description"), descIn]),
        ]),
      ]),
      el(".stack", [
        el(".card", [
          el("div", { style: { fontWeight: "650", marginBottom: "12px" } }, "Post to"),
          el(".stack", targetRows),
          el(".note.warn", { style: { marginTop: "12px" } }, [el("span.ni", "⚠️"), el("span", "eBay posts via the official API. The others have no public API, so OmniList prepares ready-to-post listings you finish in one tap — no automation.")]),
        ]),
        el(".card", [
          el("button.btn.primary.lg.block", { onClick: () => submit(true) }, "🚀 Publish to selected"),
          el("button.btn.ghost.block", { style: { marginTop: "10px" }, onClick: () => submit(false) }, "Save as draft"),
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
        el("div.small.muted", "Camera needs a secure origin — run serve.ps1 (localhost)."),
      ]));
    }
    function showCaptured(src) { App.ui.clear(stage); stage.appendChild(el("img", { src })); }
    function stopCamera() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
    async function startCamera() {
      captured = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        App.ui.clear(stage);
        stage.appendChild(video); video.srcObject = stream; await video.play();
        stage.appendChild(el(".scan-frame")); stage.appendChild(el(".scan-line"));
        setCamButtons("live");
      } catch (e) {
        toast("Camera unavailable", e && e.name === "NotAllowedError" ? "Permission denied — use Upload." : "Use Upload, or run serve.ps1.", "warn");
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
    const resultArea = el("div");
    const historyArea = el("div");

    function runAppraise() {
      const query = qIn.value.trim();
      if (!query) { toast("Add a description", "Tell the app what the item is.", "warn"); qIn.focus(); return; }
      const input = { query, brand: bIn.value.trim(), category: catSel.value, condition: condSel.value };
      App.ui.clear(resultArea);
      resultArea.appendChild(el(".card", el(".row", [el(".spinner"), el("div", [el("div", { style: { fontWeight: "600" } }, "Appraising…"), el(".small.muted", "Checking eBay sold, Depop, Vinted & Google Shopping")])])));
      App.appraisal.appraise(input).then((result) => {
        App.ui.clear(resultArea);
        resultArea.appendChild(renderAppraisalResult(input, result, captured));
        store.addAppraisal({ query: input.query, brand: input.brand, category: input.category, condition: input.condition, image: captured, result });
        renderHistory();
      });
    }

    function renderHistory() {
      App.ui.clear(historyArea);
      const aprs = store.appraisals();
      if (!aprs.length) return;
      historyArea.appendChild(el("h3", { style: { margin: "20px 0 10px" } }, "Recent appraisals"));
      historyArea.appendChild(el(".card", { style: { padding: "4px 0" } }, aprs.slice(0, 8).map((a) => el(".comp", { style: { cursor: "pointer" }, onClick: () => {
        App.ui.clear(resultArea);
        resultArea.appendChild(renderAppraisalResult({ query: a.query, brand: a.brand, category: a.category, condition: a.condition }, a.result, a.image));
        window.scrollTo({ top: 0, behavior: "smooth" });
      } }, [
        el(".photo-tile", { style: { width: "42px", height: "42px", flex: "none", backgroundImage: a.image ? "url(" + a.image + ")" : "none" } }),
        el(".c-title", [el("div.t", App.ui.composeTitle(a.brand, a.query)), el("div.s", timeAgo(a.createdAt))]),
        el("div.c-price", money(a.result.aggregate.median, a.result.currency)),
      ]))));
    }

    root.appendChild(el(".page-head", [el("div", [el("h2", "Scan & appraise"), el("p", "Estimate an item's value from eBay, Depop, Vinted & Google before you list.")])]));
    const ebayStatusChip = el("div", { style: { marginBottom: "12px" } }, el("span.small.muted", "Checking eBay connection…"));
    App.backend.status().then((st) => {
      App.ui.clear(ebayStatusChip);
      if (st && st.ebay && st.ebay.configured) ebayStatusChip.appendChild(el("span.badge.ok", "🟢 eBay LIVE — " + st.ebay.environment + " (" + st.ebay.marketplace + ")"));
      else if (st && st.offline) ebayStatusChip.appendChild(el("span.badge", "Backend offline — simulated mode. Launch via serve.ps1 for live eBay."));
      else ebayStatusChip.appendChild(el("span.badge.auto", "eBay not configured — simulated. See EBAY_SETUP.md"));
    });
    root.appendChild(ebayStatusChip);
    root.appendChild(el(".grid.cols-2", [
      el(".card", [el("div", { style: { fontWeight: "650", marginBottom: "10px" } }, "1 · Capture the item"), stage, camBtns]),
      el(".card", [
        el("div", { style: { fontWeight: "650", marginBottom: "10px" } }, "2 · Describe it"),
        el(".note.info", { style: { marginBottom: "12px" } }, [el("span.ni", "💡"), el("span", [el("strong", "Auto-identify: "), "plug a vision model (e.g., Claude) in here to read the photo and fill these in. For now, type what it is."])]),
        el("label.field", [el("span.lab", "What is it? *"), qIn]),
        el(".form-grid", { style: { marginTop: "12px" } }, [el("label.field", [el("span.lab", "Brand"), bIn]), el("label.field", [el("span.lab", "Category"), catSel])]),
        el("label.field", { style: { marginTop: "12px" } }, [el("span.lab", "Condition"), condSel]),
        el("button.btn.primary.lg.block", { style: { marginTop: "16px" }, onClick: runAppraise }, "🔎 Appraise value"),
      ]),
    ]));
    root.appendChild(el("div", { style: { marginTop: "18px" } }, resultArea));
    root.appendChild(historyArea);
    renderHistory();
    return root;
  }

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
      src.comps.forEach((cmp) => body.appendChild(el(".comp", [
        el(".c-title", [el("div.t", cmp.title), el("div.s", cmp.when)]),
        el("div.c-price", money(cmp.price, result.currency)),
        el("a.btn.sm.ghost", { href: cmp.url, target: "_blank", rel: "noopener" }, "↗"),
      ])));
      body.appendChild(el(".comp", { style: { background: "var(--bg-2)" } }, [
        el(".c-title", el("div.t", { style: { color: "var(--muted)" } }, src.label + " range")),
        el("div.c-price", { style: { color: "var(--muted)" } }, money(src.stats.low) + " – " + money(src.stats.high)),
      ]));
    }
    draw();
    wrap.appendChild(tabsBar); wrap.appendChild(body);
    return wrap;
  }

  function appraisalBanner(result) {
    if (result.ebayLive) {
      return el(".note.info", [el("span.ni", "🟢"), el("span", [
        el("strong", "eBay is LIVE" + (result.environment ? " (" + result.environment + ")" : "") + ". "),
        "Real active listings via the Browse API (current asking prices, not sold prices). Depop, Vinted & Google are simulated.",
      ])]);
    }
    if (result.backendConfigured && result.ebayError) {
      return el(".note.warn", [el("span.ni", "⚠️"), el("span", [el("strong", "eBay live request failed — "), "showing simulated eBay. ", el("span.muted", String(result.ebayError))])]);
    }
    return el(".note.warn", [el("span.ni", "⚠️"), el("span", [el("strong", "Simulated data. "), "Connect eBay for live comps (see EBAY_SETUP.md). Depop/Vinted/Google have no public APIs."])]);
  }

  function renderAppraisalResult(input, result, image) {
    const a = result.aggregate;
    return el(".stack", [
      appraisalBanner(result),
      el(".card.pad-lg", [
        image ? el(".row", { style: { gap: "16px", alignItems: "center" } }, [
          el(".photo-tile", { style: { width: "84px", height: "84px", flex: "none", backgroundImage: "url(" + image + ")" } }),
          valueHero(a, result),
        ]) : valueHero(a, result),
        el("div", { style: { marginTop: "14px" } }, [
          el(".row.between.small.muted", [el("span", "Confidence"), el("span", a.confidence + "%")]),
          el(".conf-meter", { style: { marginTop: "6px" } }, el(".conf-fill", { style: { width: a.confidence + "%" } })),
        ]),
        el(".row", { style: { marginTop: "16px", justifyContent: "center" } }, el("button.btn.primary", { onClick: () => createListingFromAppraisal(input, result, image) }, "＋ Create listing from this")),
      ]),
      el("div", [
        el("h3", { style: { margin: "4px 0 10px" } }, "Suggested price per marketplace"),
        el(".grid.cols-3", result.perMarketplace.map((pm) => el(".rec-card", [
          el(".row", [el("span.mkt-dot", { style: { background: pm.color } }), el("strong", pm.label)]),
          el(".price", { style: { margin: "6px 0" } }, money(pm.price, result.currency)),
          el(".small.muted", pm.rationale),
          el(".small.muted", { style: { marginTop: "6px", opacity: "0.8" } }, "Fees: " + pm.feeNote),
        ]))),
      ]),
      el("div", [el("h3", { style: { margin: "4px 0 10px" } }, "Comparable listings"), renderComps(result)]),
    ]);
  }
  function valueHero(a, result) {
    return el(".value-hero", { style: { flex: "1" } }, [
      el(".est", money(a.median, result.currency)),
      el(".range", "Typical range " + money(a.low) + " – " + money(a.high) + "  ·  Quick-sale " + money(a.quickSale)),
    ]);
  }
  function createListingFromAppraisal(input, result, image) {
    store.setDraft({
      title: App.ui.composeTitle(input.brand, input.query),
      brand: input.brand || "", category: input.category || "Clothing", condition: input.condition || "Good",
      price: result.aggregate.median, currency: result.currency, photos: image ? [image] : [],
    });
    go("#/new");
  }

  /* ============================ MARKETPLACES ============================ */
  function ebayLiveBadge(c) {
    if (c.id !== "ebay") return null;
    const slot = el("span");
    App.backend.status().then((st) => {
      if (st && st.ebay && st.ebay.configured) { App.ui.clear(slot); slot.appendChild(el("span.badge.ok", "🟢 Live (" + st.ebay.environment + ")")); }
    });
    return slot;
  }

  // eBay seller OAuth + real-publishing readiness (Phase 2).
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
    if (!st || !st.ok || (st.ebay && st.ebay.offline) || st.offline) {
      slot.appendChild(el(".small.muted", "Open the app via serve.ps1 to enable live publishing.")); return;
    }
    const e = st.ebay || {};
    if (!e.configured) { slot.appendChild(el(".note.warn", [el("span.ni", "⚠️"), el("span", "Add your app keys to ebay.config.json first (see EBAY_SETUP.md).")])); return; }
    if (!e.redirectConfigured) { slot.appendChild(el(".note.warn", [el("span.ni", "⚠️"), el("span", "Add your RuName (redirectUri) to ebay.config.json to enable seller login (see EBAY_SETUP.md).")])); return; }
    if (!e.userAuthorized) {
      slot.appendChild(el(".small.muted", { style: { marginBottom: "8px" } }, "Connect your eBay seller account to publish real listings (" + e.environment + ")."));
      slot.appendChild(el("button.btn.sm.primary", { onClick: () => connectEbaySeller(slot) }, "Connect eBay seller account"));
      return;
    }
    slot.appendChild(el(".row.between", [
      el("span.badge.ok", "✓ Seller connected (" + e.environment + ")"),
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
      { name: "country", label: "Country code (US, GB, DE, ...)", value: "US" },
      { name: "postalCode", label: "Postal / ZIP code", placeholder: "e.g., 95125" },
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
    if (!u || !u.ok) { App.ui.toast("Can't start eBay login", (u && (u.message || u.error)) || "error", "err"); return; }
    window.open(u.url, "_blank", "noopener");
    const r = await prompt2("Finish eBay connection",
      [{ name: "redirect", label: "After you sign in and click 'I agree', eBay opens a page. Copy that page's full URL (it contains a code) and paste it here:", type: "textarea" }],
      "Connect");
    if (!r || !r.redirect) return;
    const ex = await App.backend.ebayAuthExchange(r.redirect.trim());
    if (ex && ex.ok) { App.ui.toast("eBay seller connected", "Live publishing is on.", "ok"); refreshEbaySeller(slot); }
    else { App.ui.toast("Connection failed", (ex && (ex.message || ex.error)) || "Could not exchange the code.", "err"); }
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
        if (!c.hasOfficialApi && !c.handoff) {
          const ok = await confirmDialog("Connect " + c.label + " via automation?", c.label + " has no public API. Live posting uses browser automation, which violates " + c.label + "’s ToS and can get the account banned. Continue (demo)?", "I understand", "danger");
          if (!ok) return;
        }
        const r = await prompt2("Connect " + c.label, [{ name: "handle", label: c.label + " username / handle", placeholder: "yourhandle" }], "Connect");
        if (r) { store.setConnection(account.id, c.id, { connected: true, handle: (r.handle || "account").replace(/^@/, ""), since: Date.now() }); toast(c.label + " connected", "Linked to " + account.name, "ok"); App.app.rerender(); }
      } }, "Connect " + c.label));
    }
    return el(".card", [
      el(".row.between", [
        el(".row", [el(".mkt-logo", { style: { background: c.color, width: "40px", height: "40px" } }, c.short), el("div", [el("div", { style: { fontWeight: "700", fontSize: "16px" } }, c.label), el(".small.muted", c.audience)])]),
        el(".row", { style: { gap: "8px" } }, [
          c.hasOfficialApi ? el("span.badge.api", "🔌 Official API") : (c.handoff ? el("span.badge.api", "🙌 1-tap manual") : el("span.badge.auto", "⚠ Automation only")),
          ebayLiveBadge(c),
        ]),
      ]),
      el(".small.muted", { style: { marginTop: "12px" } }, c.apiNote),
      el("div", { style: { marginTop: "10px" } }, el("span.badge", "💸 " + c.feeNote)),
      actions,
      ebaySellerSection(c),
    ]);
  }
  function marketplaces() {
    const root = el(".view");
    const account = store.activeAccount();
    root.appendChild(el(".page-head", [el("div", [el("h2", "Marketplaces"), el("p", "Connect " + account.name + "’s marketplace accounts. Each profile links independently.")])]));
    root.appendChild(el(".note.info", { style: { marginBottom: "16px" } }, [el("span.ni", "ℹ️"), el("span", [el("strong", "Demo connections. "), "Toggling here simulates linking. Real linking uses OAuth (eBay); the rest are manual one-tap handoffs (no automation)."])]));
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
        el("button.btn.sm.danger", { onClick: async () => { if (await confirmDialog("Delete " + a.name + "?", "This removes the profile and its " + prodCount + " listings (demo only).", "Delete", "danger")) { store.removeAccount(a.id); App.app.renderChrome(); App.app.rerender(); } } }, "Delete"),
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

  window.App.views = { dashboard, newListing, appraise, marketplaces, accounts, cleanup: null };
})();
