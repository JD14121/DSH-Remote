#!/bin/sh
# R9-RELAY-02B — restart the admission plugin with the production policy.
#
# Kept as a file because `pkill -f admission-plugin` inside a `docker exec sh -c '...'` command
# matches that command's OWN command line and kills the shell before anything runs.
set -u
WORK=/work

# Kill only the python process running the plugin, matched by its full argument list.
for pid in $(ps -eo pid,args 2>/dev/null | awk '/python3 \/work\/admission-plugin/ && !/awk/ {print $1}'); do
  kill "$pid" 2>/dev/null || true
done
sleep 1

rm -f "$WORK/perr.txt" "$WORK/plugin.log"
nohup python3 "$WORK/admission-plugin.py" 9100 "$WORK/policy.toml" "$WORK/plugin.log" >"$WORK/perr.txt" 2>&1 &
sleep 3

echo "--- plugin stdout/stderr ---"
cat "$WORK/perr.txt" 2>/dev/null || echo "(empty)"
echo "--- plugin log ---"
cat "$WORK/plugin.log" 2>/dev/null || echo "(none)"
echo "--- listening on 9100? ---"
netstat -ltn 2>/dev/null | awk '$4 ~ /:9100$/ {print "  " $4}' || true
