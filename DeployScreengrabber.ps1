<#
.SYNOPSIS
  Provision AWS infra for ScreenGrabber (baffledcat-screenshots) and deploy the Lambda API.

.DESCRIPTION
  - npm install + zip Lambda package (api/)
  - Ensure S3 bucket, DynamoDB tables, IAM role, Lambda, HTTP API
  - Request/wire ACM custom domain shots.baffledcat.com when cert is issued
  - Persist secrets in api/.deploy-secrets.env (gitignored)
  - Smoke-test /health

.PARAMETER SkipSecrets
  Do not create or update Lambda environment secrets.

.PARAMETER SkipDomain
  Do not attempt ACM / API Gateway custom-domain wiring.

.PARAMETER CloudflareTeardown
  Attempt legacy Cloudflare Worker/D1 teardown (off by default; stack already migrated).

.PARAMETER DryRun
  Print actions without creating resources or deploying.

.EXAMPLE
  .\DeployScreengrabber.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipSecrets,
  [switch]$SkipDomain,
  [switch]$CloudflareTeardown,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = $PSScriptRoot
$ApiDir = Join-Path $RepoRoot "api"
$SecretsFile = Join-Path $ApiDir ".deploy-secrets.env"
$StateFile = Join-Path $ApiDir ".deploy-state.json"
$ProductionConfigFile = Join-Path $ApiDir "config.production.json"

$Region = if ($env:AWS_REGION) { $env:AWS_REGION } elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION } else { "eu-west-2" }
$AccountId = $null
$FunctionName = "baffledcat-screenshots"
$RoleName = "baffledcat-screenshots-lambda"
$ApiName = "baffledcat-screenshots"
$BucketName = "baffledcat-shots"
$ShotsTable = "baffledcat-shots"
$TicketsTable = "baffledcat-shots-tickets"
$PublicHost = "shots.baffledcat.com"
$PreferredBaseUrl = "https://$PublicHost"
$CertArnPreferred = $null

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
  Write-Host "    $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
  Write-Host "    WARN: $msg" -ForegroundColor Yellow
}

function Write-TextFile([string]$path, [string]$content) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

function Assert-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $name"
  }
}

function Get-SecretMap([string]$path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  Get-Content $path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $map[$k] = $v
  }
  return $map
}

function Get-SecretValue([string]$key, $fileMap) {
  $fromEnv = [Environment]::GetEnvironmentVariable($key)
  if ($null -ne $fromEnv -and $fromEnv -ne "") { return $fromEnv }
  if ($fileMap -and $fileMap.ContainsKey($key) -and $fileMap[$key]) { return $fileMap[$key] }
  return $null
}

# Present (even empty) env/file values; $null only when unset.
function Get-SecretValueOrEmpty([string]$key, $fileMap) {
  $fromEnv = [Environment]::GetEnvironmentVariable($key)
  if ($null -ne $fromEnv) { return $fromEnv }
  if ($fileMap -and $fileMap.ContainsKey($key)) { return [string]$fileMap[$key] }
  return $null
}

function Save-Secrets($map) {
  $lines = @(
    "# Generated/updated by DeployScreengrabber.ps1  -  do not commit",
    "AWS_REGION=$Region"
  )
  foreach ($k in @("TICKET_HMAC_SECRET", "ADMIN_TOKEN", "TURNSTILE_SECRET", "DEV_BYPASS_TURNSTILE", "PUBLIC_BASE_URL")) {
    if ($map.ContainsKey($k) -and $map[$k]) {
      $lines += "$k=$($map[$k])"
    }
  }
  Write-TextFile $SecretsFile ($lines -join "`n")
}

function Save-State($obj) {
  Write-TextFile $StateFile ($obj | ConvertTo-Json -Depth 8)
}

function Load-State {
  $h = @{}
  if (-not (Test-Path $StateFile)) { return $h }
  $obj = Get-Content $StateFile -Raw | ConvertFrom-Json
  foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
  return $h
}

