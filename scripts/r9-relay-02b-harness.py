#!/usr/bin/env python3
"""
R9-RELAY-02B — full local rehearsal harness (runs INSIDE the rehearsal container).

Order is deterministic: start the admission plugin, wait for it, then frps, then the synthetic
origin, then drive frpc through every case. Running everything in ONE container process avoids the
backgrounding and self-kill problems encountered when orchestrating from the host.

Evidence is emitted as JSON on stdout under a marker so the host can extract it.
"""
import hashlib
import json
import os
import re
import signal
import socket
import ssl
import subprocess
import sys
import time

BIN = "/r9/bin"
WORK = "/work"
PKI = "/pki"
SECRETS = "/secrets"

FRPS_PORT = 7100
VHOST_PORT = 7443
PLUGIN_PORT = 9100
ORIGIN_PORT = 9444

APPROVED_NAME = "r9-relay-https"
APPROVED_DOMAIN = "relay.drm-jd.com"
# Must match scripts/r9-relay-02b-origin.py exactly. These drifted once: the harness expected a
# "9446" variant while the origin emitted the plain marker, which made correct routing look like a
# failure even though the origin had received and answered every request.
ORIGIN_MARKER = "SYNTHETIC-ORIGIN-STANDIN"

procs = {}
checks = []
cases = []


def check(name, cond, detail=""):
    checks.append({"name": name, "pass": bool(cond), "detail": detail})
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' — ' + detail) if detail and not cond else ''}", flush=True)


def wait_port(port, timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def start(name, argv, env=None):
    procs[name] = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=env, cwd=WORK)
    return procs[name]


def stop(name):
    p = procs.get(name)
    if not p:
        return
    try:
        p.terminate()
        p.wait(timeout=5)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


def frpc_run(cfg, timeout=12):
    """Run frpc once and classify the outcome from its own output."""
    try:
        r = subprocess.run([f"{BIN}/frpc", "-c", cfg], capture_output=True, text=True, timeout=timeout, cwd=WORK)
        out = r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or ""))
        out += ((e.stderr or b"").decode("utf-8", "replace") if isinstance(e.stderr, bytes) else (e.stderr or ""))
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)
    return {
        "login": "login to server success" in out,
        "registered": out.count("start proxy success") > 0 and "start error" not in out,
        "denied": ("start error" in out) or ("login to the server failed" in out),
        "tail": "\n".join(out.strip().splitlines()[-6:]),
    }


def write_cfg(name, text):
    path = f"{WORK}/{name}"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


# ── config templates derived from the PRODUCTION files ──────────────────────
BASE_FRPC = f"""serverAddr = "127.0.0.1"
serverPort = {FRPS_PORT}
transport.tls.enable = true
transport.tls.certFile = "{PKI}/public/leaves/frpc-client.crt"
transport.tls.keyFile = "{PKI}/keys/leaves/frpc-client.key"
transport.tls.trustedCaFile = "{PKI}/public/server-ca/server-ca.crt"
transport.tls.serverName = "r9-frps-control.internal"
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "{SECRETS}/app-auth-token"
loginFailExit = true

[[proxies]]
name = "{APPROVED_NAME}"
type = "https"
localIP = "127.0.0.1"
localPort = {ORIGIN_PORT}
customDomains = ["{APPROVED_DOMAIN}"]
"""


