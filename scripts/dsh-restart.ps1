# requires -version 5.1
<#
.SYNOPSIS
    Restart the DSH Remote Gateway production stack.

.DESCRIPTION
    A clean stop followed by a fresh start. There is deliberately no hot restart: the
    supervisor's DSH child is replaced, so its launch token and auth cookie are
    necessarily fresh, and pretending otherwise would mean reusing a cookie that is no
    longer valid.

    Windows PowerShell 5.1 compatible. Every write goes through [System.IO.File]::WriteAllText; no PowerShell text-writing cmdlet is used.
#>
[CmdletBinding()]
param(
    [int] $StartTimeoutSeconds = 180,
    [int] $StopTimeoutSeconds = 30,
    [switch] $SkipCompliance,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $PSScriptRoot 'lib\harness-config.ps1')
$pc = Get-HarnessConfiguration -ConfigPath $ConfigPath
if (-not $PSBoundParameters.ContainsKey('SkipCompliance')) { $SkipCompliance = [bool]$pc.skipCompliance }
$dshHome = [string]$pc.dshHome
$gatewayPort = [int]$pc.ports.gateway
$dshPort = [int]$pc.ports.dsh

Write-Host ''
Write-Host 'DSH Remote Gateway - production restart' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan
Write-Host 'A restart replaces the DSH child, so its launch token and auth cookie are'
Write-Host 'necessarily new. The Phone credential and the R5 journal are preserved.'
Write-Host ''

# ---------------------------------------------------------------- 1. clean stop
& (Join-Path $scriptDir 'dsh-stop.ps1') -TimeoutSeconds $StopTimeoutSeconds -ConfigPath $ConfigPath
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'STOP' -ForegroundColor Red
    Write-Host 'R7_START_TIMEOUT' -ForegroundColor Red
    Write-Host 'the stop phase did not complete cleanly; refusing to start a second stack.' -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------ 2. wait for ports to free
$deadline = (Get-Date).AddSeconds(15)

while ((Get-Date) -lt $deadline) {
    $busy = $false
    foreach ($port in @($gatewayPort, $dshPort)) {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $conn) { $busy = $true }
    }
    if (-not $busy) { break }
    Start-Sleep -Milliseconds 300
}
Write-Host '[OK] previous stack has exited'

Start-Sleep -Milliseconds 500

# -------------------------------------------------------------- 3. fresh start
& (Join-Path $scriptDir 'dsh-start.ps1') -TimeoutSeconds $StartTimeoutSeconds -ConfigPath $ConfigPath -SkipCompliance:$SkipCompliance
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'STOP' -ForegroundColor Red
    Write-Host 'R7_START_TIMEOUT' -ForegroundColor Red
    Write-Host 'the start phase failed; see the supervisor log.' -ForegroundColor Red
    exit 1
}

exit 0