function To-AwsFileUri([string]$path, [string]$scheme = "file") {
  $full = [System.IO.Path]::GetFullPath($path) -replace '\\', '/'
  # AWS CLI on Windows accepts file://C:/... and fileb://C:/...
  return "{0}://{1}" -f $scheme, $full
}

function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [hashtable] -or $obj -is [System.Collections.IDictionary]) {
    if ($obj.ContainsKey($name)) { return $obj[$name] }
    return $null
  }
  $p = $obj.PSObject.Properties[$name]
  if ($null -ne $p) { return $p.Value }
  return $null
}

function Invoke-Aws {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs)
  Set-StrictMode -Off
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & aws @AwsArgs 2>&1
    $text = ($out | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = $text }
  } finally {
    $ErrorActionPreference = $prev
    Set-StrictMode -Version Latest
  }
}

function Require-AwsOk($result, [string]$what) {
  if ($result.ExitCode -ne 0) {
    Write-Host $result.Text
    throw "$what failed"
  }
}

Write-Host ""
Write-Host ("DeployScreengrabber - {0} -> {1}" -f $FunctionName, $PreferredBaseUrl) -ForegroundColor White
Write-Host ("Region: {0}" -f $Region)

Assert-Command "aws"
Assert-Command "npm"
Assert-Command "node"

# Load secrets
$fileMap = Get-SecretMap $SecretsFile
foreach ($k in @("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION")) {
  $v = Get-SecretValue $k $fileMap
  if ($v) { Set-Item -Path "Env:$k" -Value $v }
}
$env:AWS_DEFAULT_REGION = $Region
$env:AWS_REGION = $Region

Write-Step "AWS identity"
$idJson = Invoke-Aws sts get-caller-identity --output json
Require-AwsOk $idJson "sts get-caller-identity"
$id = $idJson.Text | ConvertFrom-Json
$AccountId = $id.Account
Write-Ok ("Account {0} ({1})" -f $AccountId, $id.Arn)

# ---------- Cloudflare teardown (opt-in; stack already on AWS) ----------
if ($CloudflareTeardown) {
  Write-Step "Cloudflare teardown (prior Worker/D1)"
  $cfToken = Get-SecretValue "CLOUDFLARE_API_TOKEN" $fileMap
  $cfAccount = Get-SecretValue "CLOUDFLARE_ACCOUNT_ID" $fileMap

  if (-not $cfToken) {
    Write-Warn "No CLOUDFLARE_API_TOKEN - skip remote CF delete."
    Write-Warn "Run .\TearDownCloudflareScreengrabber.ps1 with the token once, then revoke it."
  } elseif ($DryRun) {
    Write-Ok "[dry-run] would delete CF Worker + D1 using API token"
  } else {
    if (-not $cfAccount) { $cfAccount = "dc9bae83e7d1233d0d8cc674dfd30197" }
    $headers = @{ Authorization = "Bearer $cfToken"; "Content-Type" = "application/json" }
    try {
      $scripts = Invoke-RestMethod -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$cfAccount/workers/scripts"
      $hit = @($scripts.result | Where-Object { $_.id -eq "baffledcat-screenshots" })
      if ($hit.Count -gt 0) {
        Invoke-RestMethod -Method Delete -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$cfAccount/workers/scripts/baffledcat-screenshots" | Out-Null
        Write-Ok "Deleted Worker baffledcat-screenshots"
      } else {
        Write-Ok "Worker not present"
      }
      $dbs = Invoke-RestMethod -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$cfAccount/d1/database"
      $db = @($dbs.result | Where-Object { $_.name -eq "baffledcat-shots" }) | Select-Object -First 1
      if ($db) {
        Invoke-RestMethod -Method Delete -Headers $headers -Uri "https://api.cloudflare.com/client/v4/accounts/$cfAccount/d1/database/$($db.uuid)" | Out-Null
        Write-Ok "Deleted D1 baffledcat-shots"
      } else {
        Write-Ok "D1 not present"
      }
    } catch {
      Write-Warn ("CF API teardown: {0}" -f $_.Exception.Message)
    }
  }
}

