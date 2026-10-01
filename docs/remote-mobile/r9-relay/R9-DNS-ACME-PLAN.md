# R9 — DNS and ACME Plan

**Phase:** R9-RELAY-02 (design + preparation)
**Status:** `PREPARED_NOT_APPLIED`. No DNS record, no CAA record, no ACME account and no certificate
exists. Nothing here is claimed to be active.

## 1. The central security assumption

> **The VPS must not be capable of independently obtaining the browser-facing certificate simply
> because it controls public 443.**

This is a core ADR-v3 assumption. It is the reason issuance is **DNS-01 controlled from the PC** and
not HTTP-01 from the VPS: whoever can answer an HTTP-01 challenge on port 80 for the name can obtain
a certificate for it. A DNS-01 flow with the credential held only on the PC denies the VPS that
capability.

```text
PC                                  DNS provider                    Public CA
──                                  ────────────                    ─────────
ACME account key (PC only)
generate key + CSR
create order  ─────────────────────────────────────────────────────▶
receive dns-01 challenge
write _acme-challenge TXT ─────────▶ (least-privilege token)
                                    ◀─────────────────────────────── validate
receive certificate ◀───────────────────────────────────────────────
remove challenge record ───────────▶
store cert on PC
atomic bridge reload

VPS:  NO DNS credential, NO ACME account key, NO issuance capability
```

## 2. Credential separation

| Component | Holds | Must NOT hold |
| --- | --- | --- |
| PC | ACME account key, certificate private key, DNS challenge credential | — |
| DNS provider | the zone, temporary challenge records | — |
| VPS | frps config and its own frps key only | DNS credential, ACME account key, HTTPS private key |

## 3. Public CA proposal

| Field | Value |
| --- | --- |
| CA | **Let's Encrypt** (proposal; ADR-v3 §5) |
| Challenge type | **DNS-01 only** |
| HTTP-01 | **forbidden** — the VPS must not be able to obtain a certificate |
| TLS-ALPN-01 | **forbidden** |
| Wildcard certificate | **forbidden** |

## 4. CAA templates — `PREPARED_NOT_APPLIED`

Templates only. These records are **not** published, and no claim is made that they are enforced.
`R9_PUBLIC_HOST` is a placeholder; the real name must not be invented.

```dns
; Restrict issuance to the approved CA.
R9_PUBLIC_HOST.  CAA 0 issue "letsencrypt.org"

; Restrict issuance to the DNS-01 method where the CA supports it.
R9_PUBLIC_HOST.  CAA 0 issuewild ";"

; Deny wildcard issuance outright.
R9_PUBLIC_HOST.  CAA 0 issuewild ";"

; Restrict the ACME account where the CA supports account binding
; (accounturi is the ACME account URL once it exists).
R9_PUBLIC_HOST.  CAA 0 issue "letsencrypt.org; accounturi=<ACME_ACCOUNT_URI>"

; Optional: report policy violations.
R9_PUBLIC_HOST.  CAA 0 iodef "mailto:<OPERATOR_SECURITY_CONTACT>"
```

**Honest limitation:** CAA `issuewild ";"` denies wildcard issuance. Method restriction via
`validationmethods=dns-01` is **not** universally supported by every CA — this must be confirmed
against the chosen CA's documentation before it is relied upon, and it is recorded here as an
assumption to verify rather than a fact. `accounturi` binding likewise requires CA support.

## 5. Issuance workflow (PC-driven)

1. PC validates its clock.
2. PC generates a new private key and CSR for `R9_PUBLIC_HOST`.
3. PC creates the ACME order.
4. CA returns a DNS-01 challenge.
5. PC writes the temporary `_acme-challenge` TXT record using the least-privilege token.
6. CA validates the record.
7. PC stores the certificate on the PC under bridge-only ACL.
8. PC removes the challenge record.
9. Bridge atomically reloads the certificate.

**No HTTP-01. No TLS-ALPN-01. No wildcard.**

## 6. ACME account custody

| Item | Rule |
| --- | --- |
| Account key location | PC only, operator-controlled path |
| On VPS | **forbidden** |
| In repository | **forbidden** |
| In Docker image | **forbidden** |
| Creation procedure | documented; **not executed** (no CA account) |
| Backup/recovery | encrypted operator backup, offline |
| Rotation | documented procedure; rotate on suspicion or CA policy change |
| Incident response | revoke/replace the account, re-issue, review CT logs |

## 7. DNS credential custody

If a DNS API token is later used, it must be **least privilege**:

| Requirement | Rule |
| --- | --- |
| Scope | minimum record/zone permission necessary to write `_acme-challenge` only |
| Registrar account password | **never** used as an API credential |
| Broad account-admin token | **forbidden** |
| Creation in this phase | **NOT DONE** — requires provider/account and operator action |

### Proposed permission matrix

| Permission | Needed | Note |
| --- | --- | --- |
| Read zone | yes | to confirm the record landed |
| Write `_acme-challenge` TXT | yes | the only write required |
| Write any other record type | **no** | must be denied if the provider supports scoping |
| Delete zone | **no** | — |
| Manage account/billing | **no** | — |
| Manage other zones | **no** | scope to one zone |

## 8. Certificate renewal

Renewal is automated PC-side and **fails closed**: if renewal fails, remote access stops rather than
continuing on an expiring credential. Alarm before expiry; never extend validity windows to work
around a clock problem.
