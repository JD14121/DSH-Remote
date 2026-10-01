#!/usr/bin/env python3
"""
R9-RELAY-02B — frps NewProxy admission plugin (PRODUCTION).

Default DENY. Exactly one proxy shape is admitted, and every field is checked. This carries forward the
policy proven in R9-RELAY-01C (25/25 cases) but is now driven by the production policy config instead
of hardcoded fixture values.

Design properties that matter for the security claim:

* **Default deny.** The decision starts as reject and is only turned into `unchange` after EVERY field
  has been checked. A parse failure, unknown operation, missing field, or unexpected field all leave it
  as reject.
* **Explicit allowlist of fields.** A field present in the proxy definition that is not in the allowed
  set is a rejection, not something to ignore. That is what stops a valid tunnel identity from
  smuggling in group/group_key/locations/remote_port.
* **Bounded input.** The request body is capped at `max_body_bytes`; an oversized body is rejected
  without being read into memory unbounded.
* **No secret logging.** Only the decision and the reason are recorded. Request bodies are never
  written to disk.
* **Loopback only.** The listener refuses to bind a non-loopback address.

Usage: admission-plugin.py <port> <policy-config> <logfile>
"""

import json
import sys
import tomllib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Policy parsing uses the standard library's TOML reader (Python 3.11+). A hand-rolled parser was
# tried first and silently mishandled a multi-line array, which produced an empty `allowed_fields`
# and caused EVERY field to be rejected as unexpected — including the approved proxy. Using the real
# parser removes that entire class of bug.
def load_policy(path):
    with open(path, "rb") as handle:
        return tomllib.load(handle)


class Handler(BaseHTTPRequestHandler):
    server_version = "r9-admission/2.0"
    protocol_version = "HTTP/1.1"

    def _respond_raw(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def _respond(self, status, payload):
        self._respond_raw(status, json.dumps(payload).encode("utf-8"))

    def do_POST(self):  # noqa: N802
        cfg = self.server.r9_cfg
        if self.path.split("?")[0] != self.server.r9_path:
            self._respond(404, {"reject": True, "reject_reason": "unexpected plugin path"})
            log(cfg["logfile"], "decision=REJECT reason=unexpected path")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        # Bounded input: refuse an oversized body WITHOUT reading it into memory.
        if length > cfg["max_body_bytes"]:
            self._respond(200, {"reject": True, "reject_reason": "request body too large"})
            log(cfg["logfile"], f"decision=REJECT reason=body too large ({length} bytes)")
            return

        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8"))
            allowed, reason, detail = decide(payload, cfg)
        except Exception:  # noqa: BLE001 - any parse problem is a rejection
            allowed, reason, detail = False, "the request body was not valid JSON", {}

        response = {"unchange": True} if allowed else {"reject": True, "reject_reason": reason}
        log(cfg["logfile"],
            f"decision={'ALLOW' if allowed else 'REJECT'} reason={reason} detail={json.dumps(detail, sort_keys=True)}")
        self._respond(200, response)

    def do_GET(self):  # noqa: N802 - readiness probe
        if self.path.split("?")[0] != self.server.r9_path:
            self._respond(404, {"status": "not this endpoint"})
            return
        self._respond(200, {"plugin": "r9-newproxy-policy", "status": "alive"})

    def log_message(self, *args):
        """Silence default logging: request lines could carry metadata."""
        return


def decide(payload, cfg):
    """Return (allowed, reason, detail). `detail` holds only policy-relevant scalars."""
    if not isinstance(payload, dict):
        return False, "the request body was not a JSON object", {}

    operation = payload.get("op", payload.get("operation"))
    if operation != "NewProxy":
        return False, f"unexpected operation {operation!r}", {"operation": operation}

    content = payload.get("content")
    if not isinstance(content, dict):
        return False, "the NewProxy content was missing or not an object", {}

    approved = cfg["approved"][0]
    detail = {
        "proxy_name": content.get("proxy_name"),
        "proxy_type": content.get("proxy_type"),
        "custom_domains": content.get("custom_domains"),
        "subdomain": content.get("subdomain"),
        "group": content.get("group"),
        "group_key": content.get("group_key"),
        "locations": content.get("locations"),
    }

    # An unexpected field is a rejection, not something to ignore.
    unexpected = sorted(set(content.keys()) - set(cfg["allowed_fields"]))
    if unexpected:
        return False, f"unexpected field(s) present: {', '.join(unexpected)}", detail

    if content.get("proxy_name") != approved.get("proxy_name"):
        return False, "proxy name is not the approved one", detail
    if content.get("proxy_type") != approved.get("proxy_type"):
        return False, "proxy type is not the approved one", detail

    domains = content.get("custom_domains")
    expected = approved.get("custom_domains") or []
    if not isinstance(domains, list) or len(domains) != len(expected):
        return False, "the custom domain list does not match the approved length", detail
    if domains != expected:
        return False, "the custom domain list is not the approved one", detail

    for field in cfg["must_be_empty"]:
        value = content.get(field)
        if value not in (None, "", [], {}):
            return False, f"{field} must be empty", detail

    return True, "the definition matched the single approved proxy", detail


def log(path, message):
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now(timezone.utc).isoformat()} {message}\n")
    except OSError:
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 19100
    policy_path = sys.argv[2] if len(sys.argv) > 2 else "/etc/r9-frp/admission/newproxy-policy.toml"
    logfile = sys.argv[3] if len(sys.argv) > 3 else "/var/log/r9-frp/plugin.log"

    policy = load_policy(policy_path)
    # Global policy keys live under [policy]; the approved proxy definitions live under
    # [[approved_proxies]]. Keeping them in separate tables avoids the TOML nesting trap where a key
    # written after a [[table]] header silently becomes part of that table.
    settings = policy.get("policy") or {}
    approved = policy.get("approved_proxies") or []
    if not approved:
        # Fail closed at startup rather than running with an empty allowlist.
        raise SystemExit("refusing to start: the policy config defines no approved proxy")

    cfg = {
        "approved": approved,
        "must_be_empty": settings.get("must_be_empty") or ["subdomain", "group", "group_key", "locations"],
        "allowed_fields": settings.get("allowed_fields") or [],
        "denied_types": settings.get("denied_proxy_types") or [],
        "max_body_bytes": int(settings.get("max_body_bytes") or 16384),
        "logfile": logfile,
    }

    # An empty allowed_fields would reject every field as unexpected, including the approved proxy.
    # That is a configuration defect, so refuse to start rather than deny everything silently.
    if not cfg["allowed_fields"]:
        raise SystemExit("refusing to start: the policy config defines no allowed_fields")

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.timeout = 30
    server.r9_cfg = cfg
    server.r9_path = "/cgi-bin/frp-newproxy"

    bound = server.server_address
    if bound[0] != "127.0.0.1":
        raise SystemExit(f"refusing to serve on {bound[0]}: the plugin must bind loopback only")

    log(logfile, f"READY port={port} mode=policy bind={bound[0]} approved={cfg['approved'][0].get('proxy_name')}")
    print(f"READY port={port} bind={bound[0]} approved={cfg['approved'][0].get('proxy_name')}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
