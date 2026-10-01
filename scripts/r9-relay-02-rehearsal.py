#!/usr/bin/env python3
"""
R9-RELAY-02 — production-shaped local rehearsal.

Starts frps with the PRODUCTION-SHAPED rehearsal config (loopback only, no public bind) plus the
admission plugin carried forward from R9-RELAY-01C, then proves:

  * frps starts from the prepared configuration
  * the admission plugin starts and is ready before frps
  * the approved production-shaped proxy registers (positive case)
  * an unauthorized proxy is rejected
  * no listener exists beyond the expected loopback fixture ports

Nothing is published, and no production Gateway, DSH or credential is touched.
"""

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

BIN = "/fixture/bin"
CFG = "/cfg"
LOG = "/fixture/log"
WORK = "/fixture/work"

FRPS_PORT = 7100
PLUGIN_PORT = 9100
UPSTREAM_PORT = 7444
APPROVED_DOMAIN = "relay-fixture.invalid"   # synthetic: the real value is the R9_PUBLIC_HOST placeholder
PROXY_NAME = "r9-fixture-proxy"

results = []


def check(name, condition, detail=""):
    results.append({"name": name, "pass": bool(condition), "detail": detail})
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}{(' — ' + detail) if detail and not condition else ''}")


def run(cmd, timeout=20):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout + proc.stderr
    except subprocess.TimeoutExpired as exc:
        parts = []
        for stream in (exc.stdout, exc.stderr):
            if stream is None:
                continue
            parts.append(stream.decode("utf-8", "replace") if isinstance(stream, bytes) else stream)
        return None, "".join(parts) + "\n[timed out]"
    except Exception as exc:  # noqa: BLE001
        return -1, f"[runner error] {exc}"


def free_port(port):
    code, out = run(["sh", "-c", f"netstat -ltnp 2>/dev/null | grep ':{port} ' || true"], timeout=10)
    for match in re.finditer(r"(\d+)/", out or ""):
        run(["sh", "-c", f"kill -9 {match.group(1)} 2>/dev/null || true"], timeout=5)
    time.sleep(0.4)


def kill_stale():
    for pattern in ("admission-plugin.py", "/fixture/bin/frps", "/fixture/bin/frpc", "upstream.py"):
        run(["sh", "-c", f"pkill -9 -f '{pattern}' 2>/dev/null || true"], timeout=10)
    time.sleep(1)
    for port in (FRPS_PORT, PLUGIN_PORT, UPSTREAM_PORT):
        free_port(port)


