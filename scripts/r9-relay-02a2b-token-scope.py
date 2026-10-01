#!/usr/bin/env python3
"""
R9-RELAY-02A.2B — Gate 10: verify Cloudflare token validity and scope.

Reads the token from the protected file, calls the Cloudflare API, and reports ONLY non-secret
results: validity, the visible zone, and which capabilities the token actually holds. The token value
is never printed, logged, or written to evidence.

Scope checks use the token's own verification endpoint and targeted API calls, and assert that the
token can see exactly the intended zone rather than all zones.
"""

import json
import os
import sys
import urllib.error
import urllib.request

TOKEN_PATH = r"D:\r9-relay-secrets\cloudflare-dns-token"
TARGET_ZONE = "drm-jd.com"
API = "https://api.cloudflare.com/client/v4"

report = {"checks": [], "errors": []}


def check(name, condition, detail=""):
    report["checks"].append({"name": name, "pass": bool(condition), "detail": detail})
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail and not condition else ''}")


def api(path, token):
    """Call the Cloudflare API. Returns (status, parsed_json)."""
    request = urllib.request.Request(f"{API}{path}", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode())
        except Exception:  # noqa: BLE001
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return None, {"error": str(exc)}


print("=== reading the protected token file ===")
if not os.path.isfile(TOKEN_PATH):
    print(f"  [FAIL] token file not found: {TOKEN_PATH}")
    print("  Run the interactive helper first:")
    print("    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/r9-relay-02a2b-token-entry.ps1")
    sys.exit(2)

with open(TOKEN_PATH, encoding="utf-8") as handle:
    token = handle.read().strip()

if not token:
    print("  [FAIL] token file is empty")
    sys.exit(3)
print(f"  token file present, length {len(token)} (value not shown)")
report["token_file"] = {"exists": True, "length_class": f"{len(token)} chars", "value_recorded": False}

print("\n=== token validity (/user/tokens/verify) ===")
status, body = api("/user/tokens/verify", token)
valid = status == 200 and body.get("success") is True
print(f"  http status : {status}")
print(f"  success     : {body.get('success')}")
print(f"  token state : {(body.get('result') or {}).get('status')}")
check("token is valid", valid, f"http={status}")
report["token_valid"] = valid

print("\n=== zone visibility ===")
status, zones = api("/zones?per_page=50", token)
visible = []
if status == 200 and zones.get("success"):
    visible = [z.get("name") for z in (zones.get("result") or [])]
print(f"  http status       : {status}")
print(f"  zones visible     : {visible if visible else 'none'}")
check("target zone is visible", TARGET_ZONE in visible, str(visible))
check("access is limited to the intended zone only", visible == [TARGET_ZONE], f"visible={visible}")
report["zone_visible"] = visible
report["zone_restricted_to_target"] = visible == [TARGET_ZONE]

zone_id = None
for zone in (zones.get("result") or []):
    if zone.get("name") == TARGET_ZONE:
        zone_id = zone.get("id")
report["zone_id"] = zone_id
print(f"  zone id           : {zone_id}")

print("\n=== DNS read capability ===")
dns_read = False
if zone_id:
    status, records = api(f"/zones/{zone_id}/dns_records?per_page=5", token)
    dns_read = status == 200 and records.get("success") is True
    print(f"  http status    : {status}")
    print(f"  success        : {records.get('success')}")
    if dns_read:
        names = [r.get("name") for r in (records.get("result") or [])]
        print(f"  sample records : {names}")
check("can read DNS records in the target zone", dns_read)
report["dns_read"] = dns_read

print("\n=== capability summary ===")
# The token's own permission list is not directly exposed for account-owned tokens, so the
# capabilities are established from what the API actually allowed above.
report["capabilities_observed"] = {
    "zone_read": TARGET_ZONE in visible,
    "dns_read": dns_read,
    "dns_edit": "verified by the Gate 11 create/delete cycle",
}

total = len(report["checks"])
passed = sum(1 for c in report["checks"] if c["pass"])
report["total"] = total
report["pass"] = passed
print(f"\n=== token scope verification: {passed}/{total} checks passed ===")
print("  note: DNS *edit* is proven by the Gate 11 write/delete cycle, not by this read-only step")

out = r"D:\DSH-testing\dsh-remote-gateway\.r9-fixture-tools\token-scope.json"
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
print(f"  written: {out}")
sys.exit(0 if passed == total else 1)
