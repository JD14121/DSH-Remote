# R9 — PC Deployment Plan

**Phase:** R9-RELAY-02 (design + preparation)
**Scope:** the PC side of R9 — bridge, frpc, static UI artifact, custody paths and ACL plan.

## 1. Frozen local services — never relayed

| Service | Bind | Rule |
| --- | --- | --- |
| Operator DSH | `127.0.0.1:3080` | **never** exposed, relayed, bridged or probed |
| Supervised DSH | `127.0.0.1:3081` | **never** a bridge/frpc target |
| Gateway | `127.0.0.1:9445` | fixed upstream; reachable only from the bridge |

**Only the R9 bridge may mediate remote traffic.** frpc must never target 9445, 3081 or 3080.

## 2. Bridge (R9 TLS/Origin bridge)

| Property | Value |
| --- | --- |
| Listener | `127.0.0.1:9446` — loopback only, always |
| Fixed upstream | `127.0.0.1:9445` (never client-controlled) |
| External FQDN | `R9_PUBLIC_HOST` (placeholder) |
| HTTPS server cert | `config/r9/paths` placeholder → bridge-only ACL |
| HTTPS private key | bridge-service read only |
| Android-client issuer | public trust material only |
| Enrollment policy | durable, fail-closed on missing/corrupt |
| Denylist | durable, fail-closed |
| Static UI artifact | deterministic build, manifest-verified |

The production config template is `config/r9/bridge.production.toml`. It reuses the **already
accepted and tested** R9-RELAY-01 bridge behaviour: mandatory client certificate,
`SSL_OP_NO_TICKET`, no resumption, per-connection identity correlation, default-deny identity policy,
Host/SNI/Origin policy, route allowlist and header sanitisation.

## 3. Proposed PC paths (ACLs not yet applied)

| Material | Proposed location |
| --- | --- |
| HTTPS server cert + key | `C:\ProgramData\r9-relay\tls\` |
| Android issuer trust | `C:\ProgramData\r9-relay\trust\android-issuer\` |
| Enrollment allowlist + denylist | `C:\ProgramData\r9-relay\state\` |
| frpc cert + key | `C:\ProgramData\r9-relay\tls\frpc\` |
| frps trust anchor | `C:\ProgramData\r9-relay\trust\frps-issuer\` |
| frp auth secret | `C:\ProgramData\r9-relay\secrets\` |
| ACME account key | `C:\ProgramData\r9-relay\acme\` |
| DNS credential | `C:\ProgramData\r9-relay\secrets\` |
| Static UI artifact | `C:\ProgramData\r9-relay\ui\` |

These are **proposals**. `C:\ProgramData` is chosen because it is not per-user profile data and is not
inherited from a user's permissive profile ACL by default — but the ACL plan in
`R9-INCIDENT-AND-ROLLBACK.md` §5 must be applied explicitly rather than assumed.

## 4. Static UI artifact

Derived deterministically from the accepted R8 source under `src/remote/ui`.

### Forbidden

* `npm run ui:dev`
* port `8099`
* `adb reverse`
* any UI redesign

### Required

| Item | Detail |
| --- | --- |
| Artifact path | `C:\ProgramData\r9-relay\ui\` |
| Manifest | file list + per-file SHA-256 + version identifier |
| Version identifier | content hash of the artifact set |
| Build/copy command | deterministic copy from `src/remote/ui`; no dev server |

### Preserved same-origin contract

```text
https://R9_PUBLIC_HOST/
https://R9_PUBLIC_HOST/api/...
wss://R9_PUBLIC_HOST/api/v1/events
connect-src 'self'
```

`connect-src 'self'` is preserved unless a concrete incompatibility is discovered; none is known.

## 5. frpc (PC tunnel client)

| Property | Value |
| --- | --- |
| Direction | **outbound only** to `R9_VPS_HOST:7000`; frpc opens no inbound listener |
| Transport | TLS/mTLS with the dedicated frpc leaf |
| Server validation | issuer + `serverAuth` EKU + exact expected name + validity; **never** skip verification |
| Auth | dedicated frp auth secret (not the Phone Bearer, not a TLS key) |
| Proxies | **exactly one** |
| Proxy type | `https` |
| Local target | `127.0.0.1:9446` |
| `customDomains` | `[R9_PUBLIC_HOST]` |
| Never targets | 9445, 3081, 3080 |

Template: `config/r9/frpc.production.toml`.

## 6. Startup ordering (PC)

```text
1. validate clock
2. validate certificates (HTTPS server, frpc, trust anchors)
3. load durable revocation policy (fail closed if missing/corrupt)
4. start bridge on 127.0.0.1:9446
5. verify bridge ready
6. start frpc
```

**R9 must not start R7.** The R7 lifecycle remains independently authoritative.

## 7. Shutdown ordering (PC emergency stop)

```text
1. stop bridge admission
2. close owned R9 sessions
3. stop frpc
4. verify 9446 is free
```

**Do not kill the operator DSH (3080).** **Do not stop the supervised DSH merely to disable remote
transport** — stopping R7 is not the way to stop R9.

## 8. Resource limits — proposed, not frozen

| Limit | Fixture value | Proposed production | Reason | Future measurement |
| --- | --- | --- | --- | --- |
| `handshakeTimeoutMs` | 5000 | 5000 | local handshakes complete in ms | keep |
| `maxHeaderBytes` | 16384 | 16384 | API headers are far smaller | keep |
| `headerTimeoutMs` | 5000 | 5000 | bounds a stalled header send | keep |
| `maxConnections` | 64 | **128** | one phone plus reconnects; headroom for WSS + API | measure real peak |
| `maxConnectionsPerIdentity` | 8 | **16** | a phone may hold WSS plus parallel API calls | measure real peak |
| `idleTimeoutMs` | 30000 | 30000 | keep-alive WSS keeps the socket active | keep |
| `preAuthLifetimeMs` | 5000 | 5000 | pre-certificate window must stay short | keep |
| `upstreamTimeoutMs` | 15000 | 15000 | bounds a slow Gateway response | keep |

These are **proposals**, not frozen values. Performance remains unmeasured until a later relay phase;
no throughput or latency claim is made.

## 9. Time dependency

| Item | Detail |
| --- | --- |
| Windows time source | OS time service (must be verified synchronised before trusting certificate validity) |
| Failure behaviour | clock skew means certificate validation fails → **remote access stops** |
| Relaxed validity windows | **not** an option; never widen validity to work around a clock problem |
