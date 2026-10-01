# R9 transport ADR v3 — PC-terminated HTTPS over an outbound relay

**Status: PROPOSED — AWAITING HUMAN ACCEPTANCE**

Date: 2026-09-22. Design/review owner: CODEX. Implementation owner after human acceptance: DSH, unless explicitly reassigned. **DO NOT IMPLEMENT D1.** No implementation or exposure is authorized by this document.

This proposal corrects [v2](R9-TRANSPORT-ADR-v2.md); it does not imply v2 was accepted. The [review notes](R9-TRANSPORT-ADR-v3-REVIEW-NOTES.md) enumerate the substantive changes. The threat model below is newly derived, not a claimed restoration of the lost original.

## 1. Preserved facts and scope

The PC cannot accept inbound Internet connections; IPv6 is unavailable; the phone cannot use Tailscale; the PC can initiate outbound connections. NO-SSH remains frozen, including reverse SSH and frp's optional SSH-related features. VPS plus domain remains a viable candidate, not an acquired resource or approved deployment.

These are the supplied design constraints, consistent with the v2 account and [historical environment evidence](_evidence/r9b1-correction/r9b1c-transport-2026-09-22T12-52-31-634Z.json). No network remeasurement occurred for v3. A difference between NIC and egress addresses alone does not prove every inbound path impossible; v3 does not elevate that inference into new measurement. The older evidence also records a local-router preference; the current request explicitly asks to evaluate the relay candidate and does not authorize deploying either. Missing literal `serve` capability is not reused as a diagnosis.

Frozen services: operator DSH `127.0.0.1:3080`, supervised DSH `127.0.0.1:3081`, Gateway `127.0.0.1:9445`. Their listeners must never be exposed remotely or directly mapped by frp. Only the new authenticated bridge may mediate the existing Gateway API. Neither DSH port is a bridge upstream. This distinguishes mediated application access from exposing the Gateway listener; an interpretation forbidding even mediated access would make this relay purpose impossible and require clarification before implementation.

R6 bearer and one-time WS ticket remain authoritative. No R4 WS, R5 persistence/sequence, R6 authentication, R7 lifecycle, or R8 REST/WS/UI/recovery/session-retention changes. All content remains untrusted and uses the accepted safe renderer. No production APK is part of this plan.

## 2. Decision and independent TLS boundaries

Prefer **browser TLS terminating on the PC**, with frps performing HTTPS/SNI routing and TLS passthrough. Application TLS and frp transport TLS have different peers, identities, keys and failure modes.

```text
Android system browser
  | B: HTTPS/WSS, public server validation + Android client certificate
  v
VPS frps, public IPv4 TCP :443 — SNI routing; application TLS NOT terminated
  | browser TLS records carried inside A
  | A: frps <-> frpc mutually authenticated transport TLS
  |    PC initiates TCP connection(s) to VPS :7000
  v
PC frpc — forwards still-encrypted browser TLS to 127.0.0.1:9446
  v
PC R9 TLS/Origin bridge :9446 — terminates B, verifies Android identity
  | fixed loopback HTTP/WS upstream; fixed Host; no external Origin
  v
Gateway 127.0.0.1:9445 — unchanged R6 bearer / one-time ticket gate
  v
Existing supervised DSH path — unchanged; no transport mapping of :3081
```

Layer A authenticates tunnel participants; it does not authenticate the phone. Layer B authenticates the application server and phone; it does not make public port7000 private. Public443 accepts traffic before Android authentication: those TLS bytes reach the PC bridge before it can reject a client. The VPS therefore cannot act as an application mTLS admission gate in this topology.

