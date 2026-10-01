#!/bin/sh
# R9-RELAY-03 — rigorous frps-side proxy-admission test.
#
# Fixes two flaws in the previous attempt:
#   1. the "success" grep matched "frps started successfully" / "client exit success" — it must look for
#      an actual PROXY registration, not any occurrence of the word success;
#   2. case A (control) had no plugin listening, so A and B behaved identically and the control was
#      worthless. The plugin is now started and its readiness is asserted BEFORE the control runs.
set -u
BIN=/r9/bin/frps
FRPC=/r9/bin/frpc
TOKEN=/secrets/app-auth-token

start_plugin() {
  pkill -f admission-plugin 2>/dev/null || true
  sleep 1
  python3 /work/admission-plugin.py 9100 /work/policy.toml /tmp/plugin.log >/dev/null 2>&1 &
  sleep 2
  if python3 - <<'PY'
import socket, sys
try:
    with socket.create_connection(("127.0.0.1", 9100), timeout=2):
        sys.exit(0)
except OSError:
    sys.exit(1)
PY
  then echo "  plugin READY on 127.0.0.1:9100"; else echo "  *** plugin NOT ready ***"; fi
}

mkcfg() {
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
log.level = "debug"
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

verdict() {
  # Look ONLY for an actual proxy registration, never for the word "success" alone.
  if grep -qiE 'proxy \[r9-relay-https\] (is )?(added|registered|start)|new proxy \[r9-relay-https\] success|\[r9-relay-https\] start proxy success' /tmp/frps.log 2>/dev/null; then
    echo "    PROXY ADMITTED BY FRPS: YES"
    grep -iE 'proxy \[r9-relay-https\]|new proxy' /tmp/frps.log | tail -3 | sed 's/.*\] //' | sed 's/^/      /'
  else
    echo "    PROXY ADMITTED BY FRPS: NO"
  fi
}

run_case() {
  label="$1"; plug="$2"
  echo
  echo "=== $label ==="
  pkill -f "$BIN" 2>/dev/null || true; sleep 1; rm -f /tmp/frps.log /tmp/frpc.out
  mkcfg "$plug"; mkfrpc
  "$BIN" -c /tmp/frps.toml >/dev/null 2>&1 &
  sleep 4
  echo "  frps listening: $(grep -c 'started successfully' /tmp/frps.log 2>/dev/null) start line(s)"
  timeout 10 "$FRPC" -c /tmp/frpc.toml >/tmp/frpc.out 2>&1 || true
  echo "  client outcome:"
  sed -e 's/\x1b\[[0-9;]*m//g' /tmp/frpc.out | grep -E 'login to server|proxy added|start proxy success|start error' | sed 's/.*\] //' | sed 's/^/    /'
  verdict
  pkill -f "$BIN" 2>/dev/null || true; sleep 1
}

# The control MUST have a live plugin, or it proves nothing.
start_plugin
run_case "A. plugin UP (control)" "127.0.0.1:9100"
run_case "B. plugin UNREACHABLE (dead port 9199)" "127.0.0.1:9199"

echo
echo "=== C. plugin UP at start, KILLED mid-flight ==="
start_plugin
pkill -f "$BIN" 2>/dev/null || true; sleep 1; rm -f /tmp/frps.log /tmp/frpc.out
mkcfg "127.0.0.1:9100"; mkfrpc
"$BIN" -c /tmp/frps.toml >/dev/null 2>&1 &
sleep 4
echo "  frps up; killing the plugin now"
pkill -f admission-plugin 2>/dev/null || true
sleep 2
timeout 10 "$FRPC" -c /tmp/frpc.toml >/tmp/frpc.out 2>&1 || true
echo "  client outcome:"
sed -e 's/\x1b\[[0-9;]*m//g' /tmp/frpc.out | grep -E 'login to server|proxy added|start proxy success|start error' | sed 's/.*\] //' | sed 's/^/    /'
verdict
echo "    frps still running after plugin death: $(pgrep -f "$BIN" >/dev/null 2>&1 && echo YES || echo NO)"
pkill -f "$BIN" 2>/dev/null || true

rm -f /tmp/frps.toml /tmp/frpc.toml /tmp/frps.log /tmp/frpc.out /tmp/plugin.log
echo
echo DONE
