<#
  R9-RELAY-02A.2B — interactive Cloudflare DNS token entry helper.

  Run this YOURSELF, locally. It prompts without echoing, holds the token only transiently in memory,
  writes it directly to the protected file, applies/verifies a restrictive ACL, and never prints,
  logs, or transmits the value.

  Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts/r9-relay-02a2b-token-entry.ps1
#>

$ErrorActionPreference = 'Stop'

$secretRoot = 'D:\r9-relay-secrets'
$tokenPath  = Join-Path $secretRoot 'cloudflare-dns-token'
$me         = "$env:USERDOMAIN\$env:USERNAME"

Write-Host ''
Write-Host 'R9 — Cloudflare DNS token entry' -ForegroundColor Cyan
Write-Host '--------------------------------'
Write-Host "This writes the token to: $tokenPath"
Write-Host 'It will NOT be printed, logged, or sent anywhere.'
Write-Host ''

if (-not (Test-Path $secretRoot)) {
    New-Item -ItemType Directory -Force -Path $secretRoot | Out-Null
    Write-Host "Created $secretRoot"
}

if (Test-Path $tokenPath) {
    Write-Host 'A token file ALREADY exists at that path.' -ForegroundColor Yellow
    $answer = Read-Host 'Overwrite it? (type YES to overwrite)'
    if ($answer -ne 'YES') {
        Write-Host 'Aborted — existing token left untouched.'
        exit 2
    }
}

# Read without echo. The value stays in this process memory only.
$secure = Read-Host -Prompt 'Paste the Cloudflare DNS token (input hidden)' -AsSecureString

# Convert to a plain string only for the write, then release both references.
$bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain  = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

if ([string]::IsNullOrWhiteSpace($plain)) {
    Write-Host 'Empty input — nothing written.' -ForegroundColor Red
    exit 3
}

# Basic sanity: a Cloudflare API token is a long opaque string with no whitespace or newlines.
if ($plain -match '\s') {
    Write-Host 'The value contains whitespace, which a Cloudflare token should not. Nothing written.' -ForegroundColor Red
    $plain = $null
    exit 4
}

# Write WITHOUT a trailing newline and WITHOUT echoing the value.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tokenPath, $plain, $utf8NoBom)

# Drop our copy.
$plain = $null
[GC]::Collect()

Write-Host ''
Write-Host 'Token written.' -ForegroundColor Green

# Apply a restrictive ACL immediately, regardless of what was inherited.
& icacls $tokenPath /inheritance:r                                   | Out-Null
& icacls $tokenPath /grant:r "${me}:(F)"                             | Out-Null
& icacls $tokenPath /grant:r 'NT AUTHORITY\SYSTEM:(F)'                | Out-Null
& icacls $tokenPath /grant:r 'BUILTIN\Administrators:(F)'             | Out-Null

Write-Host ''
Write-Host 'Effective ACL:'
(icacls $tokenPath) | Where-Object { $_ -notmatch 'Successfully|processed' } | ForEach-Object { Write-Host "  $_" }

$aclText = (icacls $tokenPath) -join ' '
$broad = @()
foreach ($bad in 'Authenticated Users','BUILTIN\Users','Everyone') {
    if ($aclText -match [regex]::Escape($bad)) { $broad += $bad }
}
if ($broad.Count -gt 0) {
    Write-Host "WARNING: broad principals still present: $($broad -join ', ')" -ForegroundColor Red
    exit 5
}

# Report only non-secret properties.
$info = Get-Item $tokenPath
Write-Host ''
Write-Host 'Verification (no secret value shown):' -ForegroundColor Cyan
Write-Host "  exists        : True"
Write-Host "  bytes         : $($info.Length)"
Write-Host "  sha256        : $((Get-FileHash $tokenPath -Algorithm SHA256).Hash.ToLower())"
Write-Host "  broad ACLs    : absent"
Write-Host ''
Write-Host 'You may now run the scope verification step.' -ForegroundColor Green
