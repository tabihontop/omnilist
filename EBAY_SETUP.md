# Connecting eBay for real (Phase 1: live appraisals)

This turns the **eBay** source in *Scan & appraise* into **real data** from eBay's
official **Browse API**. No code changes needed — you just create eBay API keys and
paste them into a config file. The local PowerShell server does the rest (it keeps
your secret off the browser, which is required).

> **What's live vs not:** The Browse API returns **active listings (current asking
> prices)**, not completed/sold prices. That's still a solid value signal. True *sold*
> comps need eBay's **Marketplace Insights API**, which is limited-access (separate
> approval) — we can add it later if you get access.
>
> Depop & Vinted stay simulated because they have no public API.

---

## Step 1 — Create an eBay developer account (free)

1. Go to **https://developer.ebay.com** → **Register** (or sign in with your eBay account).
2. Accept the developer agreement.

## Step 2 — Get your keys (a "keyset")

1. In the developer portal: **Hi, <you>** → **Application Keys** (or **Develop → Your keysets**).
2. You'll see two environments: **Sandbox** and **Production**. Each has its own keys.
3. For each keyset you need two values:
   - **App ID (Client ID)** → goes in `clientId`
   - **Cert ID (Client Secret)** → goes in `clientSecret`

   *(You do NOT need the Dev ID or a redirect/RuName for appraisals — those are only
   for Phase 2 publishing.)*

### Sandbox vs Production — which to use?
- **Sandbox**: easiest to connect, but eBay's sandbox catalog is nearly empty, so
  searches return few/no comps. Great for confirming the plumbing works (you'll see
  the 🟢 **LIVE** badge), not for real numbers.
- **Production**: returns real marketplace data. Production access to the **Buy/Browse
  API** may require accepting the API License Agreement (and, for some accounts,
  requesting Buy API access) in the portal. Use this once you want real comps.

**Recommendation:** start with **Sandbox** to verify the connection, then switch to
**Production** for real data.

## Step 3 — Add your keys to OmniList

1. In the `omnilist` folder, copy **`ebay.config.example.json`** to **`ebay.config.json`**.
2. Open `ebay.config.json` and fill it in:

```json
{
  "environment": "sandbox",
  "clientId": "YourApp-OmniList-SBX-abc123-4d5e6f",
  "clientSecret": "SBX-1234567890abcdef1234567890",
  "marketplaceId": "EBAY_US"
}
```

- `environment`: `"sandbox"` or `"production"` (must match the keyset you copied).
- `marketplaceId`: e.g. `EBAY_US`, `EBAY_GB`, `EBAY_DE` (sets currency/region of comps).

> ⚠️ **Keep `ebay.config.json` private** — it holds your secret. Don't share or commit
> it. The server refuses to serve it to the browser.

## Step 4 — Run and verify

1. Launch with **`start.bat`** (or `serve.ps1`). The console should print:
   `eBay: LIVE (sandbox, EBAY_US)`.
2. Open the app → **Appraise**. You should see a green **🟢 eBay LIVE** chip.
3. Type an item (e.g., *"Nike Air Max 90"*) → **Appraise value**.
   The **eBay** tab in *Comparable listings* shows a **LIVE** badge with real listings.
4. **Marketplaces** screen → the eBay card shows **🟢 Live (sandbox)**.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Console says `eBay: simulated` | `ebay.config.json` missing or `clientId`/`clientSecret` blank. |
| Appraisal eBay tab still says "demo" | Backend unreachable (opened `index.html` directly?) — launch via `serve.ps1`. |
| `eBay live request failed … 401 / invalid_client` | Wrong keys, or `environment` doesn't match the keyset (sandbox keys with `"production"` or vice-versa). |
| LIVE badge shows but few/no eBay comps | Expected on **sandbox** (sparse catalog). Switch to **production**. |
| Production returns `Access denied`/`Insufficient permissions` | Enable/accept the **Buy APIs** agreement for your production keyset in the eBay portal. |

