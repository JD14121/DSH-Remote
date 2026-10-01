# R9 — FRP VPS Deployment, Runbooks and Rollback

**Phase:** R9-RELAY-02B — staged locally, **not deployed**.
**Nothing in this document has been applied to any VPS.** No VPS was contacted.

## 1. Proposed VPS filesystem layout

```text
/opt/r9-frp/bin/frps                        pinned v0.71.0 binary
/etc/r9-frp/frps.toml                       production config (from the staging package)
/etc/r9-frp/pki/frps-server.crt             frps server leaf certificate
/etc/r9-frp/pki/frps-server.key             frps server leaf private key  ← VPS-LOCAL ONLY
/etc/r9-frp/pki/frpc-client-ca.crt          FRP CLIENT CA public cert (verification anchor)
/etc/r9-frp/admission/admission-plugin.py   NewProxy admission service
/etc/r9-frp/admission/newproxy-policy.toml  admission policy
/etc/r9-frp/secrets/app-auth-token          dedicated FRP application auth secret
/var/lib/r9-frp/                            runtime state
/var/log/r9-frp/                            logs
```

### Explicitly ABSENT from the VPS

| Must never exist there | Why |
| --- | --- |
| FRP **Server CA** private key | offline operator custody |
| FRP **Client CA** private key | offline operator custody |
| **frpc** client private key | PC-side identity |
| **application HTTPS** private key (`https-server.key`) | the VPS does not terminate application TLS |
| Cloudflare DNS token | PC-only, which is what stops the VPS self-issuing |
| ACME account key | PC-only, same reason |
| Android CA private key | offline operator custody |
| Phone Bearer / DSH credential | unrelated to the relay |

## 2. Dedicated service identity

```text
user      : r9frp
login     : disabled (no interactive login, shell set to /usr/sbin/nologin)
ownership : /etc/r9-frp, /var/lib/r9-frp, /var/log/r9-frp readable by r9frp
privilege : frps does NOT run as root after initialization
```

Because frps binds TCP 443, the unit grants only `CAP_NET_BIND_SERVICE`. **No broader capability is
granted.** If the service is instead started behind a privileged port-forward, the capability can be
dropped entirely.

## 3. systemd units — STAGED, NOT DEPLOYED

> **Honesty note:** the local rehearsal environment is a container **without systemd**. These units
> have therefore been **statically reviewed only**. They are **not** claimed to be runtime-tested.
> Runtime validation under a real systemd host is a separate, future verification step.

### `r9-frp-admission.service`

```ini
[Unit]
Description=R9 FRP NewProxy admission policy service
After=network.target
Before=r9-frps.service

[Service]
Type=simple
User=r9frp
Group=r9frp
ExecStart=/usr/bin/python3 /etc/r9-frp/admission/admission-plugin.py \
          19100 /etc/r9-frp/admission/newproxy-policy.toml /var/log/r9-frp/plugin.log
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/r9-frp /var/lib/r9-frp
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
CapabilityBoundingSet=
AmbientCapabilities=
# The plugin listener is LOOPBACK ONLY; it never needs a network capability.
```

### `r9-frps.service`

```ini
[Unit]
Description=R9 FRP relay server (frps v0.71.0)
After=network.target r9-frp-admission.service
Requires=r9-frp-admission.service

[Service]
Type=simple
User=r9frp
Group=r9frp
ExecStart=/opt/r9-frp/bin/frps -c /etc/r9-frp/frps.toml
Restart=on-failure
RestartSec=3
# Only the capability needed to bind TCP 443. Nothing broader.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/r9-frp /var/lib/r9-frp
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
```

### Start ordering (§31) — enforced by `Requires=` + `After=`

```text
1. admission plugin healthy    (systemd starts r9-frp-admission first)
2. frps starts                 (Requires= the admission unit)
3. frpc connects
4. exactly one approved HTTPS proxy registers
```

