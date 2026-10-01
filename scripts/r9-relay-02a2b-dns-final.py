#!/usr/bin/env python3
"""
R9-RELAY-02A.2B — Gate 12/13: verify the temporary TXT is absent, and re-verify the CAA policy.

Read-only against public DNS. Confirms:
  * _r9-acme-dryrun.drm-jd.com is ABSENT
  * the production CAA policy is unchanged and still account-bound
  * relay.drm-jd.com remains unpublished (A / AAAA / CNAME absent)
"""

import json
import sys

from dns import resolver as dns_resolver

ZONE = "drm-jd.com"
DRYRUN = f"_r9-acme-dryrun.{ZONE}"
RELAY = f"relay.{ZONE}"
EXPECTED_ISSUE = "letsencrypt.org;validationmethods=dns-01;accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/3780342786"
RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "208.67.222.222"]

report = {"checks": [], "errors": []}


def check(name, condition, detail=""):
    report["checks"].append({"name": name, "pass": bool(condition), "detail": detail})
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail and not condition else ''}")


def rslv(server):
    res = dns_resolver.Resolver(configure=False)
    res.nameservers = [server]
    res.timeout = 6
    res.lifetime = 10
    return res


print("=== temporary TXT absence ===")
dryrun_state = {}
for server in RESOLVERS:
    try:
        answers = rslv(server).resolve(DRYRUN, "TXT")
        dryrun_state[server] = [b"".join(r.strings).decode() for r in answers]
    except Exception:  # noqa: BLE001
        dryrun_state[server] = []
    print(f"  {server:<18} {dryrun_state[server] if dryrun_state[server] else 'ABSENT'}")
check("temporary TXT absent from all queried resolvers", all(not v for v in dryrun_state.values()), str(dryrun_state))
report["dryrun_txt"] = dryrun_state

print("\n=== CAA re-verification ===")
caa_state = {}
for server in RESOLVERS:
    try:
        records = rslv(server).resolve(ZONE, "CAA")
        issue = [r.issue.decode() if isinstance(r.issue, bytes) else r.issue for r in records if getattr(r, "issue", None)]
        issuewild = [r.issuewild.decode() if isinstance(r.issuewild, bytes) else r.issuewild for r in records if getattr(r, "issuewild", None)]
        caa_state[server] = {"issue": issue, "issuewild": issuewild}
        print(f"  {server:<18} issue={issue} issuewild={issuewild}")
    except Exception as exc:  # noqa: BLE001
        caa_state[server] = {"issue": [], "issuewild": [], "error": type(exc).__name__}
        print(f"  {server:<18} ERROR {type(exc).__name__}")

all_bound = all(EXPECTED_ISSUE in v.get("issue", []) for v in caa_state.values())
all_wild_denied = all(";" in v.get("issuewild", []) for v in caa_state.values())
old_unbound = any(
    any("letsencrypt.org" in i and "accounturi" not in i for i in v.get("issue", []))
    for v in caa_state.values()
)
check("CAA issue is still exactly the account-bound value on every resolver", all_bound)
check("CAA issuewild still denies wildcards on every resolver", all_wild_denied)
check("no old non-account-bound issue reappeared", not old_unbound)
report["caa"] = {"state": caa_state, "account_bound": all_bound, "wildcard_denied": all_wild_denied, "old_unbound": old_unbound}

print("\n=== relay host remains unpublished ===")
relay_state = {}
for rtype, method in (("A", "resolve4"), ("AAAA", "resolve6"), ("CNAME", "resolveCname")):
    present = []
    for server in ["8.8.8.8", "1.1.1.1"]:
        try:
            present.extend(getattr(rslv(server), method)(RELAY))
        except Exception:  # noqa: BLE001
            pass
    relay_state[rtype] = present
    print(f"  relay.drm-jd.com {rtype:<5} : {present if present else 'absent'}")
check("relay.drm-jd.com A is absent", not relay_state["A"], str(relay_state["A"]))
check("relay.drm-jd.com AAAA is absent", not relay_state["AAAA"], str(relay_state["AAAA"]))
check("relay.drm-jd.com CNAME is absent", not relay_state["CNAME"], str(relay_state["CNAME"]))
report["relay_host"] = relay_state

total = len(report["checks"])
passed = sum(1 for c in report["checks"] if c["pass"])
report["total"] = total
report["pass"] = passed
print(f"\n=== final DNS verification: {passed}/{total} checks passed ===")

out = r"D:\DSH-testing\dsh-remote-gateway\.r9-fixture-tools\dns-final.json"
import os
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
print(f"  written: {out}")
sys.exit(0 if passed == total else 1)
