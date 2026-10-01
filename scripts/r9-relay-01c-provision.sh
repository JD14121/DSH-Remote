#!/bin/sh
# R9-RELAY-01C — bring up the isolated frp admission fixture inside a container.
#
# Everything runs in ONE container with NO published ports. frps, the admission plugin, the upstream
# and the test driver are co-located so every socket is loopback inside the container's own network
# namespace. Nothing on Windows or WSL is exposed, and no port is published.

set -e
echo "=== provisioning the R9-RELAY-01C admission fixture ==="
echo "kernel: $(uname -a)"
echo "python: $(python3 --version 2>&1)"

mkdir -p /fixture/bin /fixture/root/cgi-bin /fixture/log
cd /fixture

# The frp binaries are the SHA-256-verified v0.71.0 Linux build from the earlier phase.
cp /root/r9frp/frp_0.71.0_linux_amd64/frps /fixture/bin/frps
cp /root/r9frp/frp_0.71.0_linux_amd64/frpc /fixture/bin/frpc
chmod +x /fixture/bin/frps /fixture/bin/frpc
echo "frps: $(/fixture/bin/frps --version 2>&1)"
echo "frpc: $(/fixture/bin/frpc --version 2>&1)"

# The admission plugin: a real HTTP server, which is the whole point of the container.
cp /mnt/host/d/DSH-testing/dsh-remote-gateway/scripts/r9-relay-01c-admission-plugin.py /fixture/admission-plugin.py
wc -l /fixture/admission-plugin.py

# A minimal origin server standing in for the Android-side app behind the tunnel.
cat > /fixture/upstream.py <<'PYEOF'
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"fixture":"r9relay01c-upstream","path":"' + self.path.encode() + b'"}\n'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', 7444), H) as httpd:
    httpd.serve_forever()
PYEOF

echo "=== fixture provisioned ==="
ls -l /fixture /fixture/bin
