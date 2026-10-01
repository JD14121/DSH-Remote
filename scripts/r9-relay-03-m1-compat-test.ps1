<#
R9-RELAY-03 GATE 2B-M1 - compatibility test for secure-input.ps1.

WHAT THIS DOES
  Invokes THE REAL secure-input.ps1 in -SelfTest mode, so the script's OWN ProcessStartInfo launch path
  is what gets exercised. An earlier version of this test built its own copy of that launch code, which
  is why it passed while the real script was missing `RedirectStandardInput` and would have crashed on
  `$proc.StandardInput.Write(...)`. A test that duplicates the code under test proves nothing.

ASSERTED
  * fictitious credentials are RECEIVED by Node (the child reports the stdin credential source);
  * the child completed successfully (the script reports completion and exits 0);
  * the URL is single-line and the clipboard round-trips by length and SHA-256;
  * the clipboard hash matches an INDEPENDENT hash computed here;
  * no credential file is created on disk, and the clipboard is cleared.

NOT ASSERTED
  * the interactive Read-Host prompts (they need a human at the keyboard);
  * R2 server-side acceptance (needs a real credential; never contacted here).

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File tool\r9-relay-03-m1-compat-test.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

$fail = 0
function Check($name, $ok, $detail) {
  if ($ok) { Write-Host "  [PASS] $name" -ForegroundColor Green }
  else { Write-Host "  [FAIL] $name - $detail" -ForegroundColor Red; $script:fail++ }
}

$secureInput = Join-Path $PSScriptRoot 'r9-relay-03-m1-secure-input.ps1'
$presign = Join-Path $PSScriptRoot 'r9-relay-03-m1-presign.mjs'

Write-Host ''
Write-Host 'R9-RELAY-03 GATE 2B-M1 - secure-input compatibility test' -ForegroundColor Cyan
Write-Host "  PowerShell version : $($PSVersionTable.PSVersion)" -ForegroundColor DarkGray
Write-Host '  driving the REAL script in -SelfTest mode (its launch path is not duplicated here)' -ForegroundColor DarkGray
Write-Host ''

Check 'secure-input.ps1 is present' (Test-Path $secureInput) $secureInput
Check 'presign tool is present' (Test-Path $presign) $presign

# -- 1. static guarantees about the real script's source ---------------------
# Comments are stripped first: a previous version of this check matched the word inside an explanatory
# comment and reported a false failure.
$srcRaw = Get-Content $secureInput -Raw
$srcCode = ($srcRaw -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
Check 'does NOT use ProcessStartInfo.ArgumentList in code' (-not ($srcCode -match '\.ArgumentList')) 'ArgumentList is used'
Check 'uses a quoted Arguments string' ($srcCode -match '\$psi\.Arguments\s*=') 'no Arguments assignment'
# The specific bug that shipped: writing to StandardInput without redirecting it.
$writesStdin = $srcCode -match '\$proc\.StandardInput\.Write'
$redirectsStdin = $srcCode -match '\$psi\.RedirectStandardInput\s*=\s*\$true'
Check 'if it writes to StandardInput, it also sets RedirectStandardInput' `
  ((-not $writesStdin) -or $redirectsStdin) `
  'writes to StandardInput but never sets RedirectStandardInput - this is the crash that shipped'

# -- 2. run the REAL script end to end --------------------------------------
Write-Host ''
Write-Host '  invoking secure-input.ps1 -SelfTest -Copy -Force ...' -ForegroundColor DarkGray
$before = @(Get-ChildItem $env:TEMP -Filter 'r9-m1-creds-*.json' -ErrorAction SilentlyContinue)
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File $secureInput -SelfTest -Copy -Force 2>&1 | Out-String
$scriptExit = $LASTEXITCODE
Write-Host ''
Write-Host $out
Write-Host ''

# -- 3. assertions ----------------------------------------------------------
Check 'the real script exited 0' ($scriptExit -eq 0) "exit $scriptExit"

# Credentials actually reached Node. This is the assertion whose absence let the BOM bug ship: checking
# only for ABSENT leaked output passes even when the child rejects every input.
Check 'Node RECEIVED the credentials via stdin' ($out -match 'credential source\s*:\s*stdin') 'child did not report stdin as the credential source'
Check 'the credential payload was understood (no "not valid JSON")' (-not ($out -match 'not valid JSON')) 'stdin JSON was rejected'
Check 'the child reported success' ($out -match 'Presign completed') 'the script did not report completion'

Check 'the URL is a single line' ($out -match 'URL line count\s*:\s*1') 'not single line'
Check 'the URL is not printed to stdout' (-not ($out -match 'X-Amz-Signature=[0-9a-f]{64}')) 'full URL leaked'
Check 'the fictitious secret is not printed' (-not ($out -match 'r9-selftest-not-a-real-secret')) 'secret leaked'

Check 'the clipboard round trip verified inside the tool' ($out -match 'clipboard match\s*:\s*YES') 'clipboard verification failed'

$urlSha = [regex]::Match($out, 'URL SHA-256\s*:\s*([0-9a-f]{64})')
$clipSha = [regex]::Match($out, 'clipboard SHA-256\s*:\s*([0-9a-f]{64})')
Check 'clipboard SHA-256 equals the URL SHA-256' `
  ($urlSha.Success -and $clipSha.Success -and $urlSha.Groups[1].Value -eq $clipSha.Groups[1].Value) `
  'the two reported hashes differ'

# Independent check: hash the clipboard HERE and compare with what the tool reported.
$clip = Get-Clipboard -Raw
$clipNorm = $clip -replace "`r?`n$", ''
$clipBytes = [System.Text.Encoding]::UTF8.GetBytes($clipNorm)
$sha = [System.Security.Cryptography.SHA256]::Create()
$clipHash = ([System.BitConverter]::ToString($sha.ComputeHash($clipBytes)) -replace '-', '').ToLower()
Check 'independent clipboard hash matches the reported URL hash' `
  ($urlSha.Success -and $clipHash -eq $urlSha.Groups[1].Value) `
  "computed $($clipHash.Substring(0,16))... vs reported $($urlSha.Groups[1].Value.Substring(0,16))..."
Check 'clipboard length matches the reported URL byte length' `
  ($out -match 'clipboard length\s*:\s*\d+ bytes \(matches\)') 'clipboard length did not match'

# -- 4. no credential on disk ----------------------------------------------
$after = @(Get-ChildItem $env:TEMP -Filter 'r9-m1-creds-*.json' -ErrorAction SilentlyContinue)
Check 'no credential file created on disk' (($after.Count -eq 0) -or ($after.Count -eq $before.Count)) 'a credential file appeared in TEMP'
Check 'the credential FILE path was not used' (-not ($out -match '--creds-file')) 'the run used --creds-file'

# -- 5. cleanup ------------------------------------------------------------
# Windows PowerShell 5.1 rejects an empty Set-Clipboard value, so a single space is used.
Set-Clipboard -Value ' '
$clipAfter = Get-Clipboard -Raw
Check 'clipboard cleared after the test' ([string]::IsNullOrWhiteSpace($clipAfter)) "clipboard still holds $($clipAfter.Length) chars"

Write-Host ''
if ($fail -eq 0) {
  Write-Host 'RESULT: PASS - real secure-input.ps1 launch path works; credentials received; clipboard round trip verified' -ForegroundColor Green
  exit 0
} else {
  Write-Host "RESULT: FAIL - $fail check(s) failed" -ForegroundColor Red
  exit 1
}
