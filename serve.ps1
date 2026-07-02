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
# ===========================================================================
param([switch]$NoOpen)   # -NoOpen skips auto-launching the browser
$ErrorActionPreference = "Stop"

# eBay requires TLS 1.2; Windows PowerShell 5.1 may default to older protocols.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootFull = [System.IO.Path]::GetFullPath($root)

# ---------------------------------------------------------------------------
# eBay config + token state
# ---------------------------------------------------------------------------
$script:ebay = @{
  env          = "sandbox"
  clientId     = $null
  clientSecret = $null
  redirectUri  = $null            # RuName (for seller OAuth consent) - Phase 2
  marketplace  = "EBAY_US"
  token        = $null            # app token (Browse)
  tokenExp     = [datetime]::MinValue
}
$script:EBAY_SCOPES = "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account"
$script:CONDITION_MAP = @{ "New"="NEW"; "Like new"="USED_EXCELLENT"; "Good"="USED_GOOD"; "Fair"="USED_ACCEPTABLE"; "Poor"="FOR_PARTS_OR_NOT_WORKING" }
$script:SITE_IDS = @{ "EBAY_US"="0"; "EBAY_GB"="3"; "EBAY_DE"="77"; "EBAY_AU"="15"; "EBAY_CA"="2"; "EBAY_FR"="71"; "EBAY_IT"="101"; "EBAY_ES"="186" }

function Load-EbayConfig {
  $cfgPath = Join-Path $root "ebay.config.json"
  if (Test-Path $cfgPath) {
    try {
      $c = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($c.environment)  { $script:ebay.env = "$($c.environment)".ToLower() }
      if ($c.clientId)     { $script:ebay.clientId = "$($c.clientId)".Trim() }
      if ($c.clientSecret) { $script:ebay.clientSecret = "$($c.clientSecret)".Trim() }
      if ($c.marketplaceId){ $script:ebay.marketplace = "$($c.marketplaceId)".Trim() }
      if ($c.redirectUri)  { $script:ebay.redirectUri = "$($c.redirectUri)".Trim() }
    } catch {
      Write-Host "  WARNING: ebay.config.json is invalid JSON - running in simulated mode." -ForegroundColor Yellow
    }
  }
}
function Ebay-Configured { return [bool]($script:ebay.clientId -and $script:ebay.clientSecret) }
function Ebay-Base {
  if ($script:ebay.env -eq "production") { "https://api.ebay.com" } else { "https://api.sandbox.ebay.com" }
}