# ---------- npm / zip ----------
function Invoke-CmdLine([string]$cmdLine, [string]$workDir) {
  # StrictMode + native stderr-as-ErrorRecord breaks WinPS 5.1 on npm/npx.
  Set-StrictMode -Off
  $prevEa = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/c", $cmdLine) `
      -WorkingDirectory $workDir `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outFile `
      -RedirectStandardError $errFile
    $text = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
    if ($text) { Write-Host $text }
    if ($p.ExitCode -ne 0) { throw "Command failed ($($p.ExitCode)): $cmdLine" }
  } finally {
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    $ErrorActionPreference = $prevEa
    Set-StrictMode -Version Latest
  }
}

Write-Step "Install + pack Lambda"
if ($DryRun) {
  Write-Ok "[dry-run] would npm install and pack function.zip"
} else {
  Invoke-CmdLine "npm install --no-audit --no-fund" $ApiDir
  Invoke-CmdLine "node scripts\pack.mjs" $ApiDir
  Write-Ok "function.zip ready"
}

$zipPath = Join-Path $ApiDir "function.zip"

# ---------- S3 ----------
Write-Step "S3 bucket '$BucketName'"
$bucketCheck = Invoke-Aws s3api head-bucket --bucket $BucketName
if ($bucketCheck.ExitCode -eq 0) {
  Write-Ok "exists"
} elseif ($DryRun) {
  Write-Ok "[dry-run] would create bucket"
} else {
  if ($Region -eq "us-east-1") {
    Require-AwsOk (Invoke-Aws s3api create-bucket --bucket $BucketName) "create-bucket"
  } else {
    Require-AwsOk (Invoke-Aws s3api create-bucket --bucket $BucketName --create-bucket-configuration "LocationConstraint=$Region") "create-bucket"
  }
  Require-AwsOk (Invoke-Aws s3api put-public-access-block --bucket $BucketName --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true") "public-access-block"
  Write-Ok "created (private)"
}

# ---------- DynamoDB ----------
Write-Step "DynamoDB tables"
function Ensure-Table([string]$name, [scriptblock]$create) {
  $desc = Invoke-Aws dynamodb describe-table --table-name $name --output json
  if ($desc.ExitCode -eq 0) {
    Write-Ok "$name exists"
    return
  }
  if ($DryRun) {
    Write-Ok "[dry-run] would create $name"
    return
  }
  & $create
  Write-Ok "creating $name..."
  Require-AwsOk (Invoke-Aws dynamodb wait table-exists --table-name $name) "wait $name"
}

Ensure-Table $ShotsTable {
  $tmp = Join-Path $env:TEMP "bc-shots-table.json"
  $doc = @{
    TableName = $ShotsTable
    BillingMode = "PAY_PER_REQUEST"
    AttributeDefinitions = @(
      @{ AttributeName = "id"; AttributeType = "S" },
      @{ AttributeName = "appStatus"; AttributeType = "S" },
      @{ AttributeName = "createdAt"; AttributeType = "N" },
      @{ AttributeName = "status"; AttributeType = "S" }
    )
    KeySchema = @(
      @{ AttributeName = "id"; KeyType = "HASH" }
    )
    GlobalSecondaryIndexes = @(
      @{
        IndexName = "appStatus-createdAt-index"
        KeySchema = @(
          @{ AttributeName = "appStatus"; KeyType = "HASH" },
          @{ AttributeName = "createdAt"; KeyType = "RANGE" }
        )
        Projection = @{ ProjectionType = "ALL" }
      },
      @{
        IndexName = "status-createdAt-index"
        KeySchema = @(
          @{ AttributeName = "status"; KeyType = "HASH" },
          @{ AttributeName = "createdAt"; KeyType = "RANGE" }
        )
        Projection = @{ ProjectionType = "ALL" }
      }
    )
  }
  Write-TextFile $tmp ($doc | ConvertTo-Json -Depth 10)
  Require-AwsOk (Invoke-Aws dynamodb create-table --cli-input-json (To-AwsFileUri $tmp)) "create-table $ShotsTable"
}

Ensure-Table $TicketsTable {
  $tmp = Join-Path $env:TEMP "bc-shots-tickets.json"
  $doc = @{
    TableName = $TicketsTable
    BillingMode = "PAY_PER_REQUEST"
    AttributeDefinitions = @(
      @{ AttributeName = "jti"; AttributeType = "S" }
    )
    KeySchema = @(
      @{ AttributeName = "jti"; KeyType = "HASH" }
    )
  }
  Write-TextFile $tmp ($doc | ConvertTo-Json -Depth 8)
  Require-AwsOk (Invoke-Aws dynamodb create-table --cli-input-json (To-AwsFileUri $tmp)) "create-table $TicketsTable"
  $null = Invoke-Aws dynamodb update-time-to-live --table-name $TicketsTable --time-to-live-specification "Enabled=true,AttributeName=expiresAt"
}

# ---------- IAM role ----------
Write-Step "IAM role '$RoleName'"
$roleArn = "arn:aws:iam::${AccountId}:role/$RoleName"
$roleCheck = Invoke-Aws iam get-role --role-name $RoleName --output json
if ($roleCheck.ExitCode -ne 0) {
  if ($DryRun) {
    Write-Ok "[dry-run] would create role"
  } else {
    $trustPath = Join-Path $env:TEMP "bc-shots-trust.json"
    $trust = @{
      Version = "2012-10-17"
      Statement = @(
        @{
          Effect = "Allow"
          Principal = @{ Service = "lambda.amazonaws.com" }
          Action = "sts:AssumeRole"
        }
      )
    }
    Write-TextFile $trustPath ($trust | ConvertTo-Json -Depth 8)
    Require-AwsOk (Invoke-Aws iam create-role --role-name $RoleName --assume-role-policy-document (To-AwsFileUri $trustPath)) "create-role"
    Require-AwsOk (Invoke-Aws iam attach-role-policy --role-name $RoleName --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole") "attach basic"
    Write-Ok "created role"
    Start-Sleep -Seconds 8
  }
} else {
  Write-Ok "exists"
}

$policyPath = Join-Path $env:TEMP "bc-shots-policy.json"
$policyDoc = @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Effect = "Allow"
      Action = @("s3:GetObject", "s3:PutObject", "s3:DeleteObject")
      Resource = "arn:aws:s3:::${BucketName}/*"
    },
    @{
      Effect = "Allow"
      Action = @("dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan")
      Resource = @(
        "arn:aws:dynamodb:${Region}:${AccountId}:table/$ShotsTable",
        "arn:aws:dynamodb:${Region}:${AccountId}:table/$ShotsTable/index/*",
        "arn:aws:dynamodb:${Region}:${AccountId}:table/$TicketsTable"
      )
    }
  )
}
Write-TextFile $policyPath ($policyDoc | ConvertTo-Json -Depth 8)

