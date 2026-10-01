param(
    [string]$DeviceLabel = 'android-phone-01'
)

$ErrorActionPreference = 'Stop'
$Keytool = 'D:\Android\jdk-home\bin\keytool.exe'
$CaRoot = 'D:\r9-relay-pki\android-application'
$CaStore = Join-Path $CaRoot 'private\android-app-ca-v1.p12'
$CaCert = Join-Path $CaRoot 'public\android-app-ca-v1.crt'
$PrivateOut = Join-Path $CaRoot 'private\enrollments'
$PublicOut = Join-Path $CaRoot 'public\enrollments'
$TrustCandidate = Join-Path $CaRoot 'gateway-trust-candidate'
$LeafStore = Join-Path $PrivateOut "$DeviceLabel.p12"
$Csr = Join-Path $PrivateOut "$DeviceLabel.csr"
$LeafCert = Join-Path $PublicOut "$DeviceLabel.crt"
$PolicyOut = Join-Path $TrustCandidate 'state\android-enrollment.json'
$IssuerCandidate = Join-Path $TrustCandidate 'trust\android-issuer\android-issuer-ca.crt'
$Alias = $DeviceLabel

if ($DeviceLabel -notmatch '^android-[a-z0-9-]{3,40}$') { throw 'DeviceLabel must be a non-identifying android-* label using lowercase letters, digits, and hyphens.' }
if (-not (Test-Path -LiteralPath $Keytool -PathType Leaf)) { throw "Keytool not found: $Keytool" }
foreach ($source in @($CaStore, $CaCert)) { if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required CA file missing: $source" } }
foreach ($target in @($LeafStore, $Csr, $LeafCert, $PolicyOut, $IssuerCandidate)) {
    if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing enrollment material: $target" }
}

function Read-MaskedPair([string]$Title, [string]$Prompt) {
    $form = [System.Windows.Forms.Form]::new()
    $form.Text = $Title
    $form.Size = [System.Drawing.Size]::new(620, 260)
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $label = [System.Windows.Forms.Label]::new()
    $label.Text = $Prompt
    $label.Location = [System.Drawing.Point]::new(16, 16)
    $label.Size = [System.Drawing.Size]::new(580, 62)
    $form.Controls.Add($label)
    $firstLabel = [System.Windows.Forms.Label]::new()
    $firstLabel.Text = '口令:'
    $firstLabel.Location = [System.Drawing.Point]::new(20, 92)
    $firstLabel.Size = [System.Drawing.Size]::new(100, 24)
    $form.Controls.Add($firstLabel)
    $first = [System.Windows.Forms.TextBox]::new()
    $first.Location = [System.Drawing.Point]::new(125, 88)
    $first.Size = [System.Drawing.Size]::new(460, 25)
    $first.UseSystemPasswordChar = $true
    $form.Controls.Add($first)
    $secondLabel = [System.Windows.Forms.Label]::new()
    $secondLabel.Text = '确认:'
    $secondLabel.Location = [System.Drawing.Point]::new(20, 130)
    $secondLabel.Size = [System.Drawing.Size]::new(100, 24)
    $form.Controls.Add($secondLabel)
    $second = [System.Windows.Forms.TextBox]::new()
    $second.Location = [System.Drawing.Point]::new(125, 126)
    $second.Size = [System.Drawing.Size]::new(460, 25)
    $second.UseSystemPasswordChar = $true
    $form.Controls.Add($second)
    $ok = [System.Windows.Forms.Button]::new()
    $ok.Text = '继续'
    $ok.Location = [System.Drawing.Point]::new(370, 174)
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.AcceptButton = $ok
    $form.Controls.Add($ok)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = '取消'
    $cancel.Location = [System.Drawing.Point]::new(475, 174)
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.CancelButton = $cancel
    $form.Controls.Add($cancel)
    $result = $form.ShowDialog()
    $a = $first.Text
    $b = $second.Text
    $first.Clear(); $second.Clear(); $form.Dispose()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) { $a = $null; $b = $null; throw 'Operator cancelled.' }
    if ($a.Length -lt 20 -or $a -cne $b) { $a = $null; $b = $null; throw 'Passphrase confirmation failed or passphrase is shorter than 20 characters.' }
    $b = $null
    return $a
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $PrivateOut, $PublicOut, (Split-Path -Parent $PolicyOut), (Split-Path -Parent $IssuerCandidate) -Force | Out-Null
$caEnv = 'R9_ANDROID_APP_CA_KEYSTORE_SECRET'
$leafEnv = 'R9_ANDROID_PHONE_P12_SECRET'
$created = @()
try {
    $caPassword = Read-MaskedPair 'Android CA unlock' '输入现有 CA PKCS#12 口令（从密码管理器粘贴）。此口令不会写入脚本或命令行。'
    [Environment]::SetEnvironmentVariable($caEnv, $caPassword, 'Process')
    $caPassword = $null
    $leafPassword = Read-MaskedPair 'Phone certificate package' '创建新的客户端包口令，至少 20 字符。请保存到密码管理器，安装到手机时需要。不要与 CA 口令复用。'
    [Environment]::SetEnvironmentVariable($leafEnv, $leafPassword, 'Process')
    $leafPassword = $null

    $genArgs = @('-genkeypair', '-alias', $Alias, '-keystore', $LeafStore, '-storetype', 'PKCS12',
        '-keyalg', 'RSA', '-keysize', '3072', '-sigalg', 'SHA384withRSA', '-validity', '3650',
        '-dname', "CN=$DeviceLabel,O=DSH Remote", '-storepass:env', $leafEnv, '-keypass:env', $leafEnv)
    & $Keytool @genArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Client key generation failed.' }
    $created += $LeafStore

    $csrArgs = @('-certreq', '-rfc', '-alias', $Alias, '-keystore', $LeafStore, '-storetype', 'PKCS12',
        '-storepass:env', $leafEnv, '-file', $Csr)
    & $Keytool @csrArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Client CSR creation failed.' }
    $created += $Csr

    $importCaArgs = @('-importcert', '-noprompt', '-alias', 'android-app-ca-v1', '-file', $CaCert,
        '-keystore', $LeafStore, '-storetype', 'PKCS12', '-storepass:env', $leafEnv)
    & $Keytool @importCaArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'CA certificate staging in client PKCS#12 failed.' }

    $signedArgs = @('-gencert', '-rfc', '-alias', 'android-app-ca-v1', '-keystore', $CaStore,
        '-storetype', 'PKCS12', '-storepass:env', $caEnv, '-infile', $Csr, '-outfile', $LeafCert,
        '-validity', '180', '-sigalg', 'SHA384withRSA', '-ext', 'BC:critical=ca:false',
        '-ext', 'KU:critical=digitalSignature', '-ext', 'EKU=clientAuth')
    & $Keytool @signedArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'CA signing failed.' }
    $created += $LeafCert

    $replyArgs = @('-importcert', '-noprompt', '-alias', $Alias, '-file', $LeafCert, '-keystore', $LeafStore,
        '-storetype', 'PKCS12', '-storepass:env', $leafEnv)
    & $Keytool @replyArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Signed client certificate import failed.' }

    $leaf = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem([IO.File]::ReadAllText($LeafCert))
    $eku = $leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]$_ } | Select-Object -First 1
    $ku = $leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.15' } | ForEach-Object { [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]$_ } | Select-Object -First 1
    if (-not $eku -or -not ($eku.EnhancedKeyUsages | Where-Object Value -eq '1.3.6.1.5.5.7.3.2')) { throw 'Issued certificate lacks clientAuth EKU.' }
    if (-not $ku -or ($ku.KeyUsages -band [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -eq 0) { throw 'Issued certificate lacks digitalSignature usage.' }
    if ($leaf.NotAfter.ToUniversalTime() -gt [DateTime]::UtcNow.AddDays(181)) { throw 'Issued client certificate validity exceeds 180 days.' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $fingerprint = [Convert]::ToHexString($sha.ComputeHash($leaf.RawData)).ToLowerInvariant() } finally { $sha.Dispose() }
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($leaf)
    if (-not $rsa -or $rsa.KeySize -ne 3072) { throw 'Issued client key is not RSA 3072.' }
    $rsa.Dispose()
    $leafSerial = $leaf.SerialNumber
    $leafSubject = $leaf.Subject
    $leafIssuer = $leaf.Issuer
    $leafNotBefore = $leaf.NotBefore.ToUniversalTime().ToString('o')
    $leafNotAfter = $leaf.NotAfter.ToUniversalTime().ToString('o')
    $leaf.Dispose()

    $listing = & $Keytool -list -v -alias $Alias -keystore $LeafStore -storetype PKCS12 "-storepass:env" $leafEnv 2>&1
    if ($LASTEXITCODE -ne 0 -or ($listing -join "`n") -notmatch 'PrivateKeyEntry') { throw 'Final client PKCS#12 private entry verification failed.' }

    Copy-Item -LiteralPath $CaCert -Destination $IssuerCandidate
    $created += $IssuerCandidate
    $policy = [ordered]@{ generation = 1; allow = @(@{ fingerprint = $fingerprint; label = $DeviceLabel }); deny = @() }
    $policy | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PolicyOut -Encoding utf8
    $created += $PolicyOut
    $metadata = [ordered]@{
        deviceLabel = $DeviceLabel
        leafAlias = $Alias
        serialHex = $leafSerial
        subject = $leafSubject
        issuer = $leafIssuer
        certificateSha256 = $fingerprint
        notBeforeUtc = $leafNotBefore
        notAfterUtc = $leafNotAfter
        publicKey = 'RSA 3072'
        signature = 'SHA384withRSA'
        extendedKeyUsage = 'clientAuth'
        keyUsage = 'digitalSignature'
        encryptedPhonePackage = $LeafStore
        gatewayTrustCandidate = $TrustCandidate
        privateKeyInRepository = $false
    }
    $metaPath = Join-Path $PublicOut "$DeviceLabel-inventory.json"
    $metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metaPath -Encoding utf8
    $created += $metaPath
    Write-Output "CLIENT CERTIFICATE SHA-256: $fingerprint"
    Write-Output "CLIENT CERTIFICATE SERIAL: $($metadata.serialHex)"
    Write-Output "VALID UNTIL UTC: $($metadata.notAfterUtc)"
    Write-Output "ENCRYPTED PHONE PACKAGE: $LeafStore"
    Write-Output "GATEWAY TRUST CANDIDATE (NOT DEPLOYED): $TrustCandidate"
} catch {
    foreach ($item in $created) { if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item -Force -ErrorAction SilentlyContinue } }
    if (Test-Path -LiteralPath $LeafStore) { Remove-Item -LiteralPath $LeafStore -Force -ErrorAction SilentlyContinue }
    throw
} finally {
    [Environment]::SetEnvironmentVariable($caEnv, $null, 'Process')
    [Environment]::SetEnvironmentVariable($leafEnv, $null, 'Process')
}
