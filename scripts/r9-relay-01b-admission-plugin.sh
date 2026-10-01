#!/bin/sh
# R9-RELAY-01B — frps NewProxy admission plugin.
#
# Speaks the frp HTTP plugin protocol over loopback only. frps POSTs an operation to this endpoint and
# acts on the JSON body it gets back. The design is deliberately default-DENY: only the single
# approved fixture proxy is ever admitted, and any request this script cannot fully understand is
# rejected rather than allowed.
#
# Usage: r9-admission-plugin.sh [port] [logfile] [mode]
#   mode=record  log requests and refuse (protocol discovery)
#   mode=policy  log requests, apply the admission policy (default)
#
# Loopback only: the listener binds 127.0.0.1 inside the Linux environment.

PORT="${1:-9100}"
LOG="${2:-/root/r9frp/plugin.log}"
MODE="${3:-policy}"

# The single approved proxy definition. Anything else is denied.
APPROVED_NAME="r9-fixture-proxy"
APPROVED_TYPE="https"
APPROVED_DOMAIN="relay-fixture.invalid"

# Announce readiness so the harness can wait deterministically rather than sleeping.
echo "READY $PORT $MODE" >>"$LOG"

# A one-shot-per-connection HTTP handler driven by netcat.
#
# The response is written first and the request is logged afterwards. That ordering matters: frps
# blocks on this response, so any logging delay would stall frps, and a plugin that stalls is a
# plugin that could be treated as unavailable.
handle() {
  # Capture whatever arrives, with a bounded wait, then respond. busybox `nc -l` hands the request to
  # this handler on stdin; the raw bytes are recorded first so the protocol shape is auditable.
  #
  # `-w` on the nc side bounds the read, so a handler that never sees EOF cannot hang frps.
  body=$(cat)
  raw=$(printf '%s' "$body" | tr -d '\r')

  {
    echo "--- REQUEST $(date -u +%Y-%m-%dT%H:%M:%SZ) bytes=$(printf '%s' "$body" | wc -c) ---"
    printf '%s\n' "$raw"
    echo "--- END ---"
  } >>"$LOG" 2>/dev/null

  # The JSON body is the last line of a well-formed HTTP request; fall back to the whole capture.
  json=$(printf '%s\n' "$raw" | grep -o '{.*}' | tail -1)
  [ -z "$json" ] && json="$raw"

  decision=$(printf '%s' "$json" | MODE="$MODE" \
    APPROVED_NAME="$APPROVED_NAME" APPROVED_TYPE="$APPROVED_TYPE" APPROVED_DOMAIN="$APPROVED_DOMAIN" \
    awk '
    function fail(reason) { printf "{\"reject\":true,\"reject_reason\":\"%s\"}", reason; exit }
    function ok()        { printf "{\"unchange\":true}"; exit }
    function field(name,   pattern, line) {
      pattern = "\"" name "\"[[:space:]]*:[[:space:]]*\""
      if (match($0, pattern)) {
        line = substr($0, RSTART + RLENGTH)
        if (match(line, /^[^"]*/)) return substr(line, 1, RLENGTH)
      }
      return ""
    }
    {
      flat = $0
      gsub(/\n/, "", flat)
      op = field("operation")
      if (op != "NewProxy") { ok() }
      if (flat !~ /"content"/) fail("NewProxy content missing")
      ptype = field("type")
      pname = field("proxy_name")
      sub   = field("subdomain")
      domains = ""
      if (match(flat, /"custom_domains"[[:space:]]*:[[:space:]]*\[[^]]*\]/)) {
        domains = substr(flat, RSTART, RLENGTH)
      }
      inner = domains
      sub(/^[^[]*\[/, "", inner)
      sub(/\][^]]*$/, "", inner)
      count = 0
      n = split(inner, parts, ",")
      for (i = 1; i <= n; i++) {
        d = parts[i]
        gsub(/[ \t"]/, "", d)
        if (d != "") count++
      }
      if (ENVIRON["MODE"] == "record") fail("record-mode-always-rejects")
      if (pname != ENVIRON["APPROVED_NAME"])            fail("proxy name not approved")
      if (ptype != ENVIRON["APPROVED_TYPE"])            fail("proxy type not approved")
      if (sub != "")                                    fail("subdomain must be empty")
      if (count != 1)                                   fail("exactly one custom domain is required")
      d = inner
      gsub(/[ \t"]/, "", d)
      if (d != ENVIRON["APPROVED_DOMAIN"])              fail("custom domain not approved")
      ok()
    }
    ')

  if [ -z "$decision" ]; then
    decision='{"reject":true,"reject_reason":"plugin produced no decision"}'
  fi

  len=$(printf '%s' "$decision" | wc -c | tr -d ' ')
  {
    printf 'HTTP/1.1 200 OK\r\n'
    printf 'Content-Type: application/json\r\n'
    printf 'Content-Length: %s\r\n' "$len"
    printf 'Connection: close\r\n'
    printf '\r\n'
    printf '%s' "$decision"
  }
}

  # An empty decision must never be read as approval.
  if [ -z "$decision" ]; then
    decision='{"reject":true,"reject_reason":"plugin produced no decision"}'
  fi

  len=$(printf '%s' "$decision" | wc -c | tr -d ' ')
  {
    printf 'HTTP/1.1 200 OK\r\n'
    printf 'Content-Type: application/json\r\n'
    printf 'Content-Length: %s\r\n' "$len"
    printf 'Connection: close\r\n'
    printf '\r\n'
    printf '%s' "$decision"
  }
}

# One connection per listener instance.
#
# busybox `nc -l -p PORT` reads the request from the socket and writes its stdin to the socket, but it
# only flushes on EOF, which loses a response written by a handler that exits immediately. `-w 3` keeps
# the socket open long enough for the response to be written out. No socat or ncat exists on this
# image, so this is the available mechanism.
while true; do
  nc -l -p "$PORT" -s 127.0.0.1 -w 3 | handle 2>/dev/null
done
