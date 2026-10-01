# R9 transport ADR v3 — review notes against v2

**Status: PROPOSED — AWAITING HUMAN ACCEPTANCE**

Date: 2026-09-22. Author: CODEX. Input: [R9-TRANSPORT-ADR-v2.md](R9-TRANSPORT-ADR-v2.md), read in full. Output: [R9-TRANSPORT-ADR-v3.md](R9-TRANSPORT-ADR-v3.md). v2 is preserved unchanged. These notes describe proposed design changes, not executed remediation.

## Required correction traceability

| User correction | Substantive v2 → v3 change | v3 location |
| --- | --- | --- |
| 1: TLS boundary | Removes frps browser-TLS termination/client-cert gate. Separates A tunnel mTLS from B browser mTLS. Selects frps passthrough to explicit PC TLS/Origin bridge; identifies unauthenticated443 traffic reaching PC TLS parser | 2–3 |
| 2: Public7000 | Replaces “PC only” with public reachability protected by authenticated tunnel admission. Source-IP restriction is conditional on proof, not presumed | 4 |
| 3: Compromise claim | Deletes absolute single-layer guarantee. Compares what VPS root can read, modify, steal, impersonate and deny for both termination choices; states endpoint and DNS/CA limitations | 2,7 |
| 4: Certificate roles | Defines four nonreused leaf identities, separate issuers/trust, key custody, renewal, concrete trust rotation and blast radii; separates tunnel auth from Phone Bearer | 5 |
| 5: Revocation | Replaces generic “revoke” with durable enrollment allowlist/issuer-serial denylist, generation/race handling, per-identity live socket closure, resumption restrictions and measured5s test target | 6,A6 |
| 6: Ports | Adds all six required endpoints with bind/reachability/auth/plaintext/owner. Adds loopback9446; removes false no-new-PC-listener promise. Explicitly excludes extra public ports/features | 4 |
| 7: Naming | Replaces D0–D5 and erroneous R9D conclusion with R9-RELAY-00…05; preserves historic R9D meaning and prior gate history | 8,10 |
| 8: Threat model | Rebuilds assets, trust assumptions and complete threat matrix here before implementation. No deferral to deployment and no claim of recovering missing original verbatim | 7–8 |

## Additional substantive changes and qualifications

1. **Issuance takeover closes a gap in the preferred design.** PC key custody alone does not stop a malicious VPS from obtaining another browser-trusted certificate through domain validation it controls. v3 requires independent DNS/ACME custody and demonstrated CA account/method restrictions via CAA; explicitly retains DNS takeover and CA misissuance risk. CT is detection, not prevention, and browsers are not assumed to pin the PC key. This materially qualifies the desired VPS-confidentiality property rather than promising it absolutely.
2. **Request policy is executable as acceptance criteria.** Exact Host/SNI, strict Origin for unsafe methods/WS, narrow absent-Origin read exception, fixed upstream Host/no external Origin, identity checks before static content, route/method boundaries, one upgrade, no write/ticket retries and no secret logs are specified. These are requirements on the new bridge, not edits to accepted R8 proxy code.
3. **Exposure language is reconciled.** Direct mapping of9445 is forbidden; filtered bridge mediation of the existing API is the intended access path. Neither DSH port is ever an upstream. The bridge is a new local attack surface even though its socket is loopback-only.
4. **Identity lifecycle is explicit.** Proposed30-day private leaves, offline issuers, fail-closed expiry, one-use enrollment artifacts, separate private trust domains and no assumed hardware-backed Android key. Public-server revocation is not described as instant browser protection. Tunnel leaf revocation does not assume undocumented frp CRL/serial features; dedicated trust replacement and live connection termination are required where needed.
5. **Revocation limits are honest.** Existing TLS/WS/uploads close, but already delivered data and operations already accepted by Gateway cannot be recalled. Emergency stop is separate from a passing revocation test. Lost-phone response also uses existing R6 bearer rotation without changing its semantics.
6. **No-resource claim is narrowed.** v2 said nothing could be built/tested until VPS/domain acquisition. v3 allows future authorized offline fixture work while reserving real deployment for later approval. This turn still performs no implementation or certificate generation.
7. **Environment provenance is corrected.** Required no-inbound/no-IPv6/phone-no-Tailscale/outbound facts are retained as supplied constraints, not newly measured. Old evidence's CGNAT/capability inferences are not promoted into proof. The older local-router choice is identified; this request supersedes it only for evaluation of the relay candidate. The found v2/evidence do not prove all lost original documents were restored.
8. **Public attack handling is bounded.** Scanner and DoS risks cover both443 and7000, including PC TLS load behind passthrough. Configuration must have reviewed numeric limits; per-phone limits use certificate identity, not frpc's loopback source address. No availability guarantee under volumetric attack.
9. **Tunnel registration is distinct from tunnel identity.** Trusting a client CA alone does not prove a peer may publish only one route. Pinned-release work-connection/auth/domain/proxy restrictions are pre-exposure gates; no arbitrary extra listeners or SSH features.
10. **Deployment order is changed.** Offline bridge/security tests precede public exposure; synthetic relay acceptance precedes real integration. Missing core security coverage cannot be deferred to the final failure-test phase. R9-RELAY-02 preparation explicitly keeps exposure closed until approved.
11. **Recovery/rollback separates owners.** Independent R9 startup and bounded retry, durable policy before listening, no R7 startup side effects, no automatic request replay, no DNS-deletion-as-revocation, and cleanup only of owned resources. NO-SSH applies to VPS administration too.
12. **Unknowns stay unknown.** frp version, actual browser mTLS/WSS support, chosen CA enforcement, performance, costs and resource measurements require future evidence. All A1–A9 runtime acceptance tests are NOT_RUN; proposal acceptance is distinct from exposure authorization and final acceptance.

## Source review and validation scope

Official sources were checked for the TLS split, ACME/CAA restrictions and Android credential API. They are linked next to the relevant v3 claims. No deployed frp configuration or pinned binary has been verified. v3 selects requirements, not a ready-to-run configuration.

Reviewed the existing local proxy's route/upstream/auth boundary as design context. No Gateway/R7/R8 code was changed and no production processes were launched. No VPS provisioning, domain purchase/configuration, frps/frpc execution, key/CA creation, firewall modification, public exposure or APK build occurred. This document-only task does not claim runtime test passage; validation is document structure, local links, coverage and preservation of v2.

## DSH Resume Notes

Do not implement D1 or treat the lost original threat model as implicitly accepted. Read v3 sections2,5,6 and7 together: encrypted relay confidentiality depends on certificate issuance custody as well as TLS passthrough. Any inability to meet those assumptions returns to design review. Implementation ownership returns to DSH after human acceptance, unless explicitly reassigned.

**PROPOSED — AWAITING HUMAN ACCEPTANCE**

STOP AFTER THE CORRECTED DESIGN.
