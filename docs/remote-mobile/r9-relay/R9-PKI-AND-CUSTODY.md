# R9 — PKI and Key Custody

**Phase:** R9-RELAY-02 (design + preparation)
**Authority:** `R9-TRANSPORT-ADR-v3.md` §5 (four distinct certificate identities) and §6 (revocation)
**Cardinal rule:** four identity roles, four independent keys. **No leaf key may serve two roles, and
no private CA may silently become a generic trust root for unrelated roles.**

## 1. Identity hierarchy

```text
R9 Android Client Issuer          (offline operator-held signing key)
  └── Android device leaf(s)      clientAuth EKU, per-device, ≤30 day target validity

R9 frpc Client Issuer             (offline operator-held signing key, DISTINCT)
  └── PC frpc leaf                clientAuth EKU — authenticates PC frpc → frps

R9 frps Server Issuer             (offline operator-held signing key, DISTINCT)
  └── VPS frps leaf               serverAuth EKU — validated by the PC with an exact expected name

Public CA (proposed: Let's Encrypt, DNS-01)
  └── HTTPS server leaf for R9_PUBLIC_HOST
                                  serverAuth EKU, private key stays on the PC
```

The **three private issuers must be separate**. They must not chain to one another, must not share a
signing key, and must not be used to issue for another role.

## 2. Role table

| Role | Leaf key location | Issuer key location | EKU | Target validity | Compromise blast radius |
| --- | --- | --- | --- | --- | --- |
| 1. Public HTTPS server | PC bridge host, bridge-only ACL | *not applicable* (public CA) | serverAuth | CA-defined (public CA) | Application-server impersonation to browsers where routing permits. No Android identity or tunnel credential follows. |
| 2. Android client | Android KeyChain, unique per device | offline operator storage | clientAuth | ≤30 days (design parameter) | mTLS admission, but protected operations still require R6. Lost phone may also hold the bearer: treat both as compromised. |
| 3. frpc tunnel client | PC frpc service ACL, separate from the bridge key | offline operator storage | clientAuth | proposed 30 days | Attack on tunnel *registration*, not decryption of application TLS by itself. |
| 4. frps tunnel server | VPS frps service ACL | offline operator storage | serverAuth | proposed 30 days | Tunnel-server impersonation. Browser TLS remains independent. |

## 3. Private CA custody rules

The three private issuer signing keys:

* **MUST NOT** reside on the VPS,
* **MUST NOT** reside inside Docker images,
* **MUST NOT** be copied into Android,
* **MUST NOT** be placed in the application repository,
* **MUST NOT** appear in evidence JSON, Markdown, or logs.

### Proposed operator-controlled storage

| Item | Proposed location |
| --- | --- |
| Issuer signing keys | offline encrypted volume or removable media, held by the operator |
| Encrypted backup | second offline location, distinct from the primary |
| Public certificates + fingerprints | repository-safe inventory (public material only) |
| Revocation/allowlist state | PC durable state directory, fail-closed on absence |

**No CA was generated in this phase.** Generating production issuers requires the operator to choose
and confirm the offline storage location first. The workflow is documented so it can be executed
deliberately rather than improvised.

## 4. Public HTTPS server key

| Property | Intended |
| --- | --- |
| Location | PC bridge host only |
| Bridge service identity | **READ** |
| Ordinary users | **NO READ** unless explicitly required |
| VPS | **NO COPY** |
| Docker image | **NO COPY** |

**No production HTTPS key was generated and no real public certificate was issued**, because no domain
exists. The prepared workflow is a CSR/template path, and no issuance success is fabricated anywhere.

## 5. Android client identity (production enrollment model)

| Requirement | Preparation |
| --- | --- |
| Unique key per device | required |
| Unique serial | required |
| `clientAuth` EKU | required |
| Device-specific active enrollment record | required |
| Fingerprint binding | required (SHA-256 over the certificate bytes as presented by Node `tls`) |
| Short-lived leaf | **30-day maximum treated as a design parameter**, not an operational fact |
| Install on phone now | **NOT DONE** — belongs to R9-RELAY-04 |

The 30-day figure comes from ADR-v3 §5 as a *proposal*. This document does not upgrade it to an
operational requirement; a later phase must show whether it is practical.

## 6. frpc and frps identities

**frpc leaf** — purpose *only* PC frpc → frps transport authentication. It must **not** reuse the
phone certificate, the Phone Bearer, or the HTTPS server certificate.

**frps leaf** — the PC/frpc must eventually validate **issuer, `serverAuth` EKU, expected name, and
validity**. `skip verification` / insecure verification is forbidden and appears nowhere in any
prepared configuration.

## 7. Dedicated frp application auth

frp's own auth material is an **additional** secret, separate from every TLS key.

| Property | Value |
| --- | --- |
| Reuses Phone Bearer | **no** |
| Reuses a TLS private key | **no** |
| Reuses a CA secret | **no** |
| Stored separately from all keys | yes |
| Secret value in any report | **no** |
| Evidence may record | `exists`, category, length class, and a hash where safe |

**No production frp auth value was generated in this phase.** Config templates carry the placeholder
`R9_FRP_AUTH_TOKEN`, and the local rehearsal used the fixture token
`r9-fixture-token-not-production`, which is already non-secret and appears only in fixture files.

## 8. Invalidity, expiry and fail-closed behaviour

* Expired credentials mean **remote access stops**. There is no expired-certificate fallback, no
  self-signed browser fallback, no HTTP fallback, and no verification skip.
* Missing or corrupt revocation state is **fail-closed** (inherited from the accepted R9-RELAY-01
  identity policy).
* Short validity is **defence in depth**, not immediate revocation; the primary control is the
  PC-local active allowlist + issuer/serial denylist + fingerprint binding.
* Failure to renew a private issuer closes remote access **without touching local R7**.

## 9. What was NOT done in this phase

| Not done | Why |
| --- | --- |
| Generating production private issuers | requires the operator's offline storage decision |
| Generating the production HTTPS key | no domain exists |
| Issuing a real public certificate | no domain, no ACME account |
| Installing anything on a phone | R9-RELAY-04 |
| Creating an ACME account or DNS token | requires provider/account access |
| Populating revocation state with real material | no phone certificate exists yet |
