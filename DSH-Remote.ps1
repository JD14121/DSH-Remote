#requires -version 5.1
[CmdletBinding()]
param([string] $ConfigPath, [switch] $DiagnoseOnly, [switch] $NoPause)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'scripts\harness-start.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { throw 'Harness Remote project was moved. Run Harness Remote Setup from its new location.' }
& $launcher @PSBoundParameters
