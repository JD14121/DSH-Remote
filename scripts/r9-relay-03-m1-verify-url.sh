#!/bin/bash
# R9-RELAY-03 GATE 2B-M1 — VPS-side URL verification helper.
#
# Verifies that a pasted presigned URL survived the Recovery Console BYTE-EXACT, without ever printing
# the URL. Then optionally confirms R2 accepts the signature.
#
# NORMALISATION RULE (deliberately narrow)
#   Exactly ONE trailing LF is tolerated and stripped, because an editor appends one. Nothing else is
#   forgiven: CR, interior newlines, spaces, tabs, non-ASCII, or any other anomaly is a FAILURE.
#
# USAGE
#   bash r9-relay-03-m1-verify-url.sh <expected-bytes> <expected-sha256> [--probe]
#
#   expected-bytes   the "URL byte length" printed by the PC tool
#   expected-sha256  the "URL SHA-256" printed by the PC tool
#   --probe          additionally issue the HTTPS request to confirm R2 accepts the signature
#
# The URL is read from ~/m1/url.txt and is NEVER echoed.

set -u

URL_FILE="${M1_URL_FILE:-$HOME/m1/url.txt}"

if [ "$#" -lt 2 ]; then
  echo "usage: bash $0 <expected-bytes> <expected-sha256> [--probe]" >&2
  exit 2
fi

EXPECTED_BYTES="$1"
EXPECTED_SHA="$2"
PROBE=0
[ "${3:-}" = "--probe" ] && PROBE=1

fail() { echo "RESULT: FAIL - $1"; exit 1; }

if [ ! -s "$URL_FILE" ]; then
  fail "URL file is empty or missing: $URL_FILE"
fi

echo "=== M1 URL verification ==="
echo "  file            : $URL_FILE"

# ── 1. raw byte facts, without printing content ─────────────────────────────
RAW_BYTES=$(wc -c < "$URL_FILE")
RAW_LINES=$(grep -c '' "$URL_FILE" || true)
CR_COUNT=$(tr -cd '\r' < "$URL_FILE" | wc -c)
# Non-ASCII / control characters other than LF.
BAD_CHARS=$(LC_ALL=C tr -d '\11\12\15\40-\176' < "$URL_FILE" | wc -c)
TAB_COUNT=$(tr -cd '\t' < "$URL_FILE" | wc -c)
SPACE_COUNT=$(tr -cd ' ' < "$URL_FILE" | wc -c)

echo "  raw bytes       : $RAW_BYTES"
echo "  raw newlines    : $RAW_LINES"
echo "  CR characters   : $CR_COUNT"
echo "  tabs            : $TAB_COUNT"
echo "  spaces          : $SPACE_COUNT"
echo "  non-ASCII/ctrl  : $BAD_CHARS"

# ── 2. reject anything that is not exactly one URL line ─────────────────────
[ "$CR_COUNT" -eq 0 ] || fail "carriage returns present ($CR_COUNT) - the paste was mangled"
[ "$TAB_COUNT" -eq 0 ] || fail "tab characters present - the paste was mangled"
[ "$SPACE_COUNT" -eq 0 ] || fail "spaces present - a presigned URL contains none"
[ "$BAD_CHARS" -eq 0 ] || fail "non-ASCII or control characters present"
[ "$RAW_LINES" -le 2 ] || fail "file has $RAW_LINES lines; a single URL must be 1 line plus at most one trailing LF"

# ── 3. normalise: strip AT MOST one trailing LF ─────────────────────────────
# Byte-exact normalisation into a temp file, then hash the same bytes we measure.
NORM="$(mktemp)"
trap 'rm -f "$NORM"' EXIT
# Remove a single trailing LF if present; copy everything else unchanged.
if [ "$(tail -c 1 "$URL_FILE" | od -An -tx1 | tr -d ' \n')" = "0a" ]; then
  head -c $(( RAW_BYTES - 1 )) "$URL_FILE" > "$NORM"
else
  cat "$URL_FILE" > "$NORM"
fi

