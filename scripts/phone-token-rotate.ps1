# requires -version 5.1
<#
.SYNOPSIS
    Rotate the production Phone credential.

.DESCRIPTION
    Rotation replaces the credential with a new one. The supervisor MUST be stopped
    first, because the running process holds the old token in memory and would keep
    authenticating it after the file changed — the file and the running stack would
    disagree, which is worse than either state alone.

    The new token is written to a temporary file, ACL-hardened, verified, and only
    then atomically renamed over the old one. No plaintext copy of the old token is
    retained: recovering it is not a goal.

    Windows PowerShell 5.1 compatible. Every write goes through [System.IO.File]::WriteAllText; no PowerShell text-writing cmdlet is used.
#>
[CmdletBinding()]
param(
    [switch] $Force,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
. (Join-Path $PSScriptRoot 'lib\harness-config.ps1')
$pc = Get-HarnessConfiguration -ConfigPath $ConfigPath
$dshHome = [string]$pc.dshHome
$gatewayPort = [int]$pc.ports.gateway
$dshPort = [int]$pc.ports.dsh
$projectRoot = [string]$pc.projectRoot
$productionRoot = Join-Path $dshHome 'remote'
$secretsDir = Join-Path $productionRoot 'secrets'
$phoneTokenPath = Join-Path $secretsDir 'phone-token.v1'
$metaPath = Join-Path $secretsDir 'phone-token.meta.json'
$supervisorJson = Join-Path $productionRoot 'state\supervisor.json'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Fail {
    param([string] $Code, [string] $Message)
    Write-Host ''
    Write-Host 'STOP' -ForegroundColor Red
    Write-Host "$Code" -ForegroundColor Red
    Write-Host "$Message" -ForegroundColor Red
    exit 1
}

function Test-PidAlive {
    param([int] $ProcessId)
    if ($ProcessId -le 0) { return $false }
    try { Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function Set-ProtectedAcl {
    param([string] $Path)
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    foreach ($sid in @($currentSid, 'S-1-5-18')) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-ProtectedAcl {
    param([string] $Path, [string] $Label)
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) {
        Fail 'R7_PHONE_TOKEN_ACL_INVALID' "$Label still has inheritance enabled."
    }
    $allowed = @($currentSid, 'S-1-5-18')
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType.ToString() -ne 'Allow') { continue }
        $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($allowed -notcontains $ruleSid) {
            Fail 'R7_PHONE_TOKEN_ACL_INVALID' "$Label grants access to an unexpected SID $ruleSid."
        }
    }
}

Write-Host ''
Write-Host 'DSH Remote Gateway - rotate Phone credential' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''

# --------------------------------------------------- 1. the supervisor must be down
if (Test-Path -LiteralPath $supervisorJson) {
    try {
        $status = [System.IO.File]::ReadAllText($supervisorJson) | ConvertFrom-Json
        if ((Test-PidAlive -ProcessId ([int]$status.supervisor_pid)) -and ([string]$status.state -ne 'STOPPED')) {
            Fail 'R7_PHONE_TOKEN_INVALID' "the supervisor is running (pid $($status.supervisor_pid), state $($status.state)). Run dsh-stop.ps1 first, then rotate."
        }
    } catch { }
}

if (-not (Test-Path -LiteralPath $secretsDir)) {
    Fail 'R7_PHONE_TOKEN_INVALID' "no secrets directory exists at $secretsDir. Start the supervisor once to create it."
}

# -------------------------------------------------------- 2. generate the new token
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$newToken = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')

if ($newToken.Length -ne 43 -or $newToken -notmatch '^[A-Za-z0-9_-]{43}$') {
    Fail 'R7_PHONE_TOKEN_INVALID' 'the generated token did not have the expected 32-byte base64url shape.'
}

# -------------------------------------------------------- 3. temp file, then ACL
$tempPath = Join-Path $secretsDir "phone-token.rotate-$PID"
try {
    # UTF-8 without BOM, no trailing newline: the file is the token byte for byte.
    [System.IO.File]::WriteAllText($tempPath, $newToken, (New-Object System.Text.UTF8Encoding($false)))
    Set-ProtectedAcl -Path $tempPath
    Assert-ProtectedAcl -Path $tempPath -Label 'the rotated credential'

    # ------------------------------------------------ 4. atomic replace, then ACL
    Move-Item -LiteralPath $tempPath -Destination $phoneTokenPath -Force
    Set-ProtectedAcl -Path $phoneTokenPath
    Assert-ProtectedAcl -Path $phoneTokenPath -Label 'the credential'

    $generationId = [guid]::NewGuid().ToString()
    $meta = [ordered]@{
        v             = 1
        created_at    = (Get-Date).ToUniversalTime().ToString('o')
        generation_id = $generationId
    }
    # The metadata carries no token, hash, prefix or fingerprint.
    [System.IO.File]::WriteAllText($metaPath, ($meta | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
} finally {
    # The temporary file must never survive, whatever happened.
    if (Test-Path -LiteralPath $tempPath) {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '[OK] Phone credential rotated.' -ForegroundColor Green
Write-Host "     new generation id: $generationId"
Write-Host "     ACL verified on   : $phoneTokenPath"
Write-Host ''
Write-Host 'The previous credential is gone. No plaintext backup was kept.'
Write-Host 'The phone must be given the new value: run phone-token-show.ps1.'
Write-Host 'The R5 journal and all session state are unaffected by rotation.'
Write-Host ''
exit 0
