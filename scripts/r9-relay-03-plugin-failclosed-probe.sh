#!/bin/sh
# R9-RELAY-03 — does frps v0.71.0 FAIL CLOSED when the NewProxy plugin is unreachable?
#
# This is the load-bearing question for the systemd design. If frps denies registration when the plugin
# cannot be reached, the systemd dependency is defence-in-depth. If frps ADMITS in that case, the
# dependency is the primary control and must be hardened.
set -u
BIN=/r9/bin/frps
FRPC=/r9/bin/frpc
WORK=/work
POLICY=/work/policy.toml
TOKEN=/secrets/app-auth-token

mkconfig() {
  # $1 = plugin addr (may point at a dead port)
  cat > /tmp/frps.toml <<EOF
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
auth.tokenSource.file.path = "$TOKEN"
log.to = "/tmp/frps.log"
log.level = "info"
[[httpPlugins]]
name = "r9-newproxy-policy"
addr = "$1"
path = "/cgi-bin/frp-newproxy"
ops = ["NewProxy"]
EOF
}

mkfrpc() {
  cat > /tmp/frpc.toml <<EOF
serverAddr = "127.0.0.1"
serverPort = 7100
transport.tls.enable = true
transport.tls.certFile = "/pki/public/leaves/frpc-client.crt"
transport.tls.keyFile = "/pki/keys/leaves/frpc-client.key"
transport.tls.trustedCaFile = "/pki/public/server-ca/server-ca.crt"
transport.tls.serverName = "r9-frps-control.internal"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "$TOKEN"
loginFailExit = true

[[proxies]]
name = "r9-relay-https"
type = "https"
localIP = "127.0.0.1"
localPort = 9444
customDomains = ["relay.drm-jd.com"]
EOF
}

run_frpc() {
  timeout 12 "$FRPC" -c /tmp/frpc.toml 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g'
}

echo "=== CASE 1: plugin UP (control) ==="
pkill -f 'admission-plugin' 2>/dev/null || true
pkill -f "$BIN" 2>/dev/null || true
sleep 1
python3 "$WORK/admission-plugin.py" 9100 "$POLICY" /tmp/plugin.log >/dev/null 2>&1 &
sleep 2
mkconfig "127.0.0.1:9100"
mkfrpc
rm -f /tmp/frps.log
"$BIN" -c /tmp/frps.toml >/dev/null 2>&1 &
sleep 4
echo "--- frpc with plugin UP ---"
run_frpc | grep -E 'login to server|proxy added|start proxy success|start error' | sed 's/^/    /'
pkill -f "$BIN" 2>/dev/null || true
pkill -f 'admission-plugin' 2>/dev/null || true
sleep 1

echo
echo "=== CASE 2: plugin UNREACHABLE (dead port, frps still running) ==="
mkconfig "127.0.0.1:9199"   # nothing listening
rm -f /tmp/frps.log
"$BIN" -c /tmp/frps.toml >/dev/null 2>&1 &
sleep 4
echo "--- did frps start despite a dead plugin? ---"
grep -E 'started successfully|plugin' /tmp/frps.log 2>/dev/null | sed 's/.*\] /    /' || echo "    (no log)"
echo "--- frpc against frps with UNREACHABLE plugin ---"
run_frpc | grep -E 'login to server|proxy added|start proxy success|start error' | sed 's/^/    /'
pkill -f "$BIN" 2>/dev/null || true
sleep 1

echo
echo "=== CASE 3: plugin DIED AFTER frps started (the systemd-relevant case) ==="
pkill -f 'admission-plugin' 2>/dev/null || true
sleep 1
python3 "$WORK/admission-plugin.py" 9100 "$POLICY" /tmp/plugin.log >/dev/null 2>&1 &
sleep 2
mkconfig "127.0.0.1:9100"
rm -f /tmp/frps.log
"$BIN" -c /tmp/frps.toml >/dev/null 2>&1 &
sleep 4
echo "  frps started; now KILLING the plugin..."
pkill -f 'admission-plugin' 2>/dev/null || true
sleep 2
echo "--- frpc after the plugin died mid-flight ---"
run_frpc | grep -E 'login to server|proxy added|start proxy success|start error' | sed 's/^/    /'
echo "--- is frps still running after the plugin died? ---"
if pgrep -f "$BIN" >/dev/null 2>&1; then echo "    frps STILL RUNNING (did not self-stop)"; else echo "    frps exited"; fi
pkill -f "$BIN" 2>/dev/null || true

rm -f /tmp/frps.toml /tmp/frpc.toml /tmp/frps.log /tmp/plugin.log
echo
echo DONE
