#!/bin/sh
# R9-RELAY-02B — §4-§6: create the FRP transport PKI (two separate issuer roles).
#
# Runs inside the Linux environment where openssl is available. Writes into a staging directory that
# is then copied to the ACL-protected Windows PKI root. The issuer private keys never leave PC control.
#
# Roles created, all with INDEPENDENT keypairs:
#   server-ca   -> signs only frps server identities
#   client-ca   -> signs only frpc client identities
#   frps leaf   -> EKU serverAuth, SAN r9-frps-control.internal
#   frpc leaf   -> EKU clientAuth
#
# The application HTTPS hostname (relay.drm-jd.com) is deliberately NOT used as the FRP transport
# identity: that name belongs to the opaque application TLS layer.
set -e
OUT=/root/r9frp-pki
rm -rf "$OUT"
mkdir -p "$OUT/server-ca" "$OUT/client-ca" "$OUT/leaves"

echo "=== FRP Server CA (CA:TRUE, keyCertSign) ==="
openssl genrsa -out "$OUT/server-ca/server-ca.key" 4096 2>/dev/null
openssl req -x509 -new -key "$OUT/server-ca/server-ca.key" -sha256 -days 825 \
  -out "$OUT/server-ca/server-ca.crt" \
  -subj "/CN=R9 FRP Server CA/O=R9 RELAY FRP TRANSPORT ONLY - NOT APPLICATION TLS" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

echo "=== FRP Client CA (CA:TRUE, keyCertSign) — SEPARATE keypair ==="
openssl genrsa -out "$OUT/client-ca/client-ca.key" 4096 2>/dev/null
openssl req -x509 -new -key "$OUT/client-ca/client-ca.key" -sha256 -days 825 \
  -out "$OUT/client-ca/client-ca.crt" \
  -subj "/CN=R9 FRP Client CA/O=R9 RELAY FRP TRANSPORT ONLY - NOT APPLICATION TLS" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

echo "=== frps server leaf (serverAuth only, SAN r9-frps-control.internal) ==="
cat > "$OUT/leaves/frps.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=critical,serverAuth
subjectAltName=DNS:r9-frps-control.internal
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl genrsa -out "$OUT/leaves/frps-server.key" 2048 2>/dev/null
openssl req -new -key "$OUT/leaves/frps-server.key" -out "$OUT/leaves/frps-server.csr" \
  -subj "/CN=r9-frps-control.internal/O=R9 FRP SERVER IDENTITY"
openssl x509 -req -in "$OUT/leaves/frps-server.csr" -CA "$OUT/server-ca/server-ca.crt" \
  -CAkey "$OUT/server-ca/server-ca.key" -CAcreateserial -out "$OUT/leaves/frps-server.crt" \
  -days 397 -sha256 -extfile "$OUT/leaves/frps.ext" 2>/dev/null

echo "=== frpc client leaf (clientAuth only) ==="
cat > "$OUT/leaves/frpc.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,clientAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl genrsa -out "$OUT/leaves/frpc-client.key" 2048 2>/dev/null
openssl req -new -key "$OUT/leaves/frpc-client.key" -out "$OUT/leaves/frpc-client.csr" \
  -subj "/CN=r9-frpc-production/O=R9 FRP CLIENT IDENTITY"
openssl x509 -req -in "$OUT/leaves/frpc-client.csr" -CA "$OUT/client-ca/client-ca.crt" \
  -CAkey "$OUT/client-ca/client-ca.key" -CAcreateserial -out "$OUT/leaves/frpc-client.crt" \
  -days 397 -sha256 -extfile "$OUT/leaves/frpc.ext" 2>/dev/null

rm -f "$OUT/leaves"/*.csr "$OUT/leaves"/*.ext "$OUT"/*.srl "$OUT"/*/*.srl
echo
echo "=== created files ==="
ls -l "$OUT/server-ca" "$OUT/client-ca" "$OUT/leaves"
