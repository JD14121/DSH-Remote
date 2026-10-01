# R9 — Certificate Renewal Runbook

**Status:** the procedure and script are **prepared**. The schedule is **NOT enabled**.
Enabling automatic renewal requires separate human authorisation.

## Why this exists

The R9 HTTPS server certificate for `relay.drm-jd.com` is a **90-day Let's Encrypt certificate**. It
must be renewed before expiry. Because the deployment is designed to fail closed, an expired
certificate simply **stops remote access** — it does not fall back to a self-signed or HTTP path.

## The renewal path

`lego run` **is** the renewal path in lego v5. The old standalone `renew` command was removed; renewal
controls are flags on `run`. Running it again for the same domain is safe and idempotent: lego checks
the stored certificate and only reissues when it is actually due.

```powershell
node D:\DSH-testing\dsh-remote-gateway\scripts\r9-relay-02a3-renew.mjs
```

The script refuses to do anything until it has confirmed:

* `--ipv4only` reasoning still holds (this host has no IPv6 route, which previously caused lego's own
  propagation check to fail against Cloudflare's IPv6 nameserver),
* a renewed certificate actually came back before it touches the deployment copies.

### What it will NOT do

| Never | Why |
| --- | --- |
| `--renew-force` routinely | forces reissuance even when not due; only for a deliberate early rotation |
| `--http` / `--tls` | DNS-01 only — no inbound listener is ever opened for validation |
| open port 80 or 443 locally | DNS-01 needs no inbound listener at all |
| register a new account | it reuses the existing account in `D:\r9-relay-acme` |
| touch the VPS | the ACME account key and DNS credential stay on the PC, by design |
| restart the operator DSH or supervised DSH | R7 lifecycle is independently authoritative |

## Renewal workflow

```text
1. check days remaining (scripts/r9-relay-02a3-cert-info.mjs)
2. if due, run the renewal script
3. lego obtains a fresh certificate via DNS-01 using the protected Cloudflare token
4. lego removes the _acme-challenge TXT record
5. the script copies the renewed key + chain into D:\r9-relay-secrets\https-server
   using a temp-file + rename, so the swap is atomic
6. the R9 bridge is restarted so it reloads the certificate
7. verify with the cert-info script
```

## Credential handling

The Cloudflare token is read from the ACL-protected file
`D:\r9-relay-secrets\cloudflare-dns-token` into a **process-scoped** environment variable on the lego
child process only. It is never set as a permanent User or System variable, never printed, and never
written to logs or evidence. (lego v5.3.1 has no `*_FILE` mechanism for this provider — verified in
R9-RELAY-02A.2B.)

## Monitoring

```powershell
node D:\DSH-testing\dsh-remote-gateway\scripts\r9-relay-02a3-cert-info.mjs
```

Reports subject/SAN, issuer, serial, validity, days remaining, renewal threshold and the certificate
SPKI fingerprint. It reads **only** the public certificate — never the private key — so it is safe to
run at any time. Exit code 2 means renewal is due.

**Suggested (not yet enabled) cadence:** daily monitoring; renewal triggers automatically once days
remaining falls to one third of the lifetime (30 days for this 90-day certificate).

## Failure handling

If renewal fails:

* the **existing certificate is left untouched** — the script only overwrites after a successful run,
* remote access continues until the existing certificate expires,
* **do not** disable verification, weaken TLS, or widen validity windows to work around a failure,
* investigate: token validity, DNS zone access, CAA state, and clock synchronisation.

## Explicitly NOT done in R9-RELAY-02A.3

* No Task Scheduler entry was created.
* No Windows service or background daemon was installed.
* No automatic renewal was enabled.
