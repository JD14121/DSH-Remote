# R9-RELAY-03 — Operator Console Guide (Gates 2–5)

**Companion to:** `PHASE-R9-RELAY-03-REPORT.md`
**Channel:** DigitalOcean **Recovery Console** — **not** the SSH-based Droplet Console.
**Rule for every gate below:** DSH prepares the commands and checks sanitized results. The operator
executes and pastes back **output only** — never a secret value.

---

## Recorded environment (operator-supplied)

```text
DROPLET_NAME        r9-relay-01
REGION              sgp1
RESERVED_IPV4       146.190.192.173
DROPLET_PUBLIC_IPV4 68.183.180.39
```

### Pre-exposure baseline DSH measured from the PC (before any change)

| Address | 22 | 80 | 443 | 7000 | 19100 |
| --- | --- | --- | --- | --- | --- |
| `68.183.180.39` (Droplet public) | filtered | filtered | filtered | filtered | filtered |
| `146.190.192.173` (Reserved) | filtered | filtered | filtered | filtered | filtered |

**Every probed port is filtered on both addresses.** This is the "before" state and it is recorded so a
later success cannot be mistaken for "it was already open".

### ⚠ Open question that Gate 3 MUST settle: which address gets the A record?

The Reserved IPv4 and the Droplet's public IPv4 are **different values**. Pointing DNS at the wrong one
would fail. **Do not create the DNS record until Step 3.2 below settles this.**

---

## GATE 2 — console and delivery feasibility (NO SECRETS)

First prove the console can carry text reliably. **Do not transfer any secret during this test.**

Run these in the Recovery Console and paste back the output:

```bash
# 1. console login works and we can run commands
id
uname -a

# 2. ordinary non-secret paste/entry test
echo "R9-CONSOLE-PASTE-TEST-OK"

# 3. a short payload with a KNOWN sha256, to prove copy/paste preserves bytes exactly
printf 'r9-console-transfer-probe-0123456789\n' > /tmp/r9probe.txt
sha256sum /tmp/r9probe.txt
wc -c /tmp/r9probe.txt
```

**Expected value:**

```text
sha256 of the exact bytes "r9-console-transfer-probe-0123456789\n" (37 bytes)
= 96152cd1bf18e03068cc86ad424358dca68f752e237d9af180e886ac9c1c5b8b
```

DSH computed this digest independently. **If the console prints anything else, the console mangled the
bytes** — STOP and pick another non-SSH method.

### 2B. REALISTIC-SIZE paste test — MANDATORY before any real secret transfer

> The 37-byte probe above proves the console preserves **a few bytes**. It does **not** prove a
> multi-kilobyte paste survives. A real secret bundle is ~2.7 KB → **~3.6 KB of base64 in 47 lines**,
> and console paste fails specifically at that size: line wrapping, dropped or duplicated newlines, CR
> injection, or truncation by a paste buffer limit.
>
> **This test must pass before any production secret is transferred.** It uses a **non-secret** payload
> of the exact shape and size of a real bundle.

**Step 1 — DSH gives you two things:**

```text
payload.b64        the 3,611-character base64 blob (47 lines) — paste this
EXPECTED.json      the expected counts and hashes
```

```text
payload bytes     : 2672
payload sha256    : 083b9971d6bbf203fab522b5d09ec6d7e846eb5dd0a74704787502df71efe2a8
base64            : 3611 chars, 47 lines, width 76
contains secrets  : NO
```

**Step 2 — on the VPS, open an editor and paste the whole blob:**

```bash
mkdir -p ~/r9paste && cd ~/r9paste
vi paste.b64        # press i, paste all 47 lines, then Esc :wq
grep -c . paste.b64 # expect 47
```

**Step 3 — run the verifier (DSH provides `verify-paste.sh`):**

```bash
sh verify-paste.sh
```

**Step 4 — the required result:**

```text
RESULT: PASS - multi-kilobyte paste survived byte-exact
```

**If it reports FAIL, stop.** The channel cannot be trusted for secrets at this size, and the correct
response is another non-SSH method — **not** a larger paste attempt and **not** enabling SSH.

DSH has validated the verifier against four negative controls, so a PASS is meaningful:

| Control | Expected |
| --- | --- |
| truncated paste (30 of 47 lines) | **FAIL** — line-count mismatch |
| CR-injected (CRLF) paste | **PASS** — normalised with `tr -d '\r'` |
| corrupted content | **FAIL** — hash mismatch |
| empty paste | **FAIL** — empty/missing |

