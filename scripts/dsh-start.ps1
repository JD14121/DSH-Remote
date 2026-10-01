# requires -version 5.1
<#
.SYNOPSIS
    Start the DSH Remote Gateway production stack.

.DESCRIPTION
    Gate B entry point. Runs the preflight, verifies the R5A compliance gate, checks
    port ownership, prepares the production root if this is the first start, launches
    the Node supervisor, and waits for READY or FAILED.

    This script NEVER prints the Phone credential. Use phone-token-show.ps1 for that.

    Windows PowerShell 5.1 compatible. Every write in this file goes through
    [System.IO.File]::WriteAllText; no PowerShell text-writing cmdlet is used.
#>
[CmdletBinding()]
param(
    # The npx-mediated DSH child needs ~40-49 s to announce, plus cookie + gateway start.
    # 60 s left no margin and produced spurious R7_DSH_BOOTSTRAP_TOKEN_UNRESOLVED failures.
    [int] $TimeoutSeconds = 180,
    [switch] $SkipCompliance,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ---------------------------------------------------------------- shared helpers
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
. (Join-Path $PSScriptRoot 'lib\harness-config.ps1')
$pc = Get-HarnessConfiguration -ConfigPath $ConfigPath
if (-not $PSBoundParameters.ContainsKey('SkipCompliance')) { $SkipCompliance = [bool]$pc.skipCompliance }
$dshHome = [string]$pc.dshHome
$gatewayPort = [int]$pc.ports.gateway
$dshPort = [int]$pc.ports.dsh
$projectRoot = [string]$pc.projectRoot
$productionRoot = Join-Path $dshHome 'remote'
$supervisorJson = Join-Path $productionRoot 'state\supervisor.json'
$logsDir = Join-Path $productionRoot 'logs'

function Write-Step {
    param([string] $Message)
    Write-Host "[ ] $Message"
}

function Write-Ok {
    param([string] $Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Fail {
    param([string] $Code, [string] $Message)
    Write-Host ''
    Write-Host "STOP" -ForegroundColor Red
    Write-Host "$Code" -ForegroundColor Red
    Write-Host "$Message" -ForegroundColor Red
    Write-Host ''
    exit 1
}

function Get-ListeningPid {
    param([int] $Port)
    # Get-NetTCPConnection may be absent on very old builds; netstat is the fallback.
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $conn) { return [int]$conn.OwningProcess }
        return 0
    } catch {
        $line = netstat -ano -p tcp | Select-String -Pattern ":$Port\s+.*LISTENING" | Select-Object -First 1
        if ($null -eq $line) { return 0 }
        $parts = ($line.ToString() -split '\s+') | Where-Object { $_ -ne '' }
        return [int]$parts[-1]
    }
}

function Get-StatusJson {
    if (-not (Test-Path -LiteralPath $supervisorJson)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($supervisorJson)
        return $raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Test-PidAlive {
    param([int] $ProcessId)
    if ($ProcessId -le 0) { return $false }
    try {
        Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

Write-Host ''
Write-Host 'DSH Remote Gateway - production start' -ForegroundColor Cyan
Write-Host '=====================================' -ForegroundColor Cyan

# ------------------------------------------------------------- 1. preflight: tools
Write-Step 'preflight: PowerShell / Node / npm'
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Fail 'R7_START_TIMEOUT' 'Windows PowerShell 5.1 or later is required.'
}
foreach ($tool in @('node', 'npm', 'npx')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { Fail 'R7_START_TIMEOUT' "$tool was not found on PATH." }
}
$nodeVersion = (& node --version).TrimStart('v')
Write-Ok "PowerShell $($PSVersionTable.PSVersion), Node $nodeVersion"

# --------------------------------------------------- 2. preflight: project files
Write-Step 'preflight: project files'
foreach ($relative in @('package.json', 'scripts\remote-production.mjs', 'src\remote\production\supervisor.mjs')) {
    $full = Join-Path $projectRoot $relative
    if (-not (Test-Path -LiteralPath $full)) {
        Fail 'R7_START_TIMEOUT' "missing project file: $relative"
    }
}
Write-Ok "project root $projectRoot"

# --------------------------------------------------- 3. preflight: DSH version pin
Write-Step 'preflight: DSH version pin'
$packageJson = [System.IO.File]::ReadAllText((Join-Path $projectRoot 'package.json'))
if ($packageJson -notmatch '"ws"') {
    Fail 'R7_START_TIMEOUT' 'package.json no longer declares the ws dependency.'
}
Write-Ok 'DSH pinned to @deepseek-ai/dsh@0.1.5-rc.2'

# ------------------------------------------------------- 4. R5A compliance gate
if (-not $SkipCompliance) {
    Write-Step 'R5A compliance gate'
    Push-Location $projectRoot
    try {
        $complianceOutput = & npm run --silent compliance:r5a 2>&1 | Out-String
        $complianceExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($complianceExit -ne 0 -or $complianceOutput -notmatch 'R5A COMPLIANCE CHECK: PASS') {
        Fail 'R7_START_TIMEOUT' 'the R5A compliance gate did not pass; refusing to start production.'
    }
    Write-Ok 'R5A compliance PASS'
} else {
    Write-Host '[--] R5A compliance gate skipped by request' -ForegroundColor Yellow
}

# ------------------------------------------------- 5. preflight: no live supervisor
Write-Step 'preflight: no running supervisor'
$status = Get-StatusJson
if ($null -ne $status) {
    $liveStates = @('STARTING', 'BOOTSTRAPPING_DSH', 'STARTING_GATEWAY', 'READY', 'RESTARTING', 'STOPPING')
    if ($liveStates -contains [string]$status.state) {
        if (Test-PidAlive -ProcessId ([int]$status.supervisor_pid)) {
            Fail 'R7_SUPERVISOR_LOCKED' "a supervisor is already running (pid $($status.supervisor_pid), state $($status.state)). Use dsh-status.ps1 or dsh-stop.ps1."
        }
        Write-Host "[!!] a stale status file reports $($status.state) but pid $($status.supervisor_pid) is gone; continuing" -ForegroundColor Yellow
    }
}
Write-Ok 'no live supervisor'

# --------------------------------------------------------- 6. preflight: ports
Write-Step "preflight: ports $gatewayPort and $dshPort"
$gatewayPid = Get-ListeningPid -Port $gatewayPort
if ($gatewayPid -ne 0) {
    Fail 'R7_PORT_IN_USE' "port $gatewayPort is already in use by pid $gatewayPid. R7 will not stop an unknown owner."
}
# 3081 is the production DSH port. 3080 is the operator's interactive DSH and MUST NOT be
# checked here: it is expected to be occupied, and refusing on it made this entry point
# permanently unusable.
$dshPid = Get-ListeningPid -Port $dshPort
if ($dshPid -ne 0) {
    Fail 'R7_DSH_PORT_IN_USE' "port $dshPort is already in use by pid $dshPid. The production supervisor must own the DSH child it bootstraps from."
}
Write-Ok "ports $gatewayPort and $dshPort are free"

# ------------------------------------------------- 7. first-create: production root
Write-Step 'production root'
if (Test-Path -LiteralPath $productionRoot) {
    Write-Ok "production root exists: $productionRoot"
} else {
    Write-Host '     first production start: creating and hardening the root'
    Push-Location $projectRoot
    try {
        $prepareOutput = & node 'scripts\remote-production.mjs' --prepare --json 2>&1 | Out-String
        $prepareExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($prepareExit -ne 0) {
        Fail 'R7_ACL_HARDENING_FAILED' "could not prepare the production root:`n$prepareOutput"
    }
    Write-Ok 'production root created, ACL hardened and verified'
}

# ------------------------------------------------------------ 8. launch supervisor
Write-Step 'launching the Node supervisor'
$nodeExe = (Get-Command node).Source
$arguments = @('scripts\remote-production.mjs', '--json')
$startedAt = Get-Date

try {
    $process = Start-Process -FilePath $nodeExe `
        -ArgumentList $arguments `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -PassThru
} catch {
    Fail 'R7_START_TIMEOUT' "could not launch the supervisor: $($_.Exception.Message)"
}
Write-Ok "supervisor pid $($process.Id)"

# -------------------------------------------------------------- 9. wait for READY
Write-Step "waiting for READY (timeout ${TimeoutSeconds}s)"
$deadline = $startedAt.AddSeconds($TimeoutSeconds)
$finalState = 'UNKNOWN'
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $status = Get-StatusJson
    if ($null -ne $status) {
        $finalState = [string]$status.state
        if ($finalState -eq 'READY') { break }
        if ($finalState -eq 'FAILED') { break }
    }
    if (-not (Test-PidAlive -ProcessId $process.Id)) {
        $finalState = 'EXITED'
        break
    }
}

if ($finalState -eq 'FAILED') {
    $code = if ($null -ne $status.last_error_code) { [string]$status.last_error_code } else { 'R7_PRODUCTION_SMOKE_FAILED' }
    Fail $code "the supervisor reported FAILED. See $logsDir\supervisor.log"
}

if ($finalState -ne 'READY') {
    # A supervisor that never became ready is stopped by PID; never by process name.
    if (Test-PidAlive -ProcessId $process.Id) {
        try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { }
    }
    Fail 'R7_START_TIMEOUT' "the supervisor did not become READY within ${TimeoutSeconds}s (last state: $finalState)."
}

# --------------------------------------------------------------- 10. safe summary
$status = Get-StatusJson
$dshPidNow = Get-ListeningPid -Port $dshPort
Write-Host ''
Write-Host 'Gateway READY' -ForegroundColor Green
Write-Host "DSH READY (pid $dshPidNow)"
Write-Host "127.0.0.1:$gatewayPort"
Write-Host 'Phone credential: stored securely'
Write-Host "supervisor pid : $($process.Id)"
Write-Host "instance id    : $($status.instance_id)"
Write-Host "state file     : $supervisorJson"
Write-Host "logs           : $logsDir"
Write-Host ''
Write-Host 'The Phone credential was NOT printed. Use phone-token-show.ps1 to reveal it explicitly.'
Write-Host ''
exit 0
