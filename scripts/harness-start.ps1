#requires -version 5.1
[CmdletBinding()]
param([string] $ConfigPath, [switch] $DiagnoseOnly, [switch] $NoPause)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'lib\harness-config.ps1')

function Pause-Harness {
    if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
}
function Listener([int] $Port) {
    return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}
function Wait-Port([int] $Port, [int] $Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $entry = Listener $Port
        if ($entry) { return $entry }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Port $Port did not become ready. Check the selected profile's logs."
}

try {
    Write-Host 'Harness Remote - configuration, diagnosis and start' -ForegroundColor Cyan
    foreach ($tool in @('node', 'npm', 'npx')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed. Install Node.js 24+ and reopen this window." }
    }
    $pc = Get-HarnessConfiguration -ConfigPath $ConfigPath
    if (-not $pc.configured) { throw 'Run Harness Remote Setup first to select the PC configuration.' }
    $cliArgs = @($script:HarnessConfigCli, '--diagnose', '--config', [string]$pc.configPath)
    $diagnosisOutput = & node @cliArgs
    if ($LASTEXITCODE -ne 0) { throw 'Configuration diagnosis failed.' }
    $diagnosis = ($diagnosisOutput -join "`n") | ConvertFrom-Json
    foreach ($check in $diagnosis.checks) {
        Write-Host ("[{0}] {1}: {2}" -f $check.status.ToUpperInvariant(), $check.id, $check.detail)
    }
    $roles = @([pscustomobject]@{Name='DSH';Port=[int]$pc.ports.dsh}, [pscustomobject]@{Name='Gateway';Port=[int]$pc.ports.gateway})
    if ($pc.startDesktop) { $roles += [pscustomobject]@{Name='Desktop DSH';Port=[int]$pc.ports.desktop} }
    if ($pc.relay.enabled) { $roles += [pscustomobject]@{Name='Relay TLS';Port=9446} }
    foreach ($role in $roles) {
        $unsafe = Get-NetTCPConnection -LocalPort $role.Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }
        if ($unsafe) { throw "$($role.Name) port $($role.Port) has a non-loopback listener. No processes were replaced." }
        $entry = Listener $role.Port
        if ($entry) {
            if ($entry.LocalAddress -notin @('127.0.0.1','::1')) { throw "$($role.Name) port $($role.Port) has a non-loopback listener. No processes were replaced." }
            Write-Host "[LISTENING] $($role.Name) $($role.Port), PID $($entry.OwningProcess)"
        } else { Write-Host "[MISSING] $($role.Name) $($role.Port)" }
    }
    if (-not $diagnosis.ready) { throw 'Prerequisites are missing. Open Setup and use Check configuration for details.' }
    if ($DiagnoseOnly) { Pause-Harness; exit 0 }

    $gateway = Listener ([int]$pc.ports.gateway)
    $dsh = Listener ([int]$pc.ports.dsh)
    if ($gateway -or $dsh) {
        if (-not ($gateway -and $dsh)) { throw 'Only one production port is listening. Use the status/stop tools; no existing owner was replaced.' }
        if (-not (Test-Path -LiteralPath $pc.supervisorState)) { throw 'Production ports have an unknown owner; start was refused.' }
        $state = [System.IO.File]::ReadAllText($pc.supervisorState) | ConvertFrom-Json
        if ($state.state -ne 'READY' -or $gateway.OwningProcess -ne $state.supervisor_pid) { throw 'Listening Gateway does not match the READY supervisor; no existing process was replaced.' }
        $health = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/v1/health" -f $pc.ports.gateway) -UseBasicParsing -TimeoutSec 5
        $publicHealth = $health.Content | ConvertFrom-Json
        if ($publicHealth.data.gateway -ne 'ready') { throw 'Gateway health is not ready. No existing process was replaced.' }
        Write-Host '[OK] Production supervisor is already READY.'
    } else {
        $startArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $pc.projectRoot 'scripts\dsh-start.ps1'),'-ConfigPath',[string]$pc.configPath,'-TimeoutSeconds','180')
        if ($pc.skipCompliance) { $startArgs += '-SkipCompliance' }
        $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        & $windowsPowerShell @startArgs
        if ($LASTEXITCODE -ne 0) { throw 'Production start did not complete.' }
    }

    New-Item -ItemType Directory -Path $pc.logRoot -Force | Out-Null
    if ($pc.startDesktop -and -not (Listener ([int]$pc.ports.desktop))) {
        Start-Process -FilePath 'npx.cmd' -ArgumentList @('--yes','@deepseek-ai/dsh@0.1.5-rc.2','web','--no-open','--port',[string]$pc.ports.desktop) `
            -WorkingDirectory $pc.workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $pc.logRoot 'desktop.log') -RedirectStandardError (Join-Path $pc.logRoot 'desktop.err.log') | Out-Null
        Wait-Port ([int]$pc.ports.desktop) 180 | Out-Null
    }
    if ($pc.relay.enabled) {
        if (-not (Listener 9446)) {
            $priorBridgeConfig = $env:R9_RELAY_04_CONFIG
            $env:R9_RELAY_04_CONFIG = [string]$pc.relay.bridgeConfigPath
            try {
                Start-Process -FilePath (Get-Command node).Source -ArgumentList @('scripts\r9-relay-04.mjs') -WorkingDirectory $pc.projectRoot -WindowStyle Hidden `
                    -RedirectStandardOutput (Join-Path $pc.logRoot 'relay.log') -RedirectStandardError (Join-Path $pc.logRoot 'relay.err.log') | Out-Null
            } finally {
                if ($null -eq $priorBridgeConfig) { Remove-Item Env:R9_RELAY_04_CONFIG -ErrorAction SilentlyContinue }
                else { $env:R9_RELAY_04_CONFIG = $priorBridgeConfig }
            }
            Wait-Port 9446 30 | Out-Null
        }
        $transport = Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | Where-Object {
            $_.ExecutablePath -eq $pc.relay.frpcExecutable -and $_.CommandLine -match [regex]::Escape([string]$pc.relay.frpcConfigPath)
        } | Select-Object -First 1
        if (-not $transport) {
            if (Get-Process -Name frpc -ErrorAction SilentlyContinue) { throw 'An unrecognized FRPC process already exists. It was preserved; inspect its configuration.' }
            & $pc.relay.frpcExecutable verify -c $pc.relay.frpcConfigPath
            if ($LASTEXITCODE -ne 0) { throw 'FRPC rejected the imported runtime configuration.' }
            $transport = Start-Process -FilePath $pc.relay.frpcExecutable -ArgumentList @('-c',('"' + $pc.relay.frpcConfigPath + '"')) -WorkingDirectory $pc.projectRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $pc.logRoot 'frpc-production.stdout.log') -RedirectStandardError (Join-Path $pc.logRoot 'frpc-production.stderr.log')
            Write-Host "[STARTED] FRPC, PID $($transport.Id)."
        } else { Write-Host "[OK] Imported FRPC is running, PID $($transport.ProcessId)." }
        $serverPortText = [regex]::Match([System.IO.File]::ReadAllText($pc.relay.frpcConfigPath), '(?m)^serverPort\s*=\s*(\d+)').Groups[1].Value
        $serverPort = [int]$serverPortText
        $transportId = if ($transport.PSObject.Properties['ProcessId']) { [int]$transport.ProcessId } else { [int]$transport.Id }
        $connection = Get-NetTCPConnection -RemotePort $serverPort -State Established -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $transportId } | Select-Object -First 1
        if ($connection) { Write-Host '[OK] FRPC control connection established.' }
        else { Write-Host '[WARNING] FRPC control is not connected yet. Check transport/network logs.' -ForegroundColor Yellow }
    }
    Write-Host 'Harness Remote startup completed. Configuration:' -ForegroundColor Green
    Write-Host $pc.configPath
    Pause-Harness
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Pause-Harness
    exit 1
}