if (-not $DryRun) {
  Require-AwsOk (Invoke-Aws iam put-role-policy --role-name $RoleName --policy-name baffledcat-screenshots-data --policy-document (To-AwsFileUri $policyPath)) "put-role-policy"
}

# ---------- Secrets ----------
$ticketSecret = Get-SecretValue "TICKET_HMAC_SECRET" $fileMap
$adminToken = Get-SecretValue "ADMIN_TOKEN" $fileMap
$turnstile = Get-SecretValue "TURNSTILE_SECRET" $fileMap
$devBypass = Get-SecretValueOrEmpty "DEV_BYPASS_TURNSTILE" $fileMap
if ($null -eq $devBypass) {
  # Default on only when Turnstile is not configured yet.
  $devBypass = if ($turnstile) { "" } else { "1" }
}

if (-not $SkipSecrets) {
  if (-not $ticketSecret) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $ticketSecret = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  }
  if (-not $adminToken) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $adminToken = [Convert]::ToBase64String($bytes) -replace '[^a-zA-Z0-9]', 'x'
  }
}

# ---------- Lambda ----------
Write-Step "Lambda '$FunctionName'"
if (-not (Test-Path $ProductionConfigFile)) {
  throw "Production config not found: $ProductionConfigFile"
}
$productionConfig = Get-Content $ProductionConfigFile -Raw | ConvertFrom-Json
$allowedOrigins = (@($productionConfig.allowedOrigins) | ForEach-Object { [string]$_ }) -join ","
$allowedAppIds = (@($productionConfig.allowedAppIds) | ForEach-Object { [string]$_ }) -join ","
if (-not $allowedOrigins -or -not $allowedAppIds) {
  throw "Production config must define allowedOrigins and allowedAppIds"
}

