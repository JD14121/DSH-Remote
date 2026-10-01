#!/usr/bin/env python3
"""
R9-RELAY-02B — clean end-to-end verification of SNI routing and TLS passthrough.

Starts plugin -> frps -> origin, registers the approved proxy with a long-lived frpc, and only then
probes the vhost. Everything is done in one process so process lifetimes are deterministic.
"""
import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys
import time

BIN = "/r9/bin"
WORK = "/work"
PKI = "/pki"
SECRETS = "/secrets"
HOST = "relay.drm-jd.com"
MARKER = "SYNTHETIC-ORIGIN-STANDIN"
FRPS_PORT, VHOST_PORT, PLUGIN_PORT, ORIGIN_PORT = 7100, 7443, 9100, 9444

procs = {}


def wait_port(port, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def start(name, argv):
    procs[name] = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=WORK)
    return procs[name]


def stop_all():
    for n, p in list(procs.items()):
        try:
            p.terminate(); p.wait(timeout=5)
        except Exception:
            try: p.kill()
            except Exception: pass


def probe(sni):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        raw = socket.create_connection(("127.0.0.1", VHOST_PORT), timeout=10)
        s = ctx.wrap_socket(raw, server_hostname=sni)
        fp = hashlib.sha256(s.getpeercert(binary_form=True)).hexdigest()
        s.sendall(f"GET /api/v1/health HTTP/1.1\r\nHost: {sni}\r\nConnection: close\r\n\r\n".encode())
        data = b""
        s.settimeout(10)
        while True:
            try:
                c = s.recv(4096)
            except Exception:
                break
            if not c:
                break
            data += c
        s.close()
        return {"connected": True, "peer_sha256": fp, "bytes": len(data),
                "reached_origin": MARKER in data.decode("latin1", "replace"),
                "status": data.split(b"\r\n")[0].decode("latin1", "replace") if data else None}
    except Exception as e:  # noqa: BLE001
        return {"connected": False, "error": f"{type(e).__name__}: {str(e)[:60]}", "reached_origin": False}


def frpc_cfg(local_port):
    return f"""serverAddr = "127.0.0.1"
serverPort = {FRPS_PORT}
transport.tls.enable = true
transport.tls.certFile = "{PKI}/public/leaves/frpc-client.crt"
transport.tls.keyFile = "{PKI}/keys/leaves/frpc-client.key"
transport.tls.trustedCaFile = "{PKI}/public/server-ca/server-ca.crt"
transport.tls.serverName = "r9-frps-control.internal"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "{SECRETS}/app-auth-token"

[[proxies]]
name = "r9-relay-https"
type = "https"
localIP = "127.0.0.1"
localPort = {local_port}
customDomains = ["{HOST}"]
"""


def main():
    print("=== clean start: plugin -> frps -> origin ===", flush=True)
    start("plugin", ["python3", f"{WORK}/admission-plugin.py", str(PLUGIN_PORT), f"{WORK}/policy.toml", f"{WORK}/plugin.log"])
    print("  plugin ready :", wait_port(PLUGIN_PORT), flush=True)
    start("frps", [f"{BIN}/frps", "-c", f"{WORK}/frps.toml"])
    print("  frps ready   :", wait_port(FRPS_PORT) and wait_port(VHOST_PORT), flush=True)
    start("origin", ["python3", f"{WORK}/origin.py"])
    print("  origin ready :", wait_port(ORIGIN_PORT), flush=True)
    time.sleep(1)

    cfg = f"{WORK}/keep2.toml"
    with open(cfg, "w") as fh:
        fh.write(frpc_cfg(ORIGIN_PORT))

    # Start frpc with output captured to a file so registration can be confirmed before probing.
    log = open(f"{WORK}/keep2.out", "w")
    keep = subprocess.Popen([f"{BIN}/frpc", "-c", cfg], stdout=log, stderr=subprocess.STDOUT, cwd=WORK)
    procs["keep"] = keep
    time.sleep(10)
    log.flush()
    out = open(f"{WORK}/keep2.out").read()
    import re
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)
    print("\n=== frpc registration ===")
    for line in out.strip().splitlines()[-8:]:
        print("  " + line)
    print(f"  proxy registered: {'start proxy success' in out}")

    print("\n=== probes through the vhost (proxy live) ===")
    results = {}
    for label, sni in (("correct", HOST), ("wrong", "example-invalid.drm-jd.com"), ("none", None)):
        r = probe(sni)
        results[label] = r
        print(f"  {label:8} SNI -> {json.dumps(r)}")

    # Passthrough: the client must see the ORIGIN's certificate, not an frps one.
    der = subprocess.run(["openssl", "x509", "-in", "/origin/origin.crt", "-outform", "DER"], capture_output=True).stdout
    origin_fp = hashlib.sha256(der).hexdigest()
    print("\n=== TLS passthrough ===")
    print(f"  origin certificate sha256          : {origin_fp}")
    print(f"  certificate the client received    : {results['correct'].get('peer_sha256')}")
    print(f"  client saw the ORIGIN's identity    : {results['correct'].get('peer_sha256') == origin_fp}")

    print("\n=== origin received ===")
    try:
        print("  " + open(f"{WORK}/origin-requests.log").read().strip().replace("\n", "\n  "))
    except OSError:
        print("  (no request log)")

    verdict = {
        "correct_sni_reaches_origin": results["correct"].get("reached_origin") is True,
        "wrong_sni_blocked": results["wrong"].get("reached_origin") is not True,
        "no_sni_blocked": results["none"].get("reached_origin") is not True,
        "passthrough_client_saw_origin_cert": results["correct"].get("peer_sha256") == origin_fp,
        "proxy_registered": "start proxy success" in out,
    }
    print("\n=== VERDICT ===")
    for k, v in verdict.items():
        print(f"  [{'PASS' if v else 'FAIL'}] {k}")
    print(json.dumps({"results": results, "verdict": verdict, "origin_fp": origin_fp}, indent=2))
    return 0 if all(verdict.values()) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        stop_all()
