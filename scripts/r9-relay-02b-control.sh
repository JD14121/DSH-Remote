#!/bin/sh
# R9-RELAY-02B — container-side rehearsal control script.
#
# Runs INSIDE the rehearsal container. Kept as a real file so shell quoting is never mangled by the
# host shell. All configuration is rendered on the host and copied in beforehand.

set -u
WORK=/work
BIN=/r9/bin

start_topology() {
  pkill -f 'admission-plugin' 2>/dev/null || true
  pkill -f "$BIN/frps" 2>/dev/null || true
  pkill -f "$BIN/frpc" 2>/dev/null || true
  pkill -f 'origin.py' 2>/dev/null || true
  sleep 1
  rm -f "$WORK/plugin.log" "$WORK/frps.log" "$WORK/frps.out" "$WORK/origin.out"

  python3 "$WORK/admission-plugin.py" 9100 policy "$WORK/plugin.log" >"$WORK/plugin.out" 2>&1 &
  sleep 2
  python3 "$WORK/origin.py" >"$WORK/origin.out" 2>&1 &
  sleep 1
  "$BIN/frps" -c "$WORK/frps.toml" >"$WORK/frps.out" 2>&1 &
  sleep 4

  echo "LISTENERS:"
  netstat -ltn 2>/dev/null | awk '$4 ~ /:(7100|7443|9100|9444)$/ {print "  " $4}'
  echo "FRPS_LOG:"
  tail -5 "$WORK/frps.log" 2>/dev/null || echo "  (no frps log)"
  echo "PLUGIN_LOG:"
  tail -2 "$WORK/plugin.log" 2>/dev/null || echo "  (no plugin log)"
}

run_frpc() {
  # $1 = config file inside the container
  timeout 10 "$BIN/frpc" -c "$1" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | head -18
}

case "${1:-}" in
  start) start_topology ;;
  stop)
    pkill -f 'admission-plugin' 2>/dev/null || true
    pkill -f "$BIN/frps" 2>/dev/null || true
    pkill -f "$BIN/frpc" 2>/dev/null || true
    pkill -f 'origin.py' 2>/dev/null || true
    sleep 1
    echo "stopped"
    ;;
  frpc) run_frpc "$2" ;;
  log) tail -12 "$WORK/frps.log" 2>/dev/null || echo "(none)" ;;
  pluginlog) tail -12 "$WORK/plugin.log" 2>/dev/null || echo "(none)" ;;
  listeners) netstat -ltn 2>/dev/null | awk '$4 ~ /:(7100|7443|9100|9444)$/ {print "  " $4}' ;;
  originlog) tail -8 "$WORK/origin.out" 2>/dev/null || echo "(none)" ;;
  *) echo "usage: control.sh start|stop|frpc <cfg>|log|pluginlog|listeners|originlog" ;;
esac
