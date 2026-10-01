#!/usr/bin/env bash
# R9-RELAY-03 GATE 2B-M1 - test the ACTUAL manual commands in vps/M1-VPS-BOOTSTRAP.md.
#
# The bootstrap tells the operator to TYPE specific single-line commands, so THOSE COMMANDS are the
# artifact under test. This harness EXTRACTS them from the markdown and executes them, rather than
# re-implementing similar-looking logic. If the document and this test ever disagree, the extraction
# fails loudly instead of silently testing something else.
#
# Fixtures are SYNTHETIC. No real URL, no R2 contact, no credential.
set -u

DOC="${1:-/tmp/M1-VPS-BOOTSTRAP.md}"
if [ ! -f "$DOC" ]; then echo "FATAL: bootstrap doc not found: $DOC" >&2; exit 2; fi

WORK=$(mktemp -d)
# The document's commands say `cd ~/m1`, so the test honours that EXACTLY: it sets HOME to a sandbox and
# creates ~/m1, then runs each extracted command verbatim. Running them in an unrelated temp directory
# would silently change their meaning -- an earlier harness did that and produced false results.
export HOME="$WORK"
mkdir -p "$HOME/m1"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  [PASS] $1"; }
bad() { FAIL=$((FAIL+1)); echo "  [FAIL] $1${2:+ - $2}"; }
M1DIR="$HOME/m1"

# ---------------------------------------------------------------------------
# EXTRACT commands from the markdown. Each bootstrap command is a single line
# inside a ```sh fenced block. We keep only the lines that look like the B3/B4
# commands, so a doc rewrite that changes them is detected here.
# ---------------------------------------------------------------------------
extract() {
  # $1 = a distinctive substring identifying the command to pull out
  awk -v needle="$1" '
    /^```sh$/ { infence=1; next }
    /^```$/   { infence=0; next }
    infence && index($0, needle) { print; exit }
  ' "$DOC"
}

echo "=== extracting commands from $(basename "$DOC") ==="
CMD_B3A=$(extract 'cr=$(tr -cd')
CMD_B3B=$(extract 'tail -c 1 url.txt')
CMD_B3C=$(extract 'head -c 8 norm.txt')
CMD_B4A=$(extract '--config /dev/fd/3')
CMD_B4B=$(extract "grep -o '<Code>")
CMD_B5=$(extract 'rmdir m1')

for pair in "B3a:$CMD_B3A" "B3b:$CMD_B3B" "B3c:$CMD_B3C" "B4a:$CMD_B4A" "B4b:$CMD_B4B" "B5:$CMD_B5"; do
  name=${pair%%:*}; body=${pair#*:}
  if [ -n "$body" ]; then ok "extracted $name command from the document"
  else bad "extracted $name command from the document" "not found - the doc may have been reworded"; fi
done

if [ -z "$CMD_B3A" ] || [ -z "$CMD_B3B" ] || [ -z "$CMD_B3C" ]; then
  echo ""; echo "Cannot continue without the B3 commands."; cd /; rm -rf "$WORK"; exit 1
fi

# A synthetic URL of the right SHAPE. Not a real URL; the signature is a placeholder.
SYN="https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/r9-relay-gate2b-synthetic/t-0123456789abcdef0123456789abcdef/m1-nonexistent.probe?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKEKEY%2F20260923%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260923T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=SYNTHETIC-PLACEHOLDER"


echo ""
echo "=== B3a: character screen (as written in the document) ==="
printf '%s' "$SYN" > "$M1DIR/url.txt"
EXP_BYTES=$(wc -c < "$M1DIR/url.txt")
OUT=$(eval "$CMD_B3A")
case "$OUT" in
  *"cr=0 sp=0 tab=0"*) ok "clean URL screens clean ($OUT)" ;;
  *) bad "clean URL screen" "$OUT" ;;
esac
case "$OUT" in
  *"bytes=$EXP_BYTES "*) ok "byte count reported correctly ($EXP_BYTES)" ;;
  *) bad "byte count in screen" "$OUT" ;;
esac

printf '%s\r\n' "$SYN" > "$M1DIR/url.txt"
OUT=$(eval "$CMD_B3A")
case "$OUT" in *"cr=1"*) ok "CR is detected" ;; *) bad "CR detection" "$OUT" ;; esac

