#!/usr/bin/env python3
"""
R9-RELAY-02A.2B — Gate 11/12: controlled DNS write/read/delete test.

Proves DNS write authority WITHOUT creating an ACME order, an authorization, or an _acme-challenge
record. Uses one temporary TXT name that cannot affect production traffic:

    _r9-acme-dryrun.drm-jd.com

Flow:
    Cloudflare API CREATE  ->  Cloudflare API READ confirms  ->  public DNS confirms
    ->  Cloudflare API DELETE  ->  API confirms absence  ->  public DNS confirms absence

The token is read from the protected file and never printed. The TXT value is random and non-secret.
"""

import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from dns import resolver as dns_resolver  # dnspython if available

TOKEN_PATH = r"D:\r9-relay-secrets\cloudflare-dns-token"
TARGET_ZONE = "drm-jd.com"
DRYRUN_NAME = f"_r9-acme-dryrun.{TARGET_ZONE}"
API = "https://api.cloudflare.com/client/v4"
PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "208.67.222.222"]

report = {"checks": [], "errors": []}


def check(name, condition, detail=""):
    report["checks"].append({"name": name, "pass": bool(condition), "detail": detail})
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail and not condition else ''}")


def api(method, path, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={
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


def public_txt(name):
    """Return the TXT values visible through each public resolver."""
    found = {}
    for server in PUBLIC_RESOLVERS:
        res = dns_resolver.Resolver(configure=False)
        res.nameservers = [server]
        res.timeout = 6
        res.lifetime = 10
        try:
            answers = res.resolve(name, "TXT")
            found[server] = [b"".join(r.strings).decode() if hasattr(r, "strings") else str(r) for r in answers]
        except dns_resolver.NXDOMAIN:
            found[server] = []
        except dns_resolver.NoAnswer:
            found[server] = []
        except Exception as exc:  # noqa: BLE001
            found[server] = [f"error:{type(exc).__name__}"]
    return found


if not os.path.isfile(TOKEN_PATH):
    print(f"  [FAIL] token file not found: {TOKEN_PATH}")
    sys.exit(2)

with open(TOKEN_PATH, encoding="utf-8") as handle:
    token = handle.read().strip()
print(f"  token loaded from protected file ({len(token)} chars, value not shown)")

# ── locate the zone ─────────────────────────────────────────────────────────
status, zones = api("GET", "/zones?per_page=50", token)
zone_id = None
for zone in (zones.get("result") or []):
    if zone.get("name") == TARGET_ZONE:
        zone_id = zone.get("id")
if zone_id is None:
    print(f"  [FAIL] zone {TARGET_ZONE} not visible to this token")
    sys.exit(3)
print(f"  zone id: {zone_id}")
report["zone_id"] = zone_id

# A random, non-secret value. It proves write authority without being usable for anything.
value = f"r9-dryrun-{secrets.token_hex(8)}"
print(f"\n=== CREATE temporary TXT ===")
print(f"  name : {DRYRUN_NAME}")
print(f"  value: {value}  (random, non-secret, single-use)")
status, created = api("POST", f"/zones/{zone_id}/dns_records", token, {
    "type": "TXT", "name": DRYRUN_NAME, "content": value, "ttl": 60,
})
created_ok = status in (200, 201) and created.get("success") is True
record_id = (created.get("result") or {}).get("id")
print(f"  http status : {status}")
print(f"  success     : {created.get('success')}")
print(f"  record id   : {record_id}")
if not created_ok:
    print(f"  errors: {json.dumps(created.get('errors'), indent=2)}")
    sys.exit(4)
report["create"] = {"succeeded": True, "record_id": record_id, "value_class": "random non-secret"}

# ── API read-back ───────────────────────────────────────────────────────────
print("\n=== Cloudflare API READ confirms the exact record ===")
status, fetched = api("GET", f"/zones/{zone_id}/dns_records/{record_id}", token)
result = fetched.get("result") or {}
api_read_ok = status == 200 and result.get("content") == value and result.get("type") == "TXT"
print(f"  type matches    : {result.get('type') == 'TXT'}")
print(f"  content matches : {result.get('content') == value}")
check("Cloudflare API read confirms the exact TXT record", api_read_ok)
report["api_read"] = {"type_matches": result.get("type") == "TXT", "content_matches": result.get("content") == value}

# ── public DNS propagation ──────────────────────────────────────────────────
print("\n=== public DNS propagation (waiting for the record to appear) ===")
propagated = {}
deadline = time.time() + 90
while time.time() < deadline:
    propagated = public_txt(DRYRUN_NAME)
    visible = [s for s, v in propagated.items() if value in v]
    print(f"  visible via {len(visible)}/{len(PUBLIC_RESOLVERS)} resolvers: {visible}")
    if len(visible) >= 2:
        break
    time.sleep(5)
visible_after_create = [s for s, v in propagated.items() if value in v]
check("TXT visible through at least two independent public resolvers", len(visible_after_create) >= 2, str(visible_after_create))
report["public_after_create"] = {"resolvers": propagated, "visible_count": len(visible_after_create)}

# ── delete ──────────────────────────────────────────────────────────────────
print("\n=== DELETE the temporary TXT ===")
status, deleted = api("DELETE", f"/zones/{zone_id}/dns_records/{record_id}", token)
delete_ok = status == 200 and deleted.get("success") is True
print(f"  http status : {status}")
print(f"  success     : {deleted.get('success')}")
check("Cloudflare API delete succeeded", delete_ok)
report["delete"] = {"succeeded": delete_ok}

# ── api confirms absence ────────────────────────────────────────────────────
print("\n=== API confirms absence ===")
status, gone = api("GET", f"/zones/{zone_id}/dns_records/{record_id}", token)
absent = status == 404 or gone.get("success") is False
print(f"  http status : {status} (404 = gone)")
check("Cloudflare API confirms the record is absent", absent)
report["api_absence"] = {"http_status": status, "absent": absent}

# ── public DNS confirms absence (allowing negative caching) ─────────────────
print("\n=== public DNS confirms absence (allowing TTL / negative caching) ===")
final = {}
deadline = time.time() + 150
while time.time() < deadline:
    final = public_txt(DRYRUN_NAME)
    still = [s for s, v in final.items() if value in v]
    print(f"  still visible via {len(still)}/{len(PUBLIC_RESOLVERS)}: {still}")
    if not still:
        break
    time.sleep(10)
still_visible = [s for s, v in final.items() if value in v]
check("temporary TXT is absent from public DNS", not still_visible, str(still_visible))
report["public_after_delete"] = {"resolvers": final, "still_visible": still_visible}

total = len(report["checks"])
passed = sum(1 for c in report["checks"] if c["pass"])
report["total"] = total
report["pass"] = passed
report["record_name"] = DRYRUN_NAME
print(f"\n=== DNS dry-run: {passed}/{total} checks passed ===")

out = r"D:\DSH-testing\dsh-remote-gateway\.r9-fixture-tools\dns-dryrun.json"
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
print(f"  written: {out}")
sys.exit(0 if passed == total else 1)
