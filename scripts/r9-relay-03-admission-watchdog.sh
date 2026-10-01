#!/bin/sh
# R9-RELAY-03 — admission watchdog.
#
# WHY THIS EXISTS. Measured behaviour of frp v0.71.0 (Gate 3.4A review):
#
#   * with the plugin UNREACHABLE, frps starts anyway and DENIES proxy registration (fail-closed);
#   * with the plugin KILLED mid-flight, frps KEEPS RUNNING and still denies registration.
#
# So frps fails closed at the PROXY level but does NOT stop itself when it loses admission control. It
# keeps its control listener (7000) and HTTPS vhost (443) open while being unable to authorize anything.
#
# Consequently a systemd dependency is the only thing that tears the service down. `Requires=` is NOT
# sufficient: it does not stop frps when the plugin later dies. This watchdog makes the failure
# actionable — it polls readiness and runs `systemctl stop r9-frps` the moment the plugin stops
# answering, so 443/7000 close instead of lingering without authorization.
#
# The watchdog is bound to r9-frp-admission.service, so it also goes away when the plugin does.
set -u

ADDR="${R9_ADMISSION_ADDR:-127.0.0.1:19100}"
PATH_="${R9_ADMISSION_PATH:-/cgi-bin/frp-newproxy}"
INTERVAL="${R9_WATCHDOG_INTERVAL:-5}"
FAILS_BEFORE_STOP="${R9_WATCHDOG_FAILS:-2}"
consecutive=0

log() {
  # journald captures stdout for a simple service; systemd-cat is not required.
  echo "[r9-frp-watchdog] $*"
}

stop_frps() {
  log "admission plugin unresponsive; stopping r9-frps to close 443/7000 (fail-closed)"
  systemctl stop r9-frps.service
  # Exit non-zero so the unit is recorded as failed rather than as a clean stop.
  exit 1
}

log "watching ${ADDR}${PATH_} every ${INTERVAL}s (stop after ${FAILS_BEFORE_STOP} consecutive failures)"

while true; do
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
    consecutive=0
  else
    consecutive=$((consecutive + 1))
    log "admission plugin probe failed (${consecutive}/${FAILS_BEFORE_STOP})"
    if [ "$consecutive" -ge "$FAILS_BEFORE_STOP" ]; then
      stop_frps
    fi
  fi

  sleep "$INTERVAL"
done
