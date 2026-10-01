#!/usr/bin/env python3
"""Probe through the frps vhost and print the COMPLETE response, to settle the marker question."""
import hashlib
import json
import socket
import ssl
import subprocess
import sys
import time

BIN = "/r9/bin"
VHOST = 7443
HOST = "relay.drm-jd.com"


def probe(sni):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        raw = socket.create_connection(("127.0.0.1", VHOST), timeout=10)
        s = ctx.wrap_socket(raw, server_hostname=sni)
        fp = hashlib.sha256(s.getpeercert(binary_form=True)).hexdigest()
        s.sendall(f"GET /api/v1/health HTTP/1.1\r\nHost: {sni}\r\nAccept: */*\r\nConnection: close\r\n\r\n".encode())
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
        return {"connected": True, "peer": fp, "bytes": len(data), "raw": data.decode("latin1", "replace")}
    except Exception as e:  # noqa: BLE001
        return {"connected": False, "error": f"{type(e).__name__}: {str(e)[:80]}"}


# Keep a long-lived frpc so a proxy is registered while probing.
cfg = "/work/keep.toml"
keep = subprocess.Popen([f"{BIN}/frpc", "-c", cfg], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/work")
time.sleep(7)

try:
    for label, sni in (("correct SNI", HOST), ("wrong SNI", "example-invalid.drm-jd.com"), ("no SNI", None)):
        r = probe(sni)
        print(f"\n=== {label} ({sni!r}) ===")
        if r.get("connected"):
            print(f"  peer cert sha256 : {r['peer']}")
            print(f"  bytes received   : {r['bytes']}")
            print(f"  full response    :")
            for line in r["raw"].split("\r\n"):
                print(f"    {line}")
            print(f"  contains ORIGIN marker: {'SYNTHETIC-ORIGIN-STANDIN' in r['raw']}")
        else:
            print(f"  {json.dumps(r)}")
finally:
    keep.terminate()
    try:
        keep.wait(timeout=5)
    except Exception:
        keep.kill()
