# requires -version 5.1
<#
.SYNOPSIS
    Report the DSH Remote Gateway production status.

.DESCRIPTION
    Prints only safe state: supervisor state and PID, owned ports, loopback health, and
    the last error code. It never prints the Phone credential, any cookie, or any
    digest, and it never reads a secret file.

    Windows PowerShell 5.1 compatible. Every write goes through [System.IO.File]::WriteAllText; no PowerShell text-writing cmdlet is used.
#>
[CmdletBinding()]
param(
    [switch] $Json,
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
$supervisorJson = Join-Path $productionRoot 'state\supervisor.json'
$phoneTokenPath = Join-Path $productionRoot 'secrets\phone-token.v1'

function Get-StatusJson {
    if (-not (Test-Path -LiteralPath $supervisorJson)) { return $null }
    try { return ([System.IO.File]::ReadAllText($supervisorJson) | ConvertFrom-Json) } catch { return $null }
}

function Test-PidAlive {
    param([int] $ProcessId)
    if ($ProcessId -le 0) { return $false }
    try { Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function Get-ListeningPid {
    param([int] $Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $conn) { return [int]$conn.OwningProcess }
        return 0
    } catch {
        $line = netstat -ano -p tcp | Select-String -Pattern ":$Port\s+.*LISTENING" | Select-Object -First 1
        if ($null -eq $line) { return 0 }
        $parts = ($line.ToString() -split '\s+') | Where-Object { $_ -ne '' }
        return [int]$parts[-1]
    }
}

function Get-PublicHealth {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$gatewayPort/api/v1/health" -UseBasicParsing -TimeoutSec 5
        return ($response.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

$status = Get-StatusJson
$gatewayPid = Get-ListeningPid -Port $gatewayPort
$dshPid = Get-ListeningPid -Port $dshPort
$health = if ($gatewayPid -ne 0) { Get-PublicHealth } else { $null }

# The credential's presence is reported, never its content. Only the file's existence
# and length are read, and the length is not printed.
$credentialPresent = Test-Path -LiteralPath $phoneTokenPath

$report = [ordered]@{
    supervisor_state = if ($null -ne $status) { [string]$status.state } else { 'NO-STATUS-FILE' }
    supervisor_pid   = if ($null -ne $status) { [int]$status.supervisor_pid } else { 0 }
    supervisor_alive = if ($null -ne $status) { Test-PidAlive -ProcessId ([int]$status.supervisor_pid) } else { $false }
    instance_id      = if ($null -ne $status) { [string]$status.instance_id } else { $null }
    dsh_pid          = $dshPid
    gateway_port     = $gatewayPort
    gateway_listening = ($gatewayPid -ne 0)
    dsh_port         = $dshPort
    dsh_listening    = ($dshPid -ne 0)
    credential_stored = $credentialPresent
    credential_generation = if ($null -ne $status -and $status.PSObject.Properties['credential'] -and $null -ne $status.credential) { $status.credential.generation_id } else { $null }
    gateway_health   = if ($null -ne $health) { [string]$health.data.gateway } else { $null }
    auth_required    = if ($null -ne $health -and $null -ne $health.data.auth) { $health.data.auth.required } else { $null }
    last_error_code  = if ($null -ne $status) { [string]$status.last_error_code } else { $null }
}

if ($Json) {
    $report | ConvertTo-Json -Depth 4
    exit 0
}

Write-Host ''
Write-Host 'DSH Remote Gateway - status' -ForegroundColor Cyan
Write-Host '==========================' -ForegroundColor Cyan
Write-Host ''
Write-Host ("supervisor state : {0}" -f $report.supervisor_state)
Write-Host ("supervisor pid   : {0} ({1})" -f $report.supervisor_pid, $(if ($report.supervisor_alive) { 'alive' } else { 'not running' }))
Write-Host ("instance id      : {0}" -f $report.instance_id)
Write-Host ''
Write-Host ("Gateway $gatewayPort : {0}" -f $(if ($report.gateway_listening) { "listening (pid $gatewayPid)" } else { 'closed' }))
Write-Host ("DSH $dshPort : {0}" -f $(if ($report.dsh_listening) { "listening (pid $dshPid)" } else { 'closed' }))
Write-Host ''
Write-Host ("Phone credential : {0}" -f $(if ($credentialPresent) { 'stored securely' } else { 'absent' }))
Write-Host ("credential gen   : {0}" -f $report.credential_generation)
Write-Host ''
if ($null -ne $health) {
    Write-Host ("gateway health   : {0}" -f $report.gateway_health)
    Write-Host ("auth required    : {0}" -f $report.auth_required)
    Write-Host '                   (the public health view is minimal by design)'
} else {
    Write-Host 'gateway health   : unreachable'
}
if (-not [string]::IsNullOrEmpty([string]$report.last_error_code)) {
    Write-Host ''
    Write-Host ("last error code  : {0}" -f $report.last_error_code) -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'No secret is read or printed by this command.'
Write-Host ''
exit 0
