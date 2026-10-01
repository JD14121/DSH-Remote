# Phase R9-RELAY-01 — Offline Bridge & Relay Security Foundation

## 0. Authority

Owner:

```text
DSH
```

Architecture authority:

```text
R9-TRANSPORT-ADR-v3.md
```

Phase status on receipt:

```text
AUTHORIZED ONLY IF THE HUMAN OPERATOR EXPLICITLY APPROVES R9-RELAY-01
```

This phase is entirely offline/local.

Absolutely no public exposure.

---

# 1. Frozen upstream contracts

Do not modify:

```text
Operator DSH:
127.0.0.1:3080

Supervised DSH:
127.0.0.1:3081

Gateway:
127.0.0.1:9445

R7 lifecycle:
FROZEN

R8 REST / WS / auth / recovery / UI:
FROZEN
```

The new bridge may ultimately proxy only to:

```text
127.0.0.1:9445
```

Never:

```text
3080
3081
```

---

# 2. Phase goal

R9-RELAY-01 does NOT create remote access.

It establishes that the proposed R9 security boundary can be implemented safely in isolation:

```text
synthetic TLS client
        ↓
local TLS/mTLS bridge
127.0.0.1:9446
        ↓
synthetic fixture Gateway
```

No production Gateway.

No production Supervisor.

No real DSH.

No VPS.

No domain.

---

# 3. Public-network prohibition

During this phase:

```text
NO VPS provisioning
NO DNS change
NO frps public listener
NO port 443 exposure
NO port 7000 exposure
NO router change
NO firewall opening
NO 0.0.0.0 listener
NO LAN listener
```

Every test listener must be loopback-only.

Any non-loopback listener is:

```text
R9-RELAY-01 SECURITY FAILURE
```

---

# 4. Bridge ownership boundary

Introduce the R9 bridge as a separately owned process.

Target development bind:

```text
127.0.0.1:9446
```

It must not:

```text
start R7
stop R7
restart R7
spawn DSH
manage Gateway
read DSH credentials
```

The bridge is a transport/security mediator only.

---

# 5. Fixture upstream

Do not initially proxy to `9445`.

Create a synthetic fixture upstream on an isolated loopback port.

The fixture must be able to observe:

```text
method
path
Host
Origin presence/absence
allowed forwarded headers
body length
WS upgrade count
```

It must never require real secrets.

---

# 6. Certificate strategy for this phase

Use test-only certificates and CAs.

They must be clearly marked:

```text
R9 RELAY FIXTURE ONLY
NOT PRODUCTION
```

Do not generate:

```text
production CA
production Android certificate
production frpc certificate
production frps certificate
production HTTPS private key
```

Fixture credentials must never enter production roots.

---

# 7. mTLS gate

Before returning:

```text
static HTML
JS
CSS
API response
```

the bridge must authenticate the fixture client identity.

Test:

```text
no client certificate
foreign issuer
expired client certificate
wrong EKU
unknown enrollment
revoked identity
valid enrolled fixture identity
```

Expected:

```text
invalid → no application content/upstream request
valid → eligible for further policy checks
```

---

# 8. Identity policy

Prototype the ADR-v3 model:

```text
active enrollment allowlist
+
issuer/key-id/serial denylist
+
certificate fingerprint binding
+
monotonic policy generation
```

Use an isolated fixture state root.

Missing or corrupt policy:

```text
FAIL CLOSED
```

Never reconstruct an allowlist from connection history.

---

# 9. Policy update atomicity

Test:

```text
valid policy generation N

attempt update N+1
```

Required:

```text
atomic commit
then activate
```

Failed write:

```text
generation N remains authoritative
```

Do not claim a failed policy update succeeded.

---

# 10. SNI / authority policy

Define fixture hostname:

```text
relay-fixture.invalid
```

or another non-production reserved fixture identity.

Enforce exact configured SNI.

Enforce one canonical HTTP authority.

Reject:

```text
wrong Host
duplicate Host
absolute-form target confusion
userinfo-style authority
unconfigured port variant
ambiguous framing
```

No wildcard-host handling.

---

# 11. Origin matrix

For:

```text
unsafe HTTP methods
WebSocket upgrade
```

require exactly the configured HTTPS origin.

Reject:

```text
missing Origin
null
multiple Origin values
wrong scheme
wrong host
wrong port
```

For explicitly allowed:

```text
GET
HEAD
static assets
```

Origin may be absent after mTLS + authority validation.

If present, it must still match.

---

# 12. Fetch-metadata handling

Where browser fetch metadata exists:

reject clearly cross-site requests.

Do not use:

```text
Sec-Fetch-*
```

as authentication.

Tests must pass when legitimate clients omit the headers.

---

# 13. Route allowlist

Pin the existing accepted API surface:

```text
GET  /api/v1/health
GET  /api/v1/sessions
GET  /api/v1/sessions/:id
GET  /api/v1/sessions/:id/messages

POST /api/v1/sessions/:id/messages
POST /api/v1/sessions/:id/cancel
POST /api/v1/sessions/:id/uploads
POST /api/v1/auth/ws-ticket
POST /api/v1/sessions

WS   /api/v1/events
```

