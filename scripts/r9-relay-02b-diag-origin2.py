#!/usr/bin/env python3
"""Check whether the origin receives requests through the frps vhost."""
import http.client
import socket
import ssl
import subprocess
import time

BIN = "/r9/bin"
HOST = "relay.drm-jd.com"

print("=== is the origin process running? ===")
ps = subprocess.run(["sh", "-c", "ps -eo pid,args 2>/dev/null | grep -E 'origin.py' | grep -v grep"], capture_output=True, text=True)
print("  " + (ps.stdout.strip() or "(NOT RUNNING)"))

print("\n=== direct TLS request to the origin (no frps) ===")
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
try:
    raw = socket.create_connection(("127.0.0.1", 9444), timeout=8)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    s.sendall(b"GET /api/v1/health HTTP/1.1\r\nHost: " + HOST.encode() + b"\r\nConnection: close\r\n\r\n")
    data = b""
    s.settimeout(6)
    while True:
        try:
            c = s.recv(4096)
        except Exception:
            break
        if not c:
            break
        data += c
    s.close()
    print("  bytes:", len(data))
    print("  body :", repr(data.split(b"\r\n\r\n", 1)[-1][:120]))
except Exception as e:  # noqa: BLE001
    print("  FAILED:", type(e).__name__, e)

print("\n=== start a keep-alive frpc, then probe THROUGH the vhost ===")
keep = subprocess.Popen([f"{BIN}/frpc", "-c", "/work/keep.toml"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/work")
time.sleep(7)
try:
    ctx2 = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx2.check_hostname = False
    ctx2.verify_mode = ssl.CERT_NONE
    raw = socket.create_connection(("127.0.0.1", 7443), timeout=10)
    s = ctx2.wrap_socket(raw, server_hostname=HOST)
    s.sendall(b"GET /api/v1/health HTTP/1.1\r\nHost: " + HOST.encode() + b"\r\nConnection: close\r\n\r\n")
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
    print("  bytes through vhost:", len(data))
    print("  full:", repr(data[:400]))
finally:
    keep.terminate()
    try:
        keep.wait(timeout=5)
    except Exception:
        keep.kill()

print("\n=== origin request log after the probes ===")
try:
    print("  " + (open("/work/origin-requests.log").read().strip().replace("\n", "\n  ") or "(still empty)"))
except OSError:
    print("  (no log file)")