If the admission unit fails, systemd does **not** start frps. There is no path by which frps runs
without admission control, and a plugin outage makes registration **fail closed** (proven locally).

## 4. Firewall plan — DOCUMENT ONLY, NOT APPLIED

```text
CURRENT  (verified):   inbound NONE
FUTURE R9-RELAY-03 candidate:   TCP 443, TCP 7000 — nothing else
```

**Never add:** `22`, `80`, `3080`, `3081`, `9445`, `9446`, the plugin port, or any dashboard/admin
port.

## 5. IPv6 policy

The intended deployment is **IPv4 only**.

* public DNS: **A record only** unless separately approved
* **no AAAA record** in R9-RELAY-03 unless separately authorized
* firewall staging must consider IPv4 **and** IPv6 explicitly rather than assuming one implies the
  other — a v6 rule left at default-allow would expose the relay even with a perfect v4 posture

**Resolved in Gate 3.4A.** This was previously an open question ("confirm the provider does not
implicitly dual-stack the bind"). It was answered by measurement, not assumption: binding `0.0.0.0`
produced a listener that also answered on **IPv6**, so `0.0.0.0` *does* create an IPv6 wildcard
listener in frp v0.71.0. Binding the explicit IPv4 anchor address creates **no IPv6 listener at all**.
That is now one of the reasons for the anchor binding in §6A.

## 6. DNS plan — DOCUMENT ONLY, NOT APPLIED

```text
relay.drm-jd.com   A   <existing DigitalOcean Reserved IPv4>   Cloudflare: DNS ONLY (grey cloud)
```

**No orange-cloud proxy.** Do **not** create AAAA, CNAME or wildcard records. The Reserved IPv4 is
deliberately not written into this document or the staging package.

**The A record must use the Reserved IPv4 reported by `/metadata/v1/reserved_ip/ipv4/ip_address`, and
`/metadata/v1/reserved_ip/ipv4/active` must be `true`.** If either check fails, **STOP**. The Droplet's
own public IPv4 must **not** be substituted as a fallback — it is not the Reserved IP and does not
survive a rebuild.

## 6A. Anchor-IP binding — MANDATORY NO-FALLBACK RULE

**Approved in R9-RELAY-03 Gate 3.4A.** `frps.toml` binds both listeners to the VPS **anchor IPv4**:

```toml
bindAddr = "10.15.0.5"
proxyBindAddr = "10.15.0.5"
```

Rationale: DigitalOcean directs that services reachable through a Reserved IP be bound to the anchor
IP, so the Droplet's public IPv4 cannot **bypass** the Reserved IP. Binding an explicit IPv4 also
removes the **IPv6 wildcard listener** that `0.0.0.0` creates — which matters because the host firewall
is default-ACCEPT and would not absorb that exposure.

### The rule

> **If the Reserved IPv4 cannot reach the anchor-bound frps, STOP IMMEDIATELY.**
>
> 1. **Keep DNS unpublished** — do not create or keep an A record.
> 2. **Close any inbound 443 and 7000 that were already opened** in the Cloud Firewall.
> 3. **Do NOT fall back to `0.0.0.0`.** There is no automatic fallback, and adding one is not permitted.
> 4. **Any fix must be re-submitted for human approval** before it is applied.

**Why there is no automatic fallback.** A fallback would silently convert a deliberate security
control — bind to the anchor so the public IPv4 cannot bypass the Reserved IP, and no IPv6 wildcard
listener exists — into a wildcard bind the moment anything went wrong. That is a security downgrade
triggered by an operational symptom, with no human decision in the loop. The failure must be **loud and
stopping**, not self-healing into a weaker posture.

### Diagnostic order when the Reserved IP does not reach frps

> **`curl -k` MUST NOT be used as an acceptance or TLS-trust test.** `-k` disables certificate
> verification, so a success proves only that *something* answered — it cannot distinguish the real
> relay from a wrong or substituted certificate. TCP/listener diagnostics and authenticated
> end-to-end verification are therefore kept **separate** below.

**Stage 1 — TCP reachability only (no TLS trust implied).**

```bash
# Does the port accept a TCP connection at all? This says nothing about identity or trust.
timeout 5 bash -c 'exec 3<>/dev/tcp/10.15.0.5/7000' && echo "TCP 7000 accepts" || echo "TCP 7000 refused"
timeout 5 bash -c 'exec 3<>/dev/tcp/146.190.192.173/443' && echo "TCP 443 accepts" || echo "TCP 443 refused"
```

**Stage 2 — listener/identity facts, locally on the VPS.**

```bash
journalctl -u r9-frps --no-pager | grep "listen on"
#   expect: "frps tcp listen on 10.15.0.5:7000"
#           "https service listen on 10.15.0.5:443"
ip -4 addr show | grep 10.15.0.5
```

**Stage 3 — authenticated end-to-end verification (the only acceptance test).**

This is the real test and it **verifies** the certificate; it does not bypass it. It uses the already
trusted `relay.drm-jd.com` certificate by overriding only DNS resolution for the target address:

```bash
# From the PC, with normal certificate verification ON (no -k, no --insecure).
curl --resolve relay.drm-jd.com:443:146.190.192.173 https://relay.drm-jd.com/ -v 2>&1 | head -30
```

**A failure here is a real failure.** Do not add `-k` to make it pass; that would convert a trust
failure into a false acceptance.

**Stage 4 — only if policy changes the rules, investigate, never weaken.**

```text
1. Confirm frps bound the anchor (Stage 2). If not, the config did not take effect.
2. Confirm the anchor IP exists on the host.
3. Confirm the Cloud Firewall permits the Reserved IP across ALL attached firewalls, IPv4 AND IPv6.
4. Only then conclude the Reserved-IP -> anchor mapping is not behaving as documented.
```

If stages 1–3 pass and the Reserved IP still does not reach frps, the mapping is the remaining suspect —
**and even then the escalation is a re-submitted proposal, not a wildcard bind and not a disabled
certificate check.**

## 7. Rollback runbook (§42)

Emergency rollback order:

```text
1. remove / disable the relay DNS A record
2. close public 443 and 7000 in the firewall
3. stop frps
4. stop frpc if required
5. investigate
6. rotate any compromised FRP credential(s)
7. redeploy only after explicit approval
```

**The application bridge remains loopback-only throughout.** Note the ordering subtlety: closing the
firewall is the *effective* control; removing DNS is convenience, because caches may still resolve.

## 8. Compromise runbooks (§43)

### frpc client-key compromise

```text
1. replace the frpc trust (re-issue the client leaf, or replace the client CA)
2. terminate the old control/work connection at frps
3. rotate the FRP application auth secret
4. Android identity untouched
```

### frps server-key compromise

```text
1. re-issue the frps server leaf
2. update the trust anchor / pinned name expectation on the PC
3. terminate old transport connections
4. rebuild frps on a clean image if compromise is suspected beyond the key
```

### FRP application auth secret compromise

```text
1. generate a new secret, install it on both sides
2. restart frps then frpc
3. confirm the old secret is rejected
```

### Admission-plugin compromise

```text
1. stop frps immediately (it has no authorization gate without the plugin)
2. rebuild the plugin from the pinned staging copy and verify its hash
3. review what proxies were admitted
4. restart plugin, then frps
```

### VPS compromise

```text
1. stop trusting the VPS tunnel server (remove/replace the frps trust on the PC)
2. rotate the frps identity and the FRP application auth secret
3. review DNS, CAA and Certificate Transparency
4. VERIFY the application HTTPS private key was never on the VPS
5. VERIFY the ACME account key and DNS credential were never on the VPS
6. rebuild the VPS from a clean image
7. do NOT restore compromised keys
```

**Explicitly:** a VPS compromise does **not** by itself disclose the application HTTPS private key, the
ACME account key, the Cloudflare token, the Android CA private key, the Phone Bearer, or DSH
credentials — **assuming the architecture remains as designed**. That assumption is exactly why the
staging package contains none of them.

## 9. Rotation procedures (§44) — PREPARED, NOT SCHEDULED

| Rotation | Procedure |
| --- | --- |
| frps server leaf | issue via the Server CA, install on VPS, restart frps, verify frpc reconnects |
| frpc client leaf | issue via the Client CA, install on PC, restart frpc |
| Server CA | issue a new CA, stage the new anchor on the PC **alongside** the old, re-issue the frps leaf, then remove the old anchor |
| Client CA | same approach on the frps side |
| FRP app-auth secret | generate a new 256-bit secret, install on both sides, restart both |

**No automated rotation is enabled in this phase**, and none is scheduled.

## 10. Private CA backup status (§45) — UPDATED after R9-RELAY-02B.1

**This section previously read "NOT PERFORMED". That is now stale and has been corrected.**

```text
FRP issuer private keys : local PC-only, ACL protected (Administrators / SYSTEM / operator)
offline backup          : PERFORMED — R9-RELAY-02B.1, ACCEPTED / CLOSED by R9-RELAY-02B.1A
backup medium           : VeraCrypt container r9-offline-backup.hc (the R9 offline USB)
backup location         : \FRP-ISSUER-CA\  (sibling of the pre-existing \R9-RECOVERY\)
backup contents         : FRP Server CA key+cert, FRP Client CA key+cert, recovery metadata (7 files)
private keys in backup  : exactly 2 — the two CA keys ONLY
NOT in the backup       : frpc leaf key, frps leaf key, FRP app-auth token, Cloudflare token,
                          ACME account key, application HTTPS key, Phone Bearer
integrity               : volume copy verified by read-back against the authoritative PKI on D:
current physical state  : DISCONNECTED — R: dismounted, F: ejected and physically disconnected
```

### Co-location risk — RECORDED AND OPERATOR-ACCEPTED

The ACME account recovery material (`R9-RECOVERY`) and the FRP issuer CA recovery material
(`FRP-ISSUER-CA`) live in **the same encrypted container**. **Folder separation is not cryptographic
separation**: they share one unlock boundary, so disclosure of the unlocked container exposes **both**
the ACME account trust domain and the FRP issuer trust domain at once. The container password is
therefore load-bearing for both.

**The operator explicitly accepted this arrangement** in R9-RELAY-02B.1A. It is recorded here so the
acceptance is auditable. If revisited, the mitigation is a **separate encrypted container** for the FRP
issuer material, so one unlock boundary covers one trust domain.

### What this means operationally

* The FRP issuer keys are **recoverable** — losing the PC no longer loses the ability to re-issue
  frps/frpc leaves.
* Restoring a CA key is only correct if the key is **lost, not compromised**. If a CA key is suspected
  compromised, do **not** restore it: create a new CA, re-issue the leaves, and retire the old one.
* The backup does **not** remove the need for rotation procedures in §9.

**Reconnecting the offline USB is not required for R9-RELAY-03 deployment** and should not be done as
part of it.

## 11. PC-side production paths (§36)

```text
D:\r9-relay-pki\frp\        FRP PKI (keys ACL-protected; public certs separable)
D:\r9-relay-secrets\frp\    FRP application auth secret
D:\r9-relay-secrets\https-server\   application HTTPS key/cert (R9-RELAY-02A.3)
D:\DSH-testing\dsh-remote-gateway\config\r9\   committed templates
```

frpc needs only: its client leaf/key, the frps Server CA certificate, the FRP app-auth secret, and its
config. It must **not** have access to the Cloudflare token, the ACME account key, the Android CA
private key, or any Phone Bearer store.
