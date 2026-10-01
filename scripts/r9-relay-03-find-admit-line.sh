#!/bin/sh
# Find the exact frps log line that indicates an ADMITTED proxy, so the verdict check can be precise.
set -u
BIN=/r9/bin/frps

pkill -f "$BIN" 2>/dev/null || true
pkill -f admission-plugin 2>/dev/null || true
sleep 1
python3 /work/admission-plugin.py 9100 /work/policy.toml /tmp/plugin.log >/dev/null 2>&1 &
sleep 2

cat > /tmp/f2.toml <<'TOML'
bindAddr = "127.0.0.1"
bindPort = 7100
proxyBindAddr = "127.0.0.1"
vhostHTTPSPort = 7443
transport.tls.force = true
transport.tls.certFile = "/pki/public/leaves/frps-server.crt"
transport.tls.keyFile = "/pki/keys/leaves/frps-server.key"
transport.tls.trustedCaFile = "/pki/public/client-ca/client-ca.crt"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/secrets/app-auth-token"
log.to = "/tmp/frps.log"
log.level = "debug"
[[httpPlugins]]
name = "r9-newproxy-policy"
addr = "127.0.0.1:9100"
path = "/cgi-bin/frp-newproxy"
ops = ["NewProxy"]
TOML

cat > /tmp/f2c.toml <<'TOML'
serverAddr = "127.0.0.1"
serverPort = 7100
transport.tls.enable = true
transport.tls.certFile = "/pki/public/leaves/frpc-client.crt"
transport.tls.keyFile = "/pki/keys/leaves/frpc-client.key"
transport.tls.trustedCaFile = "/pki/public/server-ca/server-ca.crt"
transport.tls.serverName = "r9-frps-control.internal"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/secrets/app-auth-token"
loginFailExit = true
[[proxies]]
name = "r9-relay-https"
type = "https"
localIP = "127.0.0.1"
localPort = 9444
customDomains = ["relay.drm-jd.com"]
TOML

rm -f /tmp/frps.log
"$BIN" -c /tmp/f2.toml >/dev/null 2>&1 &
sleep 4
timeout 8 /r9/bin/frpc -c /tmp/f2c.toml >/dev/null 2>&1 || true
sleep 1
pkill -f "$BIN" 2>/dev/null || true

echo "=== ALL frps log lines mentioning the proxy name ==="
grep -i 'r9-relay-https' /tmp/frps.log 2>/dev/null | sed 's/.*\] //' | sed 's/^/  /' || echo "  (none)"
echo
echo "=== plugin-interaction lines ==="
grep -i 'plugin' /tmp/frps.log 2>/dev/null | sed 's/.*\] //' | sed 's/^/  /' | tail -5 || echo "  (none)"
echo
echo "=== total frps log lines ==="
wc -l < /tmp/frps.log 2>/dev/null || echo 0
