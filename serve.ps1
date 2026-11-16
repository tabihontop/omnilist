# ===========================================================================
# OmniList - local server + eBay API backend (Windows PowerShell, zero install)
#
#  * Serves the static app over http://localhost
#  * Exposes /api/* endpoints that proxy to eBay (keeps your secret off the
#    browser; eBay APIs can't be called from client-side JS anyway).
#
# Configure eBay:  copy ebay.config.example.json -> ebay.config.json and fill in
#                  your App ID (clientId) + Cert ID (clientSecret). See EBAY_SETUP.md.
#
# Run:   double-click start.bat   OR   right-click serve.ps1 -> Run with PowerShell
# Stop:  close the window / Ctrl+C
#
# NOTE: keep this file pure ASCII (Windows PowerShell 5.1 reads .ps1 files in
#       the system code page).
# ===========================================================================
param([switch]$NoOpen)   # -NoOpen skips auto-launching the browser
$ErrorActionPreference = "Stop"

# eBay requires TLS 1.2; Windows PowerShell 5.1 may default to older protocols.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
$UTF8 = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# eBay config + per-request state
# ---------------------------------------------------------------------------
$script:ebay = @{
  env          = "sandbox"
  clientId     = $null
  clientSecret = $null
  redirectUri  = $null            # RuName (for seller OAuth consent)
  marketplace  = $null            # only set when ebay.config.json pins one
  token        = $null            # app token (Browse)
  tokenExp     = [datetime]::MinValue
}
$script:market = "EBAY_US"       # effective eBay marketplace for the current request
$script:origin = $null            # http://localhost:<port>, set after binding
$script:oauthState = $null        # one-time anti-forgery value for seller login
$script:oauthStateAt = [datetime]::MinValue

$script:EBAY_SCOPES = "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account"
$script:CONDITION_MAP = @{ "New"="NEW"; "Like new"="USED_EXCELLENT"; "Good"="USED_GOOD"; "Fair"="USED_ACCEPTABLE"; "Poor"="FOR_PARTS_OR_NOT_WORKING" }
$script:MARKETS = @{
  "EBAY_US" = @{ site = "0";   currency = "USD"; lang = "en-US"; web = "https://www.ebay.com" }
  "EBAY_GB" = @{ site = "3";   currency = "GBP"; lang = "en-GB"; web = "https://www.ebay.co.uk" }
  "EBAY_DE" = @{ site = "77";  currency = "EUR"; lang = "de-DE"; web = "https://www.ebay.de" }
  "EBAY_AU" = @{ site = "15";  currency = "AUD"; lang = "en-AU"; web = "https://www.ebay.com.au" }
  "EBAY_CA" = @{ site = "2";   currency = "CAD"; lang = "en-CA"; web = "https://www.ebay.ca" }
  "EBAY_FR" = @{ site = "71";  currency = "EUR"; lang = "fr-FR"; web = "https://www.ebay.fr" }
  "EBAY_IT" = @{ site = "101"; currency = "EUR"; lang = "it-IT"; web = "https://www.ebay.it" }
  "EBAY_ES" = @{ site = "186"; currency = "EUR"; lang = "es-ES"; web = "https://www.ebay.es" }
}
function Market-Info { return $script:MARKETS[$script:market] }

function Load-EbayConfig {
  $cfgPath = Join-Path $root "ebay.config.json"
  if (Test-Path $cfgPath) {
    try {
      $c = [System.IO.File]::ReadAllText($cfgPath, $UTF8) | ConvertFrom-Json
      if ($c.environment)  { $script:ebay.env = "$($c.environment)".ToLower() }
      if ($c.clientId)     { $script:ebay.clientId = "$($c.clientId)".Trim() }
      if ($c.clientSecret) { $script:ebay.clientSecret = "$($c.clientSecret)".Trim() }
      if ($c.redirectUri)  { $script:ebay.redirectUri = "$($c.redirectUri)".Trim() }
      if ($c.marketplaceId) {
        $m = "$($c.marketplaceId)".Trim().ToUpper()
        if ($script:MARKETS.ContainsKey($m)) { $script:ebay.marketplace = $m }
        else { Write-Host "  WARNING: unknown marketplaceId '$m' - using the app's region instead." -ForegroundColor Yellow }
      }
    } catch {
      Write-Host "  WARNING: ebay.config.json is invalid JSON - running without eBay." -ForegroundColor Yellow
    }
  }
}
function Ebay-Configured { return [bool]($script:ebay.clientId -and $script:ebay.clientSecret) }
function Ebay-Base {
  if ($script:ebay.env -eq "production") { "https://api.ebay.com" } else { "https://api.sandbox.ebay.com" }
}
function Ebay-AuthHost { if ($script:ebay.env -eq "production") { "https://auth.ebay.com" } else { "https://auth.sandbox.ebay.com" } }
function Ebay-WebHost  { if ($script:ebay.env -eq "production") { (Market-Info).web } else { "https://www.sandbox.ebay.com" } }
function Tokens-Path   { Join-Path $root "ebay.tokens.json" }

