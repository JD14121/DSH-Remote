# Shared Windows PowerShell 5.1 configuration bridge. All secret material stays in its existing stores.
$script:HarnessConfigCli = Join-Path $PSScriptRoot '..\harness-config.mjs'
function Get-HarnessConfiguration {
    param([string] $ConfigPath)
    $configArgs = @($script:HarnessConfigCli, '--resolve')
    if ($ConfigPath) { $configArgs += @('--config', $ConfigPath) }
    $configOutput = & node @configArgs
    if ($LASTEXITCODE -ne 0) { throw 'Harness Remote configuration could not be resolved.' }
    $config = ($configOutput -join "`n") | ConvertFrom-Json
    if ($config.configured) { $env:HARNESS_REMOTE_CONFIG = [string]$config.configPath }
    return $config
}