function Get-EbayAppToken {
  if ($script:ebay.token -and (Get-Date) -lt $script:ebay.tokenExp) { return $script:ebay.token }
  $base = Ebay-Base
  $cred = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('{0}:{1}' -f $script:ebay.clientId, $script:ebay.clientSecret)))
  $body = 'grant_type=client_credentials&scope=' + [uri]::EscapeDataString('https://api.ebay.com/oauth/api_scope')
  $resp = Invoke-RestMethod -Method Post -Uri "$base/identity/v1/oauth2/token" `
    -Headers @{ Authorization = "Basic $cred" } -ContentType "application/x-www-form-urlencoded" -Body $body
  $script:ebay.token    = $resp.access_token
  $script:ebay.tokenExp = (Get-Date).AddSeconds([int]$resp.expires_in - 120)
  return $script:ebay.token
}

function Search-Ebay($q, $limit) {
  $token = Get-EbayAppToken
  $base  = Ebay-Base
  $enc   = [uri]::EscapeDataString($q)
  $uri   = "$base/buy/browse/v1/item_summary/search?q=$enc&limit=$limit"
  $resp  = Invoke-RestMethod -Method Get -Uri $uri `
    -Headers @{ Authorization = "Bearer $token"; "X-EBAY-C-MARKETPLACE-ID" = $script:ebay.marketplace }
  $items = @()
  if ($resp.itemSummaries) {
    foreach ($it in $resp.itemSummaries) {
      $price = $null; $cur = "USD"
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
# Phase 2 - seller OAuth + real publishing (Sell / Inventory API)
# ---------------------------------------------------------------------------
function Ebay-AuthHost { if ($script:ebay.env -eq "production") { "https://auth.ebay.com" } else { "https://auth.sandbox.ebay.com" } }
function Ebay-WebHost  { if ($script:ebay.env -eq "production") { "https://www.ebay.com" } else { "https://www.sandbox.ebay.com" } }
function Tokens-Path   { Join-Path $root "ebay.tokens.json" }

# Capture eBay JSON error bodies (Invoke-RestMethod throws on non-2xx).
function Invoke-EbayJson($method, $url, $token, $bodyObj, $extraHeaders) {
  $headers = @{ Authorization = "Bearer $token" }
  if ($extraHeaders) { foreach ($k in $extraHeaders.Keys) { $headers[$k] = $extraHeaders[$k] } }
  $p = @{ Method = $method; Uri = $url; Headers = $headers }
  if ($null -ne $bodyObj) { $p.Body = ($bodyObj | ConvertTo-Json -Depth 12); $p.ContentType = "application/json" }
  try { return @{ ok = $true; data = (Invoke-RestMethod @p) } }
  catch {
    $r = $_.Exception.Response; $b = $null; $c = $null
    if ($r) { try { $c = [int]$r.StatusCode } catch {}; try { $sr = New-Object System.IO.StreamReader($r.GetResponseStream()); $b = $sr.ReadToEnd() } catch {} }
    return @{ ok = $false; status = $c; error = $_.Exception.Message; body = $b }
  }
}
function Invoke-EbayForm($url, $cred, $body) {
  try { return @{ ok = $true; data = (Invoke-RestMethod -Method Post -Uri $url -Headers @{ Authorization = "Basic $cred" } -ContentType "application/x-www-form-urlencoded" -Body $body) } }
  catch {
    $r = $_.Exception.Response; $b = $null; $c = $null
    if ($r) { try { $c = [int]$r.StatusCode } catch {}; try { $sr = New-Object System.IO.StreamReader($r.GetResponseStream()); $b = $sr.ReadToEnd() } catch {} }
    return @{ ok = $false; status = $c; error = $_.Exception.Message; body = $b }
  }
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
  $sr = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
  $txt = $sr.ReadToEnd(); $sr.Close()
  if (-not $txt) { return $null }
  try { return ($txt | ConvertFrom-Json) } catch { return $null }
}

function Get-AuthUrl {
  $scope = [uri]::EscapeDataString($script:EBAY_SCOPES)
  $ru    = [uri]::EscapeDataString($script:ebay.redirectUri)
  $cid   = [uri]::EscapeDataString($script:ebay.clientId)
  return (Ebay-AuthHost) + "/oauth2/authorize?client_id=$cid&response_type=code&redirect_uri=$ru&scope=$scope&prompt=login"
}
function Load-AllTokens { $p = Tokens-Path; if (Test-Path $p) { try { return (Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null } }; return $null }
function Save-UserTokens($obj) {
  $all = Load-AllTokens
  if (-not $all) { $all = New-Object psobject }
  $all | Add-Member -NotePropertyName $script:ebay.env -NotePropertyValue $obj -Force
  ($all | ConvertTo-Json -Depth 8) | Out-File -FilePath (Tokens-Path) -Encoding UTF8
}
function Get-EnvTokens { $all = Load-AllTokens; if ($all -and ($all.PSObject.Properties.Name -contains $script:ebay.env)) { return $all.$($script:ebay.env) }; return $null }
function User-Authorized { $t = Get-EnvTokens; return [bool]($t -and $t.refresh_token) }
function Disconnect-User {
  $all = Load-AllTokens
  if ($all -and ($all.PSObject.Properties.Name -contains $script:ebay.env)) { $all.PSObject.Properties.Remove($script:ebay.env); ($all | ConvertTo-Json -Depth 8) | Out-File -FilePath (Tokens-Path) -Encoding UTF8 }
}

function Exchange-Code($code) {
  $cred = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('{0}:{1}' -f $script:ebay.clientId, $script:ebay.clientSecret)))
  $body = 'grant_type=authorization_code&code=' + [uri]::EscapeDataString($code) + '&redirect_uri=' + [uri]::EscapeDataString($script:ebay.redirectUri)
  $r = Invoke-EbayForm ((Ebay-Base) + "/identity/v1/oauth2/token") $cred $body
  if (-not $r.ok) { return @{ ok = $false; error = (Parse-EbayErr $r.body); status = $r.status } }
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
  $cred = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('{0}:{1}' -f $script:ebay.clientId, $script:ebay.clientSecret)))
  $body = 'grant_type=refresh_token&refresh_token=' + [uri]::EscapeDataString($t.refresh_token) + '&scope=' + [uri]::EscapeDataString($script:EBAY_SCOPES)
  $r = Invoke-EbayForm ((Ebay-Base) + "/identity/v1/oauth2/token") $cred $body
  if (-not $r.ok) { throw ("refresh_failed: " + (Parse-EbayErr $r.body)) }
  $t2 = [pscustomobject]@{ refresh_token = $t.refresh_token; refresh_exp = $t.refresh_exp; access_token = $r.data.access_token; access_exp = (Get-Date).AddSeconds([int]$r.data.expires_in - 120).ToString("o") }
  Save-UserTokens $t2
  return $r.data.access_token
}

