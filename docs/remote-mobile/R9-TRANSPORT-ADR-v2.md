# R9-TRANSPORT-ADR-v2 — relay transport for cellular access

**Status: PROPOSED, awaiting human acceptance. No implementation has started.**
Date: 2026-09-22. Owner: DSH. Supersedes the transport decision of the lost `R9-TRANSPORT-ADR.md`.

This document exists because the R9A preferred architecture is **unreachable in this environment**,
and the R9A alternative is unavailable for lack of resources. Both facts were established by
measurement, not assumption, and are recorded in
`docs/remote-mobile/_evidence/r9b1-correction/` (`r9b1c-transport-*.json`).

---

## 1. Environment facts that force the decision

| Fact | Value | Consequence |
| --- | --- | --- |
| Physical NIC address | `223.17.90.121/24`, gateway `223.17.90.1` | not a private LAN |
| Public egress address | `38.106.19.252` — **different** | the PC is behind carrier-grade NAT |
| Inbound reachability | **none** | nothing on the internet can dial in |
| IPv6 | **none** (no route; `api64` returns the IPv4 address) | the usual CGNAT workaround is unavailable |
| Nearest Tailscale DERP | Hong Kong | no direct path; everything relays offshore |
| Operator's phone | cannot run Tailscale | the overlay route is closed on the client side |
| VPS / domain | not available | the publicly-reachable component does not exist yet |

## 2. Why SSH is not the answer (recorded on the operator's instruction)

The operator asked whether SSH could provide cellular access. It cannot, and the distinction is
worth preserving so it is not re-litigated:

* **SSH is a protocol, not a reachability path.** `ssh user@pc` from cellular fails for exactly the
  same reason a browser does: the PC has no inbound address.
* The mechanism that *would* work is **`ssh -R` (a reverse tunnel)** — the PC dials out to a public
  host and publishes the DSH port there. But `-R` still requires that public host, so SSH removes
  nothing; it only changes who speaks the tunnel protocol.
* The asymmetry is the whole problem: **the PC can dial out; nothing can dial in.** Any workable
  design must be initiated by the PC.

The operator has chosen to **keep the standing NO-SSH rule**. This design therefore uses **frp**,
which speaks its own protocol over TCP and has no relationship to SSH.

## 3. Proposed architecture

```text
   ┌──────────────────────────┐                    ┌─────────────────────────────┐
   │  PC  (behind CGNAT)      │                    │  VPS  (public address)      │
   │                          │                    │                             │
   │  Gateway  127.0.0.1:9445 │                    │  frps  :7000  (tunnel)      │
   │  DSH      127.0.0.1:3081 │                    │   └─ vhost :443             │
   │  operator 127.0.0.1:3080 │  ◀── outbound ──   │        TLS + client cert    │
   │         (never exposed)  │      mTLS          │        (mandatory)          │
   │                          │      tunnel        │                             │
   │  frpc ───────────────────┼────────────────────┼─▶ published service         │
   └──────────────────────────┘                    └──────────────▲──────────────┘
                                                                  │
                                                     HTTPS :443   │  (cellular)
                                                                  │
                                                   ┌──────────────┴──────────────┐
                                                   │  Android — system browser   │
                                                   │  no VPN app, no SSH client  │
                                                   │  client certificate in      │
                                                   │  Android KeyChain           │
                                                   └─────────────────────────────┘
```

**The PC dials out. The VPS is the only public surface. The phone speaks plain HTTPS to the VPS.**

## 4. Port and bind inventory

| Component | Host | Port | Exposed to |
| --- | --- | --- | --- |
| Gateway | `127.0.0.1` | 9445 | loopback only — **unchanged** |
| Supervised DSH | `127.0.0.1` | 3081 | loopback only — **unchanged** |
| Operator DSH | `127.0.0.1` | 3080 | loopback only — **never exposed, never proxied** |
| frpc (PC) | outbound only | — | no listener on the PC |
| frps control (VPS) | `0.0.0.0` | 7000 | the PC only, mTLS |
| Published HTTPS (VPS) | `0.0.0.0` | 443 | the internet, client-certificate gated |

**No new listener is created on the PC.** That is the single most important property of this design:
the PC's attack surface does not grow.

## 5. Trust boundaries and layered authentication

Four independent layers, each of which must pass:

1. **Tunnel mTLS** — frpc↔frps mutually authenticated with a private CA. A rogue client cannot join.
2. **Transport gate** — the published vhost requires a **client certificate**. Without a valid
   certificate the TLS handshake fails; the request never reaches the tunnel. This is what makes a
   public listener defensible.