# Temporary PUBLIC_BASE_URL  -  updated after API/domain known
$publicBase = Get-SecretValue "PUBLIC_BASE_URL" $fileMap
if (-not $publicBase) { $publicBase = $PreferredBaseUrl }

function Get-LambdaEnvFile([string]$baseUrl) {
  $vars = [ordered]@{
    SHOTS_TABLE = $ShotsTable
    TICKETS_TABLE = $TicketsTable
    SHOTS_BUCKET = $BucketName
    ALLOWED_ORIGINS = $allowedOrigins
    ALLOWED_APP_IDS = $allowedAppIds
    PUBLIC_BASE_URL = $baseUrl
    MAX_UPLOAD_BYTES = "2097152"
    MAX_EDGE = "1920"
    THUMB_EDGE = "256"
    TICKET_TTL_SEC = "120"
    DEV_BYPASS_TURNSTILE = "$devBypass"
  }
  if (-not $SkipSecrets) {
    $vars["TICKET_HMAC_SECRET"] = "$ticketSecret"
    $vars["ADMIN_TOKEN"] = "$adminToken"
    if ($turnstile) { $vars["TURNSTILE_SECRET"] = "$turnstile" }
  }
  $path = Join-Path $env:TEMP "bc-shots-lambda-env.json"
  Write-TextFile $path ((@{ Variables = $vars } | ConvertTo-Json -Depth 6))
  return $path
}

$fnCheck = Invoke-Aws lambda get-function --function-name $FunctionName --output json
if ($fnCheck.ExitCode -ne 0) {
  if ($DryRun) {
    Write-Ok "[dry-run] would create function"
  } else {
    Require-AwsOk (Invoke-Aws lambda create-function `
      --function-name $FunctionName `
      --runtime nodejs20.x `
      --role $roleArn `
      --handler src/index.handler `
      --timeout 30 `
      --memory-size 512 `
      --zip-file (To-AwsFileUri $zipPath "fileb") `
      --environment (To-AwsFileUri (Get-LambdaEnvFile $publicBase))) "create-function"
    Write-Ok "created"
  }
} else {
  if ($DryRun) {
    Write-Ok "[dry-run] would update code/config"
  } else {
    Require-AwsOk (Invoke-Aws lambda update-function-code --function-name $FunctionName --zip-file (To-AwsFileUri $zipPath "fileb")) "update-function-code"
    Require-AwsOk (Invoke-Aws lambda wait function-updated --function-name $FunctionName) "wait function-updated"
    if (-not $SkipSecrets) {
      Require-AwsOk (Invoke-Aws lambda update-function-configuration `
        --function-name $FunctionName `
        --environment (To-AwsFileUri (Get-LambdaEnvFile $publicBase))) "update-function-configuration"
      Require-AwsOk (Invoke-Aws lambda wait function-updated --function-name $FunctionName) "wait function-updated"
    }
    Write-Ok "updated"
  }
}