printf '%s \n' "$SYN" > "$M1DIR/url.txt"
OUT=$(eval "$CMD_B3A")
case "$OUT" in *"sp=1"*) ok "a stray space is detected" ;; *) bad "space detection" "$OUT" ;; esac

# An interior newline must show up as an impossible byte count.
printf '%s\n%s\n' "$SYN" "extra" > "$M1DIR/url.txt"
OUT=$(eval "$CMD_B3A")
GOTB=$(echo "$OUT" | sed -n 's/^bytes=\([0-9]*\).*/\1/p')
if [ "$GOTB" -gt $((EXP_BYTES + 1)) ]; then ok "an interior newline yields an impossible byte count ($GOTB > $((EXP_BYTES+1)))"
else bad "interior newline not caught by byte count" "$OUT"; fi

echo ""
echo "=== B3b: normalisation (as written in the document) ==="
printf '%s' "$SYN" > "$M1DIR/url.txt"
EXP_SHA=$(sha256sum "$M1DIR/url.txt" | cut -d' ' -f1)
OUT=$(eval "$CMD_B3B")
GB=$(echo "$OUT" | sed -n 's/^bytes=//p'); GS=$(echo "$OUT" | tail -1)
[ "$GB" = "$EXP_BYTES" ] && ok "no trailing newline: bytes correct ($GB)" || bad "bytes" "$GB vs $EXP_BYTES"
[ "$GS" = "$EXP_SHA" ] && ok "no trailing newline: SHA-256 correct" || bad "sha" "$GS"

printf '%s\n' "$SYN" > "$M1DIR/url.txt"
OUT=$(eval "$CMD_B3B")
GB=$(echo "$OUT" | sed -n 's/^bytes=//p'); GS=$(echo "$OUT" | tail -1)
[ "$GB" = "$EXP_BYTES" ] && ok "one trailing LF: bytes unchanged ($GB)" || bad "LF bytes" "$GB vs $EXP_BYTES"
[ "$GS" = "$EXP_SHA" ] && ok "one trailing LF: SHA-256 unchanged" || bad "LF sha" "$GS"

printf '%s\n\n' "$SYN" > "$M1DIR/url.txt"
OUT=$(eval "$CMD_B3B")
GB=$(echo "$OUT" | sed -n 's/^bytes=//p')
[ "$GB" != "$EXP_BYTES" ] && ok "two trailing LFs do NOT match ($GB != $EXP_BYTES)" || bad "two LFs wrongly accepted"

echo ""
echo "=== B3c: shape checks (as written in the document) ==="
printf '%s' "$SYN" > "$M1DIR/norm.txt"
OUT=$(eval "$CMD_B3C")
# The command emits: "https://" (from `head -c 8` with no trailing newline), then `echo`'s newline, then
# the two grep counts. So the counts are on lines 2 and 3 -- an earlier harness read line 4, which is
# empty, and reported a false failure.
FIRST=$(echo "$OUT" | sed -n '1p')
[ "$FIRST" = "https://" ] && ok "scheme reads https://" || bad "scheme" "$FIRST"
SIG=$(echo "$OUT" | sed -n '2p'); HOST=$(echo "$OUT" | sed -n '3p')
[ "$SIG" = "1" ] && ok "signature parameter counted once" || bad "signature count" "$SIG"
[ "$HOST" = "1" ] && ok "R2 host counted once" || bad "host count" "$HOST"

echo ""
echo "=== B4a: the probe command keeps the URL OUT of argv ==="
# Assert the properties that matter, on the extracted text itself.
case "$CMD_B4A" in *'--max-redirs 0'*) ok "redirects are forbidden (--max-redirs 0)" ;; *) bad "no --max-redirs 0" ;; esac
case "$CMD_B4A" in *'-k'*) bad "the command contains -k (certificate verification disabled)" ;; *) ok "no -k: TLS verification preserved" ;; esac
case "$CMD_B4A" in *'--config'*) ok "the URL is supplied via --config, not argv" ;; *) bad "URL would land in argv" ;; esac
# The unsafely-substituted form must NOT appear.
case "$CMD_B4A" in *'curl -sS'*'"$(cat norm.txt)"'*) bad "URL is substituted directly into curl argv" ;; *) ok "no direct \"\$(cat ...)\" URL substitution in curl argv" ;; esac
# The NoSuchKey requirement lives in step B4b, which is executed below -- not in B4a.