3. **Existing application auth** — R6 bearer token and R4/R6 WS ticket, unchanged and authoritative.
4. **Host/Origin enforcement** — the bridge validates the exact external Host/Origin before
   forwarding upstream with a fixed Host and **no** Origin, matching the accepted `ui/api/dev-proxy.mjs`
   behaviour. `production-gateway.mjs` keeps its empty `allowedOrigins`; no environment variable will
   be used to widen it.

**A compromise of any single layer is not sufficient for access.**

## 6. Explicitly out of scope

* No SSH anywhere, inbound or outbound.
* No Tailscale in the serving path (the node stays installed and inactive at the operator's choice).
* No Funnel, no subnet routes, no exit node.
* No change to R4 WS protocol, R5 journal format, R6 auth/ticket semantics, R7 lifecycle, or R8 UI.
* Ports 3080/3081/9445 are never proxied, never bound off-loopback.
* No production Supervisor is started by unit tests.

## 7. What the operator must obtain

| Item | Why | Notes |
| --- | --- | --- |
| A small VPS with a public IP | there must be one publicly reachable component | outside mainland China is preferable; inside gives lower latency but a worse international path |
| A domain name with DNS control | needed for a trusted certificate on the published host | a cheap registrar is enough; Let's Encrypt for the server certificate |

Until both exist, **nothing in this design can be built or tested**, and no relay will be deployed.

## 8. Phased plan (each phase gated on human acceptance)

| Phase | Scope | Gate |
| --- | --- | --- |
| **D0** | this document | operator accepts the architecture |
| **D1** | VPS provisioning: frps, private CA, server certificate, firewall | operator approves the exposure |
| **D2** | PC side: frpc, mTLS config, no new listener verified | negative tests: unauthenticated TLS refused |
| **D3** | bridge with exact Host/Origin enforcement against a fixture Gateway | hostile Origin/Host refused; one upstream handshake |
| **D4** | Android client certificate enrolment + real phone test over cellular | operator observes a real session |
| **D5** | revocation, failure and reboot acceptance | revocation demonstrably closes a live stream |

## 9. Security tests required before any real exposure

* TLS without a client certificate → **handshake refused**
* TLS with a certificate from a foreign CA → **refused**
* Host/Origin confusion, traversal, duplicate framing, spoofed identity headers → **refused**
* Upstream accepted only with fixed Host and **no** Origin; exactly **one** upstream handshake
* `/api/v1/` unknown paths never become HTML; `/api/api-client.js` stays a static asset
* Bearer/ticket canaries absent from every log
* Revocation closes an **established** stream within a measured window
* After teardown: the PC has **no new listening socket**

## 10. Rollback, in three layers

1. **Stop this phase's access** — stop the frpc tunnel; the PC keeps working locally. Satisfies the
   operator's intent to keep installed infrastructure.
2. **Temporary disconnect** — stop frps and close the VPS port. Not a revocation; identity remains.
3. **Full removal** — remove frps, the CA, the client certificates and the DNS record; verify old
   credentials cannot reconnect. Other services on the VPS are not touched.

A compromised credential is **rotated, not restored**.

## 11. Honest limitations

* **The original R9 design documents are lost** (ADR, threat model, deployment architecture, phase
  plan). This document cannot cite them, and the threat model has not been re-derived. Threat
  coverage must be rebuilt during D1–D5 rather than inherited.
* **The relay sees plaintext after TLS termination.** The VPS operator *is* the operator here, so
  this is acceptable, but it must be stated rather than glossed over.
* **A public listener exists in this design** — that is a real change from the tailnet-only
  preference and needs explicit acceptance. It is mitigated by the mandatory client certificate,
  not eliminated.
* **Latency is unmeasured.** No relay has been deployed, so no performance claim is made.
* **Cost is unverified.** VPS pricing varies; no figure here should be treated as a quote.

## 12. Decision requested

```text
1. Accept relay transport (frp + client-certificate HTTPS) as the R9 transport?
2. Accept that a public listener on the VPS is created, gated by client certificates?
3. Confirm the operator will obtain a VPS and a domain before D1 starts?
4. Confirm the NO-SSH rule stays in force?
```

Until these are answered, this design is **not implemented** and nothing is exposed.

```text
R9D ARCHITECTURE PROPOSED
NO IMPLEMENTATION STARTED
NO EXPOSURE CREATED
R9C NOT STARTED
AWAITING HUMAN ACCEPTANCE
STOPPING HERE.
```