# ---------- HTTP API ----------
Write-Step "API Gateway HTTP API '$ApiName'"
$state = Load-State
$apiId = Get-Prop $state "apiId"
$apiEndpoint = Get-Prop $state "apiEndpoint"

if (-not $apiId) {
  $list = Invoke-Aws apigatewayv2 get-apis --output json
  Require-AwsOk $list "get-apis"
  $apis = @(Get-Prop ($list.Text | ConvertFrom-Json) "Items")
  $existing = $apis | Where-Object { (Get-Prop $_ "Name") -eq $ApiName } | Select-Object -First 1
  if ($existing) {
    $apiId = Get-Prop $existing "ApiId"
    $apiEndpoint = Get-Prop $existing "ApiEndpoint"
  }
}

if (-not $apiId) {
  if ($DryRun) {
    Write-Ok "[dry-run] would create HTTP API"
  } else {
    $created = Invoke-Aws apigatewayv2 create-api --name $ApiName --protocol-type HTTP --output json
    Require-AwsOk $created "create-api"
    $apiObj = $created.Text | ConvertFrom-Json
    $apiId = Get-Prop $apiObj "ApiId"
    $apiEndpoint = Get-Prop $apiObj "ApiEndpoint"
    Write-Ok "created $apiId"
  }
} else {
  Write-Ok "using $apiId ($apiEndpoint)"
}

$lambdaArn = "arn:aws:lambda:${Region}:${AccountId}:function:$FunctionName"
$integrationId = Get-Prop $state "integrationId"

