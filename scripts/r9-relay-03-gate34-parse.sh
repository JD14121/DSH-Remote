#!/bin/sh
# R9-RELAY-03 GATE 3.4 — does the ANCHORED production candidate parse under v0.71.0?
#
# Also runs a control: a deliberately broken TOML, to prove the parse check actually detects errors
# rather than reporting success unconditionally.
set -u
BIN=/r9/bin/frps

check() {
  label="$1"; file="$2"
  rm -f /tmp/p.log
  echo
  echo "=== $label ==="
  echo "  file: $file"
  # Show the bind-relevant first lines so a mangled file is visible.
  head -4 "$file" | sed 's/^/    | /'
  out=$(timeout 5 "$BIN" -c "$file" 2>&1)
  code=$?
  echo "  exit code: $code"
  parsed=YES
  case "$out" in
    *"toml:"*) parsed=NO ;;
    *"unknown field"*) parsed=NO ;;
    *"cannot unmarshal"*) parsed=NO ;;
  esac
  echo "  TOML parse error: $([ "$parsed" = NO ] && echo YES || echo NO)"
  if [ -n "$out" ]; then echo "  output:"; printf '%s\n' "$out" | head -3 | sed 's/^/    /'; fi
  if [ -f /tmp/p.log ]; then
    echo "  log:"; tail -3 /tmp/p.log | sed 's/.*\] //' | sed 's/^/    /'
  fi
  echo "  VERDICT: $([ "$parsed" = NO ] && echo PARSE-FAIL || echo CONFIG-ACCEPTED)"
}

# Control: a genuinely broken TOML file, to prove the check is not vacuous.
printf 'this is not = = valid toml\n' > /tmp/broken.toml
check "CONTROL — deliberately broken TOML (must report PARSE-FAIL)" /tmp/broken.toml

check "ANCHORED production candidate (10.15.0.5)" /tmp/anchored.toml

# Same field set but bound to a local address, to prove the accept is not just "fails to bind".
sed 's/10\.15\.0\.5/127.0.0.2/g; s|/etc/r9-frp|/pki|g; s|/etc/r9-frp/secrets/app-auth-token|/secrets/app-auth-token|g' \
  /tmp/anchored.toml > /tmp/anchored-local.toml
# Repair the paths the sed above cannot map cleanly, then re-point cert/key explicitly.
sed -i 's|/pki/pki/frps-server.crt|/pki/public/leaves/frps-server.crt|; s|/pki/pki/frps-server.key|/pki/keys/leaves/frps-server.key|; s|/pki/pki/frpc-client-ca.crt|/pki/public/client-ca/client-ca.crt|; s|log.to = "/var/log/r9-frp/frps.log"|log.to = "/tmp/p.log"|' /tmp/anchored-local.toml
check "SAME FIELDS bound to a local address (must bind successfully)" /tmp/anchored-local.toml

rm -f /tmp/broken.toml /tmp/anchored-local.toml /tmp/p.log
echo
echo DONE
