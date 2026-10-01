param(
    [string] $Keytool = 'D:\Android\jdk-home\bin\keytool.exe',
    [string] $CaRoot = 'D:\r9-relay-pki\android-application'
)

$ErrorActionPreference = 'Stop'
$alias = 'android-app-ca-v1'
$store = Join-Path $CaRoot 'private\android-app-ca-v1.p12'
$publicCert = Join-Path $CaRoot 'public\android-app-ca-v1.crt'
$inventoryFile = Join-Path $CaRoot 'public\android-app-ca-v1-inventory.json'

if (-not (Test-Path -LiteralPath $Keytool -PathType Leaf)) { throw "Keytool not found: $Keytool" }
if (-not (Test-Path -LiteralPath (Join-Path $CaRoot 'private') -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $CaRoot 'public') -PathType Container)) {
    throw "Restricted CA directories are missing: $CaRoot"
}
foreach ($target in @($store, $publicCert, $inventoryFile)) {
    if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing CA material: $target" }
}

$acl = Get-Acl -LiteralPath $CaRoot
if (-not $acl.AreAccessRulesProtected) { throw 'CA root ACL still inherits from its parent.' }
$principals = @($acl.Access | ForEach-Object { $_.IdentityReference.Value })
if (($principals | Where-Object { $_ -match 'Authenticated Users|BUILTIN\\Users' }).Count -gt 0) {
    throw 'CA root ACL grants access to a broad user group.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'Create Android Application CA v1'
$form.Size = [System.Drawing.Size]::new(620, 290)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$label = [System.Windows.Forms.Label]::new()
$label.Text = "Enter a unique CA keystore passphrase (minimum 20 characters). Save it in your approved password manager before continuing. Do not send it in ChatGPT or place it in a command or file."
$label.Location = [System.Drawing.Point]::new(18, 16)
$label.Size = [System.Drawing.Size]::new(570, 62)
$form.Controls.Add($label)

$passwordLabel = [System.Windows.Forms.Label]::new()
$passwordLabel.Text = 'Passphrase:'
$passwordLabel.Location = [System.Drawing.Point]::new(20, 92)
$passwordLabel.Size = [System.Drawing.Size]::new(120, 25)
$form.Controls.Add($passwordLabel)

$passwordBox = [System.Windows.Forms.TextBox]::new()
$passwordBox.Location = [System.Drawing.Point]::new(145, 88)
$passwordBox.Size = [System.Drawing.Size]::new(435, 26)
$passwordBox.UseSystemPasswordChar = $true
$form.Controls.Add($passwordBox)

$confirmLabel = [System.Windows.Forms.Label]::new()
$confirmLabel.Text = 'Confirm:'
$confirmLabel.Location = [System.Drawing.Point]::new(20, 130)
$confirmLabel.Size = [System.Drawing.Size]::new(120, 25)
$form.Controls.Add($confirmLabel)

$confirmBox = [System.Windows.Forms.TextBox]::new()
$confirmBox.Location = [System.Drawing.Point]::new(145, 126)
$confirmBox.Size = [System.Drawing.Size]::new(435, 26)
$confirmBox.UseSystemPasswordChar = $true
$form.Controls.Add($confirmBox)

$okButton = [System.Windows.Forms.Button]::new()
$okButton.Text = 'Create CA'
$okButton.Location = [System.Drawing.Point]::new(365, 190)
$okButton.Size = [System.Drawing.Size]::new(105, 32)
$okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.AcceptButton = $okButton
$form.Controls.Add($okButton)

$cancelButton = [System.Windows.Forms.Button]::new()
$cancelButton.Text = 'Cancel'
$cancelButton.Location = [System.Drawing.Point]::new(475, 190)
$cancelButton.Size = [System.Drawing.Size]::new(105, 32)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.CancelButton = $cancelButton
$form.Controls.Add($cancelButton)

$dialogResult = $form.ShowDialog()
$passphrase = $passwordBox.Text
$confirmation = $confirmBox.Text
$passwordBox.Clear()
$confirmBox.Clear()
$form.Dispose()
if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK) {
    $passphrase = $null
    $confirmation = $null
    Write-Output 'CA creation cancelled before generating key material.'
    exit 2
}
if ($passphrase.Length -lt 20 -or $passphrase -cne $confirmation) {
    $passphrase = $null
    $confirmation = $null
    throw 'Passphrase confirmation failed or passphrase is shorter than 20 characters. No CA material was generated.'
}
$confirmation = $null

