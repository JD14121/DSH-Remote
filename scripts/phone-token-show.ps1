# requires -version 5.1
<#
.SYNOPSIS
    Reveal the production Phone credential, on explicit operator request.

.DESCRIPTION
    This is the ONLY command that prints the Phone credential, and it does so only
    because an operator ran it deliberately. It:

      1. verifies the secret file's ACL first, and refuses if the ACL is wrong;
      2. reads the token;
      3. prints it to the current console;
      4. does NOT copy it to the clipboard;
      5. does NOT write it to any log or file;
      6. does NOT generate a QR code.

    The last three are deliberate omissions rather than unimplemented features: each
    would create a second, less controlled copy of the credential.

    Windows PowerShell 5.1 compatible. Every write goes through [System.IO.File]::WriteAllText; no PowerShell text-writing cmdlet is used.
#>
[CmdletBinding()]
param(
    [switch] $Force,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'lib\harness-config.ps1')
$pc = Get-HarnessConfiguration -ConfigPath $ConfigPath
$dshHome = [string]$pc.dshHome
$gatewayPort = [int]$pc.ports.gateway
$dshPort = [int]$pc.ports.dsh
$productionRoot = Join-Path $dshHome 'remote'
$phoneTokenPath = Join-Path $productionRoot 'secrets\phone-token.v1'
$supervisorJson = Join-Path $productionRoot 'state\supervisor.json'

function Fail {
    param([string] $Code, [string] $Message)
    Write-Host ''
    Write-Host 'STOP' -ForegroundColor Red
    Write-Host "$Code" -ForegroundColor Red
    Write-Host "$Message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $phoneTokenPath)) {
    Fail 'R7_PHONE_TOKEN_INVALID' "no Phone credential exists at $phoneTokenPath. The supervisor creates it on first start."
}

# ------------------------------------------------------- 1. verify the secret ACL
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $phoneTokenPath

if (-not $acl.AreAccessRulesProtected) {
    Fail 'R7_PHONE_TOKEN_ACL_INVALID' 'the credential file has inheritance enabled; refusing to read it.'
}

$forbidden = @{
    'S-1-1-0'      = 'Everyone'
    'S-1-5-11'     = 'Authenticated Users'
    'S-1-5-32-545' = 'BUILTIN\Users'
}
$allowed = @($currentSid, 'S-1-5-18')
foreach ($rule in @($acl.Access)) {
    if ($rule.AccessControlType.ToString() -ne 'Allow') { continue }
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($forbidden.ContainsKey($ruleSid)) {
        Fail 'R7_PHONE_TOKEN_ACL_INVALID' "the credential file grants access to $($forbidden[$ruleSid]); refusing to read it."
    }
    if ($allowed -notcontains $ruleSid) {
        Fail 'R7_PHONE_TOKEN_ACL_INVALID' "the credential file grants access to an unexpected SID $ruleSid; refusing to read it."
    }
}

# ------------------------------------------------------------------ 2. read it
$token = [System.IO.File]::ReadAllText($phoneTokenPath)

if ($token.Length -ne 43 -or $token -notmatch '^[A-Za-z0-9_-]{43}$') {
    Fail 'R7_PHONE_TOKEN_INVALID' 'the credential does not match the required 32-byte base64url format.'
}

# ------------------------------------------------------- 3. operator confirmations
$status = $null
if (Test-Path -LiteralPath $supervisorJson) {
    try { $status = [System.IO.File]::ReadAllText($supervisorJson) | ConvertFrom-Json } catch { $status = $null }
}

Write-Host ''
Write-Host 'DSH Remote Gateway - Phone credential' -ForegroundColor Cyan
Write-Host '=====================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'ACL verified: inheritance disabled, only the current user and LocalSystem.'
if ($null -ne $status) {
    Write-Host ("supervisor state: {0}, instance {1}" -f $status.state, $status.instance_id)
    if ($status.state -ne 'STOPPED') {
        Write-Host ''
        Write-Host 'WARNING: the supervisor is not stopped. The credential is live.' -ForegroundColor Yellow
    }
}
Write-Host ''
Write-Host 'Phone credential (Bearer token for the REST API):'
Write-Host ''
Write-Host $token -ForegroundColor White
Write-Host ''
Write-Host 'This value was printed to this console only. It was not copied to the'
Write-Host 'clipboard, not written to a log, and no QR code was generated.'
Write-Host ''
Write-Host 'Send it as:  Authorization: Bearer <token>'
Write-Host 'Never put it in a URL or send it over an untrusted network.'
Write-Host ''
exit 0
