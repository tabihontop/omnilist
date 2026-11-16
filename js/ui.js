/* ===========================================================================
   ui.js — DOM helpers, formatting, toasts, modals, image utilities
   Attaches to window.App.ui
   =========================================================================== */
(function () {
  window.App = window.App || {};

  /* ----- DOM builder: el('div.card#id', {attrs}, [children]) ----- */
  function el(spec, attrs, children) {
    let tag = "div", id = null, classes = [];
    spec.split(/(?=[.#])/).forEach((tok, i) => {
      if (i === 0 && !/[.#]/.test(tok)) tag = tok;
      else if (tok[0] === ".") classes.push(tok.slice(1));
      else if (tok[0] === "#") id = tok.slice(1);
      else tag = tok;
    });
    const node = document.createElement(tag || "div");
    if (id) node.id = id;
    if (classes.length) node.className = classes.join(" ");

    if (attrs && (Array.isArray(attrs) || attrs instanceof Node || typeof attrs === "string")) {
      children = attrs; attrs = null;
    }
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") node.className += " " + v;
        else if (k === "text") node.textContent = v;
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    appendChildren(node, children);
    return node;
  }
  function appendChildren(node, children) {
    if (children == null) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach((c) => {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /* ----- Links: only ever store, render or open http(s) URLs ----- */
  function safeUrl(u) {
    if (typeof u !== "string" || !u.trim()) return null;
    try {
      const url = new URL(u.trim());
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (e) { return null; }
  }
  function openSafe(u) {
    const s = safeUrl(u);
    if (s) window.open(s, "_blank", "noopener");
    return !!s;
  }

  /* ----- Formatting ----- */
  const CUR = { USD: "$", EUR: "€", GBP: "£" };
  function money(n, cur) {
    cur = cur || "USD";
    const sym = CUR[cur] || "";
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? "-" : "") + sym + Math.abs(v).toLocaleString("en-US");
  }
  function money2(n, cur) {
    cur = cur || "USD";
    const sym = CUR[cur] || "";
    const v = Number(n) || 0;
    return (v < 0 ? "-" : "") + sym + Math.abs(v).toFixed(2);
  }
  // Whole amounts without decimals, otherwise two decimals (e.g. €58 / €0.30).
  function moneyAuto(n, cur) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    return Number.isInteger(v) ? money(v, cur) : money2(v, cur);
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24); if (d < 30) return d + "d ago";
    return fmtDate(ts);
  }
  function slugify(s) {
    return String(s || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
  }
  function composeTitle(brand, query) {
    brand = (brand || "").trim(); query = (query || "").trim();
    if (!brand) return query;
    if (query.toLowerCase().indexOf(brand.toLowerCase()) !== -1) return query;
    return (brand + " " + query).trim();
  }
  function uid(prefix) { return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 9); }

  /* ----- Deterministic pseudo-random (so appraisals are stable per query) ----- */
  function hashString(s) {
    let h = 2166136261 >>> 0;
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----- Avatar color from string ----- */
  const PALETTE = ["#7c5cff", "#4dabf7", "#f783ac", "#34d399", "#fbbf24", "#fb7185", "#38bdf8", "#a78bfa"];
  function colorFor(s) { return PALETTE[hashString(s) % PALETTE.length]; }
  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    const a = parts[0][0] || "";
    const b = (parts[1] && parts[1][0]) || "";
    return ((a + b).toUpperCase().slice(0, 2)) || parts[0].slice(0, 2).toUpperCase();
  }

  /* ----- Toasts ----- */
  function toast(title, msg, type) {
    let host = document.getElementById("toasts");
    if (!host) { host = el("div#toasts"); document.body.appendChild(host); }
    const t = el(".toast" + (type ? "." + type : ""), [
      el(".t-title", title),
      msg ? el(".t-msg", msg) : null,
    ]);
    host.appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s, transform .3s"; t.style.opacity = "0"; t.style.transform = "translateX(20px)"; setTimeout(() => t.remove(), 300); }, type === "err" ? 5200 : 3400);
  }

  /* ----- Modal ----- */
  // Open modals form a stack: Escape closes only the top one.
  const modalStack = [];
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalStack.length) { e.preventDefault(); modalStack[modalStack.length - 1](); }
  });
  function modal(opts) {
    // opts: { title, body(node), actions:[{label, kind, onClick(close)}], onClose }
    const backdrop = el(".modal-backdrop");
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      const i = modalStack.indexOf(close);
      if (i !== -1) modalStack.splice(i, 1);
      backdrop.remove();
      if (opts.onClose) opts.onClose();
    }
    const foot = el(".m-foot", (opts.actions || [{ label: "Close" }]).map((a) =>
      el("button.btn" + (a.kind ? "." + a.kind : ""), { type: "button", onClick: () => a.onClick ? a.onClick(close) : close() }, a.label)
    ));
    const box = el(".modal", { role: "dialog", "aria-modal": "true", "aria-label": opts.title || "Dialog" }, [
      opts.title ? el(".m-head", opts.title) : null,
      el(".m-body", opts.body),
      foot,
    ]);
    backdrop.appendChild(box);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    modalStack.push(close);
    document.body.appendChild(backdrop);
    return { close };
  }
  function confirmDialog(title, message, confirmLabel, kind) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      modal({
        title,
        body: el("div", { text: message }),
        actions: [
          { label: "Cancel", onClick: (c) => { finish(false); c(); } },
          { label: confirmLabel || "Confirm", kind: kind || "primary", onClick: (c) => { finish(true); c(); } },
        ],
        onClose: () => finish(false),
      });
    });
  }
  function prompt2(title, fields, submitLabel) {
    // fields: [{name, label, value, type, placeholder}] -> resolves {name: value} or null
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const inputs = {};
      let m = null;
      const submit = () => {
        const out = {}; for (const k in inputs) out[k] = inputs[k].value.trim();
        finish(out); if (m) m.close();
      };
      const body = el(".stack", fields.map((f) => {
        const input = el(f.type === "textarea" ? "textarea" : "input", {
          type: f.type || "text", value: f.value || "", placeholder: f.placeholder || "",
        });
        // Enter submits from single-line fields (textareas keep Enter for new lines).
        if (f.type !== "textarea") input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
        inputs[f.name] = input;
        return el("label.field", [el("span.lab", f.label), input]);
      }));
      setTimeout(() => { const first = body.querySelector("input,textarea"); if (first) first.focus(); }, 30);
      m = modal({
        title, body,
        actions: [
          { label: "Cancel", onClick: (c) => { finish(null); c(); } },
          { label: submitLabel || "Save", kind: "primary", onClick: () => submit() },
        ],
        onClose: () => finish(null),
      });
    });
  }

  /* ----- Image utilities (resize to keep localStorage small) ----- */
  function fileToDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  function resizeImage(srcDataURL, maxDim, quality) {
    maxDim = maxDim || 1024; quality = quality || 0.72;
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (Math.max(width, height) > maxDim) {
          const s = maxDim / Math.max(width, height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const c = document.createElement("canvas");
        c.width = width; c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        try { res(c.toDataURL("image/jpeg", quality)); }
        catch (e) { res(srcDataURL); }
      };
      img.onerror = () => res(srcDataURL);
      img.src = srcDataURL;
    });
  }

  window.App.ui = {
    el, clear, safeUrl, openSafe, money, money2, moneyAuto, fmtDate, timeAgo, slugify, uid,
    hashString, mulberry32, colorFor, initials, composeTitle,
    toast, modal, confirmDialog, prompt2,
    fileToDataURL, resizeImage,
  };
})();