echo ""
echo "=== B4b: the error-code check is executed on synthetic R2 bodies ==="
if [ -n "$CMD_B4B" ]; then
  # Synthetic R2-shaped responses. The command must find NoSuchKey in the good case and find nothing in
  # the inconclusive case -- which is what makes a bare 404 insufficient.
  printf '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>' > "$M1DIR/body.txt"
  OUT=$(eval "$CMD_B4B")
  [ "$OUT" = "<Code>NoSuchKey</Code>" ] && ok "B4b finds NoSuchKey in a valid 404 body" || bad "B4b on NoSuchKey body" "$OUT"

  printf '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' > "$M1DIR/body.txt"
  OUT=$(eval "$CMD_B4B")
  case "$OUT" in
    *NoSuchKey*) bad "B4b wrongly reported NoSuchKey for an AccessDenied body" "$OUT" ;;
    *) ok "B4b reports no NoSuchKey for an AccessDenied body (bare 404 is NOT a pass)" ;;
  esac

  printf '<html><body>404 Not Found</body></html>' > "$M1DIR/body.txt"
  OUT=$(eval "$CMD_B4B")
  [ -z "$OUT" ] && ok "B4b reports nothing for a non-S3 body" || bad "B4b on non-S3 body" "$OUT"
else
  bad "B4b command not extracted from the document"
fi

echo ""
echo "=== B5: cleanup command is well-formed and non-destructive to the session ==="
case "$CMD_B5" in *'exit'*) bad "cleanup calls exit (would close the console session)" ;; *) ok "cleanup does not call exit" ;; esac
case "$CMD_B5" in *'rm -f'*) ok "cleanup removes the working files with rm -f" ;; *) bad "cleanup does not remove files" ;; esac

echo ""
echo "=== no command in the document calls exit ==="
# An exit in a Recovery Console shell closes the session. No fenced bootstrap command may contain one.
EXITS=$(awk '/^```sh$/{f=1;next} /^```$/{f=0;next} f && /(^|[^a-z])exit([^a-z]|$)/ {print}' "$DOC" | wc -l)
[ "$EXITS" -eq 0 ] && ok "no fenced command calls exit" || bad "$EXITS fenced command(s) call exit"

echo ""
echo "=== the document does not rely on grep -c for line counting ==="
# `grep -c ''` counts LINES (1 without a trailing newline, 2 with one) and must not be used as a
# pass/fail check. `grep -c '<pattern>'` is a different thing entirely -- counting pattern occurrences --
# and B3c uses it legitimately, so only the empty-pattern idiom is flagged here.
FENCED_LINECOUNT=$(awk '/^```sh$/{f=1;next} /^```$/{f=0;next} f && /grep -c '"''"'/ {print}' "$DOC" | wc -l)
[ "$FENCED_LINECOUNT" -eq 0 ] && ok "no fenced command uses grep -c '' for line counting" || bad "$FENCED_LINECOUNT fenced command(s) still count lines with grep -c"
if grep -q 'counts lines' "$DOC" && grep -q 'does \*\*not\*\* use it' "$DOC"; then
  ok "the document explains the grep -c semantics and why it is not used"
else
  bad "the grep -c explanation is missing or unclear"
fi
if grep -q 'reports `1`' "$DOC" && grep -q 'reports `2`' "$DOC"; then
  ok "the document states both the 1 and 2 cases explicitly"
else
  bad "the document does not state the 1 and 2 cases explicitly"
fi

echo ""
echo "=== the document states shred is best-effort, not physical erasure ==="
if grep -qi 'cannot be guaranteed to erase' "$DOC"; then
  ok "shred limitation stated"
else
  bad "no statement that shred cannot guarantee physical erasure"
fi
if grep -qi 'PC' "$DOC" && grep -qi 'non-secret metadata only' "$DOC"; then
  ok "PC vs VPS disk behaviour distinguished"
else
  bad "PC/VPS disk behaviour not clearly distinguished"
fi

echo ""
echo "=== bootstrap command tests: $PASS passed, $FAIL failed ==="
cd /; rm -rf "$WORK"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
