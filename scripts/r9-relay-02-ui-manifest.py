#!/usr/bin/env python3
"""
R9-RELAY-02 — static UI artifact manifest.

Deterministically hashes the accepted R8 UI source so the future production artifact has a verifiable
baseline. This does NOT run a dev server, does not touch port 8099, does not use adb reverse, and does
not redesign the UI: it only records what the accepted source consists of.

Written to the path given as argv[1], or printed if omitted.
"""

import hashlib
import json
import os
import sys

SOURCE = sys.argv[1] if len(sys.argv) > 1 else "/ui"
OUT = sys.argv[2] if len(sys.argv) > 2 else None

# Only the browser-served surface. Test fixtures and recovery tooling are not part of the artifact.
INCLUDE_EXT = {".html", ".js", ".mjs", ".css", ".json", ".svg", ".png", ".webp", ".ico", ".woff2"}

files = []
for root, dirs, names in os.walk(SOURCE):
    # Skip anything that is not part of the served UI.
    dirs[:] = [d for d in dirs if d not in ("fixtures", "node_modules", ".git")]
    for name in sorted(names):
        if name.endswith(".test.mjs") or name.endswith(".spec.mjs"):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in INCLUDE_EXT:
            continue
        path = os.path.join(root, name)
        rel = os.path.relpath(path, SOURCE).replace("\\", "/")
        data = open(path, "rb").read()
        files.append({"path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})

files.sort(key=lambda f: f["path"])

# A content-addressed version identifier: the hash of the sorted per-file digests.
aggregate = hashlib.sha256()
for entry in files:
    aggregate.update(f"{entry['path']}:{entry['sha256']}\n".encode())
version = aggregate.hexdigest()

manifest = {
    "artifact": "r9-relay-static-ui",
    "phase": "R9-RELAY-02",
    "source": "src/remote/ui (accepted R8 UI)",
    "version": version,
    "version_note": "content hash of the sorted per-file digests; changes if any served file changes",
    "file_count": len(files),
    "total_bytes": sum(f["bytes"] for f in files),
    "build_method": "deterministic copy; NO dev server, NO port 8099, NO adb reverse",
    "redesign": "none — the accepted R8 UI is preserved as-is",
    "same_origin_contract": {
        "ui": "https://R9_PUBLIC_HOST/",
        "api": "https://R9_PUBLIC_HOST/api/...",
        "events": "wss://R9_PUBLIC_HOST/api/v1/events",
        "csp_connect_src": "connect-src 'self'",
    },
    "files": files,
}

print(f"  source      : {SOURCE}")
print(f"  version     : {version}")
print(f"  files       : {len(files)} ({manifest['total_bytes']} bytes)")
for entry in files[:20]:
    print(f"    {entry['sha256'][:12]}  {entry['bytes']:>7}  {entry['path']}")
if len(files) > 20:
    print(f"    ... and {len(files) - 20} more")

if OUT:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(f"  manifest written: {OUT}")
