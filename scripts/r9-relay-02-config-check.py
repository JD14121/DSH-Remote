#!/usr/bin/env python3
"""R9-RELAY-02 — validate the prepared config templates parse, and assert key properties.

Runs inside the validation container. Uses `tomllib` (Python 3.11+) so a TOML syntax error is caught
here rather than at deployment time.
"""
import json
import sys
import tomllib

CONFIGS = {
    "frps.production.toml": "/cfg/frps.production.toml",
    "frpc.production.toml": "/cfg/frpc.production.toml",
    "bridge.production.toml": "/cfg/bridge.production.toml",
    "frps.rehearsal.toml": "/cfg/frps.rehearsal.toml",
}

report = {"parsed": {}, "assertions": [], "errors": []}


def check(name, condition, detail=""):
    report["assertions"].append({"name": name, "pass": bool(condition), "detail": detail})
    marker = "PASS" if condition else "FAIL"
    print(f"  [{marker}] {name}{(' — ' + detail) if detail and not condition else ''}")


print("=== parsing prepared configs ===")
parsed = {}
for label, path in CONFIGS.items():
    try:
        with open(path, "rb") as handle:
            doc = tomllib.load(handle)
        parsed[label] = doc
        report["parsed"][label] = {"ok": True, "top_level_keys": sorted(doc.keys())}
        print(f"  [PASS] {label} parses")
    except Exception as exc:  # noqa: BLE001
        report["parsed"][label] = {"ok": False, "error": str(exc)}
        report["errors"].append(f"{label}: {exc}")
        print(f"  [FAIL] {label} — {exc}")

print("\n=== TOML ordering guard ===")
# In TOML every key after a `[[table]]` header belongs to that table. An earlier draft of the frps
# template placed logging keys AFTER [[httpPlugins]], so they were silently nested inside the plugin
# entry: the file still parsed, and frps would simply have ignored them. This guard makes that class
# of silent misconfiguration impossible to reintroduce unnoticed.
ordering_ok = True
for label, path in CONFIGS.items():
    text = open(path, encoding="utf-8").read()
    lines = text.splitlines()
    first_table = None
    for index, line in enumerate(lines):
        if line.strip().startswith("[["):
            first_table = index
            break
    if first_table is None:
        continue
    # Any top-level assignment after the first [[table]] is suspicious unless it belongs to that table.
    for index in range(first_table + 1, len(lines)):
        stripped = lines[index].strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("["):
            continue
        key = stripped.split("=")[0].strip()
        # Keys that legitimately belong to httpPlugins are the plugin's own fields.
        if key in ("name", "addr", "path", "ops"):
            continue
        ordering_ok = False
        report["errors"].append(f"{label}: line {index + 1} top-level key '{key}' appears after [[{lines[first_table].strip().strip('[]')}]]")
        print(f"  [FAIL] {label} line {index + 1}: '{key}' looks top-level but follows a [[table]]")
check("no top-level key is silently nested after a [[table]] header", ordering_ok)

print("\n=== frps production template ===")
frps = parsed.get("frps.production.toml", {})
check("frps bindPort is 7000", frps.get("bindPort") == 7000, str(frps.get("bindPort")))
check("frps vhostHTTPSPort is 443", frps.get("vhostHTTPSPort") == 443, str(frps.get("vhostHTTPSPort")))
check("frps transport TLS is forced", frps.get("transport", {}).get("tls", {}).get("force") is True)
check("frps has no kcpBindPort", "kcpBindPort" not in frps)
check("frps has no quicBindPort", "quicBindPort" not in frps)
check("frps has no vhostHTTPPort (no port 80)", "vhostHTTPPort" not in frps)
check("frps has no dashboard/webServer", "webServer" not in frps)
check("frps has no sshTunnelGateway", "sshTunnelGateway" not in frps)
check("frps has no subDomainHost (no wildcard service)", "subDomainHost" not in frps)
check("frps has no tcpmuxHTTPConnectPort", "tcpmuxHTTPConnectPort" not in frps)
plugins = frps.get("httpPlugins", [])
check("frps uses [[httpPlugins]]", len(plugins) == 1, f"count={len(plugins)}")
check("frps plugin ops is exactly NewProxy", plugins and plugins[0].get("ops") == ["NewProxy"], str(plugins[0].get("ops") if plugins else None))
check("frps plugin binds loopback", plugins and plugins[0].get("addr", "").startswith("127.0.0.1:"), str(plugins[0].get("addr") if plugins else None))
check("frps does NOT use serverPlugin", "serverPlugin" not in frps)
check("frps passes no detailed errors to clients", frps.get("detailedErrorsToClient") is False)