# The marketplace comes from ebay.config.json if pinned there, otherwise from
# the app's region (the client sends X-OmniList-Marketplace: EBAY_DE / EBAY_GB).
function Resolve-Market($req) {
  if ($script:ebay.marketplace) { $script:market = $script:ebay.marketplace; return }
  $m = "$($req.Headers["X-OmniList-Marketplace"])".Trim().ToUpper()
  if ($m -and $script:MARKETS.ContainsKey($m)) { $script:market = $m } else { $script:market = "EBAY_US" }
}

# ---------------------------------------------------------------------------
# HTTP to eBay. Every call goes through Http-Send: request bodies are sent as
# UTF-8 bytes and responses are decoded as UTF-8 (Windows PowerShell 5.1's
# Invoke-RestMethod does neither reliably, which corrupted accented text).
# ---------------------------------------------------------------------------
function Http-Send($method, $url, $headers, [byte[]]$body, $contentType) {
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Method = $method
  $req.Timeout = 60000
  if ($headers) { foreach ($k in $headers.Keys) { $req.Headers[$k] = "$($headers[$k])" } }
  if ($null -ne $body) {
    $req.ContentType = $contentType
    $req.ContentLength = $body.Length
    $s = $req.GetRequestStream(); $s.Write($body, 0, $body.Length); $s.Close()
  }
  $resp = $null
  try { $resp = $req.GetResponse() }
  catch {
    $we = $_.Exception
    while ($we -and -not ($we -is [System.Net.WebException])) { $we = $we.InnerException }
    if ($we -and $we.Response) { $resp = $we.Response }
    else { return @{ ok = $false; status = $null; text = $null; error = $_.Exception.Message } }
  }
  try {
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), $UTF8)
    $text = $sr.ReadToEnd(); $sr.Close()
    $code = [int]$resp.StatusCode
    $ok = ($code -ge 200 -and $code -lt 300)
    return @{ ok = $ok; status = $code; text = $text; error = $(if ($ok) { $null } else { "HTTP $code" }) }
  } finally { $resp.Close() }
}
function Parse-JsonText($text) {
  if (-not $text) { return $null }
  try { return ($text | ConvertFrom-Json) } catch { return $null }
}
function Ebay-Json($method, $url, $token, $bodyObj, $extraHeaders) {
  $headers = @{ Authorization = "Bearer $token" }
  if ($extraHeaders) { foreach ($k in $extraHeaders.Keys) { $headers[$k] = $extraHeaders[$k] } }
  $bytes = $null; $ct = $null
  if ($null -ne $bodyObj) { $bytes = $UTF8.GetBytes(($bodyObj | ConvertTo-Json -Depth 12 -Compress)); $ct = "application/json; charset=utf-8" }
  $r = Http-Send $method $url $headers $bytes $ct
  return @{ ok = $r.ok; status = $r.status; data = (Parse-JsonText $r.text); body = $r.text; error = $r.error }
}
function Ebay-Form($url, $bodyText) {
  $cred = [Convert]::ToBase64String($UTF8.GetBytes(('{0}:{1}' -f $script:ebay.clientId, $script:ebay.clientSecret)))
  $r = Http-Send "POST" $url @{ Authorization = "Basic $cred" } ($UTF8.GetBytes($bodyText)) "application/x-www-form-urlencoded"
  return @{ ok = $r.ok; status = $r.status; data = (Parse-JsonText $r.text); body = $r.text; error = $r.error }
}
function Parse-EbayErr($body) {
  if (-not $body) { return $null }
  try {
    $j = $body | ConvertFrom-Json
    if ($j.errors) { return (($j.errors | ForEach-Object { $_.message }) -join "; ") }
    if ($j.error_description) { return $j.error_description }
    if ($j.error) { return $j.error }
    if ($j.message) { return $j.message }
  } catch {}
  return $body
}
function Read-Body($req) {
  if (-not $req.HasEntityBody) { return $null }
  # Always UTF-8: browsers send UTF-8 JSON without a charset parameter.
  $sr = New-Object System.IO.StreamReader($req.InputStream, $UTF8)
  $txt = $sr.ReadToEnd(); $sr.Close()
  return (Parse-JsonText $txt)
}

# ---------------------------------------------------------------------------
# Browse (live appraisal comps)
# ---------------------------------------------------------------------------
function Get-EbayAppToken {
  if ($script:ebay.token -and (Get-Date) -lt $script:ebay.tokenExp) { return $script:ebay.token }
  $body = 'grant_type=client_credentials&scope=' + [uri]::EscapeDataString('https://api.ebay.com/oauth/api_scope')
  $r = Ebay-Form ((Ebay-Base) + "/identity/v1/oauth2/token") $body
  if (-not $r.ok -or -not $r.data.access_token) { throw ("eBay sign-in failed (" + $r.status + "): " + (Parse-EbayErr $r.body)) }
  $script:ebay.token    = $r.data.access_token
  $script:ebay.tokenExp = (Get-Date).AddSeconds([int]$r.data.expires_in - 120)
  return $script:ebay.token
}

