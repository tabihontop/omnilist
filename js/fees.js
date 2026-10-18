/* ===========================================================================
   fees.js — per-region marketplace fee tables + net/profit math
   Attaches to window.App.fees

   Defaults assume a PRIVATE (non-business) seller and come from third-party
   fee guides checked October 2026 (sources linked per row). Fees change and
   vary by country, so every value is editable in Settings (stored as
   settings.feeOverrides[region][market] = { pct, fixed }).
   =========================================================================== */
(function () {
  window.App = window.App || {};

  const SRC = {
    ebayDE: "https://www.cio.de/article/3700252/ebay-deutschland-streicht-gebuehren-fuer-private-verkaeufer.html",
    ebayUK: "https://www.ebay.co.uk/help/selling/fees-credits-invoices/selling-fees?id=4364",
    depop: "https://www.getonecart.com/depop-fees/",
    vinted: "https://www.getonecart.com/how-to-sell-on-vinted/",
    facebook: "https://uk.blog.vendoo.co/a-guide-to-facebook-marketplace-fees-in-the-uk",
    sellpy: "https://intercom.help/sellpy/pl/articles/408059-nar-och-hur-far-jag-min-andel-av-forsaljningen",
  };

  const DEFAULTS = {
    EU: {
      ebay: { pct: 0, fixed: 0, src: SRC.ebayDE, note: "Private sellers on eBay.de pay no selling fees (since Mar 2023). Business sellers or other EU eBay sites pay roughly 12% + €0.35 — edit to match your account." },
      depop: { pct: 12.9, fixed: 0.3, src: SRC.depop, note: "Outside the UK/US: 10% selling fee + about 2.9% + €0.30 payment processing (third-party guides; Depop's own fee page is the authority)." },
      vinted: { pct: 0, fixed: 0, src: SRC.vinted, note: "Sellers pay nothing — the buyer pays Vinted's protection fee." },
      facebook: { pct: 0, fixed: 0, src: SRC.facebook, note: "No fee for local pickup. Shipped sales through Facebook checkout may carry a fee." },
      sellpy: { pct: 60, fixed: 0, src: SRC.sellpy, note: "Consignment: you get a tiered share — about 40% on cheaper items, more above a threshold — and some countries add a per-item fee." },
    },
    UK: {
      ebay: { pct: 0, fixed: 0, src: SRC.ebayUK, note: "UK private sellers pay no final value or regulatory fees since 1 Oct 2024 (vehicles excepted; overseas sales and upgrades can cost extra)." },
      depop: { pct: 2.9, fixed: 0.3, src: SRC.depop, note: "No selling fee on UK listings since Mar 2024; about 2.9% + £0.30 payment processing." },
      vinted: { pct: 0, fixed: 0, src: SRC.vinted, note: "Sellers pay nothing — the buyer pays Vinted's protection fee." },
      facebook: { pct: 0, fixed: 0, src: SRC.facebook, note: "No fee for local pickup. Shipped sales through Facebook checkout may carry a fee." },
      sellpy: { pct: 60, fixed: 0, src: SRC.sellpy, note: "Couldn't confirm Sellpy operates in the UK. Tiered consignment share — check Sellpy's help for your country." },
    },
  };
  const CURRENCY = { EU: "EUR", UK: "GBP" };

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function region() { const s = App.store && App.store.settings && App.store.settings(); return (s && s.region) || "EU"; }
  function currency(r) { return CURRENCY[r || region()] || "EUR"; }

  function feeFor(market, r) {
    r = r || region();
    const base = (DEFAULTS[r] && DEFAULTS[r][market]) || { pct: 0, fixed: 0, note: "No fee recorded.", src: "" };
    const all = (App.store && App.store.settings && App.store.settings().feeOverrides) || {};
    const ov = (all[r] || {})[market] || {};
    return {
      pct: ov.pct != null ? Number(ov.pct) : base.pct,
      fixed: ov.fixed != null ? Number(ov.fixed) : base.fixed,
      note: base.note, src: base.src,
      overridden: ov.pct != null || ov.fixed != null,
    };
  }

  // fee = price × pct% + fixed; net = price − fee − shipping you paid; profit = net − cost
  function calc(market, price, opts) {
    opts = opts || {};
    price = Number(price) || 0;
    const f = feeFor(market, opts.region);
    const fee = price > 0 ? round2(Math.min(price, price * f.pct / 100 + f.fixed)) : 0;
    const net = round2(price - fee - (Number(opts.shipping) || 0));
    const hasCost = opts.cost != null && opts.cost !== "" && !isNaN(Number(opts.cost));
    const profit = hasCost ? round2(net - Number(opts.cost)) : null;
    return { fee, net, profit, pct: f.pct, fixed: f.fixed };
  }

  window.App.fees = { DEFAULTS, CURRENCY, round2, region, currency, feeFor, calc };
})();
