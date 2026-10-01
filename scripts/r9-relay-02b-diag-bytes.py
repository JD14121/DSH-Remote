#!/usr/bin/env python3
"""Dump the exact bytes received through the vhost. Self-contained: starts the whole topology."""
import socket
import ssl
import subprocess
import time

BIN = "/r9/bin"
WORK = "/work"
HOST = "relay.drm-jd.com"
MARKER = "SYNTHETIC-ORIGIN-STANDIN"
procs = []


def wait_port(port, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def start(argv):
    p = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=WORK)
    procs.append(p)
    return p


try:
    start(["python3", f"{WORK}/admission-plugin.py", "9100", f"{WORK}/policy.toml", f"{WORK}/plugin.log"])
    print("  plugin ready:", wait_port(9100))
    start([f"{BIN}/frps", "-c", f"{WORK}/frps.toml"])
    print("  frps ready  :", wait_port(7100) and wait_port(7443))
    start(["python3", f"{WORK}/origin.py"])
    print("  origin ready:", wait_port(9444))
    time.sleep(1)

    keep = start([f"{BIN}/frpc", "-c", f"{WORK}/keep2.toml"])
    time.sleep(9)
    print("  frpc alive  :", keep.poll() is None)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    raw = socket.create_connection(("127.0.0.1", 7443), timeout=10)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    s.sendall(f"GET /api/v1/health HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n".encode())

    chunks = []
    s.settimeout(10)
    while True:
        try:
            c = s.recv(4096)
        except Exception:
            break
        if not c:
            break
        chunks.append(c)
    s.close()

    payload = b"".join(chunks)
    print("\n=== received through the frps vhost ===")
    print("  total bytes :", len(payload))
    print("  repr        :", repr(payload))
    body = payload.split(b"\r\n\r\n", 1)[-1]
    print("  body repr   :", repr(body))
    print("  body len    :", len(body))
    print("  marker in body        :", MARKER.encode() in body)
    print("  marker in full payload:", MARKER.encode() in payload)
finally:
    for p in procs:
        try:
            p.terminate(); p.wait(timeout=5)
        except Exception:
            try: p.kill()
            except Exception: pass