function Search-Ebay($q, $limit) {
  $token = Get-EbayAppToken
  $enc   = [uri]::EscapeDataString($q)
  $r = Ebay-Json "GET" ((Ebay-Base) + "/buy/browse/v1/item_summary/search?q=$enc&limit=$limit") $token $null @{ "X-EBAY-C-MARKETPLACE-ID" = $script:market }
  if (-not $r.ok) { throw ("eBay search failed (" + $r.status + "): " + (Parse-EbayErr $r.body)) }
  $items = @()
  if ($r.data.itemSummaries) {
    foreach ($it in $r.data.itemSummaries) {
      $price = $null; $cur = (Market-Info).currency
      if ($it.price) { $price = [double]$it.price.value; $cur = "$($it.price.currency)" }
      $items += [pscustomobject]@{
        title     = "$($it.title)"
        price     = $price
        currency  = $cur
        condition = "$($it.condition)"
        url       = "$($it.itemWebUrl)"
        image     = if ($it.image) { "$($it.image.imageUrl)" } else { $null }
      }
    }
  }
  return $items
}

# ---------------------------------------------------------------------------
# Seller OAuth
# ---------------------------------------------------------------------------
function New-OAuthState {
  $script:oauthState = [guid]::NewGuid().ToString("N")
  $script:oauthStateAt = Get-Date
  return $script:oauthState
}
function Get-AuthUrl {
  $scope = [uri]::EscapeDataString($script:EBAY_SCOPES)
  $ru    = [uri]::EscapeDataString($script:ebay.redirectUri)
  $cid   = [uri]::EscapeDataString($script:ebay.clientId)
  $state = New-OAuthState
  return (Ebay-AuthHost) + "/oauth2/authorize?client_id=$cid&response_type=code&redirect_uri=$ru&scope=$scope&state=$state&prompt=login"
}
function Load-AllTokens { $p = Tokens-Path; if (Test-Path $p) { try { return ([System.IO.File]::ReadAllText($p, $UTF8) | ConvertFrom-Json) } catch { return $null } }; return $null }
function Write-AllTokens($all) { [System.IO.File]::WriteAllText((Tokens-Path), ($all | ConvertTo-Json -Depth 8), $UTF8) }
function Save-UserTokens($obj) {
  $all = Load-AllTokens
  if (-not $all) { $all = New-Object psobject }
  $all | Add-Member -NotePropertyName $script:ebay.env -NotePropertyValue $obj -Force
  Write-AllTokens $all
}
function Get-EnvTokens { $all = Load-AllTokens; if ($all -and ($all.PSObject.Properties.Name -contains $script:ebay.env)) { return $all.$($script:ebay.env) }; return $null }
function User-Authorized { $t = Get-EnvTokens; return [bool]($t -and $t.refresh_token) }
function Disconnect-User {
  $all = Load-AllTokens
  if ($all -and ($all.PSObject.Properties.Name -contains $script:ebay.env)) { $all.PSObject.Properties.Remove($script:ebay.env); Write-AllTokens $all }
}

function Exchange-Code($code) {
  $body = 'grant_type=authorization_code&code=' + [uri]::EscapeDataString($code) + '&redirect_uri=' + [uri]::EscapeDataString($script:ebay.redirectUri)
  $r = Ebay-Form ((Ebay-Base) + "/identity/v1/oauth2/token") $body
  if (-not $r.ok -or -not $r.data.refresh_token) { return @{ ok = $false; error = (Parse-EbayErr $r.body); status = $r.status } }
  $obj = [pscustomobject]@{
    refresh_token = $r.data.refresh_token
    refresh_exp   = (Get-Date).AddSeconds([int]$r.data.refresh_token_expires_in).ToString("o")
    access_token  = $r.data.access_token
    access_exp    = (Get-Date).AddSeconds([int]$r.data.expires_in - 120).ToString("o")
  }
  Save-UserTokens $obj
  return @{ ok = $true }
}
function Get-UserToken {
  $t = Get-EnvTokens
  if (-not $t -or -not $t.refresh_token) { throw "not_authorized" }
  if ($t.access_token -and ((Get-Date) -lt [datetime]$t.access_exp)) { return $t.access_token }
  $body = 'grant_type=refresh_token&refresh_token=' + [uri]::EscapeDataString($t.refresh_token) + '&scope=' + [uri]::EscapeDataString($script:EBAY_SCOPES)
  $r = Ebay-Form ((Ebay-Base) + "/identity/v1/oauth2/token") $body
  if (-not $r.ok -or -not $r.data.access_token) { throw ("refresh_failed: " + (Parse-EbayErr $r.body)) }
  $t2 = [pscustomobject]@{ refresh_token = $t.refresh_token; refresh_exp = $t.refresh_exp; access_token = $r.data.access_token; access_exp = (Get-Date).AddSeconds([int]$r.data.expires_in - 120).ToString("o") }
  Save-UserTokens $t2
  return $r.data.access_token
}

# ---------------------------------------------------------------------------
# Sell / Inventory API
# ---------------------------------------------------------------------------
function Get-Account {
  $token = Get-UserToken
  $base = Ebay-Base; $mk = $script:market
  $ful = @(); $pay = @(); $ret = @(); $loc = @()
  $rf = Ebay-Json "GET" "$base/sell/account/v1/fulfillment_policy?marketplace_id=$mk" $token $null $null
  if ($rf.ok -and $rf.data.fulfillmentPolicies) { $ful = @($rf.data.fulfillmentPolicies) }
  $rp = Ebay-Json "GET" "$base/sell/account/v1/payment_policy?marketplace_id=$mk" $token $null $null
  if ($rp.ok -and $rp.data.paymentPolicies) { $pay = @($rp.data.paymentPolicies) }
  $rr = Ebay-Json "GET" "$base/sell/account/v1/return_policy?marketplace_id=$mk" $token $null $null
  if ($rr.ok -and $rr.data.returnPolicies) { $ret = @($rr.data.returnPolicies) }
  $rl = Ebay-Json "GET" "$base/sell/inventory/v1/location" $token $null $null
  if ($rl.ok -and $rl.data.locations) { $loc = @($rl.data.locations) }
  return @{ fulfillment = $ful; payment = $pay; return = $ret; locations = $loc }
}

