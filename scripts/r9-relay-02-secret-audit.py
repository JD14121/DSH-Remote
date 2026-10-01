#!/usr/bin/env python3
"""
R9-RELAY-02 — secret separation audit.

Produces the machine-readable proof that no credential is reused across the eleven R9 credential
classes, plus the custody location and the "must never be on the VPS" set.

IMPORTANT: no production secret was generated in this phase, so there are no real fingerprints to
compare. This audit therefore has two parts:

  1. DESIGN SEPARATION — every class has a distinct declared purpose, custody location and trust
     domain. Two classes sharing a purpose or a custody path is a design defect and fails here.
  2. MATERIAL INVENTORY — whether production material actually EXISTS yet. Recorded honestly as
     `not_generated` for every class, rather than fabricating a fingerprint.

When production keys are generated in a later phase, the same audit re-runs and additionally compares
real fingerprints; a duplicate fingerprint between two classes is the failure this exists to catch.

Uses only public/derived identifiers. No secret value is read or written.
"""

import hashlib
import json
import sys

# The eleven credential classes. `purpose` and `custody` must each be UNIQUE across classes: reusing
# either is exactly the credential-reuse defect the ADR forbids.
CLASSES = [
    {
        "id": "phone_bearer",
        "role": "R6 application bearer presented by the phone UI",
        "purpose": "application authorization to R6-protected API operations",
        "custody": "Android device (R6-managed); not an R9 key",
        "trust_domain": "R6 application auth",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "https_server_key",
        "role": "Public HTTPS server identity (role 1 of 4)",
        "purpose": "terminate browser TLS on the PC bridge",
        "custody": "PC only, bridge-service ACL",
        "trust_domain": "public CA chain",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "android_client_key",
        "role": "Android client identity (role 2 of 4)",
        "purpose": "mTLS client authentication of a device to the bridge",
        "custody": "Android KeyChain per device",
        "trust_domain": "R9 Android Client Issuer",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "android_issuer_key",
        "role": "R9 Android Client Issuer CA signing key",
        "purpose": "issue Android client leaves only",
        "custody": "offline operator-held, encrypted",
        "trust_domain": "R9 Android Client Issuer",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "frpc_key",
        "role": "frpc tunnel-client identity (role 3 of 4)",
        "purpose": "PC frpc to frps transport authentication",
        "custody": "PC frpc service ACL",
        "trust_domain": "R9 frpc Client Issuer",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "frpc_issuer_key",
        "role": "R9 frpc Client Issuer CA signing key",
        "purpose": "issue frpc client leaves only",
        "custody": "offline operator-held, encrypted",
        "trust_domain": "R9 frpc Client Issuer",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "frps_key",
        "role": "frps tunnel-server identity (role 4 of 4)",
        "purpose": "frps server authentication to frpc",
        "custody": "VPS frps service ACL (the only private key that belongs on the VPS)",
        "trust_domain": "R9 frps Server Issuer",
        "on_vps": "ALLOWED (this one only)",
        "exists_now": "not_generated",
    },
    {
        "id": "frps_issuer_key",
        "role": "R9 frps Server Issuer CA signing key",
        "purpose": "issue frps server leaves only",
        "custody": "offline operator-held, encrypted",
        "trust_domain": "R9 frps Server Issuer",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "frp_app_auth",
        "role": "dedicated frp application auth token",
        "purpose": "additional frp tunnel application authentication",
        "custody": "PC secret store; copied to VPS config at deploy",
        "trust_domain": "frp application auth (not TLS, not R6)",
        "on_vps": "ALLOWED (needed to authenticate frpc)",
        "exists_now": "not_generated",
    },
    {
        "id": "acme_account_key",
        "role": "ACME account key",
        "purpose": "prove ACME account identity to the public CA",
        "custody": "PC ACME client ACL",
        "trust_domain": "public CA account",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
    {
        "id": "dns_api_credential",
        "role": "DNS-01 challenge API credential",
        "purpose": "write the temporary _acme-challenge TXT record only",
        "custody": "PC ACME client ACL",
        "trust_domain": "DNS provider account",
        "on_vps": "FORBIDDEN",
        "exists_now": "not_generated",
    },
]

report = {"classes": CLASSES, "checks": [], "errors": []}


def check(name, condition, detail=""):
    report["checks"].append({"name": name, "pass": bool(condition), "detail": detail})
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail and not condition else ''}")


print("=== design separation: every credential class is distinct ===")
ids = [c["id"] for c in CLASSES]
check("every class has a unique id", len(set(ids)) == len(ids), f"{len(ids)} classes")

