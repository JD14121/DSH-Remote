#!/bin/sh
# Definitive side-by-side: does frps ADMIT the proxy when the plugin is up vs unreachable?
# Dumps the full frps log for both cases so the difference is visible rather than inferred.
set -u
BIN=/r9/bin/frps

mkfrps() {
  cat > /tmp/f3.toml <<TOML
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
addr = "$1"
path = "/cgi-bin/frp-newproxy"
ops = ["NewProxy"]
TOML
}

mkfrpc() {
  cat > /tmp/f3c.toml <<'TOML'
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
}

mkfrpc

case_one() {
  label="$1"; addr="$2"
  echo
  echo "############ $label (plugin addr $addr) ############"
  pkill -f "$BIN" 2>/dev/null || true; sleep 1; rm -f /tmp/frps.log
  mkfrps "$addr"
  "$BIN" -c /tmp/f3.toml >/dev/null 2>&1 &
  sleep 4
  timeout 8 /r9/bin/frpc -c /tmp/f3c.toml >/dev/null 2>&1 || true
  sleep 1
  echo "--- frps log (proxy/plugin related, in order) ---"
  grep -iE 'proxy|plugin|success|error' /tmp/frps.log 2>/dev/null | sed 's/.*\] //' | sed 's/^/  /'
  pkill -f "$BIN" 2>/dev/null || true; sleep 1
}

# Control must have a LIVE plugin.
pkill -f admission-plugin 2>/dev/null || true; sleep 1
python3 /work/admission-plugin.py 9100 /work/policy.toml /tmp/plugin.log >/dev/null 2>&1 &
sleep 2

case_one "A. plugin UP (control)" "127.0.0.1:9100"
case_one "B. plugin UNREACHABLE" "127.0.0.1:9199"

pkill -f admission-plugin 2>/dev/null || true
rm -f /tmp/f3.toml /tmp/f3c.toml /tmp/frps.log /tmp/plugin.log
echo
echo DONE
