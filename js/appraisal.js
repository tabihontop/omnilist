/* ===========================================================================
   appraisal.js — value estimation engine
   Attaches to window.App.appraisal

   eBay can be LIVE: when serve.ps1 has eBay credentials, the eBay source uses
   real comparable listings from the Browse API (active listings = current
   asking prices; true *sold* prices need eBay's limited-access Marketplace
   Insights API). Depop, Vinted & Google remain simulated (no public APIs).
   If the backend is unreachable/unconfigured, eBay falls back to simulated.
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { hashString, mulberry32 } = App.ui;

  const CONDITION_FACTOR = { "New": 1.0, "Like new": 0.86, "Good": 0.72, "Fair": 0.55, "Poor": 0.4 };
  const VARIANTS = ["", "— VGC", "Size M", "Vintage", "(BNWT)", "Rare", "Bundle", "good condition", "barely worn", "— rare colorway"];

  const SOURCES = [
    { id: "ebay", label: "eBay (demo)", color: "#0064d2", factor: 1.0, sold: true, base: "https://www.ebay.com/itm/" },
    { id: "depop", label: "Depop (demo)", color: "#ff2300", factor: 1.14, sold: false, base: "https://www.depop.com/products/" },
    { id: "vinted", label: "Vinted (demo)", color: "#09a7b0", factor: 0.9, sold: false, base: "https://www.vinted.com/items/" },
    { id: "google", label: "Google Shopping (demo)", color: "#34a853", factor: 1.25, sold: false, base: "https://www.google.com/search?tbm=shop&q=" },
  ];

  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function basePrice(query, brand) {
    const h = hashString((brand || "") + "|" + query);
    let base = 14 + (h % 220);
    const premium = /(nike|levi|sony|carhartt|apple|north face|patagonia|dr martens|new balance|adidas|gucci|prada)/i;
    if (premium.test((brand || "") + " " + query)) base = Math.round(base * 1.4 + 30);
    return base;
  }

  function buildSourceFromComps(id, label, color, live, sold, comps) {
    const sorted = comps.slice().sort((a, b) => a.price - b.price);
    const prices = sorted.map((c) => c.price);
    return {
      id, label, color, live: !!live, sold: !!sold, comps: sorted,
      stats: { count: sorted.length, low: prices.length ? Math.min(...prices) : 0, median: Math.round(median(prices)), high: prices.length ? Math.max(...prices) : 0 },
    };
  }

  // Simulated comps for all four sources (stable per query via seeded RNG).
  function gather(input) {
    const { query, brand, condition } = input;
    const rng = mulberry32(hashString("apr|" + (brand || "") + "|" + query + "|" + (condition || "")));
    const cf = CONDITION_FACTOR[condition] || 0.72;
    const base = basePrice(query, brand) * cf;
    const title = App.ui.composeTitle(brand, query);

    return SOURCES.map((src) => {
      const n = 4 + Math.floor(rng() * 4);
      const comps = [];
      for (let i = 0; i < n; i++) {
        const noise = 0.78 + rng() * 0.5;
        const price = Math.max(5, Math.round(base * src.factor * noise));
        const v = VARIANTS[Math.floor(rng() * VARIANTS.length)];
        const daysAgo = 1 + Math.floor(rng() * 40);
        comps.push({
          title: (title + " " + v).trim(),
          price,
          when: src.sold ? "Sold " + daysAgo + "d ago" : "Active",
          url: src.base + (src.id === "google" ? encodeURIComponent(title) : App.ui.slugify(title) + "-" + Math.floor(rng() * 99999)),
        });
      }
      return buildSourceFromComps(src.id, src.label, src.color, false, src.sold, comps);
    });
  }

  // Try to replace the eBay source with real Browse API data.
  async function tryLiveEbay(input, sources, out) {
    try {
      const st = await App.backend.status();
      out.backendConfigured = !!(st && st.ebay && st.ebay.configured);
      out.environment = st && st.ebay && st.ebay.environment;
      if (!out.backendConfigured) return;
      const res = await App.backend.ebaySearch(App.ui.composeTitle(input.brand, input.query), 8);
      if (res && res.ok && res.items && res.items.length) {
        const comps = res.items
          .filter((it) => it.price > 0)
          .map((it) => ({ title: it.title || "eBay listing", price: Math.round(it.price), when: it.condition || "Active listing", url: it.url || "#" }));
        if (comps.length) {
          const idx = sources.findIndex((s) => s.id === "ebay");
          sources[idx] = buildSourceFromComps("ebay", "eBay — active listings", "#0064d2", true, false, comps);
          out.ebayLive = true;
          out.currency = (res.items[0] && res.items[0].currency) || "USD";
        }
      } else if (res && !res.ok) {
        out.ebayError = res.message || res.error;
      }
    } catch (e) {
      out.ebayError = String(e && e.message || e);
    }
  }

  async function appraise(input) {
    const started = Date.now();
    const sources = gather(input);
    const out = { ebayLive: false, ebayError: null, backendConfigured: false, environment: null, currency: App.fees.currency() };

    await tryLiveEbay(input, sources, out);

    // Keep the spinner visible for at least a beat for a smooth feel.
    const minDelay = 650, elapsed = Date.now() - started;
    if (elapsed < minDelay) await new Promise((r) => setTimeout(r, minDelay - elapsed));

    const allPrices = sources.flatMap((s) => s.comps.map((c) => c.price));
    const med = Math.round(median(allPrices));
    const low = allPrices.length ? Math.min(...allPrices) : 0;
    const high = allPrices.length ? Math.max(...allPrices) : 0;
    const spread = high > 0 ? (high - low) / high : 1;
    const count = allPrices.length;
    const confidence = Math.round(Math.min(95, Math.max(35, 100 - spread * 70 + (count - 16) * 1.5)));

    const perMarketplace = App.connectors.list().map((c) => {
      const price = Math.max(5, Math.round((med * c.priceFactor) / 5) * 5 - 1);
      let rationale;
      if (c.id === "ebay") rationale = "Broadest market — price near the median for a steady sale.";
      else if (c.id === "depop") rationale = "Fashion buyers pay a premium; price above median.";
      else if (c.id === "vinted") rationale = "Value-driven EU buyers; price below median for fast turnover.";
      else if (c.id === "facebook") rationale = "Local buyers, no fees on pickup — price for a quick local sale.";
      else if (c.id === "sellpy") rationale = "Consignment (they sell for you) — expect less after commission.";
      else rationale = "Price near the median.";
      const money = App.fees.calc(c.id, price, { cost: input.shopPrice });
      return { id: c.id, label: c.label, color: c.color, price, rationale, feeNote: c.feeNote, fee: money.fee, net: money.net, profit: money.profit };
    });
    const quickSale = Math.max(5, Math.round(med * 0.88));

    return {
      currency: out.currency,
      ebayLive: out.ebayLive,
      ebayError: out.ebayError,
      backendConfigured: out.backendConfigured,
      environment: out.environment,
      aggregate: { low, median: med, high, quickSale, confidence },
      sources,
      perMarketplace,
      verdict: verdictFor(perMarketplace, confidence, input.shopPrice),
    };
  }

  /* ---------- Buy / Maybe / Pass ----------
     BUY   when the best marketplace nets at least MIN_PROFIT after fees,
           returns ≥ 50% on what you pay, and price confidence is ≥ 50%.
     MAYBE when it's still profitable but misses one of those bars.
     PASS  when you'd make nothing or lose money.
     Score (1–100) = 70% return-on-cost (capped at 200%) + 30% confidence. */
  const MIN_PROFIT = 5;
  function verdictFor(perMarketplace, confidence, shopPrice) {
    if (shopPrice == null || shopPrice === "" || isNaN(Number(shopPrice))) return null;
    const cost = Number(shopPrice);
    const best = perMarketplace.slice().sort((a, b) => b.profit - a.profit)[0];
    const profit = best.profit;
    const roi = cost > 0 ? profit / cost : null; // null = free find
    const roiOk = roi == null ? profit > 0 : roi >= 0.5;
    let call;
    if (profit >= MIN_PROFIT && roiOk && confidence >= 50) call = "BUY";
    else if (profit > 0) call = "MAYBE";
    else call = "PASS";
    const roiPart = roi == null ? (profit > 0 ? 1 : 0) : Math.max(0, Math.min(1, roi / 2));
    const score = Math.max(1, Math.min(100, Math.round(roiPart * 70 + (confidence / 100) * 30 - (profit <= 0 ? 30 : 0))));
    return { call, score, best: best.id, bestLabel: best.label, profit, roi, min: MIN_PROFIT, cost };
  }

  window.App.appraisal = { appraise, verdictFor, CONDITION_FACTOR };
})();
