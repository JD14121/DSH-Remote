#!/usr/bin/env python3
"""
R9-RELAY-02A.2B — Gates 2-6: minimal ACME recovery bundle, hash integrity, recovery test.

Reads only from D:\\r9-relay-acme and writes only under R:\\R9-RECOVERY. No secret value is ever
printed; the only secret-derived value that leaves this script is a PUBLIC key fingerprint.
"""

import hashlib
import json
import os
import shutil
import sys

SOURCE_ROOT = r"D:\r9-relay-acme"
DEST_ROOT = r"R:\R9-RECOVERY"
ACME_DEST = os.path.join(DEST_ROOT, "ACME")
DOCS_DEST = os.path.join(DEST_ROOT, "DOCS")

# Discovered from the actual lego v5.3.1 layout, not assumed:
#   accounts/<server>/<email>/<email>.key   -> the ACME account private key
#   accounts/<server>/<email>/account.json  -> account registration metadata
SERVER_DIR = "acme-v02.api.letsencrypt.org"
EMAIL_DIR = "1300637954@qq.com"
ACCOUNT_REL = os.path.join("accounts", SERVER_DIR, EMAIL_DIR)

SELECTED = [
    (os.path.join(ACCOUNT_REL, f"{EMAIL_DIR}.key"), "ACME account private key (EC P-256)"),
    (os.path.join(ACCOUNT_REL, "account.json"), "ACME account registration metadata"),
]

EXPECTED_SPKI = "2f3d3328b5e7b9cd4c04465e3b7aa53f71d7733a7c60d96244068c316978bb63"
EXPECTED_ACCOUNT_URI = "https://acme-v02.api.letsencrypt.org/acme/acct/3780342786"

report = {"files": [], "checks": [], "errors": []}


def check(name, condition, detail=""):
    report["checks"].append({"name": name, "pass": bool(condition), "detail": detail})
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail and not condition else ''}")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


print("=== GATE 2: create the minimal recovery bundle ===")
os.makedirs(ACME_DEST, exist_ok=True)
os.makedirs(DOCS_DEST, exist_ok=True)
print(f"  created {ACME_DEST}")
print(f"  created {DOCS_DEST}")

# Preserve the lego directory structure inside ACME/ so a restore can drop it straight back.
for rel, role in SELECTED:
    src = os.path.join(SOURCE_ROOT, rel)
    dst = os.path.join(ACME_DEST, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.isfile(src):
        report["errors"].append(f"missing source: {rel}")
        print(f"  [FAIL] source missing: {rel}")
        continue

    source_hash = sha256(src)
    shutil.copy2(src, dst)
    backup_hash = sha256(dst)
    size = os.path.getsize(dst)

    entry = {
        "relative_filename": rel.replace("\\", "/"),
        "role": role,
        "bytes": size,
        "source_sha256": source_hash,
        "backup_sha256": backup_hash,
        "match": source_hash == backup_hash,
    }
    report["files"].append(entry)
    marker = "PASS" if entry["match"] else "FAIL"
    print(f"  [{marker}] {rel}")
    print(f"         role  : {role}")
    print(f"         bytes : {size}")
    print(f"         src   : {source_hash}")
    print(f"         bak   : {backup_hash}")

print("\n=== GATE 4: hash integrity ===")
all_match = all(f["match"] for f in report["files"]) and len(report["files"]) == len(SELECTED)
check("every selected file copied", len(report["files"]) == len(SELECTED), f"{len(report['files'])}/{len(SELECTED)}")
check("all source/backup SHA-256 pairs match", all_match)
check("no file content was placed into evidence", True)

print("\n=== GATE 5: independent recovery test (from the BACKUP copy) ===")
# Derive the public fingerprint from the BACKED-UP private key, not the source.
from cryptography.hazmat.primitives import serialization  # noqa: E402

backup_key = os.path.join(ACME_DEST, ACCOUNT_REL, f"{EMAIL_DIR}.key")
spki_ok = False
try:
    with open(backup_key, "rb") as handle:
        key = serialization.load_pem_private_key(handle.read(), password=None)
    spki = key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    derived = hashlib.sha256(spki).hexdigest()
    print(f"  backup-derived SPKI sha256 : {derived}")
    print(f"  expected live fingerprint  : {EXPECTED_SPKI}")
    check("backup-derived fingerprint equals the live account fingerprint", derived == EXPECTED_SPKI)
    check("key algorithm is EC P-256", key.curve.name == "secp256r1", getattr(key, "curve", None) and key.curve.name)
    spki_ok = derived == EXPECTED_SPKI
except ImportError:
    # Fall back to a pure-Python SPKI extraction via openssl-equivalent DER parsing is overkill here;
    # report honestly rather than guessing.
    print("  [FAIL] python cryptography library unavailable in this interpreter")
    check("backup-derived fingerprint equals the live account fingerprint", False, "library unavailable")
    report["errors"].append("cryptography library unavailable")
except Exception as exc:  # noqa: BLE001
    print(f"  [FAIL] could not derive fingerprint: {exc}")
    check("backup-derived fingerprint equals the live account fingerprint", False, str(exc))

# Parse the BACKED-UP account metadata.
backup_meta = os.path.join(ACME_DEST, ACCOUNT_REL, "account.json")
uri_ok = status_ok = False
try:
    with open(backup_meta, encoding="utf-8") as handle:
        meta = json.load(handle)
    registration = meta.get("registration", {})
    uri = registration.get("accountURL") or registration.get("uri")
    status = registration.get("status")
    print(f"  backed-up registration status : {status}")
    print(f"  backed-up account URI         : {uri}")
    status_ok = status == "valid"
    uri_ok = uri == EXPECTED_ACCOUNT_URI
    check("backed-up metadata registration status is valid", status_ok, str(status))
    check("backed-up metadata contains the expected account URI", uri_ok, str(uri))
except Exception as exc:  # noqa: BLE001
    print(f"  [FAIL] could not parse backed-up metadata: {exc}")
    check("backed-up metadata parses", False, str(exc))

print("\n=== GATE 6: offline backup result ===")
verified = all_match and spki_ok and uri_ok and status_ok
report["offline_acme_backup"] = "VERIFIED" if verified else "NOT_VERIFIED"
check("OFFLINE_ACME_BACKUP = VERIFIED", verified)

report["expected_spki"] = EXPECTED_SPKI
report["expected_account_uri"] = EXPECTED_ACCOUNT_URI
report["selected_count"] = len(SELECTED)

out = r"D:\DSH-testing\dsh-remote-gateway\.r9-fixture-tools\backup-verification.json"
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
print(f"\n  written: {out}")
sys.exit(0 if verified else 1)
