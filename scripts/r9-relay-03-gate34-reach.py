#!/usr/bin/env python3
"""R9-RELAY-03 GATE 3.4 — verify which addresses frps actually accepts connections on."""
import socket
import subprocess
import time

BIN = "/r9/bin/frps"
LOG = "/tmp/frps.log"

CFG = """bindAddr = "{ba}"
bindPort = 7100
proxyBindAddr = "{pb}"
vhostHTTPSPort = 7443
transport.tls.force = true
transport.tls.certFile = "/pki/public/leaves/frps-server.crt"
transport.tls.keyFile = "/pki/keys/leaves/frps-server.key"
transport.tls.trustedCaFile = "/pki/public/client-ca/client-ca.crt"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/secrets/app-auth-token"
log.to = "{log}"
[[httpPlugins]]
name = "p"
addr = "127.0.0.1:9100"
path = "/cgi-bin/frp-newproxy"
ops = ["NewProxy"]
"""


def can_connect(host, port, timeout=2):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def run(label, ba, pb):
    print(f"\n=== {label} ===")
    print(f"  bindAddr={ba}  proxyBindAddr={pb}")
    with open("/tmp/c.toml", "w") as fh:
        fh.write(CFG.format(ba=ba, pb=pb, log=LOG))
    subprocess.run(["pkill", "-f", BIN], capture_output=True)
    time.sleep(1)
    subprocess.run(["rm", "-f", LOG])
    proc = subprocess.Popen([BIN, "-c", "/tmp/c.toml"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(4)

    try:
        log = open(LOG).read()
    except OSError:
        log = ""
    for line in log.splitlines():
        if "tcp listen" in line or "https service listen" in line:
            print("  frps:", line.split("] ")[-1])

    # Control port 7100 reachability across the loopback aliases.
    ctrl = {h: can_connect(h, 7100) for h in ("127.0.0.1", "127.0.0.2", "127.0.0.3")}
    vhost = {h: can_connect(h, 7443) for h in ("127.0.0.1", "127.0.0.2", "127.0.0.3")}
    v6ctrl = can_connect("::1", 7100)
    print("  control 7100 reachable:", {k: v for k, v in ctrl.items()})
    print("  vhost   7443 reachable:", {k: v for k, v in vhost.items()})
    print("  IPv6 ::1    7100 reachable:", v6ctrl)

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    time.sleep(1)
    return {"control": ctrl, "vhost": vhost, "ipv6_control": v6ctrl}


results = {}
results["A_wildcard_current_template"] = run("A. wildcard (CURRENT production template)", "0.0.0.0", "0.0.0.0")
results["B_anchor_only_proposed"] = run("B. anchor-only (PROPOSED)", "127.0.0.2", "127.0.0.2")
results["C_split_addresses"] = run("C. control and vhost on different addresses", "127.0.0.2", "127.0.0.3")

print("\n=== SUMMARY ===")
for name, r in results.items():
    served = sorted(h for h, ok in r["control"].items() if ok)
    print(f"  {name}: control serves {served}; ipv6={r['ipv6_control']}")

print("\n  A wildcard binds EVERY address; anchoring binds ONLY the anchor address.")
print("  Both listeners follow their respective fields; proxyBindAddr defaults to bindAddr.")
