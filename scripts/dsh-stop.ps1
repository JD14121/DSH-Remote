# requires -version 5.1
<#
.SYNOPSIS
    Stop the DSH Remote Gateway production stack cleanly.

.DESCRIPTION
    Writes a control request addressed to the running supervisor's instance, waits for
    it to stop, and confirms that the owned ports closed. Only the owned supervisor PID
    is ever signalled — never a process name, and never the owner of a port this script
    did not start.

    Windows PowerShell 5.1 compatible. Every write goes through [System.IO.File]::WriteAllText; no PowerShell text-writing cmdlet is used.
#>
[CmdletBinding()]
param(
    [int] $TimeoutSeconds = 30,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $PSScriptRoot 'lib\harness-config.ps1')
$pc = Get-HarnessConfiguration -ConfigPath $ConfigPath
$dshHome = [string]$pc.dshHome
$gatewayPort = [int]$pc.ports.gateway
$dshPort = [int]$pc.ports.dsh
$productionRoot = Join-Path $dshHome 'remote'
$stateDir = Join-Path $productionRoot 'state'
$controlDir = Join-Path $stateDir 'control'
$supervisorJson = Join-Path $stateDir 'supervisor.json'

function Write-Step { param([string] $Message) Write-Host "[ ] $Message" }
function Write-Ok   { param([string] $Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Fail {
    param([string] $Code, [string] $Message)
    Write-Host ''
    Write-Host 'STOP' -ForegroundColor Red
    Write-Host "$Code" -ForegroundColor Red
    Write-Host "$Message" -ForegroundColor Red
    exit 1
}

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

Write-Host ''
Write-Host 'DSH Remote Gateway - production stop' -ForegroundColor Cyan
Write-Host '====================================' -ForegroundColor Cyan

$status = Get-StatusJson
if ($null -eq $status) {
    Write-Host '[--] no status file: nothing to stop'
    exit 0
}

$instanceId = [string]$status.instance_id
$supervisorPid = [int]$status.supervisor_pid

if (-not (Test-PidAlive -ProcessId $supervisorPid)) {
    Write-Host "[--] supervisor pid $supervisorPid is not running; nothing to stop"
    Write-Host "     last recorded state: $($status.state)"
    exit 0
}

if ([string]::IsNullOrWhiteSpace($instanceId)) {
    Fail 'R7_CONTROL_REQUEST_INVALID' 'the status file carries no instance id; refusing to guess which supervisor to stop.'
}

Write-Step "requesting stop of instance $instanceId (pid $supervisorPid)"

# The request is instance-addressed. A supervisor whose instance id does not match
# ignores it, so a stale request can never stop a newer stack.
if (-not (Test-Path -LiteralPath $controlDir)) {
    New-Item -ItemType Directory -Path $controlDir -Force | Out-Null
}
$requestId = [guid]::NewGuid().ToString()
$request = [ordered]@{
    v           = 1
    instance_id = $instanceId
    request_id  = $requestId
    action      = 'stop'
    created_at  = (Get-Date).ToUniversalTime().ToString('o')
}
$requestPath = Join-Path $controlDir "stop-$requestId.json"
$json = $request | ConvertTo-Json -Compress
# Text via .NET, UTF-8 without BOM: no forbidden cmdlet.
[System.IO.File]::WriteAllText($requestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "stop request written: stop-$requestId.json"

Write-Step "waiting for the supervisor to stop (timeout ${TimeoutSeconds}s)"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    if (-not (Test-PidAlive -ProcessId $supervisorPid)) { break }
}

if (Test-PidAlive -ProcessId $supervisorPid) {
    # The supervisor owns the DSH child, so it is given the chance to clean up first.
    # Only as a last resort is its own PID terminated; the DSH child is signalled by
    # the supervisor, not by this script.
    Write-Host '[!!] the supervisor did not exit within the timeout; stopping only its own PID' -ForegroundColor Yellow
    try { Stop-Process -Id $supervisorPid -Force -ErrorAction Stop } catch { }
    Start-Sleep -Milliseconds 500
}

$status = Get-StatusJson
$gatewayPid = Get-ListeningPid -Port $gatewayPort
$dshPid = Get-ListeningPid -Port $dshPort

Write-Host ''
if ($gatewayPid -eq 0) { Write-Ok "port $gatewayPort closed" } else { Write-Host "[!!] port $gatewayPort still held by pid $gatewayPid" -ForegroundColor Yellow }
if ($dshPid -eq 0)     { Write-Ok "port $dshPort closed" } else { Write-Host "[!!] port $dshPort still held by pid $dshPid" -ForegroundColor Yellow }
if ($null -ne $status) { Write-Host "state          : $($status.state)" }
Write-Host "instance id    : $(if ($null -ne $status) { $status.instance_id } else { 'n/a' })"
Write-Host 'locks and logs are flushed by the supervisor before it exits.'
Write-Host ''
exit 0