### The encrypted delivery procedure (validated locally, 11/11)

This exact construction was validated end to end with throwaway material before being proposed. Two
earlier approaches were **rejected on evidence**, not assumption:

| Approach | Outcome |
| --- | --- |
| X25519 via `pkeyutl -encrypt` | **unsupported** — openssl cannot encrypt to an X25519 key |
| AES-256-GCM via `openssl enc` | **unsupported** — this openssl reports `enc: AEAD ciphers not supported` |
| an intermediate GCM draft | **discarded** — it used a fixed IV, a genuine vulnerability |

**Accepted construction:**

```text
RSA-3072 OAEP(SHA-256)  wraps a one-time random 256-bit key
AES-256-CBC             encrypts the payload with a RANDOM 16-byte IV
HMAC-SHA256             encrypt-then-MAC over (IV || ciphertext), MAC key derived via HKDF
```

Only `openssl` is needed — nothing to install on Ubuntu 24.04.

### Step A — on the VPS: generate the receiving keypair

```bash
umask 077
mkdir -p ~/r9recv && cd ~/r9recv
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out recv.key
chmod 600 recv.key
openssl pkey -in recv.key -pubout -out recv.pub
sha256sum recv.pub          # paste THIS back — the public key is not a secret
cat recv.pub                # paste the whole PEM block back too
```

The **private** key (`recv.key`) never leaves the VPS and is never pasted anywhere.

### Step B — on the PC: DSH encrypts the Gate-4 bundle to that public key

DSH performs this locally and gives you a single base64 text blob plus its SHA-256.

### Step C — on the VPS: decode, verify the MAC, decrypt, verify hashes

```bash
cd ~/r9recv
# Paste the base64 blob into a file using the console editor, then:
tr -d '\r' < bundle.b64 | base64 -d > rx.enc
sha256sum rx.enc            # must equal the ciphertext sha256 DSH gives you
```

Then run the unframe/decrypt commands DSH provides, which **check the HMAC before trusting any
plaintext**. A tampered or truncated payload fails the MAC and decryption is abandoned.

### Step D — cleanup (best effort, and documented as best effort)

```bash
shred -u rx.enc 2>/dev/null || rm -f rx.enc
shred -u recv.key 2>/dev/null || rm -f recv.key
```

> **Honest limitation:** `shred` is **best-effort only**. On a copy-on-write or journaled filesystem
> the original blocks may persist. This is the strongest available guarantee without full-disk
> encryption, and it is recorded as a limitation rather than a promise.

---

## GATE 3 — VPS baseline (still NO public ports)

### 3.1 System identity

```bash
cat /etc/os-release | head -3          # expect Ubuntu 24.04
uname -m                               # expect x86_64
nproc; free -m | head -2; df -h / | tail -1
timedatectl | head -4                  # clock synchronised?
```

### 3.2 Droplet identity — and settling the DNS target (CORRECTED)

