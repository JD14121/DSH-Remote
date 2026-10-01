#!/bin/sh
# Probe: does this openssl 'enc' support AES-256-GCM with -K/-iv?
set -u
cd /w

echo "=== openssl version ==="
openssl version

echo "=== does enc list gcm? ==="
openssl enc -ciphers 2>/dev/null | grep -io 'aes-256-gcm' | head -3 || echo "(grep found none)"

echo "=== attempt a GCM encrypt ==="
printf 'hello gcm test payload\n' > /w/probe.plain
openssl enc -aes-256-gcm \
  -K 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f \
  -iv 000102030405060708090a0b \
  -in /w/probe.plain -out /w/probe.ct 2>/w/probe.err
echo "encrypt exit=$?"
cat /w/probe.err 2>/dev/null | head -5
echo "ciphertext bytes: $(wc -c < /w/probe.ct 2>/dev/null || echo 0)"

echo "=== tag file produced? ==="
ls -l /w/probe.ct.tag 2>/dev/null || echo "(no separate tag file)"

echo "=== attempt the GCM decrypt ==="
openssl enc -d -aes-256-gcm \
  -K 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f \
  -iv 000102030405060708090a0b \
  -in /w/probe.ct -out /w/probe.out 2>/w/probe.derr
echo "decrypt exit=$?"
cat /w/probe.derr 2>/dev/null | head -5
if cmp -s /w/probe.plain /w/probe.out 2>/dev/null; then echo "ROUNDTRIP=OK"; else echo "ROUNDTRIP=FAILED"; fi

rm -f /w/probe.plain /w/probe.ct /w/probe.out /w/probe.err /w/probe.derr /w/probe.ct.tag /w/test.ct