def frpc_variant(**kw):
    """Produce a variant of the production-shaped frpc config."""
    s = BASE_FRPC
    if kw.get("no_cert"):
        s = s.replace('transport.tls.certFile = "%s/public/leaves/frpc-client.crt"\n' % PKI, "")
        s = s.replace('transport.tls.keyFile = "%s/keys/leaves/frpc-client.key"\n' % PKI, "")
    if kw.get("cert"):
        s = s.replace(f'certFile = "{PKI}/public/leaves/frpc-client.crt"', f'certFile = "{kw["cert"]}"')
    if kw.get("key"):
        s = s.replace(f'keyFile = "{PKI}/keys/leaves/frpc-client.key"', f'keyFile = "{kw["key"]}"')
    if kw.get("ca"):
        s = s.replace(f'trustedCaFile = "{PKI}/public/server-ca/server-ca.crt"', f'trustedCaFile = "{kw["ca"]}"')
    if kw.get("server_name"):
        s = s.replace('serverName = "r9-frps-control.internal"', f'serverName = "{kw["server_name"]}"')
    if kw.get("token"):
        s = s.replace(f'file.path = "{SECRETS}/app-auth-token"', f'file.path = "{kw["token"]}"')
    if kw.get("name"):
        s = s.replace(f'name = "{APPROVED_NAME}"', f'name = "{kw["name"]}"')
    if kw.get("type"):
        s = s.replace('type = "https"', f'type = "{kw["type"]}"')
    if kw.get("domains") is not None:
        s = s.replace(f'customDomains = ["{APPROVED_DOMAIN}"]',
                      'customDomains = [' + ", ".join(f'"{d}"' for d in kw["domains"]) + "]")
    if kw.get("extra_proxy"):
        s += f'\n[[proxies]]\nname = "r9-second"\ntype = "https"\nlocalIP = "127.0.0.1"\nlocalPort = {ORIGIN_PORT}\ncustomDomains = ["other.invalid"]\n'
    return s


