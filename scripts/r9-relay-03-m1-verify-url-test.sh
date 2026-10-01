#!/usr/bin/env bash
# R9-RELAY-03 GATE 2B-M1 — negative and positive tests for the VPS URL verifier.
#
# Uses SYNTHETIC content that matches the URL SHAPE but is NOT a real URL and carries no signature
# value from any real credential. This exercises every code path of the verifier without generating
# a real presigned URL.
set -u

VERIFY=/tmp/verify-url.sh
WORK=$(mktemp -d)
PASS=0
FAIL=0
declare -a RESULTS

check() {
  # $1 label, $2 expected (PASS|FAIL), $3 actual exit code
  local label="$1" expect="$2" code="$3"
  local got="FAIL"
  [ "$code" -eq 0 ] && got="PASS"
  if [ "$got" = "$expect" ]; then
    PASS=$((PASS+1)); RESULTS+=("  [ok]   $label (expected $expect, got $got)")
  else
    FAIL=$((FAIL+1)); RESULTS+=("  [BAD]  $label (expected $expect, got $got)")
  fi
}

# A synthetic URL of the right SHAPE. Not a real URL; the signature is filler.
SYN="https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/r9-relay-gate2b-synthetic/t-0123456789abcdef0123456789abcdef/m1-nonexistent.probe?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKEKEY%2F20260923%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260923T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=SYNTHETIC-PLACEHOLDER-NOT-A-REAL-SIGNATURE-000000000000000000000000"
EXP_BYTES=$(printf '%s' "$SYN" | wc -c)
EXP_SHA=$(printf '%s' "$SYN" | sha256sum | cut -d' ' -f1)

echo "=== synthetic fixture (NOT a real URL) ==="
echo "  bytes: $EXP_BYTES"
echo "  sha  : $EXP_SHA"

run_case() {
  local label="$1" expect="$2"; shift 2
  M1_URL_FILE="$WORK/url.txt" bash "$VERIFY" "$@" > "$WORK/out.log" 2>&1
  check "$label" "$expect" $?
}

# ── POSITIVE ────────────────────────────────────────────────────────────────
printf '%s' "$SYN" > "$WORK/url.txt"
run_case "exact URL, no trailing newline" PASS "$EXP_BYTES" "$EXP_SHA"

printf '%s\n' "$SYN" > "$WORK/url.txt"
run_case "URL plus ONE trailing LF (editor-added)" PASS "$EXP_BYTES" "$EXP_SHA"

# ── NEGATIVES ───────────────────────────────────────────────────────────────
printf '%s\r\n' "$SYN" > "$WORK/url.txt"
run_case "CRLF line ending must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

printf '%s\n\n' "$SYN" > "$WORK/url.txt"
run_case "TWO trailing newlines must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

printf '%s\n%s\n' "$SYN" "extra" > "$WORK/url.txt"
run_case "interior newline must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

printf '%s \n' "$SYN" > "$WORK/url.txt"
run_case "trailing space must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

printf '%s\t\n' "$SYN" > "$WORK/url.txt"
run_case "tab character must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

printf '%s' "${SYN:0:40}" > "$WORK/url.txt"
run_case "truncated URL must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

printf '%s' "$SYN" | sed 's/AWS4-HMAC-SHA256/AWS4-HMAC-SHA257/' > "$WORK/url.txt"
run_case "corrupted character must be REJECTED (sha mismatch)" FAIL "$EXP_BYTES" "$EXP_SHA"

printf '%s' "$SYN" > "$WORK/url.txt"
run_case "wrong expected byte length must be REJECTED" FAIL "$((EXP_BYTES+1))" "$EXP_SHA"

printf '%s' "$SYN" > "$WORK/url.txt"
run_case "wrong expected sha must be REJECTED" FAIL "$EXP_BYTES" "0000000000000000000000000000000000000000000000000000000000000000"

printf 'ftp://example.invalid/x' > "$WORK/url.txt"
run_case "non-https scheme must be REJECTED" FAIL "$(printf 'ftp://example.invalid/x' | wc -c)" "$(printf 'ftp://example.invalid/x' | sha256sum | cut -d' ' -f1)"

# missing SigV4 parameter
printf '%s' "$SYN" | sed 's/&X-Amz-Expires=900//' > "$WORK/url.txt"
run_case "missing X-Amz-Expires must be REJECTED" FAIL "$(printf '%s' "$(cat "$WORK/url.txt")" | wc -c)" "$(cat "$WORK/url.txt" | sha256sum | cut -d' ' -f1)"

# empty file
: > "$WORK/url.txt"
run_case "empty file must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

# non-ASCII byte
printf '%s' "$SYN" > "$WORK/url.txt"; printf '\xc3\xa9' >> "$WORK/url.txt"
run_case "non-ASCII byte must be REJECTED" FAIL "$EXP_BYTES" "$EXP_SHA"

# ── report ─────────────────────────────────────────────────────────────────
echo ''
echo "=== results ==="
for r in "${RESULTS[@]}"; do echo "$r"; done
echo ''
echo "=== verifier tests: $PASS passed, $FAIL failed ==="

# Show the log of one rejection so the operator can see the message quality.
printf '%s\r\n' "$SYN" > "$WORK/url.txt"
M1_URL_FILE="$WORK/url.txt" bash "$VERIFY" "$EXP_BYTES" "$EXP_SHA" > "$WORK/sample.log" 2>&1
echo ''
echo "=== sample rejection output (CRLF case) ==="
sed 's/^/  /' "$WORK/sample.log"

rm -rf "$WORK"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
