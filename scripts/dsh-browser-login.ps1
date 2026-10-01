# requires -version 5.1
<#
.SYNOPSIS
    Open the supervised DSH Web page through a one-time local login handoff.

.DESCRIPTION
    Requests a one-use, 120-second browser ticket over the protected local file
    control channel, verifies the response file ACL, then opens the fixed loopback
    handoff URL. It does not read or print the Phone token, and it never writes a
    DSH cookie or ticket into a log or persistent file after opening the browser.
#>
[CmdletBinding()]
param([string] $ConfigPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'lib\harness-config.ps1')
$pc = Get-HarnessConfiguration -ConfigPath $ConfigPath
$dshHome = [string]$pc.dshHome
$gatewayPort = [int]$pc.ports.gateway
$dshPort = [int]$pc.ports.dsh
$productionRoot = Join-Path $dshHome 'remote'
$controlDir = Join-Path $productionRoot 'state\control'
$supervisorJson = Join-Path $productionRoot 'state\supervisor.json'

function Fail {
    param([string] $Code, [string] $Message)
    Write-Host ''
    Write-Host 'STOP' -ForegroundColor Red
    Write-Host $Code -ForegroundColor Red
    Write-Host $Message -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $supervisorJson)) {
    Fail 'DSH_BROWSER_LOGIN_UNAVAILABLE' 'No production supervisor status exists.'
}
try {
    $status = [System.IO.File]::ReadAllText($supervisorJson) | ConvertFrom-Json
} catch {
    Fail 'DSH_BROWSER_LOGIN_UNAVAILABLE' 'The production supervisor status cannot be read.'
}
if ($status.state -ne 'READY') {
    Fail 'DSH_BROWSER_LOGIN_UNAVAILABLE' 'The production supervisor is not READY.'
}
$instanceId = [string]$status.instance_id
if ($instanceId -notmatch '^[0-9a-fA-F-]{36}$') {
    Fail 'DSH_BROWSER_LOGIN_UNAVAILABLE' 'The supervisor status has no valid instance id.'
}
if (-not (Test-Path -LiteralPath $controlDir -PathType Container)) {
    Fail 'DSH_BROWSER_LOGIN_UNAVAILABLE' 'The protected supervisor control directory is missing.'
}

$requestId = [guid]::NewGuid().ToString()
$requestPath = Join-Path $controlDir "browser-login-request-$requestId.json"
$responsePath = Join-Path $controlDir "browser-login-response-$requestId.json"
$request = [ordered]@{
    v = 1
    instance_id = $instanceId
    request_id = $requestId
    action = 'issue-browser-login'
    created_at = (Get-Date).ToUniversalTime().ToString('o')
}
$encoding = New-Object System.Text.UTF8Encoding($false)
$requestBytes = $encoding.GetBytes(($request | ConvertTo-Json -Compress))

try {
    $stream = [System.IO.File]::Open($requestPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.Write($requestBytes, 0, $requestBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
} catch {
    Fail 'DSH_BROWSER_LOGIN_UNAVAILABLE' 'Could not write a local handoff request.'
}

$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $responsePath -PathType Leaf)) {
    Start-Sleep -Milliseconds 200
}
if (-not (Test-Path -LiteralPath $responsePath -PathType Leaf)) {
    if (Test-Path -LiteralPath $requestPath) { Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue }
    Fail 'DSH_BROWSER_LOGIN_TIMEOUT' 'The supervisor did not answer the local handoff request.'
}

# Verify the response file grants access only to this Windows user and LocalSystem.
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($currentSid, 'S-1-5-18')
$forbidden = @{
    'S-1-1-0' = 'Everyone'
    'S-1-5-11' = 'Authenticated Users'
    'S-1-5-32-545' = 'BUILTIN\Users'
}
try {
    $acl = Get-Acl -LiteralPath $responsePath
    $seen = @{}
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType.ToString() -ne 'Allow') { continue }
        $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($forbidden.ContainsKey($ruleSid) -or $allowed -notcontains $ruleSid) {
            Fail 'DSH_BROWSER_LOGIN_ACL_INVALID' 'The local handoff response has an unexpected Allow rule.'
        }
        $seen[$ruleSid] = $true
    }
    foreach ($sid in $allowed) {
        if (-not $seen.ContainsKey($sid)) { Fail 'DSH_BROWSER_LOGIN_ACL_INVALID' 'The response ACL is missing an expected principal.' }
    }
} catch {
    if ($_.Exception.Message -match 'DSH_BROWSER_LOGIN_ACL_INVALID') { throw }
    Fail 'DSH_BROWSER_LOGIN_ACL_INVALID' 'Could not verify the local handoff response ACL.'
}

try {
    $response = [System.IO.File]::ReadAllText($responsePath) | ConvertFrom-Json
} catch {
    Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
    Fail 'DSH_BROWSER_LOGIN_INVALID' 'The supervisor response is malformed.'
}
Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
if ($response.request_id -ne $requestId) {
    Fail 'DSH_BROWSER_LOGIN_INVALID' 'The supervisor response did not match this request.'
}
if ($response.ok -ne $true) {
    $code = [string]$response.code
    if ($code -notmatch '^DSH_BROWSER_LOGIN_[A-Z_]+$' -and $code -ne 'DSH_AUTH_UNAVAILABLE') { $code = 'DSH_BROWSER_LOGIN_UNAVAILABLE' }
    Fail $code 'The supervisor could not issue a browser handoff.'
}

$handoffUrl = [string]$response.url
$uri = $null
$validUrl = [System.Uri]::TryCreate($handoffUrl, [System.UriKind]::Absolute, [ref]$uri)
if ($validUrl) {
    $validUrl = $uri.Scheme -eq 'http' -and $uri.Host -eq '127.0.0.1' -and $uri.Port -eq $gatewayPort `
        -and $uri.AbsolutePath -eq '/_local/dsh-browser-login' `
        -and $uri.Query -match '^\?ticket=[A-Za-z0-9_-]{43}$' -and $uri.Fragment -eq ''
}
if (-not $validUrl) {
    Fail 'DSH_BROWSER_LOGIN_INVALID' 'The supervisor returned a URL outside the fixed local handoff.'
}
$expiresAt = [DateTimeOffset]::MinValue
$expiryParsed = [DateTimeOffset]::TryParse([string]$response.expires_at, [ref]$expiresAt)
if (-not $expiryParsed -or $expiresAt -le [DateTimeOffset]::UtcNow -or $expiresAt -gt [DateTimeOffset]::UtcNow.AddMinutes(3)) {
    Fail 'DSH_BROWSER_LOGIN_EXPIRED' 'The one-time browser handoff is expired or outside its expected lifetime.'
}

Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
try {
    Start-Process -FilePath $handoffUrl -ErrorAction Stop | Out-Null
} catch {
    Fail 'DSH_BROWSER_LOGIN_OPEN_FAILED' 'Could not open the local handoff URL in the default browser.'
}
Write-Host ''
Write-Host 'Opened the supervised DSH Web page in the default browser.' -ForegroundColor Cyan
Write-Host 'The one-time ticket expires in 120 seconds and is consumed on use.'
Write-Host 'The ticket and DSH cookie were not printed to this console.'
Write-Host ''
