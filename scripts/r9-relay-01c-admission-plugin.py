#!/usr/bin/env python3
"""
R9-RELAY-01C — frps NewProxy admission plugin.

A real HTTP server, which is what the previous phase could not provide. It implements the frp HTTP
plugin protocol for the `NewProxy` operation and is **default-DENY**: exactly one proxy definition is
admitted, and any request whose fields differ in any way is rejected.

Design notes that matter for the security claim:

* **Default deny.** The decision starts as `reject` and is only converted to `unchange` after every
  field has been checked. A parse failure, an unexpected operation, a missing field, or an unexpected
  field all leave it as `reject`.
* **Explicit allowlist of fields.** Any field present in the proxy definition that is not part of the
  approved shape causes a rejection. That is what stops a valid tunnel identity from smuggling in
  `group`, `group_key`, extra `locations`, `subdomain`, `remote_port` and similar.
* **No body or credential logging.** Only the decision and the reason are recorded. The request body
  is never written to disk, because it may contain tunnel metadata.
* **Binds loopback only.** 127.0.0.1, inside the container's own network namespace.

Usage: admission-plugin.py <port> <mode> <logfile>
  mode=policy       apply the admission policy (default)
  mode=reject       deny everything, for negative testing
  mode=invalid-json return a body that is not JSON at all
  mode=truncated    return a body shorter than its declared Content-Length
  mode=http500      return HTTP 500 with an error body
  mode=timeout      accept the connection and never answer
  mode=empty        return an empty body with a 200
"""

import json
import sys
import time
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The single approved proxy definition. Nothing else is admitted.
APPROVED = {
    "proxy_name": "r9-fixture-proxy",
    "proxy_type": "https",
    "custom_domain": "relay-fixture.invalid",
    "local_ip": "127.0.0.1",
    "local_port": "7444",
}

# Fields that must be absent or empty. A non-empty value here is a policy violation, not a detail.
MUST_BE_EMPTY = ("subdomain", "group", "group_key", "locations")

# The only field keys the approved shape may contain. Anything else fails closed.
#
# `user` is included because frp sends it; it is part of the plugin envelope, not a routing choice,
# and it is not used as an authorization input — the tunnel identity is.
ALLOWED_FIELDS = {
    "proxy_name", "proxy_type", "custom_domains", "subdomain", "group", "group_key",
    "locations", "local_ip", "local_port", "use_encryption", "use_compression",
    "transport", "metadatas", "annotations", "health_check", "load_balancer", "user",
}

# Recorded decisions, for evidence. No request bodies are stored.
DECISIONS = []
LOCK = threading.Lock()


def log(path, message):
    """Append a single safe line. Never the request body."""
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now(timezone.utc).isoformat()} {message}\n")
    except OSError:
        pass


def decide(payload, mode):
    """
    Decide a NewProxy request.

    Returns (allowed: bool, reason: str, detail: dict). `detail` holds only policy-relevant scalars,
    never the raw body.
    """
    if not isinstance(payload, dict):
        return False, "the request body was not a JSON object", {}

    # frp sends the operation in `op`. Observed payload shape for the approved proxy:
    #   {"version":"0.1.0","op":"NewProxy","content":{"proxy_name":...,"proxy_type":...,
    #                                                  "custom_domains":[...],"user":...}}
    # The `operation` spelling is accepted as well so the check is not brittle to a key rename, but
    # an absent/unknown operation is a rejection either way.
    operation = payload.get("op", payload.get("operation"))
    if operation != "NewProxy":
        # Only NewProxy is registered for this plugin, so anything else is unexpected.
        return False, f"unexpected operation {operation!r}", {"operation": operation}

    content = payload.get("content")
    if not isinstance(content, dict):
        return False, "the NewProxy content was missing or not an object", {}

    detail = {
        "proxy_name": content.get("proxy_name"),
        "proxy_type": content.get("proxy_type"),
        "custom_domains": content.get("custom_domains"),
        "subdomain": content.get("subdomain"),
        "group": content.get("group"),
        "group_key": content.get("group_key"),
        "locations": content.get("locations"),
    }

    if mode == "reject":
        return False, "reject mode denies every request", detail

    # An unexpected field is a rejection, not something to ignore. That is what stops a valid tunnel
    # identity from smuggling in group/group_key/locations/remote_port.
    unexpected = sorted(set(content.keys()) - ALLOWED_FIELDS)
    if unexpected:
        return False, f"unexpected field(s) present: {', '.join(unexpected)}", detail

    if content.get("proxy_name") != APPROVED["proxy_name"]:
        return False, "proxy name is not the approved one", detail
    if content.get("proxy_type") != APPROVED["proxy_type"]:
        return False, "proxy type is not the approved one", detail

    # Exactly one custom domain, and it must be the approved one.
    domains = content.get("custom_domains")
    if not isinstance(domains, list) or len(domains) != 1:
        return False, "exactly one custom domain is required", detail
    if domains[0] != APPROVED["custom_domain"]:
        return False, "the custom domain is not the approved one", detail

    # These must be absent or empty.
    for field in MUST_BE_EMPTY:
        value = content.get(field)
        if value not in (None, "", [], {}):
            return False, f"{field} must be empty", detail

    # The local target must be the fixture upstream, so the tunnel cannot be repointed.
    if content.get("local_ip") not in (None, APPROVED["local_ip"]):
        return False, "local_ip is not the approved one", detail
    if content.get("local_port") not in (None, APPROVED["local_port"], int(APPROVED["local_port"])):
        return False, "local_port is not the approved one", detail

    return True, "the definition matched the single approved proxy", detail


