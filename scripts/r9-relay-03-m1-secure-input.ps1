<#
R9-RELAY-03 GATE 2B-M1 - secure credential input helper (Windows PowerShell).

WHAT THIS DOES
  * Reads the three credential values interactively WITHOUT echoing them (Read-Host -AsSecureString).
  * Converts each to plaintext only in memory, solely to serialise into a JSON object.
  * Starts the Node child process with credentials passed on STDIN - so they never enter:
      - command-line arguments (argv),
      - the PowerShell command text,
      - PSReadLine history,
      - any file,
      - ANY ENVIRONMENT VARIABLE.
  * Clears the plaintext variables, the secure strings, and the JSON payload in a `finally` block.

WHY STDIN AND NOT AN ENVIRONMENT VARIABLE
  The taskbook permits a temporary process-scoped environment variable. This helper goes further and
  avoids environment variables entirely, because on Windows an environment block is readable by other
  processes running as the same user (e.g. via WMI Win32_Process). Passing the values on the child's
  stdin removes that exposure rather than merely shortening it.

RESIDUAL LIMITATION - STATED PLAINLY, NOT HIDDEN
  This helper reduces exposure; it does NOT eliminate it. The remaining limits are:
    1. The plaintext exists transiently in this PowerShell process's memory. Any credential that is
       ever typed into a machine is exposed to that machine's memory, and .NET strings cannot be
       reliably zeroed. A SecureString reduces the window but does not remove it.
    2. Values pass through an anonymous pipe to the child process. Another process with equivalent
       privileges could in principle observe it; this is not a defence against a local administrator
       or against malware already running as this user.
    3. Windows may page process memory to disk. There is no portable way to lock these buffers from
       PowerShell, so a hibernation file or pagefile could in principle contain a copy.
    4. The signed URL that the child prints metadata for is a live bearer credential for one object
       until it expires; treating its hash as non-secret is fine, treating the URL as non-secret is
       not.
  A hostile local user or administrator is OUT OF SCOPE for this design; the goal is to keep
  credentials out of argv, history, files, logs, and the environment block.

USAGE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\r9-relay-03-m1-secure-input.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\r9-relay-03-m1-secure-input.ps1 -Copy
#>