def wait_for_port(port, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def start_upstream():
    proc = subprocess.Popen([sys.executable, "/fixture/upstream.py"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_for_port(UPSTREAM_PORT)
    return proc


def frpc_config(proxy_name, domain, filename):
    config = f"""serverAddr = "127.0.0.1"
serverPort = {FRPS_PORT}
auth.method = "token"
auth.token = "r9-fixture-token-not-production"
transport.tls.enable = true
loginFailExit = true

[[proxies]]
name = "{proxy_name}"
type = "https"
localIP = "127.0.0.1"
localPort = {UPSTREAM_PORT}
customDomains = ["{domain}"]
"""
    path = f"{WORK}/{filename}"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(config)
    return path


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(LOG, exist_ok=True)
    kill_stale()

    print("=== rehearsal: production-shaped frps config ===")
    upstream = start_upstream()
    check("fixture upstream listening on loopback", wait_for_port(UPSTREAM_PORT))

    # The plugin must be ready BEFORE frps, per the documented fail-closed ordering.
    plugin_log = f"{LOG}/plugin.log"
    open(plugin_log, "w").close()
    plugin = subprocess.Popen([sys.executable, "/fixture/admission-plugin.py", str(PLUGIN_PORT), "policy", plugin_log],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    plugin_ready = wait_for_port(PLUGIN_PORT, timeout=10)
    check("admission plugin ready BEFORE frps starts", plugin_ready)

    frps_log = f"{LOG}/frps.rehearsal.log"
    frps = subprocess.Popen([f"{BIN}/frps", "-c", f"{CFG}/frps.rehearsal.toml"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    frps_ready = wait_for_port(FRPS_PORT, timeout=15)
    check("frps started from the prepared rehearsal config", frps_ready)

    if not (plugin_ready and frps_ready):
        code, out = run(["sh", "-c", f"tail -20 {frps_log} 2>/dev/null || true"], timeout=10)
        print("  frps log tail:", out.strip()[:400])
        for proc in (frps, plugin, upstream):
            proc.terminate()
        return 1

    # ── listener inventory ───────────────────────────────────────────────────
    print("\n=== listener inventory (loopback only expected) ===")
    code, out = run(["sh", "-c", "netstat -ltn 2>/dev/null | tail -n +3"], timeout=10)
    observed = []
    for line in (out or "").splitlines():
        parts = line.split()
        if len(parts) >= 4:
            observed.append(parts[3])
            print(f"    {parts[3]}")
    for required in (f"127.0.0.1:{FRPS_PORT}", f"127.0.0.1:{PLUGIN_PORT}", f"127.0.0.1:{UPSTREAM_PORT}"):
        check(f"fixture listener present and loopback: {required}", required in observed)
    check("no public 443 listener", not any(a.endswith(":443") for a in observed))
    check("no listener on 7000", not any(a.endswith(":7000") for a in observed))
    check("no listener on 80/8080", not any(a.endswith(":80") or a.endswith(":8080") for a in observed))
    check("no listener on 22/2200", not any(a.endswith(":22") or a.endswith(":2200") for a in observed))
    check("no dashboard listener on 7500", not any(a.endswith(":7500") for a in observed))
    check("no listener on any frozen port (3080/3081/9445/9446)",
          not any(a.endswith(p) for a in observed for p in (":3080", ":3081", ":9445", ":9446")))

    # ── positive case ────────────────────────────────────────────────────────
    print("\n=== positive case: approved production-shaped proxy ===")
    cfg = frpc_config(PROXY_NAME, APPROVED_DOMAIN, "approved.toml")
    code, out = run([f"{BIN}/frpc", "-c", cfg], timeout=10)
    login_ok = "login to server success" in out
    registered = out.count("start proxy success") > 0 and "start error" not in out
    check("tunnel authentication succeeded", login_ok)
    check("approved proxy registered", registered)
    with open(plugin_log, encoding="utf-8") as handle:
        log_text = handle.read()
    check("plugin decision for the approved proxy was ALLOW", "decision=ALLOW" in log_text)

    # ── negative case ────────────────────────────────────────────────────────
    print("\n=== negative case: unauthorized proxy with a VALID tunnel identity ===")
    before = log_text.count("decision=")
    cfg2 = frpc_config(PROXY_NAME, "unauthorized-fixture.invalid", "unauthorized.toml")
    code, out2 = run([f"{BIN}/frpc", "-c", cfg2], timeout=10)
    login_ok2 = "login to server success" in out2
    registered2 = out2.count("start proxy success") > 0 and "start error" not in out2
    with open(plugin_log, encoding="utf-8") as handle:
        log_text2 = handle.read()
    new_decisions = log_text2.count("decision=") - before
    check("the tunnel identity still authenticated", login_ok2)
    check("the unauthorized proxy did NOT register", not registered2)
    check("the plugin was actually consulted", new_decisions > 0, f"new decisions={new_decisions}")
    check("the plugin rejected it", "decision=REJECT" in log_text2)

    # ── teardown ─────────────────────────────────────────────────────────────
    print("\n=== teardown ===")
    for proc in (frps, plugin, upstream):
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            proc.kill()
    time.sleep(1)
    check("fixture port 7100 released", not wait_for_port(FRPS_PORT, timeout=1))
    check("fixture port 9100 released", not wait_for_port(PLUGIN_PORT, timeout=1))

    total = len(results)
    passed = sum(1 for r in results if r["pass"])
    summary = {"total": total, "pass": passed, "fail": total - passed, "assertions": results}
    print(f"\n=== rehearsal: {passed}/{total} assertions passed ===")
    with open(f"{LOG}/rehearsal.json", "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
