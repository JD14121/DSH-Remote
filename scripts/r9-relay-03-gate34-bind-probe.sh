#!/bin/sh
# R9-RELAY-03 GATE 3.4 — rigorous bind-semantics probe with explicit listener capture.
set -u
BIN=/r9/bin/frps
LOG=/tmp/frps.log

echo "=== baseline interfaces ==="
ip -o addr show 2>/dev/null | awk '{print "  " $2, $3, $4}'

echo
echo "=== adding a second loopback address to stand in for the anchor IP ==="
ip addr add 127.0.0.2/8 dev lo 2>&1 | sed 's/^/  /' || echo "  (ip addr add failed)"
ip addr add 127.0.0.3/8 dev lo 2>&1 | sed 's/^/  /' || echo "  (ip addr add failed)"
echo "  after:"
ip -o addr show 2>/dev/null | awk '{print "    " $2, $3, $4}'

cfg() {
  cat > /tmp/c.toml <<EOF
bindAddr = "$1"
bindPort = 7100
proxyBindAddr = "$2"
vhostHTTPSPort = 7443
transport.tls.force = true
transport.tls.certFile = "/pki/public/leaves/frps-server.crt"
transport.tls.keyFile = "/pki/keys/leaves/frps-server.key"
transport.tls.trustedCaFile = "/pki/public/client-ca/client-ca.crt"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/secrets/app-auth-token"
log.to = "$LOG"
log.level = "info"
[[httpPlugins]]
name = "p"
addr = "127.0.0.1:9100"
path = "/cgi-bin/frp-newproxy"
ops = ["NewProxy"]
EOF
}

probe() {
  label="$1"; ba="$2"; pb="$3"
  echo
  echo "=== $label ==="
  echo "  config: bindAddr=$ba  proxyBindAddr=$pb"
  cfg "$ba" "$pb"
  pkill -f "$BIN" 2>/dev/null || true; sleep 1; rm -f "$LOG"
  "$BIN" -c /tmp/c.toml >/dev/null 2>&1 &
  sleep 4
  echo "  frps reported:"
  grep -E 'tcp listen|https service listen' "$LOG" 2>/dev/null | sed 's/.*\] //' | sed 's/^/    /'
  echo "  actual sockets (ss):"
  ss -H -tln 2>/dev/null | awk '$4 ~ /:(7100|7443)$/ {print "    " $4}'
  echo "  reachability:"
  for t in 127.0.0.1 127.0.0.2 127.0.0.3; do
    if timeout 2 sh -c "exec 3<>/dev/tcp/$t/7100" 2>/dev/null; then echo "    $t:7100 OPEN"; else echo "    $t:7100 closed"; fi
  done
  pkill -f "$BIN" 2>/dev/null || true; sleep 1
}

probe "A. wildcard (current production template)" 0.0.0.0 0.0.0.0
probe "B. anchor-only (proposed)"                 127.0.0.2 127.0.0.2
probe "C. control and vhost on DIFFERENT addresses" 127.0.0.2 127.0.0.3
probe "D. IPv6 wildcard"                          "::" "::"

echo
echo "=== does explicit IPv4 binding create ANY IPv6 listener? ==="
cfg 127.0.0.2 127.0.0.2
pkill -f "$BIN" 2>/dev/null || true; sleep 1; rm -f "$LOG"
"$BIN" -c /tmp/c.toml >/dev/null 2>&1 &
sleep 4
echo "  all IPv6 TCP listeners:"
ss -H -tln6 2>/dev/null | awk '$4 ~ /:(7100|7443)$/ {print "    " $4}' || true
echo "  (no lines above = no IPv6 listener on those ports)"
pkill -f "$BIN" 2>/dev/null || true

echo
echo "=== unset proxyBindAddr: does it default to bindAddr? ==="
cat > /tmp/d.toml <<EOF
bindAddr = "127.0.0.2"
bindPort = 7100
vhostHTTPSPort = 7443
transport.tls.force = true
transport.tls.certFile = "/pki/public/leaves/frps-server.crt"
transport.tls.keyFile = "/pki/keys/leaves/frps-server.key"
transport.tls.trustedCaFile = "/pki/public/client-ca/client-ca.crt"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/secrets/app-auth-token"
log.to = "$LOG"
[[httpPlugins]]
name = "p"
addr = "127.0.0.1:9100"
path = "/cgi-bin/frp-newproxy"
ops = ["NewProxy"]
EOF
pkill -f "$BIN" 2>/dev/null || true; sleep 1; rm -f "$LOG"
"$BIN" -c /tmp/d.toml >/dev/null 2>&1 &
sleep 4
grep -E 'tcp listen|https service listen' "$LOG" 2>/dev/null | sed 's/.*\] /  /'
pkill -f "$BIN" 2>/dev/null || true

rm -f /tmp/c.toml /tmp/d.toml "$LOG"
echo
echo DONE