[CmdletBinding()]
param(
  # Also place the generated URL on the clipboard (the child verifies the round trip).
  [switch]$Copy,
  # Skip the confirmation prompt. Only for scripted use after you have reviewed this file.
  [switch]$Force,
  # TEST ONLY. Bypasses the interactive prompts with FICTITIOUS credentials, so the compatibility test
  # can exercise THIS script's real process-launch path instead of a copy of it. Never used by an
  # operator flow; the values below grant access to nothing and R2 is never contacted.
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
# Locate the presign tool whether this script sits beside it, in ./tool, or in ./scripts.
# Hard-coding a single relative path broke as soon as the deliverables were moved into one folder,
# so the tool is now searched for in the plausible locations.
function Find-PresignTool {
  $candidates = @(
    (Join-Path $PSScriptRoot 'r9-relay-03-m1-presign.mjs'),
    (Join-Path $PSScriptRoot 'tool/r9-relay-03-m1-presign.mjs'),
    (Join-Path $PSScriptRoot '../tool/r9-relay-03-m1-presign.mjs'),
    (Join-Path $PSScriptRoot 'scripts/r9-relay-03-m1-presign.mjs')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
  return $null
}
$tool = Find-PresignTool

if (-not $tool -or -not (Test-Path $tool)) {
  Write-Error "presign tool not found: $tool"
  exit 2
}

Write-Host ''
Write-Host 'R9-RELAY-03 GATE 2B-M1 - secure credential entry' -ForegroundColor Cyan
Write-Host '  Input is NOT echoed and is NOT written to argv, history, files, or the environment.' -ForegroundColor DarkGray
Write-Host ''

if ($SelfTest) {
  Write-Host '  SELF-TEST MODE: fictitious credentials, interactive prompts bypassed.' -ForegroundColor Yellow
  Write-Host '  Nothing below grants access to anything; R2 is never contacted.' -ForegroundColor DarkGray
} elseif (-not $Force) {
  $ok = Read-Host '  Type YES to confirm you want to enter credentials now'
  if ($ok -ne 'YES') { Write-Host '  Aborted.' -ForegroundColor Yellow; exit 3 }
}

# Plaintext holders. Deliberately NOT script-scoped or global.
$plainAccess = $null
$plainSecret = $null
$plainAccount = $null
$payload = $null

try {
  if ($SelfTest) {
    # Fictitious values, obvious on sight, correct shape. 32-hex account id, as the real one must be.
    $plainAccess = 'R9-SELFTEST-NOT-A-REAL-ACCESS-KEY'
    $plainSecret = 'r9-selftest-not-a-real-secret'
    $plainAccount = '0123456789abcdef0123456789abcdef'
  } else {
    # -AsSecureString prevents echo and keeps the value out of the console buffer.
    $secAccess = Read-Host '  Access Key ID' -AsSecureString
    $secSecret = Read-Host '  Secret Access Key' -AsSecureString
    $secAccount = Read-Host '  R2 Account ID (32 hex)' -AsSecureString

    # Convert to plaintext only where strictly required, to build the JSON payload.
    $plainAccess = [System.Net.NetworkCredential]::new('', $secAccess).Password
    $plainSecret = [System.Net.NetworkCredential]::new('', $secSecret).Password
    $plainAccount = [System.Net.NetworkCredential]::new('', $secAccount).Password
  }

  if ([string]::IsNullOrWhiteSpace($plainAccess) -or
      [string]::IsNullOrWhiteSpace($plainSecret) -or
      [string]::IsNullOrWhiteSpace($plainAccount)) {
    Write-Error '  One or more values were empty. Nothing was generated.'
    exit 2
  }

  if ($plainAccount -notmatch '^[0-9a-fA-F]{32}$') {
    Write-Error '  R2 Account ID must be exactly 32 hexadecimal characters.'
    exit 2
  }

  # Serialise ONCE, in memory. Never echoed.
  $payload = @{
    accessKeyId     = $plainAccess
    secretAccessKey = $plainSecret
    accountId       = $plainAccount.ToLower()
  } | ConvertTo-Json -Compress

  Write-Host ''
  Write-Host '  Starting the presign tool (credentials via stdin; no environment variable, nothing on disk)...' -ForegroundColor DarkGray
  Write-Host ''

  # CREDENTIAL HANDOFF: stdin. No file is created and no environment variable is used.
  #
  # HISTORY, because it matters for trust: an earlier revision of this helper switched to a temporary
  # credential FILE after stdin appeared to fail with "stdin was not valid JSON". That was the wrong
  # response. Root-causing it showed .NET Framework's redirected StandardInput ALWAYS prepends a
  # UTF-8 BOM: writing the plain ASCII text "HELLO" reaches the child as 8 bytes with a leading
  # U+FEFF, unconditionally, whatever encoding the writer is given. The tool now strips a leading BOM,
  # so stdin works and credentials never need to touch the filesystem.
  #
  # COMPATIBILITY: ProcessStartInfo.ArgumentList does NOT exist in Windows PowerShell 5.1 (it arrived
  # in .NET Core / PowerShell 6+). Using it there throws, so arguments are passed as a single
  # correctly-quoted Arguments string, which works on both 5.1 and 7.x.
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'node'
  $argList = @($tool, '--stdin')
  if ($Copy) { $argList += '--copy' }
  $psi.Arguments = ($argList | ForEach-Object {
      if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
  # RedirectStandardInput MUST be set. Without it $proc.StandardInput is $null and the Write below
  # throws InvalidOperationException at runtime. That bug was shipped in an earlier revision because
  # the compatibility test built its OWN ProcessStartInfo instead of exercising this one.
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # Do NOT copy this process's environment block into the child beyond the minimum needed, so no
  # credential can exist as an environment variable anywhere in this flow.
  $psi.EnvironmentVariables.Clear() | Out-Null
  $psi.EnvironmentVariables['PATH'] = $env:PATH
  if ($env:SystemRoot) { $psi.EnvironmentVariables['SystemRoot'] = $env:SystemRoot }
  if ($env:TEMP) { $psi.EnvironmentVariables['TEMP'] = $env:TEMP }
  if ($env:TMP) { $psi.EnvironmentVariables['TMP'] = $env:TMP }

  $proc = [System.Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  $null = $proc.Start()

  # Write the payload to stdin and close it. The .NET pipe prepends a BOM; the tool strips it. Nothing
  # is written to disk and no environment variable carries a credential.
  $proc.StandardInput.Write($payload)
  $proc.StandardInput.Flush()
  $proc.StandardInput.Close()
  $payload = $null   # release the reference as early as possible

  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()

  # The child's output contains length, line count, SHA-256 and times only - never the URL.
  Write-Host $stdout
  if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Host $stderr -ForegroundColor Yellow }

  $exitCode = $proc.ExitCode
  Write-Host ''
  if ($exitCode -eq 0) {
    Write-Host '  Presign completed.' -ForegroundColor Green
    if ($Copy) {
      Write-Host '  The URL is on the clipboard and was verified by length and SHA-256.' -ForegroundColor Green
      Write-Host '  Paste it into the Recovery Console, then clear the clipboard.' -ForegroundColor Green
    } else {
      Write-Host '  Re-run with -Copy when you are ready to paste.' -ForegroundColor DarkGray
    }
  } else {
    Write-Host "  Presign FAILED (exit $exitCode)." -ForegroundColor Red
  }

  exit $exitCode
}
finally {
  # Cleanup runs whether or not anything above threw.
  $plainAccess = $null
  $plainSecret = $null
  $plainAccount = $null
  $payload = $null
  if ($secAccess) { $secAccess.Dispose() }
  if ($secSecret) { $secSecret.Dispose() }
  if ($secAccount) { $secAccount.Dispose() }
  # No credential file is created in this flow, so there is nothing on disk to remove.
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