function Get-CategoryTreeId($token) {
  $tr = Ebay-Json "GET" ((Ebay-Base) + "/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=$($script:market)") $token $null $null
  if ($tr.ok -and $tr.data.categoryTreeId) { return "$($tr.data.categoryTreeId)" }
  return $null
}
function Get-CategoryId($token, $title) {
  $tree = Get-CategoryTreeId $token
  if (-not $tree) { return $null }
  $enc = [uri]::EscapeDataString($title)
  $sg = Ebay-Json "GET" ((Ebay-Base) + "/commerce/taxonomy/v1/category_tree/$tree/get_category_suggestions?q=$enc") $token $null $null
  if ($sg.ok -and $sg.data.categorySuggestions -and @($sg.data.categorySuggestions).Count -gt 0) { return @($sg.data.categorySuggestions)[0].category.categoryId }
  return $null
}

# Required item specifics (aspects) for a category.
function Get-Aspects($token, $catId) {
  $tree = Get-CategoryTreeId $token
  if (-not $tree) { return @() }
  $r = Ebay-Json "GET" ((Ebay-Base) + "/commerce/taxonomy/v1/category_tree/$tree/get_item_aspects_for_category?category_id=" + [uri]::EscapeDataString("$catId")) $token $null $null
  if (-not $r.ok -or -not $r.data.aspects) { return @() }
  $out = @()
  foreach ($a in $r.data.aspects) {
    if (-not $a.aspectConstraint.aspectRequired) { continue }   # required only
    $vals = @()
    if ($a.aspectValues) { $vals = @($a.aspectValues | ForEach-Object { "$($_.localizedValue)" } | Select-Object -First 80) }
    $out += [pscustomobject]@{
      name        = "$($a.localizedAspectName)"
      required    = $true
      mode        = "$($a.aspectConstraint.aspectMode)"                 # FREE_TEXT or SELECTION_ONLY
      cardinality = "$($a.aspectConstraint.itemToAspectCardinality)"    # SINGLE or MULTI
      values      = $vals
    }
  }
  return $out
}

# Create (or reuse) a default inventory location so offers can be published.
function Create-Location($b) {
  $token = Get-UserToken
  $key = "omnilist-default"
  $addr = @{ country = "$($b.country)".ToUpper(); postalCode = "$($b.postalCode)" }
  if ($b.city) { $addr.city = "$($b.city)" }
  if ($b.state) { $addr.stateOrProvince = "$($b.state)" }
  if ($b.addressLine1) { $addr.addressLine1 = "$($b.addressLine1)" }
  $body = @{
    location = @{ address = $addr }
    name = "OmniList Default Location"
    locationTypes = @("WAREHOUSE")
    merchantLocationStatus = "ENABLED"
  }
  $r = Ebay-Json "POST" ((Ebay-Base) + "/sell/inventory/v1/location/$key") $token $body @{ "Content-Language" = (Market-Info).lang }
  if ($r.ok) { return @{ ok = $true; merchantLocationKey = $key } }
  $err = Parse-EbayErr $r.body
  if ($r.status -eq 409 -or "$err" -match "already exists") { return @{ ok = $true; merchantLocationKey = $key; note = "already existed" } }
  return @{ ok = $false; error = "create_location_failed"; status = $r.status; message = $err }
}

# Upload one image (raw bytes) to eBay Picture Services via the Trading API.
function Upload-Image($token, $bytes, $name) {
  $boundary = "OmniList" + [guid]::NewGuid().ToString("N")
  $nl = "`r`n"
  $xml = '<?xml version="1.0" encoding="utf-8"?><UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><PictureName>' + $name + '</PictureName></UploadSiteHostedPicturesRequest>'
  $ms = New-Object System.IO.MemoryStream
  $w = { param($s) $b = $UTF8.GetBytes($s); $ms.Write($b, 0, $b.Length) }
  & $w ("--$boundary$nl")
  & $w ("Content-Disposition: form-data; name=`"XML Payload`"$nl")
  & $w ("Content-Type: text/xml; charset=utf-8$nl$nl")
  & $w ($xml + $nl)
  & $w ("--$boundary$nl")
  & $w ("Content-Disposition: form-data; name=`"image`"; filename=`"$name.jpg`"$nl")
  & $w ("Content-Type: application/octet-stream$nl$nl")
  $ms.Write($bytes, 0, $bytes.Length)
  & $w ($nl + "--$boundary--$nl")
  $body = $ms.ToArray(); $ms.Dispose()
  $headers = @{
    "X-EBAY-API-CALL-NAME" = "UploadSiteHostedPictures"
    "X-EBAY-API-COMPATIBILITY-LEVEL" = "1193"
    "X-EBAY-API-SITEID" = (Market-Info).site
    "X-EBAY-API-DETAIL-LEVEL" = "0"
    "X-EBAY-API-IAF-TOKEN" = $token
  }
  $r = Http-Send "POST" ((Ebay-Base) + "/ws/api.dll") $headers $body "multipart/form-data; boundary=$boundary"
  if (-not $r.text) { throw ("EPS upload failed: " + $r.error) }
  $x = [xml]$r.text
  $ack = $x.UploadSiteHostedPicturesResponse.Ack
  if ($ack -eq "Failure" -or -not $r.ok) {
    $em = $x.UploadSiteHostedPicturesResponse.Errors
    throw ("EPS upload failed: " + ($(if ($em) { $em.LongMessage } else { $r.error })))
  }
  return $x.UploadSiteHostedPicturesResponse.SiteHostedPictureDetails.FullURL
}

