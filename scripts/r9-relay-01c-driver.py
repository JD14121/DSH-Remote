#!/usr/bin/env python3
"""
R9-RELAY-01C — frp NewProxy admission test driver.

Runs entirely inside the fixture container. It starts the admission plugin, frps and a stand-in
upstream, then drives the positive case, the negative matrix, and the failure-injection cases, and
prints a machine-readable JSON summary.

The critical evidence for every case is kept in three separate places, because a registration
succeeding or failing is not by itself proof that the *plugin* decided it:

  plugin_decision   what the plugin logged it decided
  proxy_registered  what frpc reported happened
  (together these distinguish "policy rejected this" from "the plugin was never consulted")
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

BIN = "/fixture/bin"
CONF = "/fixture/conf"
LOG = "/fixture/log"
WORK = "/fixture/work"

FRPS_PORT = 7100
PLUGIN_PORT = 9100
UPSTREAM_PORT = 7444
PROXY_NAME = "r9-fixture-proxy"
APPROVED_DOMAIN = "relay-fixture.invalid"
TOKEN = "r9-fixture-token-not-production"

results = []


def run(cmd, timeout=20, **kwargs):
    """Run a command, never raising on a non-zero status."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kwargs)
        return proc.returncode, proc.stdout + proc.stderr
    except subprocess.TimeoutExpired as exc:
        # A timeout is a NORMAL outcome here: frpc stays alive once a proxy registers, and is also
        # held open while a rejected registration retries. The captured output is what matters.
        parts = []
        for stream in (exc.stdout, exc.stderr):
            if stream is None:
                continue
            parts.append(stream.decode("utf-8", "replace") if isinstance(stream, bytes) else stream)
        return None, "".join(parts) + "\n[timed out]"
    except Exception as exc:  # noqa: BLE001 - the driver must never crash mid-matrix
        return -1, f"[runner error] {exc}"


def free_port(port):
    """Best-effort: terminate anything still holding a fixture port from an earlier run."""
    code, out = run(["sh", "-c", f"netstat -ltnp 2>/dev/null | grep ':{port} ' || true"], timeout=10)
    for match in re.finditer(r"(\d+)/", out or ""):
        pid = match.group(1)
        run(["sh", "-c", f"kill -9 {pid} 2>/dev/null || true"], timeout=5)
    time.sleep(0.5)


def wait_for_port(port, host="127.0.0.1", timeout=15.0):
    """Wait until something accepts connections on the port."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def start_plugin(mode="policy"):
    """Start the plugin and wait for its ready line."""
    logfile = f"{LOG}/plugin.log"
    open(logfile, "w").close()
    proc = subprocess.Popen(
        [sys.executable, "/fixture/admission-plugin.py", str(PLUGIN_PORT), mode, logfile],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    # A timeout mode never answers, so readiness is judged by the listening socket.
    ready = wait_for_port(PLUGIN_PORT, timeout=10.0)
    return proc, ready, logfile


def stop(proc):
    if proc is None:
        return
    try:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def start_frps(plugin_addr=f"127.0.0.1:{PLUGIN_PORT}", plugin_path="/cgi-bin/frp-newproxy"):
    """Start frps with the given plugin address, so the refusal case can be exercised."""
    config = f"""
bindAddr = "127.0.0.1"
bindPort = {FRPS_PORT}
proxyBindAddr = "127.0.0.1"
vhostHTTPSPort = 7443
auth.method = "token"
auth.token = "{TOKEN}"
transport.tls.force = true
log.to = "{LOG}/frps.log"
log.level = "info"
detailedErrorsToClient = false
[[httpPlugins]]
name = "r9-newproxy-policy"
addr = "{plugin_addr}"
path = "{plugin_path}"
ops = ["NewProxy"]
"""
    path = f"{CONF}/frps-run.toml"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(config)
    proc = subprocess.Popen([f"{BIN}/frps", "-c", path], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    ready = wait_for_port(FRPS_PORT, timeout=15.0)
    return proc, ready


def start_upstream():
    proc = subprocess.Popen([sys.executable, "/fixture/upstream.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_for_port(UPSTREAM_PORT, timeout=10.0)
    return proc


def frpc_config(proxies, filename):
    """Write an frpc config for the given proxy blocks."""
    blocks = []
    for block in proxies:
        lines = [f'[[proxies]]', f'name = "{block["name"]}"', f'type = "{block["type"]}"']
        if "local_port" in block:
            lines.append(f'localIP = "127.0.0.1"')
            lines.append(f'localPort = {block["local_port"]}')
        if "custom_domains" in block:
            domains = ", ".join(f'"{d}"' for d in block["custom_domains"])
            lines.append(f"customDomains = [{domains}]")
        for field in ("subdomain", "group", "groupKey", "locations"):
            if field in block:
                value = block[field]
                if isinstance(value, list):
                    rendered = ", ".join(f'"{v}"' for v in value)
                    lines.append(f"{field} = [{rendered}]")
                else:
                    lines.append(f'{field} = "{value}"')
        if "remote_port" in block:
            lines.append(f'remotePort = {block["remote_port"]}')
        blocks.append("\n".join(lines))

    config = f"""serverAddr = "127.0.0.1"