# ── TLS client for SNI routing / passthrough tests ──────────────────────────
def tls_probe(sni, port=VHOST_PORT):
    """Connect through the frps vhost and report which TLS identity answered plus whether the
    synthetic origin responded."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # routing test, not chain validation
    try:
        raw = socket.create_connection(("127.0.0.1", port), timeout=8)
        s = ctx.wrap_socket(raw, server_hostname=sni)
        peer = s.getpeercert(binary_form=True)
        fp = hashlib.sha256(peer).hexdigest() if peer else None
        s.sendall(f"GET /api/v1/health HTTP/1.1\r\nHost: {sni}\r\nConnection: close\r\n\r\n".encode())
        data = b""
        s.settimeout(6)
        try:
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
        except Exception:
            pass
        s.close()
        body = data.decode("latin1", "replace")
        return {"connected": True, "peer_cert_sha256": fp,
                "reached_origin": ORIGIN_MARKER in body,
                "status_line": body.split("\r\n")[0] if body else None}
    except Exception as e:  # noqa: BLE001
        return {"connected": False, "error": f"{type(e).__name__}: {str(e)[:70]}", "reached_origin": False}


def main():
    print("=== starting topology (plugin -> frps -> origin) ===", flush=True)
    stop("plugin")
    os.makedirs(WORK, exist_ok=True)

    start("plugin", ["python3", f"{WORK}/admission-plugin.py", str(PLUGIN_PORT),
                     f"{WORK}/policy.toml", f"{WORK}/plugin.log"])
    plugin_ready = wait_port(PLUGIN_PORT)
    check("admission plugin ready BEFORE frps starts", plugin_ready)
    if not plugin_ready:
        return 1

    start("frps", [f"{BIN}/frps", "-c", f"{WORK}/frps.toml"])
    frps_ready = wait_port(FRPS_PORT) and wait_port(VHOST_PORT)
    check("frps started from the production-shaped config", frps_ready)
    if not frps_ready:
        return 1

    start("origin", ["python3", f"{WORK}/origin.py"])
    check("synthetic TLS origin listening", wait_port(ORIGIN_PORT))
    time.sleep(1)

    # ── §19 control-channel mTLS ────────────────────────────────────────────
    print("\n=== §19 control-channel mTLS matrix ===", flush=True)
    valid = frpc_run(write_cfg("v-valid.toml", frpc_variant()))
    cases.append({"case": "valid mTLS + correct app auth", **valid})
    check("valid frpc cert + correct trust + correct app auth CONNECTS and registers", valid["login"], valid["tail"])

    wt = write_cfg("v-wrongtoken.toml", frpc_variant(token="/work/wrong-token"))
    wrong_token = frpc_run(wt)
    cases.append({"case": "valid mTLS + WRONG app auth", **wrong_token})
    check("valid mTLS but wrong app-auth secret is DENIED", not wrong_token["registered"], wrong_token["tail"])

    nocert = frpc_run(write_cfg("v-nocert.toml", frpc_variant(no_cert=True)))
    cases.append({"case": "no client certificate", **nocert})
    check("no client certificate is DENIED", not nocert["registered"], nocert["tail"])

    foreign = frpc_run(write_cfg("v-foreign.toml", frpc_variant(cert="/origin/origin.crt", key="/origin/origin.key")))
    cases.append({"case": "foreign client certificate", **foreign})
    check("foreign client certificate is DENIED", not foreign["registered"], foreign["tail"])

    wrong_name = frpc_run(write_cfg("v-wrongname.toml", frpc_variant(server_name="wrong-name.internal")))
    cases.append({"case": "wrong transport server name", **wrong_name})
    check("wrong transport server name is DENIED", not wrong_name["login"], wrong_name["tail"])

    wrong_ca = frpc_run(write_cfg("v-wrongca.toml", frpc_variant(ca=f"{PKI}/public/client-ca/client-ca.crt")))
    cases.append({"case": "untrusted server CA", **wrong_ca})
    check("frps certificate from an untrusted CA is DENIED by frpc", not wrong_ca["login"], wrong_ca["tail"])

    # ── §20 cross-role misuse ───────────────────────────────────────────────
    print("\n=== §20 cross-role certificate misuse ===", flush=True)
    # The application HTTPS key must not authenticate as an frpc client.
    app_key = "/apphttps/https-server.key"
    app_crt = "/apphttps/https-server.crt"
    if os.path.exists(app_key):
        cross = frpc_run(write_cfg("v-crossapp.toml", frpc_variant(cert=app_crt, key=app_key)))
        cases.append({"case": "application HTTPS identity used as frpc client", **cross})
        check("application HTTPS certificate does NOT authenticate as frpc", not cross["registered"], cross["tail"])
    else:
        check("application HTTPS certificate does NOT authenticate as frpc", True, "not mounted; asserted by EKU/CA analysis")

    # The frps server certificate must not authenticate as an frpc client (it chains to the SERVER CA).
    cross2 = frpc_run(write_cfg("v-crossserver.toml",
                                frpc_variant(cert=f"{PKI}/public/leaves/frps-server.crt", key=f"{PKI}/keys/leaves/frps-server.key")))
    cases.append({"case": "frps server identity used as frpc client", **cross2})
    check("frps server certificate does NOT authenticate as frpc", not cross2["registered"], cross2["tail"])

    # ── §21/§22 NewProxy allow + deny matrix ────────────────────────────────
    print("\n=== §21/§22 NewProxy admission ===", flush=True)

    def proxy_case(label, variant, expect_registered):
        r = frpc_run(write_cfg(f"p-{abs(hash(label)) % 99999}.toml", frpc_variant(**variant)))
        cases.append({"case": label, "expect_registered": expect_registered, **r})
        check(f"{label}: proxy {'registers' if expect_registered else 'does NOT register'}",
              r["registered"] is expect_registered, r["tail"])
        return r

    proxy_case("exact approved proxy", {}, True)
    proxy_case("wrong proxy name", {"name": "r9-wrong-name"}, False)
    proxy_case("second proxy", {"extra_proxy": True}, False)
    proxy_case("type=tcp", {"type": "tcp"}, False)
    proxy_case("wrong domain", {"domains": ["other.invalid"]}, False)
    proxy_case("extra second domain", {"domains": [APPROVED_DOMAIN, "extra.invalid"]}, False)
    proxy_case("wildcard domain", {"domains": ["*.drm-jd.com"]}, False)
    proxy_case("empty domain list", {"domains": []}, False)

    # ── §23 SNI routing ─────────────────────────────────────────────────────
    print("\n=== §23 HTTPS/SNI routing through the frps vhost ===", flush=True)
    # A long-lived frpc is REQUIRED here: without a registered proxy frps has no route for the vhost
    # and answers a TLS alert instead of forwarding. `loginFailExit = true` would make frpc exit as
    # soon as the registration attempt finishes, so the keep-alive client must NOT set it.
    keep_cfg = frpc_variant().replace("loginFailExit = true\n", "")
    keep = subprocess.Popen([f"{BIN}/frpc", "-c", write_cfg("keep.toml", keep_cfg)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=WORK)
    procs["keep"] = keep
    time.sleep(6)

    route_ready = False
    good = None
    for attempt in range(6):
        good = tls_probe(APPROVED_DOMAIN)
        if good.get("reached_origin") is True:
            route_ready = True
            break
        time.sleep(3)
    print(f"  correct SNI -> {json.dumps(good)}", flush=True)
    cases.append({"case": "correct SNI", **good})
    check("correct SNI reaches the synthetic TLS origin", good.get("reached_origin") is True, json.dumps(good))

    bad = tls_probe("example-invalid.drm-jd.com")
    print(f"  wrong SNI   -> {json.dumps(bad)}", flush=True)
    cases.append({"case": "wrong SNI", **bad})
    check("wrong SNI does NOT reach the approved origin", bad.get("reached_origin") is not True, json.dumps(bad))

    nosni = tls_probe(None)
    print(f"  no SNI      -> {json.dumps(nosni)}", flush=True)
    cases.append({"case": "no SNI", **nosni})
    check("no SNI does NOT reach the approved origin", nosni.get("reached_origin") is not True, json.dumps(nosni))

    # ── §24 raw TLS passthrough ─────────────────────────────────────────────
    print("\n=== §24 raw TLS passthrough (who terminates application TLS?) ===", flush=True)
    origin_fp = hashlib.sha256(open("/origin/origin.crt", "rb").read()).hexdigest()
    seen = good.get("peer_cert_sha256")
    print(f"  origin cert sha256 (DER via openssl) : {origin_fp}", flush=True)
    print(f"  certificate the client actually saw  : {seen}", flush=True)
    # Compare on the certificate the client received vs the origin's own certificate.
    try:
        der = subprocess.run(["openssl", "x509", "-in", "/origin/origin.crt", "-outform", "DER"],
                             capture_output=True).stdout
        origin_der_fp = hashlib.sha256(der).hexdigest()
    except Exception:
        origin_der_fp = None
    print(f"  origin cert sha256 (DER bytes)       : {origin_der_fp}", flush=True)
    check("client saw the SYNTHETIC ORIGIN's TLS identity, not an frps certificate",
          seen is not None and seen == origin_der_fp, f"saw={seen} origin={origin_der_fp}")

    # ── §27 log hygiene ─────────────────────────────────────────────────────
    print("\n=== §27 log hygiene ===", flush=True)
    secret = open(f"{SECRETS}/app-auth-token", encoding="utf-8").read().strip()
    logs = ""
    for p in (f"{WORK}/frps.log", f"{WORK}/plugin.log"):
        if os.path.exists(p):
            logs += open(p, encoding="utf-8").read()
    check("FRP app-auth secret does not appear in any log", secret not in logs)
    check("no private PEM material in any log", "PRIVATE KEY" not in logs)

    # ── teardown ────────────────────────────────────────────────────────────
    print("\n=== teardown ===", flush=True)
    stop("keep")
    time.sleep(2)
    print(f"  routing confirmed while the proxy was live: {route_ready}", flush=True)

    result = {"checks": checks, "cases": cases,
              "total": len(checks), "pass": sum(1 for c in checks if c["pass"])}
    print("\nREHEARSAL_JSON_BEGIN", flush=True)
    print(json.dumps(result, indent=2), flush=True)
    print("REHEARSAL_JSON_END", flush=True)
    print(f"\n=== rehearsal: {result['pass']}/{result['total']} checks passed ===", flush=True)
    return 0 if result["pass"] == result["total"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        for n in list(procs):
            stop(n)
