<#
.SYNOPSIS
  Delete leftover Cloudflare Worker + D1 from the old screenshots stack.

.DESCRIPTION
  Needs CLOUDFLARE_API_TOKEN (and ideally CLOUDFLARE_ACCOUNT_ID) in the environment
  or in api/.deploy-secrets.env. After this succeeds, revoke and delete that API
  token in the Cloudflare dashboard. Stack has already moved to AWS; this is legacy cleanup.

.EXAMPLE
  $env:CLOUDFLARE_API_TOKEN = "..."
  $env:CLOUDFLARE_ACCOUNT_ID = "dc9bae83e7d1233d0d8cc674dfd30197"
  .\TearDownCloudflareScreengrabber.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SecretsFile = Join-Path $PSScriptRoot "api\.deploy-secrets.env"
$AccountFallback = "dc9bae83e7d1233d0d8cc674dfd30197"
$WorkerName = "baffledcat-screenshots"
$DbName = "baffledcat-shots"

function Get-SecretMap([string]$path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  Get-Content $path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    $map[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim()
  }
  return $map
}

$map = Get-SecretMap $SecretsFile
$token = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN")
if (-not $token -and $map.ContainsKey("CLOUDFLARE_API_TOKEN")) { $token = $map["CLOUDFLARE_API_TOKEN"] }
$account = [Environment]::GetEnvironmentVariable("CLOUDFLARE_ACCOUNT_ID")
if (-not $account -and $map.ContainsKey("CLOUDFLARE_ACCOUNT_ID")) { $account = $map["CLOUDFLARE_ACCOUNT_ID"] }
if (-not $account) { $account = $AccountFallback }

if (-not $token) {
  Write-Host "Set CLOUDFLARE_API_TOKEN (env or api/.deploy-secrets.env), then re-run." -ForegroundColor Yellow
  Write-Host "Or delete manually in the dashboard:"
  Write-Host "  Workers: $WorkerName"
  Write-Host "  D1:      $DbName"
  Write-Host "  Account: $account"
  exit 1
}

$headers = @{
  Authorization = "Bearer $token"
  "Content-Type" = "application/json"
}

Write-Host "Account $account"

# Worker
try {
  $scripts = Invoke-RestMethod -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$account/workers/scripts"
  $hit = @($scripts.result | Where-Object { $_.id -eq $WorkerName })
  if ($hit.Count -gt 0) {
    Invoke-RestMethod -Method Delete -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$account/workers/scripts/$WorkerName" | Out-Null
    Write-Host "Deleted Worker $WorkerName" -ForegroundColor Green
  } else {
    Write-Host "Worker $WorkerName not present" -ForegroundColor Green
  }
} catch {
  Write-Host ("Worker delete: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

# D1
try {
  $dbs = Invoke-RestMethod -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$account/d1/database"
  $db = @($dbs.result | Where-Object { $_.name -eq $DbName }) | Select-Object -First 1
  if ($db) {
    $uuid = $db.uuid
    Invoke-RestMethod -Method Delete -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$account/d1/database/$uuid" | Out-Null
    Write-Host "Deleted D1 $DbName ($uuid)" -ForegroundColor Green
  } else {
    Write-Host "D1 $DbName not present" -ForegroundColor Green
  }
} catch {
  Write-Host ("D1 delete: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

# Custom domain / route for shots.baffledcat.com may linger on the zone - best effort
Write-Host ""
Write-Host "If shots.baffledcat.com still points at a Cloudflare Worker route, remove that route in the dashboard."
Write-Host "Then revoke the Cloudflare API token."
Write-Host "Done."