NORM_BYTES=$(wc -c < "$NORM")
NORM_LINES=$(grep -c '' "$NORM" || true)
NORM_SHA=$(sha256sum "$NORM" | cut -d' ' -f1)

echo "  --- after stripping at most one trailing LF ---"
echo "  normalised bytes: $NORM_BYTES"
echo "  normalised lines: $NORM_LINES"
echo "  normalised sha  : $NORM_SHA"
echo "  expected bytes  : $EXPECTED_BYTES"
echo "  expected sha    : $EXPECTED_SHA"

[ "$NORM_LINES" -eq 1 ] || fail "normalised content is not exactly one line"
[ "$NORM_BYTES" = "$EXPECTED_BYTES" ] || fail "byte length mismatch ($NORM_BYTES != $EXPECTED_BYTES)"
[ "$NORM_SHA" = "$EXPECTED_SHA" ] || fail "SHA-256 mismatch - the console did NOT preserve the URL byte-exact"

# ── 4. sanity: it must look like the expected endpoint, without revealing it ─
PREFIX=$(head -c 8 "$NORM")
if [ "$PREFIX" != "https://" ]; then
  fail "content does not begin with https://"
fi
HOST_OK=0
if grep -qE '^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com/' "$NORM"; then HOST_OK=1; fi
[ "$HOST_OK" -eq 1 ] || fail "URL is not an R2 cloudflarestorage.com presigned URL"
for p in X-Amz-Algorithm X-Amz-Credential X-Amz-Date X-Amz-Expires X-Amz-SignedHeaders X-Amz-Signature; do
  if ! grep -q "$p=" "$NORM"; then fail "missing SigV4 parameter $p"; fi
done
echo "  shape           : valid R2 presigned URL (host + 6 SigV4 parameters)"

echo "  BYTE-EXACT MATCH: YES"

# ── 5. optional probe: does R2 accept the signature? ───────────────────────
if [ "$PROBE" -eq 1 ]; then
  echo ''
  echo "=== R2 acceptance probe ==="
  echo "  requirements: certificate verification ON (no -k), redirects NOT followed, GET only"
  URL="$(cat "$NORM")"
  BODY_FILE="$(mktemp)"
  trap 'rm -f "$NORM" "$BODY_FILE"' EXIT

  # --fail-with-body is NOT used: a 404 is the expected SUCCESS signal and must not be swallowed.
  # -s silent, -S show errors, no -k, --max-redirs 0, -o body to a file, -w status only.
  STATUS=$(curl -sS --max-redirs 0 -o "$BODY_FILE" -w '%{http_code}' "$URL" 2>/dev/null) || true
  echo "  HTTP status     : $STATUS"

  if [ "$STATUS" = "404" ]; then
    # R2 returns an S3-style XML error body. Require NoSuchKey specifically: a bare 404 could also be
    # produced by a wrong host, so the error code is what proves the signature was accepted.
    if grep -q '<Code>NoSuchKey</Code>' "$BODY_FILE"; then
      echo "  R2 error code   : NoSuchKey"
      echo ''
      echo "RESULT: PASS - URL byte-exact AND R2 accepted the signature (404 NoSuchKey, object absent)"
      exit 0
    fi
    echo "  R2 error code   : (not NoSuchKey)"
    echo "  body excerpt    : $(head -c 200 "$BODY_FILE" | tr -d '\n' | sed 's/[^[:print:]]//g')"
    fail "HTTP 404 but the R2 error code is not NoSuchKey - inconclusive, treat as failure"
  fi

  if [ "$STATUS" = "403" ]; then
    echo "  R2 error code   : $(grep -o '<Code>[^<]*</Code>' "$BODY_FILE" | head -1)"
    fail "HTTP 403 - the signature was REJECTED (clock skew, wrong key, or corruption in transit)"
  fi

  if [ "$STATUS" = "200" ]; then
    fail "HTTP 200 - an object EXISTS at the probe key. STOP and investigate; M1 must not touch real data"
  fi

  fail "unexpected HTTP status $STATUS"
fi

echo ''
echo "RESULT: PASS - the console preserved the URL byte-exact (R2 acceptance not probed)"