print("\n=== frpc production template ===")
frpc = parsed.get("frpc.production.toml", {})
check("frpc serverPort is 7000", frpc.get("serverPort") == 7000, str(frpc.get("serverPort")))
proxies = frpc.get("proxies", [])
check("frpc declares exactly one proxy", len(proxies) == 1, f"count={len(proxies)}")
if proxies:
    p = proxies[0]
    check("frpc proxy type is https", p.get("type") == "https", str(p.get("type")))
    check("frpc proxy targets bridge 9446", p.get("localPort") == 9446, str(p.get("localPort")))
    check("frpc proxy does NOT target 9445", p.get("localPort") != 9445)
    check("frpc proxy does NOT target 3081", p.get("localPort") != 3081)
    check("frpc proxy does NOT target 3080", p.get("localPort") != 3080)
    check("frpc customDomains uses the placeholder", p.get("customDomains") == ["R9_PUBLIC_HOST"], str(p.get("customDomains")))
    check("frpc proxy has no subdomain", not p.get("subdomain"))
    check("frpc proxy has no group", not p.get("group"))
check("frpc enables transport TLS", frpc.get("transport", {}).get("tls", {}).get("enable") is True)
check("frpc serverAddr is a placeholder, not a fabricated IP", frpc.get("serverAddr") == "R9_VPS_HOST", str(frpc.get("serverAddr")))

print("\n=== bridge production template ===")
bridge = parsed.get("bridge.production.toml", {})
b = bridge.get("bridge", {})
check("bridge binds loopback only", b.get("bind_host") == "127.0.0.1", str(b.get("bind_host")))
check("bridge port is 9446", b.get("bind_port") == 9446, str(b.get("bind_port")))
check("bridge upstream is 9445", b.get("upstream_port") == 9445, str(b.get("upstream_port")))
check("bridge upstream is loopback", b.get("upstream_host") == "127.0.0.1")
tls = bridge.get("tls", {})
check("bridge requires a client certificate", tls.get("require_client_certificate") is True)
check("bridge enables SSL_OP_NO_TICKET control", tls.get("disable_session_tickets") is True)
limits = bridge.get("limits", {})
check("bridge limits are all numeric", all(isinstance(v, int) for v in limits.values()), str(limits))
pol = bridge.get("request_policy", {})
check("bridge never retries writes", pol.get("retry_writes") is False)
check("bridge fixes the upstream Host", pol.get("fix_upstream_host") is True)

print("\n=== rehearsal template ===")
reh = parsed.get("frps.rehearsal.toml", {})
check("rehearsal binds loopback only", reh.get("bindAddr") == "127.0.0.1", str(reh.get("bindAddr")))
check("rehearsal uses a clearly non-secret token", reh.get("auth", {}).get("token") == "r9-fixture-token-not-production")
check("rehearsal uses the same plugin mechanism", len(reh.get("httpPlugins", [])) == 1)
check("rehearsal does NOT use serverPlugin", "serverPlugin" not in reh)

print("\n=== secret hygiene across all prepared configs ===")
import re
secret_patterns = [
    (r"Bearer\s+[A-Za-z0-9._-]{8,}", "an Authorization bearer value"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
]
hygiene_ok = True
for label, path in CONFIGS.items():
    text = open(path, encoding="utf-8").read()
    for pattern, what in secret_patterns:
        if re.search(pattern, text):
            hygiene_ok = False
            report["errors"].append(f"{label} contains {what}")
            print(f"  [FAIL] {label} contains {what}")
check("no private key or bearer value in any prepared config", hygiene_ok)

total = len(report["assertions"])
passed = sum(1 for a in report["assertions"] if a["pass"])
report["total"] = total
report["pass"] = passed
report["fail"] = total - passed
print(f"\n=== {passed}/{total} config assertions passed ===")
with open("/fixture/log/config-validation.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
sys.exit(0 if passed == total else 1)