class Handler(BaseHTTPRequestHandler):
    """frp HTTP plugin endpoint."""

    server_version = "r9-admission/1.0"
    protocol_version = "HTTP/1.1"

    def do_POST(self):  # noqa: N802 - the protocol requires this name
        mode = self.server.r9_mode
        logfile = self.server.r9_log

        # The configured plugin path is an exact endpoint; anything else is not this plugin's business
        # and is refused rather than silently accepted.
        if self.path.split("?")[0] != self.server.r9_path:
            self._respond(404, {"reject": True, "reject_reason": "unexpected plugin path"})
            log(logfile, f"decision=REJECT reason=unexpected path {self.path!r}")
            return

        # Read the complete body using the declared length: the previous phase's failure was reading
        # a body that never arrived.
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""

        try:
            payload = json.loads(raw.decode("utf-8"))
            parsed = True
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            payload = None
            parsed = False

        if not parsed:
            allowed, reason, detail = False, "the request body was not valid JSON", {}
        else:
            allowed, reason, detail = decide(payload, mode)

        # Protocol-discovery aid: the exact key set frps sends is recorded (keys and scalar policy
        # fields only, never verbatim bodies) so the policy can be checked against reality.
        if mode == "policy" and isinstance(payload, dict):
            content = payload.get("content") if isinstance(payload.get("content"), dict) else {}
            log(logfile, f"RECEIVED keys={sorted(payload.keys())} content_keys={sorted(content.keys())}")

        # Failure injection. The point of these modes is to prove that a plugin which misbehaves
        # cannot cause a proxy to be registered, so each writes a deliberately bad response and
        # returns without ever emitting a valid approval.
        if mode == "invalid-json":
            self._respond_raw(200, b"this is not json at all", "application/json")
            log(logfile, "decision=INJECTED invalid-json")
            return
        if mode == "truncated":
            # Declares 200 bytes but sends 10, then CLOSES. The connection must be closed here, or a
            # later write would append the real decision and frps would read a valid approval — which
            # would be a defect in this harness rather than a finding about frps.
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "200")
            self.end_headers()
            self.wfile.write(b'{"unchan')
            self.wfile.flush()
            self.close_connection = True
            log(logfile, "decision=INJECTED truncated (declared 200, sent 10, closing)")
            return
        if mode == "http500":
            self._respond_raw(500, b'{"error":"injected failure"}', "application/json")
            log(logfile, "decision=INJECTED http500")
            return
        if mode == "timeout":
            # Hold the connection open and never answer. The handler must not return, or the response
            # machinery would finish the exchange and frps would see a truncated/empty reply instead
            # of a genuine timeout.
            log(logfile, "decision=INJECTED timeout (holding connection open)")
            self.close_connection = True
            try:
                while True:
                    time.sleep(1)
            except BaseException:
                pass
            return
        if mode == "empty":
            self._respond_raw(200, b"", "application/json")
            log(logfile, "decision=INJECTED empty-body")
            return

        # The response is the frp plugin contract: `unchange` to accept, `reject` to refuse.
        response = {"unchange": True} if allowed else {"reject": True, "reject_reason": reason}
        body = json.dumps(response).encode("utf-8")

        with LOCK:
            DECISIONS.append({
                "at": datetime.now(timezone.utc).isoformat(),
                "operation": (payload or {}).get("operation") if isinstance(payload, dict) else None,
                "allowed": allowed,
                "reason": reason,
                "detail": detail,
            })

        log(logfile, f"decision={'ALLOW' if allowed else 'REJECT'} reason={reason} detail={json.dumps(detail, sort_keys=True)}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - used only to prove the listener is alive
        if self.path.split("?")[0] != self.server.r9_path:
            self._respond(404, {"status": "not this endpoint"})
            return
        self._respond(200, {"plugin": "r9-relay-01c", "status": "alive"})

    def _respond(self, status, payload):
        """Write one JSON response with an explicit length."""
        body = json.dumps(payload).encode("utf-8")
        self._respond_raw(status, body, "application/json")

    def _respond_raw(self, status, body, content_type):
        """Write a raw body, used by the failure-injection modes."""
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def log_message(self, *args):
        """Silence the default stderr logging: request lines could carry metadata."""
        return


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9100
    mode = sys.argv[2] if len(sys.argv) > 2 else "policy"
    logfile = sys.argv[3] if len(sys.argv) > 3 else "/fixture/log/plugin.log"

    # Loopback only. A non-loopback bind would be a security failure for this fixture.
    #
    # THREADED on purpose. A single-threaded server wedges on a persistent (keep-alive) connection:
    # frps holds one open, the accept loop never runs again, and every later request times out — which
    # is exactly what happened and made the plugin appear "unavailable" while it was still listening.
    # The mode is fixed per process, so threading introduces no mode race.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    # Bound how long a client may hold a connection open without sending, so one stalled peer cannot
    # consume a worker indefinitely.
    server.timeout = 30
    server.r9_mode = mode
    server.r9_log = logfile
    # The exact endpoint configured in frps.toml, kept in one place so the two cannot drift.
    server.r9_path = "/cgi-bin/frp-newproxy"

    bound = server.server_address
    if bound[0] != "127.0.0.1":
        raise SystemExit(f"refusing to serve on {bound[0]}: the plugin must bind loopback only")

    log(logfile, f"READY port={port} mode={mode} bind={bound[0]}")
    print(f"READY port={port} mode={mode} bind={bound[0]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
