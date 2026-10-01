# R9 — Resource Inventory

**Phase:** R9-RELAY-02 (configuration preparation)
**Status of this document:** preparation only. No resource is marked `AVAILABLE` without evidence.
**Rule applied:** where the required provider/account information is absent, the item is recorded as
`NEEDS_OPERATOR_INPUT` and preparation continues on everything provider-independent.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `AVAILABLE` | exists and is verifiable **now**, with evidence recorded |
| `SELECTED_NOT_ACQUIRED` | a concrete candidate is chosen but not purchased/provisioned |
| `NOT_SELECTED` | no candidate chosen yet |
| `NOT_REQUIRED_YET` | genuinely not needed for R9-RELAY-03 |
| `NEEDS_OPERATOR_INPUT` | blocked on a human decision; DSH must not invent a value |

## Inventory

| # | Resource | Status | Evidence / note |
| --- | --- | --- | --- |
| 1 | **VPS** (public IPv4, Linux x86_64) | `NEEDS_OPERATOR_INPUT` | No VPS exists. No IP, provider or account was invented. Requirements in §VPS below. |
| 2 | **Domain** (production FQDN `R9_PUBLIC_HOST`) | `NEEDS_OPERATOR_INPUT` | No domain owned. No fabricated hostname is used anywhere; templates carry the literal placeholder `R9_PUBLIC_HOST`. |
| 3 | **DNS provider** (zone control + DNS-01 API) | `NEEDS_OPERATOR_INPUT` | Must be the provider authoritative for the future zone. Requirements in §Domain below. |
| 4 | **Registrar** | `NEEDS_OPERATOR_INPUT` | MFA and account security are an operator responsibility. |
| 5 | **Public CA** | `SELECTED_NOT_ACQUIRED` | **Let's Encrypt** is the working proposal (ADR-v3 §5). No ACME account exists yet. |
| 6 | **Android target device** | `NOT_REQUIRED_YET` | Belongs to R9-RELAY-04. No certificate will be installed on any phone in this phase. |
| 7 | **PC storage path** (keys, policy, UI artifact) | `AVAILABLE` (design) | The PC exists and is the bridge host. Concrete paths are proposed in the PC deployment plan; ACLs are not yet applied. |
| 8 | **Backup location** (encrypted offline) | `NEEDS_OPERATOR_INPUT` | Must be offline and outside the repository. No backup has been created because no production key has been generated. |
| 9 | **PC host (bridge runtime)** | `AVAILABLE` | This machine. Loopback only; nothing exposed. |
| 10 | **Docker Desktop** (validation tooling) | `AVAILABLE` | Used for local rehearsal only; **not** part of the production architecture. |

## VPS minimum requirements

| Requirement | Detail |
| --- | --- |
| Public IPv4 | required; **no IPv6/AAAA and no wildcard dual-stack listener** is authorized |
| Platform | Linux x86_64, matching the pinned `frp_0.71.0_linux_amd64` artifact |
| frps | must run the pinned v0.71.0 release, hash-verified |
| Management channel | **provider web console, serial/VNC console, or provider agent** — see below |
| Firewall control | provider security group or host firewall the operator can change |
| Storage | persistent disk for frps config and the frps server key only |
| Autostart | must be able to restart frps after reboot in a future phase |
| Time sync | NTP or provider-synchronized clock; validated before trusting certificate validity |
| Location | latency to the operator's PC is a selection factor; not a security control |

### NO-SSH remains frozen

SSH is **not** an approved management method for this project. Future VPS management must use an
approved non-SSH channel:

1. provider web console (preferred),
2. provider serial/VNC console,
3. provider management agent,

Do not introduce SSH for convenience, and do not open port 22 in the future firewall design.

## Domain requirements

| Capability | Why it is required |
| --- | --- |
| DNS control | to publish the A record and temporary DNS-01 challenge records |
| CAA support | so the CAA design in the DNS/ACME plan can actually be applied |
| DNS-01 automation or API | DNS-01 is the **only** authorized issuance method |
| Least-privilege challenge credential | the token must not be a registrar/account-admin credential |
| Wildcard issuance prevention | R9 uses one exact FQDN; wildcards are forbidden |
| MFA on registrar and DNS account | account takeover would allow certificate issuance and traffic redirection |

**No domain is owned, so only templates are prepared.** Every template uses the literal placeholder
`R9_PUBLIC_HOST`; no fabricated FQDN appears anywhere in this work.

## Inputs still required before R9-RELAY-03

| Input | Needed for |
| --- | --- |
| VPS provider + instance + public IPv4 | public bind design, firewall design |
| Domain name + registrar | `R9_PUBLIC_HOST`, DNS design |
| DNS provider + zone | DNS-01 and CAA application |
| Operator decision on the non-SSH management channel | VPS operations |
| Encrypted offline backup location | private issuer custody |
| Explicit authorization to APPLY public exposure | the actual R9-RELAY-03 boundary |

## Honesty statement

Nothing in this inventory claims a resource is available when it is not. The VPS, domain, DNS
provider and registrar are all **unacquired**, and no value has been fabricated to fill the gap.