function Find-OfferId($token, $sku) {
  $r = Ebay-Json "GET" ((Ebay-Base) + "/sell/inventory/v1/offer?sku=" + [uri]::EscapeDataString($sku) + "&marketplace_id=$($script:market)") $token $null $null
  if ($r.ok -and $r.data.offers -and @($r.data.offers).Count) { return "$(@($r.data.offers)[0].offerId)" }
  return $null
}
function Get-Offer($token, $offerId) {
  $r = Ebay-Json "GET" ((Ebay-Base) + "/sell/inventory/v1/offer/" + [uri]::EscapeDataString($offerId)) $token $null $null
  if ($r.ok) { return $r.data }
  return $null
}

# Publish or update one listing: inventory_item -> offer -> publish.
# Idempotent: the client sends back the sku/offerId it got last time, so a retry
# or re-push updates the same eBay listing instead of creating a duplicate.
function Publish-Listing($p) {
  $token = Get-UserToken
  $base = Ebay-Base
  $mk = $script:market
  $info = Market-Info
  $h = @{ "Content-Language" = $info.lang }

  $cur = if ($p.currency) { "$($p.currency)".ToUpper() } else { $info.currency }
  if ($cur -ne $info.currency) {
    return @{ ok = $false; step = "currency"; error = "currency_mismatch"; message = "This item is priced in $cur but eBay $mk sells in $($info.currency). Change the item's currency or the eBay marketplace." }
  }

  $sku = if ($p.sku -and ("$($p.sku)" -match '^[A-Za-z0-9_-]{1,50}$')) { "$($p.sku)" } else { "OMNI-" + ([guid]::NewGuid().ToString("N").Substring(0, 12)) }
  $offerId = if ($p.offerId -and ("$($p.offerId)" -match '^[A-Za-z0-9_-]{1,64}$')) { "$($p.offerId)" } else { $null }

  $acct = Get-Account
  $ful = if ($p.fulfillmentPolicyId) { $p.fulfillmentPolicyId } elseif ($acct.fulfillment.Count) { $acct.fulfillment[0].fulfillmentPolicyId } else { $null }
  $pay = if ($p.paymentPolicyId) { $p.paymentPolicyId } elseif ($acct.payment.Count) { $acct.payment[0].paymentPolicyId } else { $null }
  $ret = if ($p.returnPolicyId) { $p.returnPolicyId } elseif ($acct.return.Count) { $acct.return[0].returnPolicyId } else { $null }
  $loc = if ($p.merchantLocationKey) { $p.merchantLocationKey } elseif ($acct.locations.Count) { $acct.locations[0].merchantLocationKey } else { $null }
  $missing = @()
  if (-not $ful) { $missing += "fulfillment (shipping) policy" }
  if (-not $pay) { $missing += "payment policy" }
  if (-not $ret) { $missing += "return policy" }
  if (-not $loc) { $missing += "inventory location" }
  if ($missing.Count) { return @{ ok = $false; step = "account_setup"; error = "missing_prerequisites"; missing = $missing; sku = $sku; offerId = $offerId } }

  $cat = if ($p.categoryId) { "$($p.categoryId)" } else { Get-CategoryId $token $p.title }
  if (-not $cat) { return @{ ok = $false; step = "category"; error = "no_category"; message = "Could not resolve an eBay category from the title. Set a categoryId."; sku = $sku; offerId = $offerId } }

  $imageUrls = @()
  $i = 0
  foreach ($img in @($p.images)) {
    if (-not $img) { continue }
    if ("$img" -match '^https://') { $imageUrls += "$img"; continue }
    if ("$img" -match '^data:image/') {
      try {
        $i++
        $b64 = ("$img" -split ',', 2)[1]
        $bytes = [Convert]::FromBase64String($b64)
        $full = Upload-Image $token $bytes ("omnilist-$i")
        if ($full) { $imageUrls += "$full" }
      } catch { return @{ ok = $false; step = "image_upload"; error = "image_upload_failed"; message = $_.Exception.Message; sku = $sku; offerId = $offerId } }
    }
  }
  if (-not $imageUrls.Count) { return @{ ok = $false; step = "images"; error = "no_images"; message = "eBay requires at least one photo. Add an image to the listing."; sku = $sku; offerId = $offerId } }

  $cond = if ($script:CONDITION_MAP.ContainsKey("$($p.condition)")) { $script:CONDITION_MAP["$($p.condition)"] } elseif ($p.condition) { "$($p.condition)" } else { "USED_GOOD" }
  $qty = if ($p.quantity) { [int]$p.quantity } else { 1 }
  $desc = if ($p.description) { "$($p.description)" } else { "$($p.title)" }

  $invBody = @{
    availability = @{ shipToLocationAvailability = @{ quantity = $qty } }
    condition    = $cond
    product      = @{ title = "$($p.title)"; description = $desc; imageUrls = $imageUrls }
  }
  if ($p.brand) { $invBody.product.brand = "$($p.brand)" }
  $aspects = @{}
  if ($p.brand) { $aspects["Brand"] = @("$($p.brand)") }
  if ($p.aspects) {
    foreach ($prop in $p.aspects.PSObject.Properties) {
      $v = $prop.Value
      if ($v -is [System.Array]) { $aspects[$prop.Name] = @($v | ForEach-Object { "$_" }) }
      elseif ($null -ne $v -and "$v" -ne "") { $aspects[$prop.Name] = @("$v") }
    }
  }
  if ($aspects.Count) { $invBody.product.aspects = $aspects }
  # createOrReplaceInventoryItem is idempotent for the same SKU.
  $r1 = Ebay-Json "PUT" ("$base/sell/inventory/v1/inventory_item/" + [uri]::EscapeDataString($sku)) $token $invBody $h
  if (-not $r1.ok) { return @{ ok = $false; step = "inventory_item"; status = $r1.status; error = (Parse-EbayErr $r1.body); sku = $sku; offerId = $offerId; imageUrls = $imageUrls } }

  $price = ([double]$p.price).ToString("0.00", [Globalization.CultureInfo]::InvariantCulture)
  $details = @{
    availableQuantity = $qty; categoryId = "$cat"
    listingDescription = $desc
    listingPolicies = @{ fulfillmentPolicyId = $ful; paymentPolicyId = $pay; returnPolicyId = $ret }
    pricingSummary = @{ price = @{ value = $price; currency = $info.currency } }
    merchantLocationKey = $loc
  }

  if (-not $offerId) { $offerId = Find-OfferId $token $sku }
  if ($offerId) {
    # Update the existing offer; if it is already live this updates the listing.
    $r2 = Ebay-Json "PUT" ("$base/sell/inventory/v1/offer/" + [uri]::EscapeDataString($offerId)) $token $details $h
    if (-not $r2.ok) { return @{ ok = $false; step = "offer_update"; status = $r2.status; error = (Parse-EbayErr $r2.body); sku = $sku; offerId = $offerId; imageUrls = $imageUrls } }
    $o = Get-Offer $token $offerId
    if ($o -and "$($o.status)" -eq "PUBLISHED" -and $o.listing -and $o.listing.listingId) {
      $lid = "$($o.listing.listingId)"
      return @{ ok = $true; updated = $true; listingId = $lid; offerId = $offerId; sku = $sku; categoryId = "$cat"; imageUrls = $imageUrls; url = (Ebay-WebHost) + "/itm/$lid" }
    }
  } else {
    $create = $details.Clone()
    $create.sku = $sku; $create.marketplaceId = $mk; $create.format = "FIXED_PRICE"
    $r2 = Ebay-Json "POST" "$base/sell/inventory/v1/offer" $token $create $h
    if (-not $r2.ok) { return @{ ok = $false; step = "offer"; status = $r2.status; error = (Parse-EbayErr $r2.body); sku = $sku; imageUrls = $imageUrls } }
    $offerId = "$($r2.data.offerId)"
  }

  $r3 = Ebay-Json "POST" ("$base/sell/inventory/v1/offer/" + [uri]::EscapeDataString($offerId) + "/publish") $token @{} $h
  if (-not $r3.ok) { return @{ ok = $false; step = "publish"; status = $r3.status; error = (Parse-EbayErr $r3.body); sku = $sku; offerId = $offerId; imageUrls = $imageUrls } }
  $lid = "$($r3.data.listingId)"
  return @{ ok = $true; listingId = $lid; offerId = $offerId; sku = $sku; categoryId = "$cat"; imageUrls = $imageUrls; url = (Ebay-WebHost) + "/itm/$lid" }
}

# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------
function Write-Json($res, $obj, $status) {
  if ($status) { $res.StatusCode = $status }
  $res.ContentType = "application/json; charset=utf-8"
  $res.Headers.Add("Cache-Control", "no-store")
  $res.Headers.Add("X-Content-Type-Options", "nosniff")
  $json  = ($obj | ConvertTo-Json -Depth 10 -Compress)
  $bytes = $UTF8.GetBytes($json)
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

$WRITE_ENDPOINTS = @("/api/ebay/publish", "/api/ebay/auth/exchange", "/api/ebay/auth/disconnect", "/api/ebay/location/create")

function Handle-Api($req, $res) {
  $path = $req.Url.AbsolutePath

  # Only this app may call the API: reject other origins / cross-site requests.
  $origin = "$($req.Headers["Origin"])"
  $site = "$($req.Headers["Sec-Fetch-Site"])"
  if (($origin -and $origin -ne $script:origin) -or ($site -and $site -ne "same-origin" -and $site -ne "none")) {
    Write-Json $res @{ ok = $false; error = "forbidden_origin" } 403; return
  }
  # State-changing endpoints: POST with a JSON body only (blocks simple cross-site forms).
  if ($WRITE_ENDPOINTS -contains $path) {
    if ($req.HttpMethod -ne "POST") { Write-Json $res @{ ok = $false; error = "method_not_allowed" } 405; return }
    if (-not ("$($req.ContentType)" -like "application/json*")) { Write-Json $res @{ ok = $false; error = "unsupported_media_type" } 415; return }
  }
  Resolve-Market $req

  if ($path -eq "/api/status") {
    Write-Json $res @{
      ok   = $true
      ebay = @{
        configured         = (Ebay-Configured)
        redirectConfigured = [bool]$script:ebay.redirectUri
        userAuthorized     = (User-Authorized)
        environment        = $script:ebay.env
        marketplace        = $script:market
        currency           = (Market-Info).currency
        marketplacePinned  = [bool]$script:ebay.marketplace
      }
    }
    return
  }
  if ($path -eq "/api/ebay/search") {
    if (-not (Ebay-Configured)) {
      Write-Json $res @{ ok = $false; error = "ebay_not_configured"; message = "Create ebay.config.json with clientId + clientSecret (see EBAY_SETUP.md)." } 503
      return
    }
    $q = $req.QueryString["q"]
    if (-not $q) { Write-Json $res @{ ok = $false; error = "missing_q" } 400; return }
    $lim = 8
    if ($req.QueryString["limit"]) { [void][int]::TryParse($req.QueryString["limit"], [ref]$lim) }
    if ($lim -le 0 -or $lim -gt 50) { $lim = 8 }
    try {
      $items = @(Search-Ebay $q $lim)
      Write-Json $res @{ ok = $true; environment = $script:ebay.env; marketplace = $script:market; currency = (Market-Info).currency; query = $q; count = $items.Count; items = $items }
    } catch {
      $msg = $_.Exception.Message
      $hint = ""
      if ($msg -match "401|invalid_client|Unauthorized") { $hint = "Check your clientId/clientSecret and that they match the environment ($($script:ebay.env))." }
      Write-Json $res @{ ok = $false; error = "ebay_request_failed"; message = $msg; hint = $hint } 502
    }
    return
  }
  if ($path -eq "/api/ebay/auth/url") {
    if (-not (Ebay-Configured)) { Write-Json $res @{ ok = $false; error = "ebay_not_configured" } 503; return }
    if (-not $script:ebay.redirectUri) { Write-Json $res @{ ok = $false; error = "no_redirect_uri"; message = "Add redirectUri (your RuName) to ebay.config.json - see EBAY_SETUP.md." } 400; return }
    Write-Json $res @{ ok = $true; url = (Get-AuthUrl) }
    return
  }
  if ($path -eq "/api/ebay/auth/exchange") {
    $body = Read-Body $req
    $raw = $null
    if ($body) { $raw = if ($body.redirect) { "$($body.redirect)" } else { "$($body.code)" } }
    if (-not $raw -or $raw -notmatch 'code=([^&#\s]+)') { Write-Json $res @{ ok = $false; error = "missing_code"; message = "Paste the full address from your browser's address bar after you clicked 'I agree'." } 400; return }
    $code = [uri]::UnescapeDataString($matches[1])
    if ($raw -notmatch 'state=([^&#\s]+)') { Write-Json $res @{ ok = $false; error = "missing_state"; message = "Paste the full address (it must include the state=... part)." } 400; return }
    $state = [uri]::UnescapeDataString($matches[1])
    $fresh = ((Get-Date) - $script:oauthStateAt).TotalMinutes -lt 20
    if (-not $script:oauthState -or $state -ne $script:oauthState -or -not $fresh) {
      Write-Json $res @{ ok = $false; error = "state_mismatch"; message = "That sign-in link expired or didn't come from this OmniList window. Click Connect again." } 400; return
    }
    $script:oauthState = $null   # one use only
    $r = Exchange-Code $code
    if ($r.ok) { Write-Json $res @{ ok = $true; authorized = $true } }
    else { Write-Json $res @{ ok = $false; error = "exchange_failed"; message = $(if ($r.error) { $r.error } else { "Authorization failed - the code may be expired, or the RuName/environment may not match your keyset." }) } 502 }
    return
  }
  if ($path -eq "/api/ebay/auth/disconnect") {
    Disconnect-User
    Write-Json $res @{ ok = $true; authorized = $false }
    return
  }
  if ($path -eq "/api/ebay/account") {
    if (-not (User-Authorized)) { Write-Json $res @{ ok = $false; error = "not_authorized" } 401; return }
    try {
      $a = Get-Account
      $missing = @()
      if (-not $a.fulfillment.Count) { $missing += "shipping (fulfillment) policy" }
      if (-not $a.payment.Count) { $missing += "payment policy" }
      if (-not $a.return.Count) { $missing += "return policy" }
      if (-not $a.locations.Count) { $missing += "inventory location" }
      Write-Json $res @{
        ok = $true; ready = ($missing.Count -eq 0); missing = $missing
        counts = @{ fulfillment = $a.fulfillment.Count; payment = $a.payment.Count; return = $a.return.Count; locations = $a.locations.Count }
      }
    } catch { Write-Json $res @{ ok = $false; error = "account_failed"; message = $_.Exception.Message } 502 }
    return
  }
  if ($path -eq "/api/ebay/publish") {
    if (-not (Ebay-Configured)) { Write-Json $res @{ ok = $false; error = "ebay_not_configured" } 503; return }
    if (-not (User-Authorized)) { Write-Json $res @{ ok = $false; error = "not_authorized"; message = "Connect your eBay seller account first (Marketplaces screen)." } 401; return }
    $body = Read-Body $req
    if (-not $body -or -not $body.title) { Write-Json $res @{ ok = $false; error = "bad_request"; message = "Missing listing data." } 400; return }
    try { Write-Json $res (Publish-Listing $body) }
    catch {
      $m = $_.Exception.Message
      if ($m -eq "not_authorized") { Write-Json $res @{ ok = $false; error = "not_authorized" } 401 }
      else { Write-Json $res @{ ok = $false; step = "exception"; error = $m } 500 }
    }
    return
  }
  if ($path -eq "/api/ebay/aspects") {
    if (-not (User-Authorized)) { Write-Json $res @{ ok = $false; error = "not_authorized" } 401; return }
    try {
      $token = Get-UserToken
      $cat = if ($req.QueryString["category"]) { $req.QueryString["category"] } elseif ($req.QueryString["q"]) { Get-CategoryId $token $req.QueryString["q"] } else { $null }
      if (-not $cat) { Write-Json $res @{ ok = $false; error = "no_category" }; return }
      Write-Json $res @{ ok = $true; categoryId = "$cat"; aspects = @(Get-Aspects $token $cat) }
    } catch { Write-Json $res @{ ok = $false; error = "aspects_failed"; message = $_.Exception.Message } 502 }
    return
  }
  if ($path -eq "/api/ebay/location/create") {
    if (-not (User-Authorized)) { Write-Json $res @{ ok = $false; error = "not_authorized" } 401; return }
    $body = Read-Body $req
    if (-not $body -or -not $body.country -or -not $body.postalCode) { Write-Json $res @{ ok = $false; error = "bad_request"; message = "country and postalCode are required." } 400; return }
    try { Write-Json $res (Create-Location $body) }
    catch { Write-Json $res @{ ok = $false; error = "exception"; message = $_.Exception.Message } 500 }
    return
  }

  Write-Json $res @{ ok = $false; error = "unknown_endpoint"; path = $path } 404
}

# Only these file types are ever served; dot-files/folders (.git, .gitignore),
# 8.3 short names (~) and NTFS streams (:) are refused.
$mime = @{
  ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
  ".svg" = "image/svg+xml"; ".png" = "image/png"; ".jpg" = "image/jpeg"; ".jpeg" = "image/jpeg"
  ".gif" = "image/gif"; ".ico" = "image/x-icon"; ".woff2" = "font/woff2"
}
function Write-NotFound($res) {
  $res.StatusCode = 404
  $msg = $UTF8.GetBytes("404 Not Found")
  $res.OutputStream.Write($msg, 0, $msg.Length)
}
function Handle-Static($req, $res) {
  $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart("/"))
  if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
  foreach ($seg in ($rel -split '[\\/]')) {
    if ($seg.StartsWith(".") -or $seg.Contains("~") -or $seg.Contains(":")) { Write-NotFound $res; return }
  }
  $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
  if (-not $full.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { $res.StatusCode = 403; return }
  $ext = [System.IO.Path]::GetExtension($full).ToLower()
  if (-not $mime.ContainsKey($ext)) { Write-NotFound $res; return }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { Write-NotFound $res; return }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $res.ContentType = $mime[$ext]
  $res.Headers.Add("Cache-Control", "no-cache")
  $res.Headers.Add("X-Content-Type-Options", "nosniff")
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
Load-EbayConfig

# A failed Start() disposes the HttpListener, so use a fresh one per port.
$ports = 8080, 8081, 8090, 3000, 5500
$listener = $null
$bound = $null
foreach ($p in $ports) {
  $l = New-Object System.Net.HttpListener
  try { $l.Prefixes.Add("http://localhost:$p/"); $l.Start(); $listener = $l; $bound = $p; break }
  catch { try { $l.Close() } catch {} }
}
if (-not $bound) {
  Write-Host "ERROR: could not bind any of: $($ports -join ', ')" -ForegroundColor Red
  Read-Host "Press Enter to exit"; exit 1
}
$script:origin = "http://localhost:$bound"

$url = "http://localhost:$bound/"
Write-Host ""
Write-Host "  OmniList running at:  $url" -ForegroundColor Green
if (Ebay-Configured) {
  $mkText = if ($script:ebay.marketplace) { $script:ebay.marketplace } else { "from the app's region" }
  Write-Host "  eBay: LIVE ($($script:ebay.env), marketplace $mkText)" -ForegroundColor Cyan
} else {
  Write-Host "  eBay: not connected (no ebay.config.json yet - see EBAY_SETUP.md)" -ForegroundColor DarkGray
}
Write-Host "  (close this window or press Ctrl+C to stop)" -ForegroundColor DarkGray
Write-Host ""
if (-not $NoOpen) { try { Start-Process $url } catch { Write-Host "Open $url in your browser." } }

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $req = $ctx.Request; $res = $ctx.Response
  try {
    if ($req.Url.AbsolutePath -like "/api/*") { Handle-Api $req $res }
    else { Handle-Static $req $res }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.Close() } catch {}
  }
}
