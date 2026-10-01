#!/usr/bin/env python3
"""Diagnose the synthetic origin: what does it actually return?"""
import ssl
import socket

print("=== direct TLS to the origin on 9444 ===")
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
try:
    raw = socket.create_connection(("127.0.0.1", 9444), timeout=8)
    s = ctx.wrap_socket(raw, server_hostname="relay.drm-jd.com")
    s.sendall(b"GET /api/v1/health HTTP/1.1\r\nHost: relay.drm-jd.com\r\nConnection: close\r\n\r\n")
    data = b""
    s.settimeout(6)
    try:
        while True:
            c = s.recv(4096)
            if not c:
                break
            data += c
    except Exception as e:  # noqa: BLE001
        print("  recv ended:", type(e).__name__)
    s.close()
    print("  bytes:", len(data))
    print("  raw  :", repr(data[:400]))
except Exception as e:  # noqa: BLE001
    print("  FAILED:", type(e).__name__, e)

print("\n=== origin stdout/stderr ===")
try:
    print(open("/work/origin.out").read()[-800:] or "(empty)")
except OSError:
    print("  (no origin.out)")