serverPort = {FRPS_PORT}
auth.method = "token"
auth.token = "{TOKEN}"
transport.tls.enable = true
loginFailExit = true

""" + "\n\n".join(blocks) + "\n"
    path = f"{WORK}/{filename}"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(config)
    return path


def approved_block(**overrides):
    """The one approved proxy definition, with optional overrides for negative cases."""
    block = {
        "name": PROXY_NAME,
        "type": "https",
        "local_port": UPSTREAM_PORT,
        "custom_domains": [APPROVED_DOMAIN],
    }
    block.update(overrides)
    return block


def read_plugin_decisions(logfile):
    """Parse the plugin log into structured decisions. No request bodies are ever logged."""
    decisions = []
    try:
        with open(logfile, encoding="utf-8") as handle:
            for line in handle:
                match = re.search(r"decision=(\w+)(?: reason=(.*?) detail=(\{.*\}))?$", line.strip())
                if match:
                    decisions.append({
                        "outcome": match.group(1),
                        "reason": (match.group(2) or "").strip(),
                        "detail": match.group(3),
                    })
                elif "decision=" in line:
                    decisions.append({"outcome": line.split("decision=")[1].split()[0], "reason": "", "detail": None})
    except OSError:
        pass
    return decisions


def attempt(label, proxies, expect_registered, expect_plugin=None, plugin_log=None, duration=8,
            expect_only_approved=False):
    """
    Run one frpc attempt and classify it.

    Registration is judged from frpc's per-proxy outcome counts, and the plugin's decision is read
    separately, so a rejection can be attributed to the plugin rather than to an unrelated failure.

    `expect_only_approved` covers the two-proxy case: the single approved proxy may register, but the
    extra one must not. Without it, "one success" and "one rejection" in the same output would be
    indistinguishable from "the extra proxy registered too".
    """
    name = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    cfg = frpc_config(proxies, f"frpc-{name}.toml")
    before = len(read_plugin_decisions(plugin_log)) if plugin_log else 0

    # frpc stays alive once registered, so it is always run under a timeout.
    code, out = run([f"{BIN}/frpc", "-c", cfg], timeout=duration)

    login_ok = "login to server success" in out
    start_error = "start error" in out
    login_failed = "login to the server failed" in out or "connect: connection refused" in out

    # Count outcomes rather than substring-matching a boolean.
    #
    # A config may declare several proxies, and previously `"start proxy success" in out or
    # ("proxy added" in out and "start error" not in out)` reported "registered" whenever ANY proxy
    # succeeded with no error anywhere. For the two-proxy case that made a correctly rejected extra
    # proxy look like a successful extra registration. Per-proxy counts remove the ambiguity.
    success_count = out.count("start proxy success")
    error_count = out.count("start error")
    added_count = out.count("proxy added")
    registered = success_count > 0 and error_count == 0
    all_rejected = added_count > 0 and success_count == 0 and error_count >= added_count

    after = read_plugin_decisions(plugin_log) if plugin_log else []
    new_decisions = after[before:]
    plugin_decision = new_decisions[-1]["outcome"] if new_decisions else "NONE"
    plugin_reason = new_decisions[-1]["reason"] if new_decisions else ""

    # A case passes when the observed registration matches expectation AND, where the plugin was
    # expected to be consulted, the plugin's recorded decision agrees.
    if expect_only_approved:
        # Exactly one proxy registered and exactly one was refused by the plugin.
        registration_matches = success_count == 1 and error_count >= 1
    else:
        registration_matches = registered == expect_registered
    plugin_matches = True
    if expect_plugin is not None:
        plugin_matches = plugin_decision == expect_plugin

    result = {
        "label": label,
        "expect_registered": expect_registered,
        "login_ok": login_ok,
        "login_failed": login_failed,
        "proxy_registered": registered,
        "all_rejected": all_rejected,
        "success_count": success_count,
        "error_count": error_count,
        "added_count": added_count,
        "start_error": start_error,
        "plugin_decision": plugin_decision,
        "plugin_reason": plugin_reason,
        "plugin_consulted": plugin_decision != "NONE",
        "expect_plugin": expect_plugin,
        "pass": bool(registration_matches and plugin_matches),
    }
    results.append(result)
    marker = "PASS" if result["pass"] else "FAIL"
    print(f"  [{marker}] {label:<44} registered={registered!s:<5} plugin={plugin_decision:<10} login={login_ok}", flush=True)
    return result


def probe_plugin_field(label, content, expect_allowed=False):
    """
    Ask the plugin directly about a field combination frpc's config format cannot express.

    `group`, `groupKey` and `locations` are rejected by frpc's own TOML parsing before any tunnel
    exists, so no integration attempt can test them. Rather than record those as regressions, the
    plugin's field policy is exercised over real HTTP and the result is labelled as plugin-level
    evidence, which is what it actually is.
    """
    import urllib.request
    body = json.dumps({"version": "0.1.0", "op": "NewProxy", "content": content}).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{PLUGIN_PORT}/cgi-bin/frp-newproxy",
        data=body, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode())
    except Exception as exc:  # noqa: BLE001
        payload = {"error": str(exc)}

    allowed = "unchange" in payload
    passed = allowed == expect_allowed
    results.append({
        "label": label,
        "evidence_level": "plugin-level (frpc cannot express this field)",
        "expect_registered": expect_allowed,
        "login_ok": None,
        "login_failed": None,
        "proxy_registered": allowed,
        "start_error": None,
        # The decision recorded is the one this call actually received, taken from its own HTTP
        # response rather than from a shared log tail.
        "plugin_decision": "ALLOW" if allowed else "REJECT",
        "plugin_reason": payload.get("reject_reason", "") if not allowed else "the definition matched the single approved proxy",
        "plugin_consulted": True,
        "expect_plugin": "ALLOW" if expect_allowed else "REJECT",
        "pass": passed,
    })
    marker = "PASS" if passed else "FAIL"
    detail = "" if allowed else f" reason={payload.get('reject_reason', payload)}"
    print(f"  [{marker}] {label:<44} plugin={'ALLOW' if allowed else 'REJECT':<10} (plugin-level){detail}", flush=True)


def kill_stale_fixture():
    """
    Terminate fixture processes left by a previous run.

    This matters because the `timeout` injection mode holds its connection forever: a plugin in that
    mode keeps the port bound, so a later run's own plugin cannot bind and the probes silently talk
    to the stale, hanging server. The driver's own command line does not contain these patterns, so
    matching on them cannot kill this process.
    """
    for pattern in ("admission-plugin.py", "/fixture/bin/frps", "/fixture/bin/frpc", "upstream.py"):
        run(["sh", "-c", f"pkill -9 -f '{pattern}' 2>/dev/null || true"], timeout=10)
    time.sleep(1)
    for port in (FRPS_PORT, PLUGIN_PORT, UPSTREAM_PORT):
        free_port(port)


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)
    for name in ("frps.log", "plugin.log"):
        try:
            os.remove(f"{LOG}/{name}")
        except OSError:
            pass

    kill_stale_fixture()

    print("=== starting fixture ===", flush=True)
    upstream = start_upstream()
    upstream_ready = wait_for_port(UPSTREAM_PORT)
    print(f"  upstream on 127.0.0.1:{UPSTREAM_PORT}: {upstream_ready}", flush=True)
    if not upstream_ready:
        code, out = run(["sh", "-c", "python3 /fixture/upstream.py 2>&1 | head -5"], timeout=5)
        print(f"  upstream error: {out.strip()}", flush=True)

    plugin, plugin_ready, plugin_log = start_plugin("policy")
    print(f"  plugin on 127.0.0.1:{PLUGIN_PORT}: {plugin_ready}", flush=True)

    frps, frps_ready = start_frps()
    print(f"  frps on 127.0.0.1:{FRPS_PORT}: {frps_ready}", flush=True)

    if not (plugin_ready and frps_ready):
        print(json.dumps({"error": "fixture failed to start", "plugin_ready": plugin_ready, "frps_ready": frps_ready}))
        stop(frps); stop(plugin); stop(upstream)
        return 1

    # ── Step 5: the mandatory positive case ──────────────────────────────────
    print("\n=== STEP 5: positive case (exact approved proxy) ===", flush=True)
    attempt("approved proxy", [approved_block()], True, expect_plugin="ALLOW", plugin_log=plugin_log, duration=10)

    # ── Step 6: negative matrix ─────────────────────────────────────────────
    print("\n=== STEP 6: negative matrix ===", flush=True)
    negatives = [
        ("second proxy (different name)", [approved_block(name="r9-second-proxy")]),
        ("different custom domain", [approved_block(custom_domains=["other-fixture.invalid"])]),
        ("multiple custom domains", [approved_block(custom_domains=[APPROVED_DOMAIN, "extra-fixture.invalid"])]),
        ("subdomain present", [approved_block(subdomain="sub")]),
        ("http proxy", [approved_block(type="http")]),
        ("tcp proxy", [{"name": PROXY_NAME, "type": "tcp", "local_port": UPSTREAM_PORT, "remote_port": 7500}]),
        ("udp proxy", [{"name": PROXY_NAME, "type": "udp", "local_port": UPSTREAM_PORT, "remote_port": 7501}]),
        ("stcp proxy", [{"name": PROXY_NAME, "type": "stcp", "local_port": UPSTREAM_PORT}]),
        ("xtcp proxy", [{"name": PROXY_NAME, "type": "xtcp", "local_port": UPSTREAM_PORT}]),
        ("sudp proxy", [{"name": PROXY_NAME, "type": "sudp", "local_port": UPSTREAM_PORT}]),
    ]
    for label, proxies in negatives:
        attempt(label, proxies, False, expect_plugin="REJECT", plugin_log=plugin_log)

    # The two-proxy case: the approved proxy may register, the extra one must be refused.
    #
    # `expect_plugin` is deliberately None here. The plugin log's LAST decision for this attempt
    # belongs to the extra (rejected) proxy, so asserting ALLOW against it would be comparing the
    # wrong event; the per-proxy counts asserted by `expect_only_approved` are the meaningful check,
    # and the rejected decision is visible in the recorded log alongside them.
    attempt("additional proxy registration", [approved_block(), approved_block(name="r9-extra-proxy")],
            False, expect_plugin=None, plugin_log=plugin_log, expect_only_approved=True)

    # These three cannot be expressed through frpc: its own TOML parsing rejects the fields before a
    # tunnel exists. They are therefore proven at the plugin boundary over real HTTP.
    # Diagnostic: if the plugin stopped answering after the integration attempts, the reason must be
    # visible rather than guessed at.
    alive = plugin.poll()
    print(f"  [diag] plugin process state before 6b: {'alive' if alive is None else f'exited({alive})'}", flush=True)
    code, probe = run(["sh", "-c",
                       f"python3 -c \"import urllib.request;"
                       f"print(urllib.request.urlopen('http://127.0.0.1:{PLUGIN_PORT}{'/cgi-bin/frp-newproxy'}',timeout=4).status)\" 2>&1 || true"],
                      timeout=10)
    print(f"  [diag] plugin GET probe: {probe.strip().splitlines()[-1] if probe.strip() else '(no output)'}", flush=True)
    code, portstate = run(["sh", "-c", f"netstat -ltn 2>/dev/null | grep -c ':{PLUGIN_PORT} ' || true"], timeout=10)
    print(f"  [diag] listeners on {PLUGIN_PORT}: {portstate.strip()}", flush=True)

    print("\n=== STEP 6b: fields frpc's config format cannot express (plugin-level) ===", flush=True)
    probe_plugin_field("non-empty group", {
        "proxy_name": PROXY_NAME, "proxy_type": "https",
        "custom_domains": [APPROVED_DOMAIN], "group": "some-group"})
    probe_plugin_field("non-empty group_key", {
        "proxy_name": PROXY_NAME, "proxy_type": "https",
        "custom_domains": [APPROVED_DOMAIN], "group_key": "some-key"})
    probe_plugin_field("unexpected locations", {
        "proxy_name": PROXY_NAME, "proxy_type": "https",
        "custom_domains": [APPROVED_DOMAIN], "locations": ["/admin"]})
    # A control: the exact shape frps actually sends is still admitted. The approved-shape probe uses
    # the same key set observed from frps (`proxy_name`, `proxy_type`, `custom_domains`) and must be
    # ALLOW, proving the three rejections above are caused by the offending field and nothing else.
    probe_plugin_field("approved shape control", {
        "proxy_name": PROXY_NAME, "proxy_type": "https",
        "custom_domains": [APPROVED_DOMAIN], "user": ""},
        expect_allowed=True)

    # ── Step 7: plugin unavailable must fail closed ─────────────────────────
    print("\n=== STEP 7: plugin unavailable (fail closed) ===", flush=True)
    stop(plugin)
    time.sleep(1)
    attempt("plugin stopped", [approved_block()], False, expect_plugin="NONE", plugin_log=plugin_log, duration=10)

    print("\n=== STEP 7b: plugin restored, approved proxy registers again ===", flush=True)
    plugin, plugin_ready, plugin_log = start_plugin("policy")
    print(f"  plugin restarted: {plugin_ready}", flush=True)
    time.sleep(1)
    attempt("approved proxy after restart", [approved_block()], True, expect_plugin="ALLOW", plugin_log=plugin_log, duration=10)

    # ── Step 8: malformed / error plugin responses ──────────────────────────
    #
    # The requirement is that none of these may cause the proxy to be REGISTERED. Two distinct
    # fail-closed mechanisms are acceptable and are recorded separately:
    #   * frps treats the bad response as a refusal (registration denied), or
    #   * frps never obtains a usable decision, so it does not complete registration either
    #     (the attempt stays pending until the client gives up).
    # What is NOT acceptable is `start proxy success`.
    print("\n=== STEP 8: malformed plugin responses (each must fail closed) ===", flush=True)
    for mode, label in [
        ("reject", "plugin rejects everything"),
        ("invalid-json", "plugin returns invalid JSON"),
        ("empty", "plugin returns an empty body"),
        ("truncated", "plugin returns a truncated body"),
        ("http500", "plugin returns HTTP 500"),
        ("timeout", "plugin never answers (timeout)"),
    ]:
        stop(plugin)
        time.sleep(1)
        plugin, _, plugin_log = start_plugin(mode)
        time.sleep(1)
        result = attempt(label, [approved_block()], False, expect_plugin=None, plugin_log=plugin_log, duration=12)
        result["evidence_level"] = "integration"
        result["fail_closed_mechanism"] = (
            "frps denied registration on the bad response" if result["start_error"]
            else "no usable decision: registration never completed" if not result["proxy_registered"]
            else "REGISTERED — NOT fail closed"
        )
        result["pass"] = not result["proxy_registered"]
        if not result["pass"]:
            print(f"        ^ NOT FAIL CLOSED: {label}", flush=True)

    # Connection refusal: point frps at a port where nothing is listening.
    stop(plugin)
    stop(frps)
    time.sleep(1)
    frps, frps_ready = start_frps(plugin_addr="127.0.0.1:9199")
    print(f"  frps restarted with a dead plugin address: {frps_ready}", flush=True)
    attempt("plugin connection refused", [approved_block()], False, expect_plugin=None, plugin_log=None, duration=12)

    # ── teardown ────────────────────────────────────────────────────────────
    stop(frps)
    stop(plugin)
    stop(upstream)

    passed = sum(1 for r in results if r["pass"])
    total = len(results)
    summary = {
        "total": total,
        "pass": passed,
        "fail": total - passed,
        "positive_registered": next((r["proxy_registered"] for r in results if r["label"] == "approved proxy"), None),
        "results": results,
    }
    print("\n=== SUMMARY ===", flush=True)
    print(f"  {passed}/{total} cases behaved as required", flush=True)
    with open(f"{LOG}/results.json", "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print("  results written to /fixture/log/results.json", flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
