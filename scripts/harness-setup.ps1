#requires -version 5.1
[CmdletBinding()]
param([string] $ConfigPath, [switch] $UseExistingConfiguration, [string] $InputProfile, [string] $ShortcutName = 'Harness Remote', [switch] $NoShortcuts, [switch] $ValidateUi)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$setupCli = Join-Path $PSScriptRoot 'harness-config.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24+ before running Harness Remote Setup.' }
$setupArgs = @($setupCli, '--defaults')
if ($ConfigPath) { $setupArgs += @('--config', $ConfigPath) }
$initialOutput = & node @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'Could not load setup defaults.' }
$initial = ($initialOutput -join "`n") | ConvertFrom-Json
if (-not $ConfigPath) { $ConfigPath = [string]$initial.configPath }
if (-not $ConfigPath) { throw 'Choose an absolute configuration file path using -ConfigPath.' }
$settings = $initial.config
$labels = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'harness-setup.ui.zh-CN.json')) | ConvertFrom-Json

function ConvertTo-AsciiJson($Value) {
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    return [regex]::Replace($json, '[^\x00-\x7f]', { param($Match) '\u' + ([int][char]$Match.Value).ToString('x4') })
}
function Invoke-ProfileCommand($Value, [string] $Operation, [string] $Destination) {
    $commandArgs = @($setupCli, $Operation, '--config', $Destination)
    $output = ConvertTo-AsciiJson $Value | & node @commandArgs
    if ($LASTEXITCODE -ne 0) { throw 'Profile operation failed. No services were started.' }
    return ($output -join "`n") | ConvertFrom-Json
}
function Install-HarnessShortcuts($Value) {
    if ($NoShortcuts) { return }
    if ($ShortcutName -match '[\\/:*?"<>|]' -or -not $ShortcutName.Trim()) { throw 'Invalid shortcut name.' }
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $icon = $null
    foreach ($name in @(($ShortcutName + '.lnk'), 'DeepSeek Harness.lnk')) {
        $source = Join-Path $desktop $name
        if (Test-Path -LiteralPath $source) { $icon = $shell.CreateShortcut($source).IconLocation; if ($icon) { break } }
    }
    foreach ($entry in @(@{Name=$ShortcutName;Script='Harness-Remote.cmd'}, @{Name='Harness Remote Setup';Script='Harness-Remote-Setup.cmd'})) {
        $shortcut = $shell.CreateShortcut((Join-Path $desktop ($entry.Name + '.lnk')))
        $shortcut.TargetPath = Join-Path $Value.projectRoot ('scripts\' + $entry.Script)
        $shortcut.WorkingDirectory = [string]$Value.projectRoot
        $shortcut.Arguments = '-ConfigPath "' + $ConfigPath + '"'
        if ($entry.Script -eq 'Harness-Remote-Setup.cmd') { $shortcut.Arguments += ' -ShortcutName "' + $ShortcutName + '"' }
        if ($icon) { $shortcut.IconLocation = $icon }
        $shortcut.Save()
    }
}
function Save-Installation($Value) {
    $saved = Invoke-ProfileCommand $Value '--save' $ConfigPath
    Install-HarnessShortcuts $Value
    return $saved
}

if ($InputProfile) { $settings = [System.IO.File]::ReadAllText($InputProfile) | ConvertFrom-Json }
if ($UseExistingConfiguration -or $InputProfile) {
    Save-Installation $settings | ConvertTo-Json -Depth 8
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $labels.title
$form.ClientSize = New-Object System.Drawing.Size(780, 720)
$form.StartPosition = 'CenterScreen'
$form.AutoScaleMode = 'Dpi'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.MinimumSize = New-Object System.Drawing.Size(780, 750)
$intro = New-Object System.Windows.Forms.Label
$intro.SetBounds(18, 14, 745, 42)
$intro.Text = $labels.intro
$form.Controls.Add($intro)
$fields = @{}
function Add-Field([string] $Name, [string] $Label, [string] $Value, [int] $Y, [bool] $File) {
    $caption = New-Object System.Windows.Forms.Label
    $caption.SetBounds(18, $Y + 5, 130, 24)
    $caption.Text = $Label
    $field = New-Object System.Windows.Forms.TextBox
    $field.SetBounds(150, $Y, 525, 28)
    $field.Text = $Value
    $field.Anchor = 'Top,Left,Right'
    $button = New-Object System.Windows.Forms.Button
    $button.SetBounds(684, $Y - 1, 78, 30)
    $button.Text = $labels.browse
    $button.Tag = @{Field=$field;File=$File;Save=($Name -eq 'configPath')}
    $button.Anchor = 'Top,Right'
    $button.Add_Click({
        $selection = $this.Tag
        if ($selection.File) {
            $dialog = if ($selection.Save) { New-Object System.Windows.Forms.SaveFileDialog } else { New-Object System.Windows.Forms.OpenFileDialog }
            $dialog.FileName = $selection.Field.Text
            if ($dialog.ShowDialog() -eq 'OK') { $selection.Field.Text = $dialog.FileName }
        } else {
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.SelectedPath = $selection.Field.Text
            if ($dialog.ShowDialog() -eq 'OK') { $selection.Field.Text = $dialog.SelectedPath }
        }
        $dialog.Dispose()
    })
    $fields[$Name] = $field
    $form.Controls.AddRange(@($caption,$field,$button))
}
Add-Field 'projectRoot' $labels.projectRoot $settings.projectRoot 62 $false
Add-Field 'workspace' $labels.workspace $settings.workspace 101 $false
Add-Field 'dshHome' $labels.dshHome $settings.dshHome 140 $false
Add-Field 'logRoot' $labels.logRoot $settings.logRoot 179 $false
Add-Field 'configPath' $labels.configPath $ConfigPath 218 $true
$relayEnabled = New-Object System.Windows.Forms.CheckBox
$relayEnabled.SetBounds(18, 258, 744, 28)
$relayEnabled.Text = $labels.relay
$relayEnabled.Checked = [bool]$settings.relay.enabled
$form.Controls.Add($relayEnabled)
Add-Field 'bridgeConfigPath' $labels.bridgeConfigPath $settings.relay.bridgeConfigPath 294 $true
Add-Field 'frpcConfigPath' $labels.frpcConfigPath $settings.relay.frpcConfigPath 333 $true
Add-Field 'frpcExecutable' $labels.frpcExecutable $settings.relay.frpcExecutable 372 $true
$desktopEnabled = New-Object System.Windows.Forms.CheckBox
$desktopEnabled.SetBounds(18, 410, 370, 26)
$desktopEnabled.Text = $labels.desktop
$desktopEnabled.Checked = [bool]$settings.startDesktop
$compliance = New-Object System.Windows.Forms.CheckBox
$compliance.SetBounds(18, 440, 740, 26)
$compliance.Text = $labels.compliance
$compliance.Checked = [bool]$settings.skipCompliance
$form.Controls.AddRange(@($desktopEnabled,$compliance))
$portsLabel = New-Object System.Windows.Forms.Label
$portsLabel.SetBounds(18, 479, 285, 24)
$portsLabel.Text = $labels.ports
$form.Controls.Add($portsLabel)
$portFields = @{}
$x = 306
foreach ($name in @('desktop','dsh','gateway')) {
    $numeric = New-Object System.Windows.Forms.NumericUpDown
    $numeric.SetBounds($x, 474, 140, 28)
    $numeric.Minimum = 1
    $numeric.Maximum = 65535
    $numeric.Value = [decimal]$settings.ports.$name
    $portFields[$name] = $numeric
    $form.Controls.Add($numeric)
    $x += 154
}
$note = New-Object System.Windows.Forms.Label
$note.SetBounds(18, 515, 744, 48)
$note.Text = $labels.note
$form.Controls.Add($note)
$output = New-Object System.Windows.Forms.TextBox
$output.SetBounds(18, 570, 744, 87)
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Vertical'
$output.Anchor = 'Top,Bottom,Left,Right'
$form.Controls.Add($output)
function Get-FormProfile {
    return [ordered]@{version=1;projectRoot=$fields.projectRoot.Text;workspace=$fields.workspace.Text;dshHome=$fields.dshHome.Text;logRoot=$fields.logRoot.Text;
        ports=@{desktop=[int]$portFields.desktop.Value;dsh=[int]$portFields.dsh.Value;gateway=[int]$portFields.gateway.Value};
        startDesktop=$desktopEnabled.Checked;skipCompliance=$compliance.Checked;
        relay=@{enabled=$relayEnabled.Checked;bridgeConfigPath=$fields.bridgeConfigPath.Text;frpcConfigPath=$fields.frpcConfigPath.Text;frpcExecutable=$fields.frpcExecutable.Text}}
}
function Show-Diagnosis($Result) {
    $output.Text = (($Result.checks | ForEach-Object { '[{0}] {1}: {2}' -f $_.status, $_.id, $_.detail }) -join "`r`n")
}
$buttonX = 18
foreach ($name in @('dependencies','check','save','cancel')) {
    $button = New-Object System.Windows.Forms.Button
    $button.SetBounds($buttonX, 674, $(if ($name -eq 'save') { 238 } else { 146 }), 32)
    $button.Anchor = 'Bottom,Left'
    $button.Text = $labels.$name
    $button.Tag = $name
    $button.Add_Click({
        try {
            if ($this.Tag -eq 'cancel') { $form.Close(); return }
            $form.UseWaitCursor = $true
            if ($this.Tag -eq 'dependencies') {
                $projectPath = $fields.projectRoot.Text
                if (Test-Path -LiteralPath (Join-Path $projectPath 'node_modules\ws\package.json')) { $output.Text = $labels.dependencyPresent; return }
                if (-not (Test-Path -LiteralPath (Join-Path $projectPath 'package-lock.json'))) { throw 'Select the Harness Remote project before installing dependencies.' }
                if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is missing; install Node.js 24+ first.' }
                $dependencyLogRoot = Join-Path $env:TEMP 'HarnessRemote-Setup'
                New-Item -ItemType Directory -Path $dependencyLogRoot -Force | Out-Null
                $task = Start-Process -FilePath (Get-Command npm.cmd).Source -ArgumentList @('ci','--no-audit','--no-fund') -WorkingDirectory $projectPath -WindowStyle Hidden -PassThru -Wait `
                    -RedirectStandardOutput (Join-Path $dependencyLogRoot 'npm.log') -RedirectStandardError (Join-Path $dependencyLogRoot 'npm.err.log')
                if ($task.ExitCode -ne 0) { throw "Dependency install failed. See $dependencyLogRoot" }
                $output.Text = $labels.dependencyDone
                return
            }
            $value = Get-FormProfile
            $script:ConfigPath = $fields.configPath.Text
            $diagnosis = Invoke-ProfileCommand $value '--check-input' $ConfigPath
            Show-Diagnosis $diagnosis
            if ($this.Tag -eq 'save') {
                if (-not $diagnosis.ready) { $output.Text = $labels.failed + "`r`n" + $output.Text; return }
                Save-Installation $value | Out-Null
                [System.Windows.Forms.MessageBox]::Show($labels.saved, $labels.title) | Out-Null
                $form.Close()
            }
        } catch { $output.Text = $_.Exception.Message }
        finally { $form.UseWaitCursor = $false }
    })
    $form.Controls.Add($button)
    $buttonX += $(if ($name -eq 'save') { 248 } else { 156 })
}
if ($ValidateUi) { Write-Output ('UI constructed: ' + $form.Controls.Count + ' controls') }
else { [void]$form.ShowDialog() }
$form.Dispose()