function Get-Account {
  $token = Get-UserToken
  $base = Ebay-Base; $mk = $script:ebay.marketplace
  $ful = @(); $pay = @(); $ret = @(); $loc = @()
  $rf = Invoke-EbayJson "GET" "$base/sell/account/v1/fulfillment_policy?marketplace_id=$mk" $token $null $null
  if ($rf.ok -and $rf.data.fulfillmentPolicies) { $ful = @($rf.data.fulfillmentPolicies) }
  $rp = Invoke-EbayJson "GET" "$base/sell/account/v1/payment_policy?marketplace_id=$mk" $token $null $null
  if ($rp.ok -and $rp.data.paymentPolicies) { $pay = @($rp.data.paymentPolicies) }
  $rr = Invoke-EbayJson "GET" "$base/sell/account/v1/return_policy?marketplace_id=$mk" $token $null $null
  if ($rr.ok -and $rr.data.returnPolicies) { $ret = @($rr.data.returnPolicies) }
  $rl = Invoke-EbayJson "GET" "$base/sell/inventory/v1/location" $token $null $null
  if ($rl.ok -and $rl.data.locations) { $loc = @($rl.data.locations) }
  return @{ fulfillment = $ful; payment = $pay; return = $ret; locations = $loc }
}

function Get-CategoryId($token, $title) {
  $base = Ebay-Base; $mk = $script:ebay.marketplace
  $tr = Invoke-EbayJson "GET" "$base/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=$mk" $token $null $null
  if (-not $tr.ok -or -not $tr.data.categoryTreeId) { return $null }
  $enc = [uri]::EscapeDataString($title)
  $sg = Invoke-EbayJson "GET" "$base/commerce/taxonomy/v1/category_tree/$($tr.data.categoryTreeId)/get_category_suggestions?q=$enc" $token $null $null
  if ($sg.ok -and $sg.data.categorySuggestions -and $sg.data.categorySuggestions.Count -gt 0) { return $sg.data.categorySuggestions[0].category.categoryId }
  return $null
}

# Required item specifics (aspects) for a category.
function Get-Aspects($token, $catId) {
  $base = Ebay-Base; $mk = $script:ebay.marketplace
  $tr = Invoke-EbayJson "GET" "$base/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=$mk" $token $null $null
  if (-not $tr.ok -or -not $tr.data.categoryTreeId) { return @() }
  $url = "$base/commerce/taxonomy/v1/category_tree/$($tr.data.categoryTreeId)/get_item_aspects_for_category?category_id=$catId"
  $r = Invoke-EbayJson "GET" $url $token $null $null
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
  $base = Ebay-Base
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
  $r = Invoke-EbayJson "POST" "$base/sell/inventory/v1/location/$key" $token $body @{ "Content-Language" = "en-US" }
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
  $w = { param($s) $b = [Text.Encoding]::UTF8.GetBytes($s); $ms.Write($b, 0, $b.Length) }
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
  $site = if ($script:SITE_IDS.ContainsKey($script:ebay.marketplace)) { $script:SITE_IDS[$script:ebay.marketplace] } else { "0" }
  $headers = @{
    "X-EBAY-API-CALL-NAME" = "UploadSiteHostedPictures"
    "X-EBAY-API-COMPATIBILITY-LEVEL" = "1193"
    "X-EBAY-API-SITEID" = $site
    "X-EBAY-API-DETAIL-LEVEL" = "0"
    "X-EBAY-API-IAF-TOKEN" = $token
  }
  $resp = Invoke-RestMethod -Method Post -Uri ((Ebay-Base) + "/ws/api.dll") -Headers $headers -ContentType "multipart/form-data; boundary=$boundary" -Body $body
  $x = if ($resp -is [string]) { [xml]$resp } else { $resp }
  $ack = $x.UploadSiteHostedPicturesResponse.Ack
  if ($ack -eq "Failure") {
    $em = $x.UploadSiteHostedPicturesResponse.Errors
    throw ("EPS upload failed: " + ($(if ($em) { $em.LongMessage } else { "unknown" })))
  }
  return $x.UploadSiteHostedPicturesResponse.SiteHostedPictureDetails.FullURL
}