if (-not $DryRun -and $apiId) {
  if (-not $integrationId) {
    $ints = Invoke-Aws apigatewayv2 get-integrations --api-id $apiId --output json
    if ($ints.ExitCode -eq 0) {
      $items = @(Get-Prop ($ints.Text | ConvertFrom-Json) "Items")
      $hit = $items | Where-Object { (Get-Prop $_ "IntegrationUri") -like "*$FunctionName*" } | Select-Object -First 1
      if ($hit) { $integrationId = Get-Prop $hit "IntegrationId" }
    }
  }
  if (-not $integrationId) {
    $integ = Invoke-Aws apigatewayv2 create-integration `
      --api-id $apiId `
      --integration-type AWS_PROXY `
      --integration-uri $lambdaArn `
      --payload-format-version "2.0" `
      --output json
    Require-AwsOk $integ "create-integration"
    $integrationId = Get-Prop ($integ.Text | ConvertFrom-Json) "IntegrationId"
    Write-Ok "integration $integrationId"
  }

  $routes = Invoke-Aws apigatewayv2 get-routes --api-id $apiId --output json
  Require-AwsOk $routes "get-routes"
  $routeItems = @(Get-Prop ($routes.Text | ConvertFrom-Json) "Items")
  $needDefault = -not ($routeItems | Where-Object { (Get-Prop $_ "RouteKey") -eq '$default' })
  if ($needDefault) {
    Require-AwsOk (Invoke-Aws apigatewayv2 create-route --api-id $apiId --route-key '$default' --target "integrations/$integrationId") "create-route default"
    Write-Ok "route `$default"
  }

  $stages = Invoke-Aws apigatewayv2 get-stages --api-id $apiId --output json
  $stageNames = @()
  if ($stages.ExitCode -eq 0) {
    $stageNames = @(Get-Prop ($stages.Text | ConvertFrom-Json) "Items" | ForEach-Object { Get-Prop $_ "StageName" })
  }
  if ($stageNames -notcontains '$default') {
    Require-AwsOk (Invoke-Aws apigatewayv2 create-stage --api-id $apiId --stage-name '$default' --auto-deploy) "create-stage"
  }

  # Permission for API GW to invoke Lambda
  $srcArn = "arn:aws:execute-api:${Region}:${AccountId}:${apiId}/*/*"
  $perm = Invoke-Aws lambda add-permission `
    --function-name $FunctionName `
    --statement-id apigw-invoke `
    --action lambda:InvokeFunction `
    --principal apigateway.amazonaws.com `
    --source-arn $srcArn
  if ($perm.ExitCode -ne 0 -and $perm.Text -notmatch 'ResourceConflictException') {
    Write-Host $perm.Text
    throw "add-permission failed"
  }
}

# ---------- Custom domain ----------
$effectiveBase = $apiEndpoint
if ($apiEndpoint) { $effectiveBase = $apiEndpoint.TrimEnd('/') }

if (-not $SkipDomain) {
  Write-Step "Custom domain $PublicHost"
  $certList = Invoke-Aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED --output json
  Require-AwsOk $certList "list-certificates"
  $certs = @(Get-Prop ($certList.Text | ConvertFrom-Json) "CertificateSummaryList")
  $cert = $certs | Where-Object { (Get-Prop $_ "DomainName") -eq $PublicHost } | Select-Object -First 1
  if (-not $cert) {
    if ($DryRun) {
      Write-Ok "[dry-run] would request ACM cert"
    } else {
      $req = Invoke-Aws acm request-certificate --domain-name $PublicHost --validation-method DNS --output json
      Require-AwsOk $req "request-certificate"
      $CertArnPreferred = Get-Prop ($req.Text | ConvertFrom-Json) "CertificateArn"
      Write-Ok "requested $CertArnPreferred"
    }
  } else {
    $CertArnPreferred = Get-Prop $cert "CertificateArn"
  }

  if ($CertArnPreferred -and -not $DryRun) {
    $desc = Invoke-Aws acm describe-certificate --certificate-arn $CertArnPreferred --output json
    Require-AwsOk $desc "describe-certificate"
    $c = Get-Prop ($desc.Text | ConvertFrom-Json) "Certificate"
    $dvo = @(Get-Prop $c "DomainValidationOptions")
    $rr = $null
    if ($dvo.Count -gt 0) { $rr = Get-Prop $dvo[0] "ResourceRecord" }
    if ($rr) {
      Write-Host ""
      Write-Host "    Add this DNS CNAME at your DNS host (Cloudflare DNS is fine as DNS-only):" -ForegroundColor Yellow
      Write-Host ("      Name:  {0}" -f ((Get-Prop $rr "Name") + "").TrimEnd('.'))
      Write-Host ("      Value: {0}" -f ((Get-Prop $rr "Value") + "").TrimEnd('.'))
      Write-Host ""
    }
    $certStatus = Get-Prop $c "Status"
    if ($certStatus -eq "ISSUED") {
      $dn = Invoke-Aws apigatewayv2 get-domain-name --domain-name $PublicHost --output json
      if ($dn.ExitCode -ne 0) {
        Require-AwsOk (Invoke-Aws apigatewayv2 create-domain-name `
          --domain-name $PublicHost `
          --domain-name-configurations "CertificateArn=$CertArnPreferred,EndpointType=REGIONAL,SecurityPolicy=TLS_1_2") "create-domain-name"
        $dn = Invoke-Aws apigatewayv2 get-domain-name --domain-name $PublicHost --output json
      }
      Require-AwsOk $dn "get-domain-name"
      $dnObj = $dn.Text | ConvertFrom-Json
      $dnConfigs = @(Get-Prop $dnObj "DomainNameConfigurations")
      $apiGwDomain = Get-Prop $dnConfigs[0] "ApiGatewayDomainName"

      $maps = Invoke-Aws apigatewayv2 get-api-mappings --domain-name $PublicHost --output json
      $hasMap = $false
      if ($maps.ExitCode -eq 0) {
        $hasMap = @(Get-Prop ($maps.Text | ConvertFrom-Json) "Items" | Where-Object { (Get-Prop $_ "ApiId") -eq $apiId }).Count -gt 0
      }
      if (-not $hasMap) {
        Require-AwsOk (Invoke-Aws apigatewayv2 create-api-mapping --domain-name $PublicHost --api-id $apiId --stage '$default') "create-api-mapping"
      }

      Write-Host "    Also point the apex hostname:" -ForegroundColor Yellow
      Write-Host ("      CNAME  {0}  ->  {1}" -f $PublicHost, $apiGwDomain)
      $effectiveBase = $PreferredBaseUrl
      Write-Ok "custom domain ready (after DNS propagates)"
    } else {
      Write-Warn ("ACM status={0} - using execute-api URL until ISSUED + DNS set" -f $certStatus)
      $effectiveBase = ($apiEndpoint + "").TrimEnd('/')
    }
  }
}

# Update Lambda PUBLIC_BASE_URL to effective base
if (-not $DryRun -and -not $SkipSecrets -and $effectiveBase) {
  Write-Step "Set PUBLIC_BASE_URL = $effectiveBase"
  Require-AwsOk (Invoke-Aws lambda update-function-configuration `
    --function-name $FunctionName `
    --environment (To-AwsFileUri (Get-LambdaEnvFile $effectiveBase))) "update PUBLIC_BASE_URL"
  Require-AwsOk (Invoke-Aws lambda wait function-updated --function-name $FunctionName) "wait"
}

# Persist secrets + state
if (-not $DryRun) {
  $save = @{}
  foreach ($k in $fileMap.Keys) { $save[$k] = $fileMap[$k] }
  if (-not $SkipSecrets) {
    $save["TICKET_HMAC_SECRET"] = $ticketSecret
    $save["ADMIN_TOKEN"] = $adminToken
    if ($turnstile) { $save["TURNSTILE_SECRET"] = $turnstile }
    $save["DEV_BYPASS_TURNSTILE"] = $devBypass
  }
  $save["PUBLIC_BASE_URL"] = $effectiveBase
  Save-Secrets $save
  Save-State @{
    apiId = $apiId
    apiEndpoint = $apiEndpoint
    integrationId = $integrationId
    functionName = $FunctionName
    bucket = $BucketName
    publicBaseUrl = $effectiveBase
    certArn = $CertArnPreferred
    region = $Region
  }
  Write-Ok "wrote api/.deploy-secrets.env and api/.deploy-state.json"
}

# Smoke test
Write-Step "Smoke test"
if ($DryRun) {
  Write-Ok "[dry-run] skip"
} elseif ($effectiveBase) {
  Start-Sleep -Seconds 3
  try {
    $health = Invoke-RestMethod -Uri "$effectiveBase/health" -TimeoutSec 30
    if ($health.ok) { Write-Ok "/health OK ($effectiveBase)" }
    else { Write-Warn "/health unexpected: $($health | ConvertTo-Json -Compress)" }
  } catch {
    # custom domain may not resolve yet  -  try execute-api
    if ($apiEndpoint -and $effectiveBase -ne $apiEndpoint.TrimEnd('/')) {
      try {
        $health = Invoke-RestMethod -Uri "$($apiEndpoint.TrimEnd('/'))/health" -TimeoutSec 30
        if ($health.ok) { Write-Ok "/health OK via execute-api ($apiEndpoint)" }
      } catch {
        Write-Warn ("health check failed: {0}" -f $_.Exception.Message)
      }
    } else {
      Write-Warn ("health check failed: {0}" -f $_.Exception.Message)
    }
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ("  API:     {0}" -f $effectiveBase)
Write-Host ("  Admin:   {0}/admin" -f $effectiveBase)
Write-Host ("  S3:      {0}" -f $BucketName)
Write-Host ("  Tables:  {0}, {1}" -f $ShotsTable, $TicketsTable)
if (-not $SkipSecrets) {
  Write-Host ("  ADMIN_TOKEN saved in api/.deploy-secrets.env")
}
Write-Host ""