$envName = 'R9_ANDROID_APP_CA_KEYSTORE_SECRET'
[Environment]::SetEnvironmentVariable($envName, $passphrase, 'Process')
$passphrase = $null
$arguments = @(
    '-genkeypair', '-alias', $alias,
    '-keystore', $store, '-storetype', 'PKCS12',
    '-keyalg', 'RSA', '-keysize', '3072', '-sigalg', 'SHA384withRSA',
    '-validity', '1825',
    '-dname', 'CN=DSH Remote Android Application Issuing CA v1,O=DSH Remote',
    '-ext', 'BC:critical=ca:true,pathlen:0',
    '-ext', 'KU:critical=keyCertSign,cRLSign',
    '-storepass:env', $envName, '-keypass:env', $envName
)
try {
    $generationOutput = & $Keytool @arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "keytool CA generation failed with exit $LASTEXITCODE" }
    $exportArgs = @('-exportcert', '-rfc', '-alias', $alias, '-keystore', $store,
        '-storetype', 'PKCS12', '-storepass:env', $envName, '-file', $publicCert)
    $exportOutput = & $Keytool @exportArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "keytool public certificate export failed with exit $LASTEXITCODE" }

    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem(
        [System.IO.File]::ReadAllText($publicCert)
    )
    $constraints = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | ForEach-Object {
        [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]$_
    } | Select-Object -First 1
    $usage = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.15' } | ForEach-Object {
        [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]$_
    } | Select-Object -First 1
    if (-not $constraints -or -not $constraints.CertificateAuthority -or $constraints.HasPathLengthConstraint -ne $true -or $constraints.PathLengthConstraint -ne 0) {
        throw 'Generated CA certificate has incorrect BasicConstraints.'
    }
    $requiredUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    if (-not $usage -or ($usage.KeyUsages -band $requiredUsage) -ne $requiredUsage) {
        throw 'Generated CA certificate has incorrect KeyUsage.'
    }
    $rsaPublic = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert)
    if (-not $rsaPublic -or $rsaPublic.KeySize -ne 3072) { throw 'Generated CA public key is not RSA 3072 bits.' }

    $pfxCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $store, [Environment]::GetEnvironmentVariable($envName, 'Process'),
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    )
    try {
        if (-not $pfxCert.HasPrivateKey -or $pfxCert.Thumbprint -ne $cert.Thumbprint) {
            throw 'PKCS#12 private entry does not match the exported CA certificate.'
        }
    } finally { $pfxCert.Dispose() }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $certSha256 = [Convert]::ToHexString($sha.ComputeHash($cert.RawData)).ToLowerInvariant() }
    finally { $sha.Dispose() }
    $serial = $cert.SerialNumber.ToLowerInvariant()
    $inventory = [ordered]@{
        version = 1
        alias = $alias
        subject = $cert.Subject
        issuer = $cert.Issuer
        serialHex = $serial
        certificateSha256 = $certSha256
        publicKeyAlgorithm = $cert.PublicKey.Oid.FriendlyName
        publicKeyBits = $rsaPublic.KeySize
        signatureAlgorithmOid = $cert.SignatureAlgorithm.Value
        notBeforeUtc = $cert.NotBefore.ToUniversalTime().ToString('o')
        notAfterUtc = $cert.NotAfter.ToUniversalTime().ToString('o')
        basicConstraints = 'critical; CA:TRUE; pathLen:0'
        keyUsage = 'critical; keyCertSign, cRLSign'
        privateKeystore = 'private/android-app-ca-v1.p12'
        publicCertificate = 'public/android-app-ca-v1.crt'
        privateKeyMaterialExported = $false
        pkcs12PrivateEntryVerified = $true
        windowsVolumeEncryptionStatus = 'unverified; PKCS#12 passphrase encryption and restricted directory ACL required'
        offlineBackupCopiesCreated = $false
    }
    $rsaPublic.Dispose()
    $inventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $inventoryFile -Encoding utf8
    $cert.Dispose()
    [System.Windows.Forms.MessageBox]::Show(
        "Android application CA created and verified.`n`nCertificate SHA-256: $certSha256`nSerial: $serial`nExpires UTC: $($inventory.notAfterUtc)`n`nThe private key remains in the password-encrypted PKCS#12. No leaf was issued and no phone/runtime was changed.",
        'CA created', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    Write-Output "CA certificate SHA-256: $certSha256"
    Write-Output "CA certificate serial: $serial"
    Write-Output "CA certificate expiry (UTC): $($inventory.notAfterUtc)"
    Write-Output "Public certificate: $publicCert"
    Write-Output "Encrypted private keystore: $store"
    Write-Output "Inventory: $inventoryFile"
} catch {
    if (Test-Path -LiteralPath $publicCert) { Remove-Item -LiteralPath $publicCert -Force }
    if (Test-Path -LiteralPath $inventoryFile) { Remove-Item -LiteralPath $inventoryFile -Force }
    if (Test-Path -LiteralPath $store) { Remove-Item -LiteralPath $store -Force }
    [System.Windows.Forms.MessageBox]::Show(
        "CA creation or verification failed. Any partial output was removed from the dedicated CA directory.`n`n$($_.Exception.Message)",
        'CA creation failed', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    throw
} finally {
    [Environment]::SetEnvironmentVariable($envName, $null, 'Process')
}