The official frp examples put HTTPS termination at the local service or a client-side plugin; transport TLS is configured separately. v3 chooses an explicit local TLS bridge, **not** an HTTPS-to-HTTP frpc plugin and not VPS TLS offload. Pin and verify the eventual frp release, including passthrough and all control/work-connection authentication, before implementation approval; documentation is not proof of a deployed configuration. [frp HTTPS example](https://gofrp.org/en/docs/examples/https2http/), [transport TLS](https://gofrp.org/en/docs/features/common/network/network-tls/).

### Alternative comparison and the compromised VPS

| Capability of a fully compromised VPS, including frps root access | VPS application TLS termination | Selected PC application TLS termination |
| --- | --- | --- |
| Read | HTTP headers, Phone Bearer, ticket, messages, uploads | IPs, visible SNI, timing, sizes, routing/control metadata and tunnel credentials held on VPS; application ciphertext under the assumptions below |
| Modify | Requests, responses, scripts/UI, uploads and messages | Drop, delay, reorder or corrupt traffic; authenticated TLS rejects content forgery; cannot supply accepted application plaintext without defeating server authentication |
| Steal | Application secrets in transit plus VPS keys | frps private key and VPS-held frp auth material; not PC public-server private key or Android/frpc private keys merely by reading VPS storage |
| Impersonate | Application server to phone, possibly harvest bearer and reuse tickets | Tunnel server and relay endpoint; not the real application TLS endpoint under the assumptions below; cannot reuse a client's TLS signature as its private key |
| Deny | Full outage | Full outage, selective disconnect, traffic analysis and traffic flooding toward PC |

There is **no absolute single-layer compromise guarantee**. PC/bridge compromise exposes application plaintext and can bypass its gate; a compromised phone may contain both bearer and client key; malicious same-origin code can act with the browser's credentials. R6 does not make those endpoint compromises safe.

Crucial qualification: a compromised VPS controlling the domain's validation endpoint may obtain a new publicly trusted certificate through HTTP-01/TLS-ALPN-01 unless issuance is restricted. Merely storing the legitimate key on the PC is insufficient. Proposed pre-exposure controls are DNS-01 issuance from the PC, DNS/registrar/ACME accounts outside the VPS, and CAA restricting the approved CA, validation method to DNS-01 and the specific ACME account. Disallow wildcard issuance. Verify chosen CA support and effective CAA policy; monitor CT. A commodity browser does not pin this application's key. CA misissuance, compromised DNS/registrar, or failure to enforce these restrictions remains a route to server impersonation, malicious UI and bearer theft. If the controls cannot be demonstrated, **do not approve the claim that VPS compromise preserves plaintext confidentiality**; revise the architecture/assurance before exposure. [ACME challenges](https://letsencrypt.org/docs/challenge-types/), [CAA restrictions](https://letsencrypt.org/docs/caa/).

## 3. PC bridge ownership and request policy

The new, separately owned R9 process binds only `127.0.0.1:9446`. It owns the public server certificate/key, Android trust and revocation state, exact external authority/origin checks, static serving of the unchanged accepted UI, HTTP proxying and WS upgrade proxying. It has no lifecycle control over R7. frpc targets only9446, never9445/3080/3081. Local malicious processes are not excluded by a loopback bind; the PC host is a trusted endpoint with a remaining local attack surface.

Define one deployment FQDN `H` and origin `O = https://H`; these are placeholders, not a domain selection. Require exact configured SNI H and a single canonical Host H (optionally H:443 only if explicitly covered by the authority parser); reject alternatives, duplicates, userinfo, absolute-form targets, forwarded-host substitutions and ambiguous framing. Use HTTP/1.1 initially, including WS upgrade; no QUIC/HTTP3 or HTTP2 fallback that bypasses policy.

Require certificate chain/time/clientAuth validity and the current enrolled-identity policy before any static content or upstream request. For every WS upgrade and unsafe HTTP method, require exactly Origin O; reject missing, null, multiple and hostile values. GET/HEAD navigation and same-origin reads may legitimately omit Origin: permit omission only on the explicit read/static allowlist after mTLS and Host/SNI checks; if Origin is present it must equal O. Reject cross-site fetch metadata where present, but do not trust it as authentication. Confirm this policy against the unchanged real browser flow before release; no loosening of Gateway allowedOrigins.

Route only the accepted API/method surface, including the exact `POST /api/v1/sessions` New Session route, ticket and events paths; unknown `/api/v1/` never becomes HTML. The create route remains gated by mTLS, exact same-origin policy, and the Gateway's Phone authentication, empty-body and durability checks. Preserve `/api/api-client.js` as a static asset. No arbitrary upstream, CONNECT, open proxy or traversal. Reject malformed/ambiguous lengths and hop-by-hop smuggling. Set upstream Host to `127.0.0.1:9445`, remove external Origin and forwarded/identity headers, then forward only required headers. Preserve R6 bearer/ticket carriage without minting, caching or logging them. One validated external upgrade creates at most one upstream handshake; cancellation/closure releases its paired resources. No bridge retries of writes or consumed tickets.

No secrets in any layer's logs: no headers, query strings, full URLs, bodies, TLS session secrets, dumps or client private material. Log bounded event codes, counts and pseudonymous identity IDs. Set bounded connection, handshake, header and idle limits separately from legitimate stream lifetimes and existing upload limits. Enforce identity/global quotas on the bridge: all forwarded connections appear local, so source-IP rate limits there are not per-phone identity. VPS can enforce coarse network limits but cannot inspect encrypted HTTP paths.

## 4. Final proposed port inventory

This is a design inventory, not an observed listener list. VPS public IPv4 is represented by V; if the provider uses address translation, validate the actual local bind and firewall equivalent before deployment. No IPv6/AAAA or wildcard dual-stack listener is authorized.

| Endpoint | Bind / owner | Network reachability | Authentication before application access | Plaintext visibility |
| --- | --- | --- | --- | --- |
| VPS443 TCP | V:443, frps HTTPS vhost | Public Internet, not phone-only | Android mTLS at PC, then bridge checks and R6 on protected API; VPS does not perform phone validation | frps sees TLS records and metadata, not HTTP under section2 assumptions |
| VPS7000 TCP | V:7000, frps control/work transport | Public attack surface unless a proven stable PC source-IP firewall rule exists; none assumed | Mandatory A mTLS, exact server identity and dedicated frp auth; not sufficient for B/R6 | frp control metadata and VPS auth material; nested application TLS remains encrypted |
| PC9446 TCP | 127.0.0.1:9446, R9 TLS/Origin bridge | Local PC only at socket layer; remotely reachable indirectly through approved tunnel | Android mTLS, enrollment/revocation, Host/Origin; R6 downstream | Bridge decrypts headers, bearer/tickets and content in memory |
| PC9445 TCP | 127.0.0.1:9445, Gateway | Local PC only; no raw frp mapping | Existing R6 rules, unchanged; only filtered requests from bridge | Loopback HTTP/WS plaintext at bridge/Gateway and privileged PC observers |
| PC3081 TCP | 127.0.0.1:3081, supervised DSH | Local only, never relay/bridge target | Existing local contract unchanged; no new remote auth assertion | Existing local DSH traffic visible to its endpoints/privileged PC |
| PC3080 TCP | 127.0.0.1:3080, operator DSH | Local only, never relay/bridge target or probe target | Existing operator boundary unchanged | Existing operator traffic; R9 must not inspect it |

frpc opens outbound ephemeral TCP sockets to7000, no inbound listener. The bridge **does create a new local listener**, correcting v2. No80, public dashboards/admin APIs, UDP, SSH22, extra TCP proxy ports, KCP/QUIC, Funnel, subnet routes or exit node. Disable unused frp features and enforce a single registered domain/proxy. mTLS alone authenticates a CA-issued peer, not its right to register arbitrary routes: verify the pinned release's auth/registration restrictions or block deployment. A future source-IP restriction must be proven with measured stable egress and positive/negative tests; authenticated usability must never be relabeled network privacy.

## 5. Four distinct certificate identities

Separate leaf keys and trust domains; never reuse a certificate/key pair across roles. The three private issuers below are distinct dedicated issuing authorities with offline signing keys, held by the operator outside VPS/browser/service accounts. No general private root is added to the phone's HTTPS server trust store. Public certificate chains are not secrets; their associated private keys are.

| Identity / issuer | Certificate and private-key storage | Renewal | Revocation and compromise blast radius |
| --- | --- | --- | --- |
| Public HTTPS server for H / approved public CA, proposed Let's Encrypt DNS-01 | Public chain and unique private key on PC under bridge-only ACL; encrypted operator backup if retained; ACME/DNS account isolated from frpc and VPS | Automated PC-side DNS-01, least-privilege challenge token, rotate key and atomically reload; renew before CA-defined expiry, alarm and fail closed on expiry | Request CA revocation and replace key/cert; browser revocation is not assumed immediate. Theft enables application-server impersonation to browsers where routing permits; no Android client identity or tunnel credential follows automatically |
| Android client / dedicated Android-client issuer | Leaf in Android KeyChain; unique private key on device where supported. If import is required, one-use encrypted enrollment bundle and controlled deletion; no hardware/non-exportability claim without device proof | Proposed30-day maximum validity; re-enroll fresh key before expiry with local operator approval; brief explicit overlap only | PC enforced active allowlist + issuer/serial denylist, section6; stolen usable key admits mTLS but protected operations still require R6. Lost phone may also contain bearer: treat both compromised |
| frpc tunnel client / dedicated tunnel-client issuer | PC frpc service ACL, separate from bridge key; leaf public copy at verifier; unique clientAuth key | Proposed30-day leaf, operator-managed rotation and controlled reconnect; no silent expired fallback | Replace dedicated client trust/leaf authorization at frps and terminate old control/work connections. If pinned frp lacks per-leaf revocation, replace this single-client issuer/trust anchor and restart only dedicated tunnel service; stolen key can attack tunnel registration, not decrypt B by itself |
| frps tunnel server / dedicated tunnel-server issuer | VPS frps service ACL holds unique serverAuth key; PC holds issuer trust and exact expected name | Proposed30-day leaf, staged replacement; reconnect validates expected name and trust, never skip verification | Replace server issuer/trust on PC and server key on clean VPS, terminate old A connections. Stolen key permits tunnel-server impersonation; browser TLS remains independent subject to section2 |

Private issuer renewal is a scheduled operator responsibility, not an invented online CA. Failure to renew closes remote access without changing local R7. Dedicated frp auth material is an additional secret, scoped to this tunnel and rotated with compromise; do not reuse the Phone Bearer as tunnel auth. No private CA keys, Android bundles, PC application key, DNS credentials or ACME account key belong on the VPS. Android KeyChain permits client credential selection, but actual browser HTTPS/WSS support and enrollment behavior remain device acceptance requirements. [Android KeyChain](https://developer.android.com/reference/android/security/KeyChain).

## 6. Android revocation: enforceable state and timing

Primary enforcement is a PC-local, durable **active enrollment allowlist plus issuer-key-ID/serial denylist**; removing a leaf from the active set denies it even before natural expiry. Bind enrollment to the leaf fingerprint too. Short validity is defense in depth, not immediate revocation. No reliance on phone deletion, public OCSP or an unimplemented CRL refresh.

An authenticated local operator operation commits a new monotonic policy generation atomically to disk, then activates it in bridge memory. Missing/corrupt policy prevents bridge startup; failed update never reports success. At activation stop admitting the removed identity, recheck policy on every HTTP request and upgrade, destroy all downstream TLS/keepalive/WS sockets for that identity and their paired upstreams, including uploads. Track sockets by verified identity, not IP. Recheck generation immediately before upstream dispatch to close admission races. Disable TLS session resumption/tickets and early data initially; verify TLS1.2/1.3 reconnect behavior so a revoked client cannot resume around the gate.

Acceptance target: within **5 seconds of local revocation activation**, no owned connection for the identity remains and no new operation is forwarded. Measure both activation and completion; this is a proposed release threshold, not measured performance. If activation/closure fails, use the local R9 emergency stop to close the bridge and frpc, report revocation failure, and remain closed. An emergency stop is not evidence the revocation feature passed. Persist removal across reboot; restoring service must not restore revoked enrollments.

Test with identityA on HTTP keepalive, WS and upload plus identityB as control: revokeA, immediately attempt new TLS, resumed TLS, keepalive request and WS reconnect with otherwise-valid R6 test credentials. All A requests must fail before Gateway access; existing A links terminate within5s, B remains usable. New enrollment requires a new key/serial and explicit approval. Certificate failure normally fails TLS; serial rejection may instead occur immediately after cryptographic verification but must precede any HTTP/static response or upstream dispatch. Do not misreport that distinction.

Revocation cannot retract previously downloaded content, buffered bytes already sent, or cancel a model operation already accepted by Gateway. Do not invent an R7/R8 cancellation side effect. On lost phone also rotate/revoke the bearer through the existing supported R6/operator procedure; preserve its existing semantics and scope.

## 7. Rebuilt threat model before implementation

Assets: Phone Bearer, one-time ticket, messages/uploads, UI integrity, four private keys, CA/DNS/ACME accounts, revocation policy, availability and frozen local lifecycle. Trusted endpoints are the Android browser/device and PC bridge/Gateway OS; VPS is not trusted with application plaintext. Public CA/DNS trust and correct TLS implementations are explicit dependencies. Tables describe intended controls, not passed tests.

| Threat | Capability / consequence | Control, residual risk and acceptance link |
| --- | --- | --- |
| Passive Internet observer | Observe IP/SNI, sizes, timing | Nested authenticated TLS protects payload; metadata not concealed. A1/A2 |
| Active MITM | Redirect/inject/drop traffic | Both independent server validations, client certs and no insecure fallback; can deny service. A1/A2 |
| Compromised VPS | Full storage/network/control access | Section2 comparison and CA-issuance restrictions mandatory; cannot promise confidentiality against DNS/CA compromise. A2/A9 |
| Compromised frps process | Steal its keys/auth, reroute and send hostile bytes to frpc/bridge | No PC app secrets there, least privilege and updates, no arbitrary proxies; exploit chaining into frpc/PC remains possible. A2/A3 |
| Stolen Android certificate/key | Client impersonation (public certificate alone is insufficient) | Enrollment removal plus live closure; bearer still needed on protected API; static UI accessible until removal. A5/A6 |
| Stolen Phone Bearer | Invoke R6 if transport access also available | B gate blocks an external bearer-only attacker; a local PC attacker bypasses that network gate. Existing bearer rotation; no absolute independence. A5 |
| Stolen frpc key | Authenticate as tunnel client, attempt route takeover or DoS | Separate role/CA, dedicated auth and registration restriction; rotate trust and close A; B prevents automatic app impersonation. A3/A6 |
| Replayed WS ticket | Duplicate or expired upgrade | Existing one-time/expiry validation stays authoritative, new ticket per retry; bridge never retries ticket. A5 |
| Malicious public scanner | Reach443/7000, fuzz SNI/TLS/frp | Reject invalid identity before application; parser/time/resource limits, updates; public attack surface persists. A1/A3/A7 |
| DoS against443 | Exhaust relay bandwidth or PC TLS capacity | VPS coarse limits plus PC handshake/global quotas and circuit stop; cannot guarantee availability under volumetric attack. A7 |
| DoS against7000 | Exhaust tunnel handshake/control or drop A | Separate caps, mandatory mTLS/auth and bounded retry; no source-IP privacy assumption. A3/A7 |
| Hostile Host | Routing confusion/open proxy | Exact authority/SNI, fixed upstream, malformed/duplicate rejection. A4 |
| Hostile Origin | Cross-site use of browser client cert | Exact Origin for unsafe/WS; safe absent-Origin exception narrowly defined; Origin is not nonbrowser authentication. A4 |
| DNS compromise | Route to attacker and potentially mint public cert | DNS/registrar account isolation/MFA, restricted CAA/account/method and CT detection; full DNS compromise can defeat these controls and steal bearer via malicious UI. A9; residual human acceptance required |
| Lost phone | Both browser credential and device key may be usable | Local revoke, live closure, R6 rotation and fresh enrollment; screen lock is not revocation. A6 |
| PC reboot | Old policy, expired cert, unexpected startup | Durable policy before listen, no insecure fallback; independent R9 service, no R7 launches. A8 |
| Relay disconnect | Interrupted requests/streams | Close paired resources; bounded frpc reconnect and existing R8 replay/resync; no bridge POST replay. A8 |
| Cellular/Wi-Fi transition | IP change and stale connection | Identity not tied to source IP; existing generation/ticket/recovery logic; real phone test. A8 |
| PC/bridge or browser compromise | Plaintext/key theft, same-origin actions | Endpoint hardening and recovery remain necessary; outside relay confidentiality guarantee, explicitly not defeated by layering. A2/A9 review |

## 8. Acceptance plan and deployment gates

Use only namespace **R9-RELAY-00 through R9-RELAY-05** for this plan. No bare D0–D5 and no new meaning for R9D; earlier project R9D retains its Android-connectivity meaning. Historical R9B.1 gates/results remain historical and are not silently waived or called passed. This proposal does not start R9C or any other implementation phase.

| Phase | Scope after separate authorization | Exit gate |
| --- | --- | --- |
| R9-RELAY-00 | This corrected ADR and threat model only | Human accepts architecture, residual DNS/CA/endpoint risks and phase boundaries; current status pending |
| R9-RELAY-01 | Offline detailed implementation/config review, pinned frp/runtime selection and fixture-only bridge tests | A1/A3/A4/A5/A6/A7 locally demonstrated; no VPS/domain required for local test design; no public listeners |
| R9-RELAY-02 | Obtain approved resources and prepare isolated deployment: distinct identities, DNS-01/CAA, PC ACLs, VPS config with exposure still closed | Key custody, port inventory, A9 issuance restrictions and rollback reviewed; explicit public443/7000 exposure approval required |
| R9-RELAY-03 | Authorized public relay to synthetic fixture only | A1–A7/A9 over actual path, positive and negative evidence; no production Gateway or sessions |
| R9-RELAY-04 | Approved Android end-to-end integration with unchanged existing stack | Real browser HTTPS/WSS/enrollment and A5/A8; no APK build, R7 startup only if separately authorized for real acceptance |
| R9-RELAY-05 | Revocation, failure, approved reboot and teardown acceptance | A6/A8 repeated on real deployment, ownership/cleanup evidence, human acceptance; no automatic next phase |

| Test ID | Required evidence before release |
| --- | --- |
| A1 TLS | No cert, foreign issuer, expired/wrong-purpose leaf rejected before application; correct identity works; no insecure protocol/fallback or alternate listener |
| A2 End-to-end boundary | Synthetic payload/token canaries absent from VPS/frps plaintext logs/storage and observable decrypted A content; browser sees PC-issued public identity; swapping relay backend to unrelated TLS endpoint fails. Packet inspection alone is not proof against full VPS compromise; review key custody and A9 too |
| A3 Tunnel | Invalid/missing/wrong-role client/server cert, wrong server name, missing frp auth and unauthorized proxy registration denied; work connections also gated; only intended two public ports |
| A4 Routing | Host/SNI/Origin matrix including browser missing-Origin reads, hostile/multiple/null headers, framing/traversal; one WS handshake, fixed upstream Host, no external Origin, API/static distinction, no secret logs |
| A5 Frozen auth | Valid mTLS but absent/invalid bearer fails protected R6 operations; bearer without mTLS fails at bridge; ticket replay/expiry rejected per existing R6; unchanged R8 safe rendering and recovery regressions |
| A6 Revocation | Section6 live/new/resumed connection tests, durable reboot removal, failed update fail-closed behavior; tunnel-key trust rotation and old connection termination tested separately |
| A7 Resources | Bounded synthetic scanner/slow-handshake/concurrency tests in authorized scope; record numeric configured limits and memory/socket recovery, no Internet load attack; stop path closes only owned R9 resources |
| A8 Recovery | Relay loss, PC restart in approved window, Wi-Fi/cellular switch; current R8 replay/resync, no duplicated writes, fresh one-time ticket, no stale callbacks; no R7 lifecycle changes |
| A9 Custody/issuance | Four nonreused identities; no app/DNS/CA secret on VPS; actual CA honors account/method CAA restrictions, rejected unauthorized issuance tested safely using approved CA test facilities; browser validation and CT response procedure verified |

Each future run records version, time, test input category, expected/actual outcome, limits, sanitized artifact references and cleanup. Unrun tests stay NOT_RUN; all tests above are currently NOT_RUN. Inability to prove Android support, frp admission restrictions, resumed-session revocation, public-certificate issuance restrictions or frozen R8 compatibility is a blocking result, not permission to weaken controls.

## 9. Failure, rollback and operational ownership

R9 bridge and frpc have separate service ownership from R7. Proposed restart order: validate clock/certs/durable policy, start bridge loopback listener, then frpc; bounded retry with exponential delay and jitter capped at60s and a finite10-attempt incident budget, then stop remote access and require operator restart. These are proposed transport values, not edits to R8 reconnect. Local Gateway absence returns bounded unavailable behavior; R9 must not start it. Never forward pre-auth data to compensate for outage.

Emergency stop closes bridge admission and paired connections, stops only owned frpc, then disables the owned VPS route/service in an authorized operation. Deleting DNS alone is neither immediate disconnection nor identity revocation. Restore only known-clean config with current revocation policy; do not roll back denylist generation or reuse compromised keys. Full removal cleans this deployment's services, keys and DNS records without altering unrelated VPS services or R7. NO-SSH also constrains future VPS management: an approved provider console/management channel must be available; do not introduce SSH for convenience.

Latency, cellular reliability, browser certificate UX, cost, resource limits and deployment compatibility remain unmeasured. The current work neither provisions resources nor creates certificates, listeners, firewall rules or an APK.

## 10. Human acceptance and DSH Resume Notes

Review the selected PC termination, publicly reachable443/7000, new loopback9446 listener, four identities, concrete revocation threshold and DNS/CA residual risk. Acceptance of this ADR is not authorization to expose ports; later gates require their own concrete evidence and scope. No resources need to be purchased to complete this design review.

DSH receives implementation ownership only after human acceptance and within the separately authorized phase. Do not implement v2 D1. Use R9-RELAY identifiers and the A1–A9 matrix; do not defer this threat model until deployment. Preserve all frozen application/lifecycle contracts. The exact domain, VPS, pinned binaries and Android browser are deployment inputs still to be selected and verified, not reasons to invent current capabilities.

**PROPOSED — AWAITING HUMAN ACCEPTANCE**

DESIGN ONLY — NO IMPLEMENTATION AUTHORIZED — STOPPING HERE.
