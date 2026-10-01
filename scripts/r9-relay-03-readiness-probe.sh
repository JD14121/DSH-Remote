#!/bin/sh
# R9-RELAY-03 — admission readiness probe.
#
# Used by r9-frp-readiness.service (ExecStart) AND by r9-frps.service (ExecStartPre). Keeping it in one
# script means "ready" has exactly one definition, so the gate and the ordering check cannot drift.
#
# The plugin holds no state and has no side effects, so two small startup + steady-state probes are safe
# and cannot register a proxy. The probe is deliberately a GET: only POST carries a NewProxy request.
#
# Exit 0 only when the plugin answers correctly on loopback. Any other outcome exits non-zero, which
# makes the dependent unit fail closed rather than start without admission control.
set -u

ADDR="${R9_ADMISSION_ADDR:-127.0.0.1:19100}"
PATH_="${R9_ADMISSION_PATH:-/cgi-bin/frp-newproxy}"
RETRIES="${R9_READINESS_RETRIES:-30}"
SLEEP="${R9_READINESS_SLEEP:-1}"
i=0

while [ "$i" -lt "$RETRIES" ]; do
  # Bound each attempt so a hung plugin cannot stall the unit past systemd's own timeout.
  body=$(timeout 3 python3 - "$ADDR" "$PATH_" <<'PY' 2>/dev/null
import sys, urllib.request
addr, path = sys.argv[1], sys.argv[2]
try:
    with urllib.request.urlopen(f"http://{addr}{path}", timeout=2) as r:
        sys.stdout.write(r.read(200).decode("utf-8", "replace"))
except Exception:
    sys.exit(1)
PY
)
  rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"alive"'; then
    echo "admission plugin ready on ${ADDR}${PATH_}"
    exit 0
  fi
  i=$((i + 1))
  sleep "$SLEEP"
done

echo "admission plugin NOT ready after ${RETRIES} attempts on ${ADDR}${PATH_}" >&2
exit 1