`POST /api/v1/sessions` is the explicit mobile New Session capability. Admit only this exact
method/path through the bridge after mTLS identity, canonical Host, and exact same-origin checks.
The Gateway then requires Phone authentication, an empty JSON object, and durable storage before
calling DSH `session/create` with an empty request. No caller-selected path, workspace, preset, or
session id is accepted. Do not add any other session collection methods or routes.

Unknown `/api/v1/*` must be refused.

Never fall back to HTML.

---

# 14. Static assets

The bridge may fixture-test static serving.

Preserve the distinction:

```text
/api/real-mode.js
/api/api-client.js
...
```

are browser modules.

They are NOT Gateway REST routes.

Do not regress R8G.1.

---

# 15. Fixed upstream

For fixture proxying:

one configured upstream only.

No client-controlled:

```text
hostname
port
scheme
proxy destination
CONNECT
forward proxy
```

Eventually production upstream is:

```text
127.0.0.1:9445
```

but R9-RELAY-01 remains fixture-only.

---

# 16. Header sanitization

Before forwarding:

set a fixed upstream Host.

Remove external:

```text
Origin
Forwarded
X-Forwarded-*
X-Real-IP
proxy identity headers
client-certificate supplied headers
```

Do not turn TLS identity into a spoofable HTTP header unless a later explicit contract requires it.

Forward only headers needed by existing Gateway behavior.

---

# 17. Authorization secrecy

Fixture tests must use canaries rather than real credentials.

Verify:

```text
Authorization
WS ticket
cookie
request body
query secret
```

never appear in:

```text
logs
error output
evidence
exception dump
full URL logging
```

---

# 18. WebSocket upgrade

Prove:

```text
one accepted external upgrade
→ at most one fixture upstream handshake
```

Reject invalid Origin before upstream connection.

Connection close must release both directions.

No retry of:

```text
consumed WS ticket
```

No bridge-generated application replay.

---

# 19. HTTP write semantics

The bridge must never automatically retry:

```text
POST messages
POST cancel
POST upload
POST ws-ticket
```

on connection failure.

Application retry remains owned by existing R8 contracts.

---

# 20. Revocation prototype

With identity A and identity B:

establish:

```text
A HTTP keepalive
A WebSocket
B control connection
```

Activate revocation of A.

Required:

```text
new A access denied
existing A HTTP sockets closed
existing A WS closed
B remains alive
```

Target:

```text
<= 5 seconds
```

Treat 5 seconds as a proposed release threshold and record actual timing.

Do not tune the test to manufacture a pass.

---

# 21. Resumption

Initially disable TLS session resumption/tickets where supported by the selected runtime.

Test reconnect after revocation.

A revoked identity must not regain access using an old TLS session.

If the runtime cannot provide a provable mechanism:

```text
BLOCK
```

Do not waive it.

---

# 22. Resource limits

Define explicit numeric fixture limits for at least:

```text
TLS handshake timeout
header size
header timeout
connection count
per-identity connection count
idle timeout
pre-auth connection lifetime
```

Do not copy arbitrary defaults without documenting them.

Do not run Internet load tests.

Use bounded local synthetic tests only.

---

# 23. Slow-client tests

Locally test:

```text
slow TLS establishment
slow/incomplete headers
connection flood within bounded fixture scale
abandoned WS upgrade
```

Required:

```text
resources recover
bridge remains responsive
owned sockets close on stop
```

---

# 24. Safe static UI strategy

Determine how the accepted R8 web UI becomes a deterministic production static artifact.

Do not redesign the UI.

Document:

```text
source directories
asset manifest
content hashes
build/copy process
cache policy
version identifier
```

The production bridge must never depend on:

```text
npm run ui:dev
port 8099
ADB reverse
```

---

# 25. CSP

Preserve same-origin architecture.

Target production UI:

```text
https://H/
```

and API/WS:

```text
https://H/api/...
wss://H/api/v1/events
```

Prefer retaining:

```text
connect-src 'self'
```

Do not add wildcard CSP.

Fixture tests must pin the intended production CSP.

---

# 26. frp selection — review only

Select a candidate frp release.

Do not deploy it publicly.

Record:

```text
version
official source
release hash/signature provenance where available
required features
disabled features
```

Verify from the pinned release/config model:

```text
HTTPS/SNI passthrough
transport TLS
mutual verification
custom-domain registration
work-connection authentication behavior
feature-disable options
```

Do not assume generic documentation exactly matches an unpinned binary.

---

# 27. No frp SSH

Ensure selected configuration does not use or enable:

```text
frp SSH
Tailscale SSH
system SSH
reverse SSH
```

NO-SSH remains frozen.

---

# 28. Tunnel identity versus registration

Determine exactly how the selected frp version restricts an authenticated frpc to the intended proxy/domain.

If the product provides no adequate restriction:

