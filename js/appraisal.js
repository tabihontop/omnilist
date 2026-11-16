/* ===========================================================================
   appraisal.js — value estimation
   Attaches to window.App.appraisal

   Two modes, never mixed:
   • "live" — the local backend (serve.ps1 + eBay keys) returned real eBay
     listings. Every number (median, range, confidence, per-marketplace prices,
     Buy/Maybe/Pass) is computed from those live listings only. They are
     current ASKING prices, not sold prices.
   • "demo" — no live source. Comparable listings are generated from the text
     you typed purely to show how the screen works. No verdict, score or
     confidence is produced, and the UI labels everything as demo data.
   =========================================================================== */
(function () {
  window.App = window.App || {};
  const { hashString, mulberry32 } = App.ui;
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const CONDITION_FACTOR = { "New": 1.0, "Like new": 0.86, "Good": 0.72, "Fair": 0.55, "Poor": 0.4 };
  const VARIANTS = ["", "— VGC", "Size M", "Vintage", "(BNWT)", "Rare", "Bundle", "good condition", "barely worn", "— rare colorway"];
  const DEMO_SOURCES = [
    { id: "ebay", label: "eBay (demo)", color: "#0064d2", factor: 1.0 },
    { id: "depop", label: "Depop (demo)", color: "#ff2300", factor: 1.14 },
    { id: "vinted", label: "Vinted (demo)", color: "#09a7b0", factor: 0.9 },
    { id: "google", label: "Google Shopping (demo)", color: "#34a853", factor: 1.25 },
  ];

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function median(arr) { return quantile([...arr].sort((a, b) => a - b), 0.5); }

  function buildSourceFromComps(id, label, color, live, comps) {
    const sorted = comps.slice().sort((a, b) => a.price - b.price);
    const prices = sorted.map((c) => c.price);
    return {
      id, label, color, live: !!live, comps: sorted,
      stats: { count: sorted.length, low: prices.length ? prices[0] : 0, median: round2(median(prices)), high: prices.length ? prices[prices.length - 1] : 0 },
    };
  }

  /* ---------- Demo data: generated from the query text, NOT market data ---------- */
  function demoBase(query, brand) {
    const h = hashString((brand || "") + "|" + query);
    let base = 14 + (h % 220);
    if (/(nike|levi|sony|carhartt|apple|north face|patagonia|dr martens|new balance|adidas|gucci|prada)/i.test((brand || "") + " " + query)) base = Math.round(base * 1.4 + 30);
    return base;
  }
  function gatherDemo(input) {
    const { query, brand, condition } = input;
    const rng = mulberry32(hashString("apr|" + (brand || "") + "|" + query + "|" + (condition || "")));
    const base = demoBase(query, brand) * (CONDITION_FACTOR[condition] || 0.72);
    const title = App.ui.composeTitle(brand, query);
    return DEMO_SOURCES.map((src) => {
      const n = 4 + Math.floor(rng() * 4);
      const comps = [];
      for (let i = 0; i < n; i++) {
        const price = Math.max(5, Math.round(base * src.factor * (0.78 + rng() * 0.5)));
        comps.push({ title: (title + " " + VARIANTS[Math.floor(rng() * VARIANTS.length)]).trim(), price, when: "Demo listing", url: null });
      }
      return buildSourceFromComps(src.id, src.label, src.color, false, comps);
    });
  }

  /* ---------- Live eBay comps ---------- */
  async function fetchLive(input, out) {
    try {
      const st = await App.backend.status();
      out.backendConfigured = !!(st && st.ok && st.ebay && st.ebay.configured);
      out.environment = st && st.ebay && st.ebay.environment;
      out.marketplace = st && st.ebay && st.ebay.marketplace;
      if (!out.backendConfigured) return null;
      const res = await App.backend.ebaySearch(App.ui.composeTitle(input.brand, input.query), 8);
      if (res && res.ok && Array.isArray(res.items)) {
        const comps = res.items
          .filter((it) => Number(it.price) > 0)
          .map((it) => ({ title: it.title || "eBay listing", price: round2(it.price), when: it.condition || "Active listing", url: App.ui.safeUrl(it.url) }));
        if (comps.length) return { comps, currency: res.currency || (res.items[0] && res.items[0].currency) || (st.ebay && st.ebay.currency) || "USD" };
        out.ebayError = "eBay found no comparable listings for this search.";
      } else if (res && !res.ok) {
        out.ebayError = res.message || res.error;
      }
    } catch (e) {
      out.ebayError = String(e && e.message || e);
    }
    return null;
  }

  // Spread of the middle half of prices + a penalty for few listings.
  function liveConfidence(prices) {
    const n = prices.length;
    if (n < 2) return 15;
    const s = prices.slice().sort((a, b) => a - b);
    const med = quantile(s, 0.5);
    const disp = med > 0 ? (quantile(s, 0.75) - quantile(s, 0.25)) / med : 1;
    return Math.round(Math.max(10, Math.min(95, 100 - disp * 100 - Math.max(0, 8 - n) * 6)));
  }

  function rationaleFor(id) {
    return ({
      ebay: "Broadest market — price near the median for a steady sale.",
      depop: "Fashion buyers pay a premium; price above median.",
      vinted: "Value-driven EU buyers; price below median for fast turnover.",
      facebook: "Local buyers, no fees on pickup — price for a quick local sale.",
      sellpy: "Consignment (they sell for you) — expect less after commission.",
    })[id] || "Price near the median.";
  }

  // Suggested price per marketplace. Fees/profit only when the prices are in
  // the region's currency (fee tables are in EUR/GBP).
  function perMarketplaceFor(med, currency, shopPrice) {
    const acc = App.store.activeAccount();
    const feesOk = currency === App.fees.currency();
    return App.connectors.list().map((c) => {
      const raw = med * c.priceFactor;
      const price = raw >= 10 ? Math.max(1, Math.round(raw / 5) * 5 - 1) : Math.max(1, Math.round(raw));
      const m = feesOk ? App.fees.calc(c.id, price, { cost: shopPrice }) : { fee: null, net: null, profit: null };
      return {
        id: c.id, label: c.label, color: c.color, price, rationale: rationaleFor(c.id),
        fee: m.fee, net: m.net, profit: m.profit,
        connected: !!(acc.connections[c.id] && acc.connections[c.id].connected),
      };
    });
  }

  async function appraise(input) {
    const started = Date.now();
    const shopPrice = input.shopPrice == null || input.shopPrice === "" || isNaN(Number(input.shopPrice)) || Number(input.shopPrice) < 0 ? null : Number(input.shopPrice);
    const out = { ebayError: null, backendConfigured: false, environment: null, marketplace: null };
    const live = await fetchLive(input, out);

    // Keep the spinner visible for at least a beat.
    const elapsed = Date.now() - started;
    if (elapsed < 650) await new Promise((r) => setTimeout(r, 650 - elapsed));

    if (live) {
      const source = buildSourceFromComps("ebay", "eBay — active listings", "#0064d2", true, live.comps);
      const prices = live.comps.map((c) => c.price);
      const med = round2(median(prices));
      const confidence = liveConfidence(prices);
      const regionCurrency = App.fees.currency();
      const currencyMismatch = live.currency !== regionCurrency;
      const perMarketplace = perMarketplaceFor(med, live.currency, shopPrice);
      let verdict = null, verdictBlocked = null;
      if (shopPrice !== null) {
        const eligible = perMarketplace.filter((p) => p.connected);
        if (currencyMismatch) verdictBlocked = "currency";
        else if (!eligible.length) verdictBlocked = "no_connected";
        else verdict = verdictFor(eligible, confidence, shopPrice);
      }
      return {
        mode: "live", currency: live.currency, regionCurrency, currencyMismatch,
        ebayLive: true, environment: out.environment, marketplace: out.marketplace,
        aggregate: { low: source.stats.low, median: med, high: source.stats.high, quickSale: round2(med * 0.88), confidence },
        sources: [source], perMarketplace, verdict, verdictBlocked,
      };
    }

    const sources = gatherDemo(input);
    const all = sources.flatMap((s) => s.comps.map((c) => c.price));
    const med = Math.round(median(all));
    return {
      mode: "demo", currency: App.fees.currency(),
      ebayLive: false, ebayError: out.ebayError, backendConfigured: out.backendConfigured, environment: out.environment,
      aggregate: { low: Math.min(...all), median: med, high: Math.max(...all), quickSale: Math.round(med * 0.88), confidence: null },
      sources, perMarketplace: perMarketplaceFor(med, App.fees.currency(), null), verdict: null,
    };
  }

  /* ---------- Buy / Maybe / Pass (live data only) ----------
     BUY   when the best CONNECTED marketplace nets at least MIN_PROFIT after
           fees, returns ≥ 50% on what you pay, and confidence is ≥ 50%.
     MAYBE when it's still profitable but misses one of those bars.
     PASS  when you'd make nothing or lose money.
     Score (1–100) = 70% return-on-cost (capped at 200%) + 30% confidence. */
  const MIN_PROFIT = 5;
  function verdictFor(perMarketplace, confidence, shopPrice) {
    if (shopPrice == null || shopPrice === "" || isNaN(Number(shopPrice)) || Number(shopPrice) < 0) return null;
    const usable = perMarketplace.filter((p) => typeof p.profit === "number");
    if (!usable.length || typeof confidence !== "number") return null;
    const cost = Number(shopPrice);
    const best = usable.slice().sort((a, b) => b.profit - a.profit)[0];
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

  window.App.appraisal = { appraise, verdictFor, liveConfidence, CONDITION_FACTOR };
})();