> **Correction.** An earlier revision of this guide treated
> `.../interfaces/public/0/anchor_ipv4/address` as the Reserved IPv4 and proposed a
> "whichever public IP completes the handshake wins" rule for the A record. **Both were wrong.**
> DigitalOcean defines the anchor IP and the Reserved IP as **different** things, and exposes the
> Reserved IP through **dedicated endpoints**. Verified against the official documentation:
> [Reserved IPs metadata reference](https://docs.digitalocean.com/reference/api/metadata/reserved-ips/)
> and [Find Droplet Anchor IPs](https://docs.digitalocean.com/products/networking/reserved-ips/how-to/find-anchor-ips/).

```bash
# What the host itself sees bound to its interfaces
ip -4 addr show scope global | grep inet

# Droplet's OWN public IPv4 — NOT the DNS target
curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address; echo

# Anchor address — internal mapping address for the Reserved IP.
# NOT the DNS target. Relevant only to the bind decision below.
curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/address; echo

# Is a Reserved IP actually ASSIGNED to this Droplet? (true/false)
curl -s http://169.254.169.254/metadata/v1/reserved_ip/ipv4/active; echo

# The Reserved IPv4 actually assigned to this Droplet — THIS is the DNS target
curl -s http://169.254.169.254/metadata/v1/reserved_ip/ipv4/ip_address; echo

curl -s http://169.254.169.254/metadata/v1/region; echo
```

**Paste back all six values plus the `ip -4 addr` lines.**

Per the official reference, `/metadata/v1/reserved_ip/ipv4/` indexes exactly two attributes —
`active` and `ip_address`. `active` reports whether a Reserved IP is currently assigned to the
Droplet; `ip_address` is that Reserved IPv4.

### Gate 9 decision rule — FIXED, with no fallback

```text
reserved_ip/ipv4/active      == "true"
AND
reserved_ip/ipv4/ip_address  == "146.190.192.173"
        |
        v
relay.drm-jd.com A  =  146.190.192.173
```

**If either condition fails → STOP.**

**`68.183.180.39` must NOT be used as the DNS target.** The previous "whichever address can handshake
wins" rule is **deleted** — it would have pointed DNS at the Droplet's public IPv4, which is not the
Reserved IP and does not survive a rebuild.

Both addresses may still be **diagnosed** in Gate 8 — probing both is how a stray exposure gets
detected — but **diagnosis is not selection**.

### ⚠ Newly identified: bind target vs anchor IP

The same documentation states:

> *"An anchor IP is only accessible to the Droplet it belongs to and the reserved IP assigned to the
> Droplet. You should bind any public services that you want to make highly available through a
> reserved IP to **the anchor IP** to prevent users from using the public IP addresses of your Droplets
> to bypass your reserved IP."*

This is a **real design question for R9**, and it is **not yet decided**:

| Option | Consequence |
| --- | --- |
| bind `0.0.0.0` (current template) | serves the Reserved IP **and** the Droplet public IPv4 — which the docs call a documented **bypass** of the Reserved IP |
| bind the **anchor IP** | only the Reserved IP is served; the Droplet public IPv4 cannot be used to bypass it |

The production template currently has `bindAddr = "0.0.0.0"` / `proxyBindAddr = "0.0.0.0"`. **I am
flagging this rather than silently changing the frozen template.** The decision needs the actual anchor
IP from the command above and it changes the effective attack surface, so it is recorded as an
explicit, operator-visible choice **before** the firewall opens.

### 3.3 No unexpected public listeners, and host firewall state

```bash
ss -tulpn                                  # what is listening, on which addresses
sudo ufw status verbose 2>/dev/null || echo "ufw not active/installed"
sudo iptables -S 2>/dev/null | head -20
sudo nft list ruleset 2>/dev/null | head -30 || echo "no nftables ruleset"
```

**Require:** nothing listening publicly except the expected base services, and **no permits for public
22/80/admin ports** beyond what already exists for droplet management.

### 3.4 Fetch and verify the pinned frps

```bash
cd /tmp
curl -fsSLO https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_amd64.tar.gz
sha256sum frp_0.71.0_linux_amd64.tar.gz
```

**Expected:**

```text
84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716
```

**If this does not match, STOP.** Do not proceed with an unverified binary.

### 3.5 Service identity and staging (no public ports yet)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin r9frp
id r9frp

sudo mkdir -p /opt/r9-frp/bin /etc/r9-frp/{pki,admission,secrets} /var/lib/r9-frp /var/log/r9-frp
sudo tar -xzf /tmp/frp_0.71.0_linux_amd64.tar.gz -C /tmp
sudo install -m 0755 /tmp/frp_0.71.0_linux_amd64/frps /opt/r9-frp/bin/frps
/opt/r9-frp/bin/frps --version        # must print 0.71.0
sudo chown -R r9frp:r9frp /var/lib/r9-frp /var/log/r9-frp
```

Then stage `frps.toml`, `admission/admission-plugin.py`, `admission/newproxy-policy.toml` from the
non-secret package DSH provides, with DSH-supplied hashes to verify each one.

**Do not open public ports in this gate.**

---

## GATE 4 — VPS secret delivery (only after Gate 2 passes)

The VPS may receive **only** these four items:

```text
/etc/r9-frp/pki/frps-server.crt        frps server leaf certificate
/etc/r9-frp/pki/frps-server.key        frps server leaf private key
/etc/r9-frp/pki/frpc-client-ca.crt     FRP Client CA PUBLIC certificate
/etc/r9-frp/secrets/app-auth-token     FRP application auth secret
```

**It must never receive:** Server CA or Client CA private keys, the frpc client private key, the
application HTTPS private key, the ACME account private key, the Cloudflare token, the Android CA
private key, or any Phone Bearer / DSH credential.

### Permissions

```bash
sudo chown root:r9frp /etc/r9-frp/pki/frps-server.key /etc/r9-frp/secrets/app-auth-token
sudo chmod 0640 /etc/r9-frp/pki/frps-server.key /etc/r9-frp/secrets/app-auth-token
sudo chmod 0644 /etc/r9-frp/pki/frps-server.crt /etc/r9-frp/pki/frpc-client-ca.crt
sudo chown -R r9frp:r9frp /etc/r9-frp/admission
sudo chmod 0755 /etc/r9-frp/admission
ls -l /etc/r9-frp/pki /etc/r9-frp/secrets
```

### Verify pairing and fingerprints (no secret values printed)

```bash
# The server key must match its own certificate
sudo openssl x509 -in /etc/r9-frp/pki/frps-server.crt -pubkey -noout \
  | openssl pkey -pubin -outform DER | sha256sum
sudo openssl pkey -in /etc/r9-frp/pki/frps-server.key -pubout -outform DER | sha256sum
```

Both must print the **same** SPKI fingerprint. DSH checks it against
`5f97fcaee48b7b1fe07fbf1cac86ac99aac0700472a3f6a844435945e8a0b7af`.

Also verify the **release** identity: the certificate SAN must be `r9-frps-control.internal` and the
public hostname `relay.drm-jd.com` must **not** appear as the FRP transport identity.

**Never** paste the private key or the app-auth token into the console, a report, or a screenshot.
Where a hash is needed:

```bash
sha256sum /etc/r9-frp/secrets/app-auth-token     # hash only, never the value
```

---

## GATE 5 — VPS local acceptance (Cloud Firewall inbound still NONE)

### 5.1 Plugin first, loopback only

```bash
sudo -u r9frp python3 /etc/r9-frp/admission/admission-plugin.py \
  19100 /etc/r9-frp/admission/newproxy-policy.toml /var/log/r9-frp/plugin.log &
sleep 2
ss -tlnp | grep 19100        # MUST be 127.0.0.1:19100, never 0.0.0.0
curl -s http://127.0.0.1:19100/cgi-bin/frp-newproxy
```

**Require:** the listener is **`127.0.0.1:19100`**. If it binds `0.0.0.0`, **STOP** — the plugin would
be publicly reachable.

### 5.2 Fail-closed proof — MOVED, not deleted

> **Correction.** An earlier revision placed the fail-closed proof here, while Cloud Firewall inbound
> is still `NONE`. **That test cannot work at this point**, and running it would produce a false PASS.
>
> The real `frpc` runs on the PC and must reach the VPS over **public TCP 7000**. With inbound `NONE`
> the connection never arrives, so "no proxy became active" would only prove **the network was
> closed** — not that NewProxy admission fails closed. The two are indistinguishable from the result.
>
> **This proof now runs as Gate 7B**, after TCP 7000 is opened to the PC. See the re-sequenced gate
> order at the top of this guide.

What *can* be verified here, locally on the VPS with no inbound:

```bash
# The plugin must refuse to start with no approved proxy, and must refuse on an empty allowed_fields.
# These are startup guards and need no network.
sudo -u r9frp python3 /etc/r9-frp/admission/admission-plugin.py 19100 /tmp/empty-policy.toml /tmp/p.log
# expect a refusal and a non-zero exit — NOT a listening service
```

That is a **local configuration guard**, and it is **not** a substitute for the Gate 7B fail-closed
proof against a real control connection. Both are required; neither alone is sufficient.

### 5.3 frps under systemd

```bash
sudo systemctl start r9-frp-admission
sudo systemctl status r9-frp-admission --no-pager | head -12
sudo systemctl start r9-frps
sudo systemctl status r9-frps --no-pager | head -12
```

Then prove **restart and fail-closed ordering**:

```bash
sudo systemctl stop r9-frp-admission
sudo systemctl status r9-frps --no-pager | head -6    # must NOT be running without the plugin
sudo systemctl start r9-frp-admission
```

### 5.4 Only the intended listeners

```bash
sudo ss -tlnp | grep -E ':(443|7000|19100)\b'
```

**Require:** `443` and `7000` on frps, `19100` on **loopback only** — **and nothing else new.**

### 5.5 No public access yet

```bash
sudo iptables -S | grep -i drop | head
```

With Cloud Firewall inbound still `NONE`, external reachability must fail. DSH will verify this from
the PC.

---

## GATE 7A — open TCP 7000 ONLY (still no 443, still no DNS)

**Operator action, after Gate 5A passes.** Add **one** inbound rule and nothing else:

```text
Protocol : TCP
Port     : 7000
Source   : <PC public egress IPv4>/32      <-- strongly preferred
```

Get the PC's current public egress IP (DSH supplies this; it is not a secret). **Prefer the /32
restriction.** If it is not operationally feasible:

> TCP 7000 then has a **broader attack surface** and must remain protected by **mandatory transport
> mTLS plus FRP app auth**. That fact must be **documented explicitly**, not glossed over.

**Leave TCP 443 closed. Leave DNS absent.**

### Check EVERY firewall attached to the Droplet

Not just the one named `R9`. A Droplet can have more than one Cloud Firewall, and host-level rules may
also exist.

```bash
sudo iptables -S; sudo nft list ruleset 2>/dev/null | head -40
sudo ufw status verbose 2>/dev/null || true
```

DSH verifies from the PC that **7000 is reachable and 443 is still not**.

---

## GATE 7B — the fail-closed proof, now actually testable

This is the proof Gate 5.2 **could not** perform. With TCP 7000 open and the real frpc on the PC, the
control connection can genuinely reach frps, so a failure to register means the **admission policy**
refused it — not that the network was down.

**7B.1 — plugin UP: the approved proxy must register.**

```bash
sudo systemctl start r9-frp-admission
# DSH starts the real frpc production identity from the PC
```

**Require:** `login to server success` **and** `start proxy success` **and** exactly one proxy active.

**7B.2 — plugin DOWN: the control channel may connect, but registration MUST FAIL.**

```bash
sudo systemctl stop r9-frp-admission
# DSH re-runs the same frpc from the PC
```

**Require:**

* the frpc **control connection may still be established** (that is expected — frps accepts the tunnel), **but**
* the proxy **MUST NOT become active**, and
* frps **must not** admit the proxy by falling back to allow.

If the proxy registers with the plugin down, that is a **fail-open defect**: **STOP**, do not open 443,
do not create DNS, and do not weaken anything to proceed.

```bash
# On the VPS, confirm no proxy is registered while the plugin is down
sudo journalctl -u r9-frps --no-pager | tail -30
sudo systemctl start r9-frp-admission      # restore the approved state
```

**Restore the approved identity/config after the negative test before continuing.**

---

## GATE 7C — only now open TCP 443

After 7B passes, add **one** more inbound rule:

```text
Protocol : TCP
Port     : 443
```

**Still no DNS record.** Gate 8 tests the Reserved IPv4 directly with an explicit SNI override.

---

## Re-sequenced gate order (authoritative)

This ordering replaced the original one, because the original could not prove fail-closed.

```text
Gate 5A   VPS local: systemd, listeners, plugin, local guards
          Cloud Firewall inbound still NONE
             |
             v  PASS
Gate 7A   open TCP 7000 ONLY (prefer Source = PC egress /32)
          443 still CLOSED, DNS still ABSENT
             |
             v
          real production frpc connects from the PC
             |
             v
Gate 7B   plugin UP   -> approved proxy registers
          plugin DOWN -> control connection may exist,
                         proxy registration MUST FAIL
             |
             v  PASS
Gate 7C   open TCP 443
             |
             v
Gate 8    public synthetic HTTPS testing against the Reserved IPv4
             |
             v  PASS
Gate 9    create the A record  (Reserved IPv4 from metadata, per the fixed rule)
```

The benefit over the original order: the fail-closed property is proven against a **real, reachable
control channel**, and no public application listener exists while that proof is being made.

---

## What DSH needs from you to start

| Input | Status |
| --- | --- |
| Droplet name / region | **received** — `r9-relay-01` / `sgp1` |
| Reserved IPv4 | **received** — `146.190.192.173` (to be **confirmed** via the metadata endpoints) |
| Droplet public IPv4 | **received** — `68.183.180.39` (**not** a DNS target) |
| Gate 2 + Gate 3.1/3.2 console output | **needed next** |
| Anchor IP value | **needed** — decides the bind question in §3.2 |

Do **not** send the VeraCrypt password, the app-auth token, or any private key.