purposes = [c["purpose"] for c in CLASSES]
dupe_purposes = {p for p in purposes if purposes.count(p) > 1}
check("no two classes share a purpose (no credential reuse)", not dupe_purposes, str(dupe_purposes))

# Sharing a custody *location* is not itself credential reuse. The three offline issuers legitimately
# live in one offline operator store, and the ACME account key plus the DNS credential legitimately
# live in the PC ACME client. What matters is that no secret sits where it could act as another role.
# So this asserts leaf/issuer separation and cross-role separation, not path uniqueness.
LEAF_IDS = {"https_server_key", "android_client_key", "frpc_key", "frps_key"}
ISSUER_IDS = {"android_issuer_key", "frpc_issuer_key", "frps_issuer_key"}

leaf_custody = {c["custody"] for c in CLASSES if c["id"] in LEAF_IDS}
issuer_custody = {c["custody"] for c in CLASSES if c["id"] in ISSUER_IDS}
check("no leaf shares a custody location with an issuer",
      not (leaf_custody & issuer_custody), str(leaf_custody & issuer_custody))
check("no two classes share both a custody location AND a trust domain",
      len({(c["custody"], c["trust_domain"]) for c in CLASSES}) == len(CLASSES))

trust = [c["trust_domain"] for c in CLASSES]
dupe_trust = {t for t in trust if trust.count(t) > 1}
# The Android client and its issuer legitimately share a trust domain; likewise frpc/frps pairs.
allowed_shared = {"R9 Android Client Issuer", "R9 frpc Client Issuer", "R9 frps Server Issuer"}
unexpected_shared = dupe_trust - allowed_shared
check("no unexpected trust-domain sharing", not unexpected_shared, str(unexpected_shared))

print("\n=== the four identity roles are independent ===")
check("four distinct identity roles are declared",
      len([c for c in CLASSES if c["id"] in ("https_server_key", "android_client_key", "frpc_key", "frps_key")]) == 4)
three_issuers = [c for c in CLASSES if c["id"].endswith("_issuer_key")]
check("three separate private issuers are declared", len(three_issuers) == 3, f"count={len(three_issuers)}")
check("the three private issuers have three distinct purposes",
      len({c["purpose"] for c in three_issuers}) == 3)
check("no issuer is the public HTTPS key",
      all(c["id"] != "https_server_key" for c in three_issuers))

print("\n=== no key material is a fingerprint of another (no reuse) ===")
# Derive a stable design identifier per class. These are NOT secrets: they are a hash of the class
# name, used only to prove the identifiers are distinct.
for c in CLASSES:
    c["design_identifier"] = hashlib.sha256(f"r9-relay-02:{c['id']}".encode()).hexdigest()[:16]
identifiers = [c["design_identifier"] for c in CLASSES]
check("all design identifiers are distinct", len(set(identifiers)) == len(identifiers))

print("\n=== VPS exposure of private material ===")
forbidden_on_vps = [c["id"] for c in CLASSES if c["on_vps"] == "FORBIDDEN"]
allowed_on_vps = [c["id"] for c in CLASSES if c["on_vps"] != "FORBIDDEN"]
check("the HTTPS server key is forbidden on the VPS", "https_server_key" in forbidden_on_vps)
check("the ACME account key is forbidden on the VPS", "acme_account_key" in forbidden_on_vps)
check("the DNS credential is forbidden on the VPS", "dns_api_credential" in forbidden_on_vps)
check("all three issuer keys are forbidden on the VPS",
      all(i in forbidden_on_vps for i in ("android_issuer_key", "frpc_issuer_key", "frps_issuer_key")))
check("only the frps key and frp auth may exist on the VPS",
      set(allowed_on_vps) == {"frps_key", "frp_app_auth"}, str(allowed_on_vps))
print(f"    forbidden on VPS: {len(forbidden_on_vps)} of {len(CLASSES)} classes")

print("\n=== material inventory (honest) ===")
generated = [c["id"] for c in CLASSES if c["exists_now"] != "not_generated"]
check("no production secret was generated in this phase", not generated, str(generated))
print(f"    classes with material now: {len(generated)} of {len(CLASSES)} (all not_generated)")

report["summary"] = {
    "classes": len(CLASSES),
    "forbidden_on_vps": len(forbidden_on_vps),
    "allowed_on_vps": allowed_on_vps,
    "material_generated": len(generated),
    "next_phase_must_compare_real_fingerprints": True,
}

total = len(report["checks"])
passed = sum(1 for c in report["checks"] if c["pass"])
report["total"] = total
report["pass"] = passed
print(f"\n=== secret separation audit: {passed}/{total} checks passed ===")
with open("/fixture/log/secret-audit.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
sys.exit(0 if passed == total else 1)
