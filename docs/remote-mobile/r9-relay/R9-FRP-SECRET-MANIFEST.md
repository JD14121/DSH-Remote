# R9-RELAY-02B — VPS Secret Material Manifest

**Phase:** R9-RELAY-02B — staged locally, **not transferred, not deployed**.
**Purpose:** state exactly which secrets a future VPS deployment must inject, and — more importantly —
which it must never receive.

**§40 compliance:** no secret-transfer channel is invented or executed in this phase. No upload, no
email, no temporary public storage, no SSH/SCP, no secret-bearing cloud-init. The options in §5 below
are recorded for later human approval only.

## 1. Secrets the VPS MUST receive (4 items)

| # | Material | Source | Install path | How it is used |
| --- | --- | --- | --- | --- |
| 1 | **frps server leaf certificate** | FRP Server CA (offline) | `/etc/r9-frp/pki/frps-server.crt` | presented on the control transport |
| 2 | **frps server leaf private key** | FRP Server CA issuance | `/etc/r9-frp/pki/frps-server.key` | proves the frps identity to frpc |
| 3 | **FRP Client CA public certificate** | FRP Client CA (offline) | `/etc/r9-frp/pki/frpc-client-ca.crt` | verification anchor for client certificates |
| 4 | **FRP application auth secret** | PC-generated, 256-bit | `/etc/r9-frp/secrets/app-auth-token` | additional frp application authentication |

All four are **already staged or identified**; none has been transferred anywhere.

## 2. Material the VPS must NEVER receive (8 items)

| Material | Why it must not be there |
| --- | --- |
| FRP **Server CA** private key | offline operator custody; its presence would let the VPS mint server identities |
| FRP **Client CA** private key | offline operator custody; its presence would let the VPS mint client identities |
| **frpc** client private key | PC-side identity; the VPS must not be able to act as the PC |
| **application HTTPS** private key | the VPS passes application TLS through; holding the key would break the design |
| **Cloudflare DNS token** | PC-only — this is what prevents the VPS from self-issuing a certificate |
| **ACME account key** | PC-only — same reason |
| **Android CA private key** | offline operator custody |
| **Phone Bearer** | application credential; unrelated to the relay |

## 3. Non-secret package contents (already built and scanned)

The non-secret staging tree at `D:\r9-relay-staging` contains **only**:

```text
bin/frps                              pinned v0.71.0 binary (checksum-verified)
etc/frps.toml                         production config
admission/admission-plugin.py         NewProxy admission service
admission/newproxy-policy.toml        admission policy
pki/frpc-client-ca.crt                PUBLIC CA certificate (not a secret)
checksums/frp_sha256_checksums.txt    official release checksum manifest
```

A full secret-leak scan over every file found **no private keys, no tokens, and no credential values**,
and none of the forbidden secret filenames are present.

## 4. What is deliberately missing from the non-secret package

* `frps-server.key` — injected separately as a secret (§1 item 2)
* `app-auth-token` — injected separately as a secret (§1 item 4)
* every issuer private key
* the ACME account key, the Cloudflare token, the application HTTPS key
* the Reserved IPv4 address (it appears in no staged file)

## 5. Options for a future transfer channel — NOT EXECUTED

Recorded for later human approval. **None of these has been performed.**

| Option | Notes |
| --- | --- |
| Manual entry over an approved non-SSH management channel | consistent with the frozen NO-SSH rule; operator pastes each secret into a console session |
| Operator-mediated encrypted file transfer outside the repository | requires an agreed encryption method and a key the operator controls |
| Secrets generated **on** the VPS where feasible | strongest option, but the frps leaf must be signed by the offline Server CA, so at minimum the leaf must move |

**Explicitly rejected as options:** uploading secrets to any third-party storage, emailing them,
creating temporary public storage, or using SSH/SCP (frozen).

## 6. Staging manifest

A machine-readable manifest with a relative path, size, SHA-256 and role for every non-secret file is
recorded in the phase evidence.