record the limitation and design compensating server-side policy.

Do not equate:

```text
valid tunnel client certificate
```

with:

```text
authorized to publish arbitrary proxies
```

If this cannot be made safe:

```text
R9-RELAY-01 BLOCKED
```

---

# 29. Public certificate design review

No real certificate issuance yet.

Document a concrete future plan for:

```text
DNS-01
CAA CA restriction
CAA validationmethods=dns-01
CAA accounturi
issuewild denial
ACME account custody
DNS credential custody
server private-key custody
CT monitoring
```

Verify chosen CA/DNS provider capabilities before R9-RELAY-02.

Unknown provider capability remains:

```text
NOT_PROVEN
```

---

# 30. Four-identity test

Prove in documentation/config fixtures that four identities are nonreused:

```text
public HTTPS server
Android client
frpc client
frps server
```

No key pair may satisfy two roles.

---

# 31. Android feasibility remains NOT_RUN

Do not manufacture success using desktop TLS tools.

R9-RELAY-01 may prepare the browser acceptance procedure, but actual Android:

```text
KeyChain
client certificate UX
HTTPS
WSS
```

remains:

```text
NOT_RUN
```

until R9-RELAY-04.

---

# 32. Tailscale

Existing Tailscale installation/enrollment may remain untouched.

It is not part of the serving path.

Do not:

```text
enable Serve
enable Funnel
enable routes
enable exit node
enable Tailscale SSH
```

---

# 33. R7/R8 protection

Before and after:

verify protected R7/R8 files or regression state.

R9-RELAY-01 must not alter their contracts.

Expected baseline:

```text
1485 tests
1476 pass
0 fail
9 skipped
R5A PASS
```

If baseline has legitimately grown due to new R9 tests:

```text
0 failures
same 9 known skips unless separately explained
```

is authoritative.

---

# 34. Test mapping

Produce evidence against:

```text
A1 TLS
A3 Tunnel
A4 Routing
A5 Frozen auth
A6 Revocation
A7 Resources
```

For A5 during fixture tests:

use synthetic bearer/ticket canaries.

Do NOT claim actual R6 integration acceptance yet.

A2/A8/A9 remain partially or wholly NOT_RUN where real relay/resources are required.

---

# 35. Files

Prefer isolated new R9 paths.

Do not scatter bridge code through R7/R8 modules.

Architecture should visibly preserve ownership.

Document every modified file.

---

# 36. Evidence

Create an R9-RELAY-01 evidence directory.

Record sanitized machine-readable results for:

```text
TLS matrix
Host/SNI matrix
Origin matrix
route/method matrix
header stripping
secret canaries
WS handshake count
revocation
resource limits
frp pinned-release review
static asset manifest
regression
```

No real secrets.

---

# 37. Required report

Create:

```text
PHASE-R9-RELAY-01-REPORT.md
```

Answer at minimum:

```text
What bridge runtime was selected?

What binds 127.0.0.1:9446?

Was any non-loopback listener created?

Were any production credentials generated?

Did invalid mTLS clients receive any static/API content?

Did SNI/Host policy pass?

Did the Origin matrix pass?

Were unknown API routes refused?

Did one external WS upgrade create at most one upstream handshake?

Were write requests automatically retried?

Did secret canaries appear in logs?

Did identity revocation close existing connections?

What was measured revocation time?

Could TLS resumption bypass revocation?

What numeric resource limits were selected?

Did bounded resource tests recover?

How is the production UI static artifact generated?

Does CSP retain same-origin semantics?

What frp release is proposed?

Was that exact release/config model reviewed?

Can an authenticated frpc register arbitrary proxies/domains?

If yes, what blocks deployment?

Were any VPS/domain/firewall/public-listener changes made?

Expected:
NO.

Were R7/R8 contracts modified?

Expected:
NO.

Did full regression pass?

Which A1–A9 gates remain NOT_RUN?
```

---

# 38. PASS

R9-RELAY-01 may pass only if:

```text
bridge is loopback-only

fixture mTLS fail-closed

Host/SNI/Origin policy proven

route boundary proven

secret logging clean

WS one-handshake rule proven

no write/ticket retry

revocation prototype proven

resumption cannot bypass revocation

resource limits explicit and tested

production static artifact strategy defined

frp release/config reviewed

no public exposure

R7/R8 unchanged

regression green
```

It does NOT require a VPS or domain.

---

# 39. Success state

```text
R9-RELAY-01 COMPLETE

OFFLINE BRIDGE SECURITY FOUNDATION ACCEPTED

NO PUBLIC EXPOSURE CREATED

R7/R8 REMAIN FROZEN

R9-RELAY-02 REQUIRES SEPARATE HUMAN AUTHORIZATION

STOPPING HERE.
```

---

# 40. Failure state

Any unresolved core control:

```text
R9-RELAY-01 BLOCKED

DO NOT WEAKEN THE CONTROL TO PASS

NO PUBLIC EXPOSURE

STOPPING HERE.
```