---

---

# Phase 2: real cross-*posting* (publish live eBay listings)

This publishes actual eBay listings from **New Listing** (the eBay row goes live for
real; Depop/Vinted stay simulated). It's wired through the same `serve.ps1` backend:
`inventory_item` → `offer` → `publish`, with photos uploaded to eBay Picture Services.

## Step A — Get a RuName (redirect) and add it to your config

Seller publishing needs the seller to log in and consent (OAuth), which requires a
**RuName**:

1. eBay developer portal → **User tokens (OAuth)** / **Get a Token from eBay via Your
   Application** for your environment.
2. You'll have (or can create) a **RuName** (looks like `Your-Name-YourApp-PRD-abc-de`).
   Set its **Auth accepted URL** and **Auth declined URL** to any HTTPS pages (the
   eBay-provided defaults are fine — you'll copy the code from the browser, so the page
   itself doesn't matter).
3. Put the **RuName** into `ebay.config.json` as `redirectUri`:

```json
{
  "environment": "production",
  "clientId": "…",
  "clientSecret": "…",
  "marketplaceId": "EBAY_US",
  "redirectUri": "Your-Name-YourApp-PRD-abc-de"
}
```

> Make sure your keyset is allowed the **`sell.inventory`** and **`sell.account`** OAuth
> scopes (default for most apps). The server requests those at login.

## Step B — Seller prerequisites (one-time, in your eBay *account*)

eBay refuses to publish until the seller account has these. The app checks for them and
tells you what's missing on the **Marketplaces → eBay** card.

1. **Business policies** — payment, return, and shipping (fulfillment) policies.
   Production: opt in at **Seller Hub → Account → Business Policies**, then create one of
   each. (Sandbox has no Seller Hub UI — policies must be created via the Account API.)
2. **Inventory location** — eBay needs a `merchantLocationKey`. Most sellers don't have
   one yet, and it can't be created from eBay's website. **The app handles this:** if a
   location is missing, the **Marketplaces → eBay** card shows a **＋ Create default
   location** button (just enter your country + postal code).

> **Item specifics (aspects):** if a category requires item specifics (e.g. Size, Type),
> the app automatically asks you for them in a popup when you publish, and includes them
> in the listing. No manual setup needed.

## Step C — Connect your seller account (in the app)

1. Launch with `start.bat`, open **Marketplaces → eBay**.
2. Under **Live publishing**, click **Connect eBay seller account**.
3. A new tab opens eBay's sign-in / consent page → sign in → **I agree**.
4. eBay redirects you to a page whose URL contains `?code=…`. **Copy that full URL** and
   paste it back into the app's prompt → **Connect**.
5. The card shows **✓ Seller connected** and a readiness check (policies + location).

The seller token is stored locally in `ebay.tokens.json` and auto-refreshes (keep it
private; the server won't serve it).

## Step D — Publish

**New Listing** → add photos + details → **Publish to selected**. The eBay row will show
**Published LIVE via eBay API (listing …)** with a real, clickable listing link. If
something's missing, the row shows a specific error and which step failed.

> Strongly recommended: do your first publish in **sandbox** (`"environment": "sandbox"`)
> so you don't post a real listing while testing.

## Phase 2 troubleshooting

| Error on the eBay row | Meaning / fix |
|---|---|
| `Connect your eBay seller account first` | Do Step C (you added keys but didn't log in). |
| `eBay account setup needed - missing: …` | Step B — create the listed policies/location. |
| `[step: image_upload]` | Photo couldn't upload to eBay Picture Services. Try a smaller/standard JPEG. |
| `[step: inventory_item]` … "condition" | The item condition isn't valid for that category — change condition. |
| `[step: offer]` … aspects / required | The app prompts for required item specifics before publishing; if eBay still wants more for that category, the message lists them — re-publish and fill them in. |
| `[step: category]` | Couldn't auto-pick a category from the title — make the title more specific. |