# Full publish pipeline: inventory_item -> offer -> publish.
function Publish-Listing($p) {
  $token = Get-UserToken
  $base = Ebay-Base
  $h = @{ "Content-Language" = "en-US" }

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
  if ($missing.Count) { return @{ ok = $false; step = "account_setup"; error = "missing_prerequisites"; missing = $missing } }

  $cat = if ($p.categoryId) { "$($p.categoryId)" } else { Get-CategoryId $token $p.title }
  if (-not $cat) { return @{ ok = $false; step = "category"; error = "no_category"; message = "Could not resolve an eBay category from the title. Set a categoryId." } }

  $imageUrls = @()
  $i = 0
  foreach ($img in @($p.images)) {
    if (-not $img) { continue }
    if ($img -match '^https?://') { $imageUrls += $img; continue }
    if ($img -match '^data:') {
      try {
        $i++
        $b64 = ($img -split ',', 2)[1]
        $bytes = [Convert]::FromBase64String($b64)
        $full = Upload-Image $token $bytes ("omnilist-$i")
        if ($full) { $imageUrls += "$full" }
      } catch { return @{ ok = $false; step = "image_upload"; error = "image_upload_failed"; message = $_.Exception.Message } }
    }
  }
  if (-not $imageUrls.Count) { return @{ ok = $false; step = "images"; error = "no_images"; message = "eBay requires at least one photo. Add an image to the listing." } }

  $cond = if ($script:CONDITION_MAP.ContainsKey("$($p.condition)")) { $script:CONDITION_MAP["$($p.condition)"] } elseif ($p.condition) { "$($p.condition)" } else { "USED_GOOD" }
  $qty = if ($p.quantity) { [int]$p.quantity } else { 1 }
  $sku = "OMNI-" + ([guid]::NewGuid().ToString("N").Substring(0, 12))

  $invBody = @{
    availability = @{ shipToLocationAvailability = @{ quantity = $qty } }
    condition    = $cond
    product      = @{ title = $p.title; description = $(if ($p.description) { $p.description } else { $p.title }); imageUrls = $imageUrls }
  }
  if ($p.brand) { $invBody.product.brand = $p.brand }
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
  $r1 = Invoke-EbayJson "PUT" "$base/sell/inventory/v1/inventory_item/$sku" $token $invBody $h
  if (-not $r1.ok) { return @{ ok = $false; step = "inventory_item"; status = $r1.status; error = (Parse-EbayErr $r1.body) } }

  $price = ([double]$p.price).ToString("0.00", [Globalization.CultureInfo]::InvariantCulture)
  $offerBody = @{
    sku = $sku; marketplaceId = $script:ebay.marketplace; format = "FIXED_PRICE"
    availableQuantity = $qty; categoryId = "$cat"
    listingDescription = $(if ($p.description) { $p.description } else { $p.title })
    listingPolicies = @{ fulfillmentPolicyId = $ful; paymentPolicyId = $pay; returnPolicyId = $ret }
    pricingSummary = @{ price = @{ value = $price; currency = $(if ($p.currency) { $p.currency } else { "USD" }) } }
    merchantLocationKey = $loc
  }
  $r2 = Invoke-EbayJson "POST" "$base/sell/inventory/v1/offer" $token $offerBody $h
  if (-not $r2.ok) { return @{ ok = $false; step = "offer"; status = $r2.status; error = (Parse-EbayErr $r2.body) } }
  $offerId = $r2.data.offerId

  $r3 = Invoke-EbayJson "POST" "$base/sell/inventory/v1/offer/$offerId/publish" $token @{} $h
  if (-not $r3.ok) { return @{ ok = $false; step = "publish"; status = $r3.status; error = (Parse-EbayErr $r3.body); offerId = $offerId } }

  return @{ ok = $true; listingId = "$($r3.data.listingId)"; offerId = "$offerId"; sku = "$sku"; categoryId = "$cat"; imageCount = $imageUrls.Count; url = (Ebay-WebHost) + "/itm/$($r3.data.listingId)" }
}

# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------
function Write-Json($res, $obj, $status) {
  if ($status) { $res.StatusCode = $status }
  $res.ContentType = "application/json; charset=utf-8"
  $res.Headers.Add("Cache-Control", "no-store")
  $json  = ($obj | ConvertTo-Json -Depth 10 -Compress)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Handle-Api($req, $res) {
  $path = $req.Url.AbsolutePath
  if ($path -eq "/api/status") {
    Write-Json $res @{
      ok   = $true
      ebay = @{
        configured        = (Ebay-Configured)
        redirectConfigured = [bool]$script:ebay.redirectUri
        userAuthorized    = (User-Authorized)
        environment       = $script:ebay.env
        marketplace       = $script:ebay.marketplace
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
      Write-Json $res @{ ok = $true; environment = $script:ebay.env; query = $q; count = $items.Count; items = $items }
    } catch {
      $msg = $_.Exception.Message
      $hint = ""
      if ($msg -match "401|invalid_client|Unauthorized") { $hint = "Check your clientId/clientSecret and that they match the environment ($($script:ebay.env))." }
      Write-Json $res @{ ok = $false; error = "ebay_request_failed"; message = $msg; hint = $hint } 502
    }
    return
  }
  # ----- Phase 2: seller OAuth -----
  if ($path -eq "/api/ebay/auth/url") {
    if (-not (Ebay-Configured)) { Write-Json $res @{ ok = $false; error = "ebay_not_configured" } 503; return }
    if (-not $script:ebay.redirectUri) { Write-Json $res @{ ok = $false; error = "no_redirect_uri"; message = "Add redirectUri (your RuName) to ebay.config.json - see EBAY_SETUP.md." } 400; return }
    Write-Json $res @{ ok = $true; url = (Get-AuthUrl) }
    return
  }
  if ($path -eq "/api/ebay/auth/exchange") {
    $body = Read-Body $req
    $code = $null
    if ($body) { $code = if ($body.redirect) { $body.redirect } else { $body.code } }
    if ($code -and ($code -match 'code=([^&]+)')) { $code = [uri]::UnescapeDataString($matches[1]) }
    if (-not $code) { Write-Json $res @{ ok = $false; error = "missing_code"; message = "Paste the URL (or code) eBay redirected you to." } 400; return }
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

$mime = @{
  ".html" = "text/html; charset=utf-8"; ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"; ".json" = "application/json; charset=utf-8"
  ".svg" = "image/svg+xml"; ".png" = "image/png"; ".jpg" = "image/jpeg"; ".jpeg" = "image/jpeg"
  ".gif" = "image/gif"; ".ico" = "image/x-icon"; ".woff2" = "font/woff2"
  ".txt" = "text/plain; charset=utf-8"; ".md" = "text/plain; charset=utf-8"
}
function Handle-Static($req, $res) {
  $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart("/"))
  if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
  $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
  if (-not $full.StartsWith($rootFull)) { $res.StatusCode = 403; return }
  # never serve secrets
  $fn = [System.IO.Path]::GetFileName($full)
  if ($fn -ieq "ebay.config.json" -or $fn -ieq "ebay.tokens.json") { $res.StatusCode = 403; return }
  if (Test-Path $full -PathType Leaf) {
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] }
    $res.Headers.Add("Cache-Control", "no-cache")
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
    $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
    $res.OutputStream.Write($msg, 0, $msg.Length)
  }
}

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
Load-EbayConfig

$ports = 8080, 8081, 8090, 3000, 5500
$listener = New-Object System.Net.HttpListener
$bound = $null
foreach ($p in $ports) {
  try { $listener.Prefixes.Clear(); $listener.Prefixes.Add("http://localhost:$p/"); $listener.Start(); $bound = $p; break }
  catch { }
}
if (-not $bound) {
  Write-Host "ERROR: could not bind any of: $($ports -join ', ')" -ForegroundColor Red
  Read-Host "Press Enter to exit"; exit 1
}

$url = "http://localhost:$bound/"
Write-Host ""
Write-Host "  OmniList running at:  $url" -ForegroundColor Green
if (Ebay-Configured) {
  Write-Host "  eBay: LIVE ($($script:ebay.env), $($script:ebay.marketplace))" -ForegroundColor Cyan
} else {
  Write-Host "  eBay: simulated (no ebay.config.json yet - see EBAY_SETUP.md)" -ForegroundColor DarkGray
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
