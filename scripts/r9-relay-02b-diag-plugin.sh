#!/bin/sh
# Diagnose the admission plugin startup. Kept as a file: the awk/kill one-liner is mangled by the
# host shell when passed through docker exec.
for p in $(ps -eo pid,args 2>/dev/null | awk '/admission-plugin/ && !/awk/ {print $1}'); do
  kill "$p" 2>/dev/null || true
done
sleep 1
echo "=== foreground run ==="
python3 /work/admission-plugin.py 9100 /work/policy.toml /work/plugin.log 2>&1 | head -15
echo "=== exit ==="
