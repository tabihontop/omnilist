# OmniList — Cross-Listing & Appraisal (prototype)

List a product **once** and push it to **eBay, Depop, Vinted, Facebook Marketplace &
Sellpy** at the same time. Switch between multiple seller **accounts**, and
**scan/appraise** an item to estimate its value from those marketplaces + Google before
you list.

This is a **working front-end prototype**: the whole flow runs offline with *demo
connectors* and *simulated* appraisal data. The architecture has clean seams so you
can drop in real APIs later (see **Going live** below).

---

## Run it

### Option A — recommended (camera works)
The scanner uses your camera via `getUserMedia`, which browsers only allow on a
**secure origin** (`https://` or `http://localhost`). The included server gives you that.

1. Double-click **`start.bat`**, **or** right-click **`serve.ps1`** → *Run with PowerShell*.
2. Your browser opens at `http://localhost:8080/`.
3. Close the window (or `Ctrl+C`) to stop.

No Node/Python needed — it's a tiny server built on PowerShell (already on Windows).

### Option B — quick peek (no camera)
Double-click **`index.html`**. Everything works **except** the live camera in *Appraise*
(use the **Upload photo** button there instead).

---

## What you can do

| Feature | Where | Notes |
|---|---|---|
| **Cross-post one listing to all marketplaces** | New Listing → *Publish to selected* | Watch each marketplace publish live, with retry on failure. |
| **Switch seller accounts** | Top-right account chip | Each profile has its own connections + listings. |
| **Connect / disconnect marketplaces** | Marketplaces | Per-account. eBay = official API; Depop/Vinted = automation (ToS warning shown). |
| **Scan & appraise an item** | Appraise | Camera capture or upload → estimated value, per-marketplace price, comps. |
| **Create a listing from an appraisal** | Appraise → *Create listing from this* | Prefills New Listing with the suggested price + photo. |
| **Manage listings** | Dashboard | Status per marketplace, re-push, view, delete. |

Your data is saved in the browser's **localStorage**. Use the account menu →
**Reset demo data** to restore the original sample.

---

## The honest part: which integrations can be *real*

| Marketplace | Official posting API? | How real cross-posting would work |
|---|---|---|
| **eBay** | ✅ Yes | eBay **Sell API** (Inventory + Offer). Register an eBay developer app, do OAuth, then call `/sell/inventory/v1`. This can be fully legitimate. |
| **Depop** | ❌ No | No public listing API (Etsy-owned). Live posting needs **browser automation**, which **violates Depop's ToS** and risks bans. |
| **Vinted** | ❌ No | No public listing API. Same automation caveat as Depop. |

The same is true for most resale apps (Poshmark, Mercari, OfferUp, Facebook
Marketplace). Tools like Vendoo/List Perfectly automate the browser for these — use
that approach knowingly and at your own risk.

---

## Going live (where to plug real code)

The prototype is structured so each external dependency is isolated:

- **`js/connectors.js` → `publish(market, product, connection)`**
  - eBay → ✅ **wired for real.** Publishes via the Sell/Inventory API through the backend
    (`/api/ebay/publish`) once your seller account is connected. See **[EBAY_SETUP.md](EBAY_SETUP.md)** (Phase 2).
  - Vinted, Depop, Facebook Marketplace & Sellpy → **ToS-safe handoff** (no automation): OmniList prepares a ready-to-post listing (copy-ready fields + downloadable photos) and opens their sell page so you post it yourself in one tap. (Sellpy is consignment — it opens Sellpy so you can send your items in.)
- **`js/appraisal.js` → `tryLiveEbay(input)`** — ✅ **eBay is wired for real.**
  When `ebay.config.json` exists, the eBay source uses live **Browse API** comps via
  the local backend (`serve.ps1` → `/api/ebay/search`). See **[EBAY_SETUP.md](EBAY_SETUP.md)**.
  Still simulated (swap in real data the same way):
  - Google Shopping → Custom Search / a SERP provider.
  - Depop/Vinted "active" comps → search-page scraping (ToS caveats).
  - eBay *sold* prices (vs active) → Marketplace Insights API (limited access).
- **Photo → item identification** (in `js/views.js`, the *Appraise* screen):
  Send the captured image to a **vision model** (e.g., the Claude API) to auto-fill
  the brand/title/category instead of typing them.

> Anything that holds API secrets or scrapes should live in a **backend**, not this
> client. Treat this front-end as the UI layer of that system.

---

## File structure

```
omnilist/
├─ index.html          # entry point (loads the scripts below in order)
├─ assets/styles.css   # design system / all styling
├─ js/
│  ├─ ui.js            # DOM helpers, formatting, toasts, modals, image resize
│  ├─ store.js         # state + localStorage + demo seed data
│  ├─ connectors.js    # marketplace registry + simulated publish  ← API seam
│  ├─ appraisal.js     # value-estimation engine (simulated comps) ← data seam
│  ├─ views.js         # all screens + shared components
│  └─ app.js           # shell, hash router, account switcher, bootstrap
├─ serve.ps1           # zero-dependency local server (for the camera)
├─ start.bat           # double-click launcher
└─ README.md
```

No build step, no dependencies, no framework — plain HTML/CSS/JS.

---

## Limitations (it's a prototype)

- Marketplace posts and appraisal numbers are **simulated** — nothing is sent anywhere.
- "View ↗" links on listings/comps are illustrative and won't resolve.
- Data lives only in this browser (localStorage); clearing site data resets it.
- Image identification from photos is a manual step until a vision API is wired in.
