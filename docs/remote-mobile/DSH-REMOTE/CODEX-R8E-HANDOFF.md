# Codex Handoff — Phase R8E

## Replay, Resync & Interrupted-Stream Recovery

---

# 0. Purpose of this handoff

You are temporarily taking over **one phase only** of an existing DSH Remote project.

```text
Assigned phase:
R8E — Replay, Resync & Interrupted-Stream Recovery

Your role:
Temporary implementation owner for R8E only

Previous implementation owner:
DSH

Expected owner after R8E:
DSH again

DO NOT continue into:
R8F
R8G
R9
```

The primary requirement is:

> Complete R8E without disturbing the contracts, project structure, audit trail, or assumptions that DSH will rely on when it resumes work in later phases.

This is **not a refactor opportunity**.

Do not redesign the project.

Do not reinterpret earlier phases unless a genuine contradiction blocks R8E.

---

# 1. Project location

```text
D:\DSH-testing\dsh-remote-gateway
```

Primary runtime environment:

```text
Windows 11
PowerShell 5.1
Node.js 24.x
npm 11.x
```

DSH package:

```text
@deepseek-ai/dsh@0.1.5-rc.2
```

Existing interactive DSH normally uses:

```text
127.0.0.1:3080
```

R7 supervised DSH used:

```text
127.0.0.1:3081
```

Gateway:

```text
127.0.0.1:9445
```

R8 local development UI:

```text
127.0.0.1:8099
```

---

# 2. Product goal

The final product is a mobile-friendly browser chat client for a DSH agent running on the user's PC.

Architecture:

```text
Phone / Mobile Browser
          │
          │ REST + WebSocket
          ▼
Remote Gateway
          │
          │ DshAdapter
          ▼
         DSH
```

The phone UI is:

```text
a chat client
```

It is **not**:

```text
a terminal
a shell
a process manager
a DSH lifecycle controller
```

---

# 3. Security architecture

The project deliberately separates several credentials.

## Phone credential

Long-lived Phone Access Token.

Used for authenticated REST:

```text
Authorization: Bearer <Phone Token>
```

Browser storage:

```text
sessionStorage only
```

Forbidden:

```text
localStorage
IndexedDB
URL
query string
logs
error text
```

---

## WebSocket ticket

The Phone Bearer is used to request:

```text
POST /api/v1/auth/ws-ticket
```

That returns a:

```text
short-lived
single-use
memory-only
WebSocket ticket
```

The WebSocket uses:

```text
/api/v1/events?ticket=<one-time-ticket>&session_id=...
```

The long-lived Phone Bearer must never appear in a WS URL.

---

## DSH credentials

DSH launch token and `dsh-auth-*` cookie are server-side concerns.

The browser must never see them.

Do not read or modify:

```text
.credentials.yaml
```

---

# 4. Frozen architecture

The project already has these major layers:

```text
UI
 │
 ├── ApiClient
 │     └── REST
 │
 ├── EventClient
 │     └── WebSocket
 │
 ├── UI state
 │
 ├── safe rendering
 │
 └── recovery layer     ← R8E goes here

Gateway
 │
 ├── REST routes
 ├── WebSocket protocol
 ├── AuthService
 ├── SessionsService
 ├── StatusService
 ├── EventsService
 ├── Persistence
 └── DshAdapter
```

R8E is primarily a **browser recovery/orchestration phase**.

Do not move recovery responsibility into Gateway unless a proven protocol gap makes the existing contract impossible.

---

# 5. Historical phase state

Treat the following as accepted baselines.

```text
R0   ACCEPTED
R1   ACCEPTED
R2   ACCEPTED
R3   ACCEPTED
R4   ACCEPTED
R5A  ACCEPTED
R6   ACCEPTED

R7   CONDITIONALLY ACCEPTED FOR R8 DEVELOPMENT
     NOT production-complete

R8A    ACCEPTED
R8A.1  ACCEPTED
R8A.1A ACCEPTED

R8B  ACCEPTED
R8C  ACCEPTED
R8C.1 ACCEPTED
R8D  ACCEPTED

R8E  CURRENT ASSIGNMENT
```

Do not reopen accepted phases without concrete blocking evidence.

---

# 6. Permanent R7 limitation

Keep this limitation intact:

```text
R7-KNOWN-LIMITATION-01

A verified owned DSH listener may survive graceful shutdown
on Windows even after termination has been issued.
```

Consequences:

```text
R8 development is allowed.

Production unattended lifecycle is NOT accepted.

R9 final production acceptance remains blocked.
```

The UI must not expose:

```text
Start DSH
Stop DSH
Restart DSH
Kill DSH
```

R8E must not attempt to fix R7.

---

# 7. R8 UI state model

There are exactly **8 domain states**:

```text
idle
queued
running
waiting_input
completed
failed
cancelled
disconnected
```

Do not add a ninth.

In particular, these are NOT domain states:

```text
streaming
thinking
replaying
connecting
live
```

There are exactly **6 UI connection states**:

```text
auth_required
connecting
connected
reconnecting
resync_required
gateway_unavailable
```

Domain state and connection state are independent.

This is valid:

```text
running + reconnecting
```

Do not collapse the two axes.

---

# 8. Current REST surface

The UI already integrates:

```text
GET  /api/v1/health

GET  /api/v1/sessions

GET  /api/v1/sessions/:sessionId

GET  /api/v1/sessions/:sessionId/messages

POST /api/v1/sessions/:sessionId/messages

POST /api/v1/sessions/:sessionId/cancel

POST /api/v1/sessions/:sessionId/uploads

POST /api/v1/auth/ws-ticket
```

This route remains deliberately absent:

```text
POST /api/v1/sessions
```

Do not add it.

The New Session UI remains deferred/disabled.

---

# 9. Session discovery — already resolved

R8C found that the old implementation did this:

```text
DshAdapter.listSessions() → 37
GET /api/v1/sessions      → 0
```

R8C.1 fixed it.

Current HTTP path:

```text
GET /api/v1/sessions
      ↓
SessionsService.listFresh()
      ↓
adapter.listSessions()
      ↓
merge into SessionViewStore
      ↓
paginate
```

The production-class regression now proves:

```text
store before request : 0
adapter sessions      : 37
REST sessions         : 37
duplicates            : 0
```

Do not undo this.

---

# 10. Session retention semantic — human decision

A later audit found that the store is intentionally additive.

Current behavior is:

```text
GET /api/v1/sessions
=
current DSH adapter enumeration
UNION
previously tracked Gateway sessions
```

Example:

```text
adapter:
  dsh-1
  dsh-2

Gateway store:
  gateway-only
  dsh-1
  dsh-2

REST:
  dsh-1
  dsh-2
  gateway-only
```

Human decision for R8:

```text
OPTION A — KEEP UNION
```

Reason:

absence from `adapter.listSessions()` does not prove deletion.

It could mean:

```text
archived
filtered
temporarily unavailable
not enumerated
or actually deleted
```

The current DSH contract does not distinguish those cases.

Therefore R8E must:

```text
preserve current union semantic
```

and must NOT implement deletion semantics.

Future explicit deletion semantics belong to a later backend phase.

---

# 11. R8B UI foundation

R8B implemented the static UI shell.

Technology:

```text
HTML5
CSS
ES Modules
DOM APIs
```

No:

```text
React
Vue
Next.js
bundler
frontend framework
```

Important security invariant:

```text
model/user content must never be inserted using innerHTML
```

Safe rendering already exists.

Do not replace it.

---

# 12. Non-blocking UI polish backlog

Human visual review accepted the current UI for development.

Known cosmetic issues:

```text
text/composer spacing can feel tight

large flat colour surfaces reduce visual depth

additional tonal hierarchy may improve aesthetics
```

Recorded as:

```text
R8-UI-POLISH-BACKLOG-01
```

It does NOT block R8E.

R8E may make only small visual changes required for:

```text
resync loading
resync error
retry
reconnected confirmation
```

Do not redesign the interface.

---

# 13. R8C REST client

REST integration already exists.

Browser-side boundary:

```text
ApiClient
```

Components must not issue arbitrary `fetch()` calls.

Credential behavior is already frozen:

```text
401
→ clear credential
→ auth_required

network failure
→ preserve credential
→ gateway_unavailable
```

Do not break this distinction.

---

# 14. R8D WebSocket implementation

R8D is accepted.

The browser already has:

```text
src/remote/ui/ws/
```

with approximately:

```text
event-normalizer.js
ticket-client.js
stream-assembler.js
event-client.js
reconnect-controller.js
live-session.js
```

Use the actual repository as authority for exact filenames.

---

# 15. EventClient ownership

`EventClient` is the only browser module allowed to own/create a WebSocket.

Do not construct sockets inside:

```text
components
recovery UI
ApiClient
state modules
```

R8D tests structurally enforce this.

Preserve the invariant.

---

# 16. Existing WebSocket contract

Route:

```text
/api/v1/events
```

Subprotocol:

```text
dsh-remote-v1
```

Handshake/replay:

```text
ticket
↓
WebSocket upgrade
↓
hello
↓
replay
↓
replay_complete
↓
live
```

One active socket corresponds to one active session.

Do not invent multi-session multiplexing.

---

# 17. Current sequence discipline

R8D already enforces:

```text
seq <= lastAppliedSequence
→ ignore duplicate/already-applied

seq == lastAppliedSequence + 1
→ apply
→ advance watermark

seq > lastAppliedSequence + 1
→ gap
→ DO NOT apply
→ DO NOT advance watermark
→ enter resync_required
```

After a detected gap, later events remain suppressed.

Do not weaken this behavior.

---

# 18. `lastAppliedSequence`

It may come only from server-derived information.

Current accepted sources:

```text
REST snapshot/session state
actual Gateway event sequence
```

Never manufacture it from:

```text
Date.now()
message count
local counter
array index
```

R8D has structural tests around this.

---

# 19. Streaming behavior already implemented

R8D already guarantees:

```text
assistant.start
→ create one transient assistant message

assistant.delta
→ append to that same message

assistant.end
→ finalize it
```

Replay duplicate example already passes:

```text
start
chunk A
disconnect
replay chunk A
chunk B
end

result:
AB
not AAB
```

Do not replace the stream assembler.

R8E should reconcile recovery around it.

---

# 20. Interrupted stream behavior

Current accepted behavior on disconnect:

```text
partial assistant content remains visible

stream cursor stops

message becomes interrupted

NO fake assistant.end is created

NO completion is invented
```

R8E must preserve this invariant.

---

# 21. Existing reconnect behavior

R8D already implements basic reconnect:

```text
socket loss
→ reconnecting
→ bounded backoff
→ fresh WS ticket
→ new socket
→ last_sequence supplied
→ normal replay
```

Backoff is:

```text
bounded
cancelable
reset after healthy connection
```

Do not replace this with a second reconnect system.

R8E should orchestrate on top of it.

---

# 22. Existing generation protection

R8D already protects against stale socket callbacks using connection generations/session identity.

Examples already tested:

```text
connect A
switch B
late frame from A
→ ignored
```

and:

```text
pending reconnect for A
switch B
→ old reconnect cannot resurrect A
```

R8E needs an equivalent **recovery generation** for REST/recovery chains.

Do not remove existing connection-generation protection.

---

# 23. R8E exact objective

R8D stops when recovery cannot safely continue.

R8E completes the recovery flow.

Two paths must remain distinct.

## Path A — normal replay

```text
disconnect
→ reconnect
→ fresh ticket
→ replay
→ replay_complete
→ live
```

No REST history reload.

## Path B — full resync

```text
sequence gap
OR explicit server resync requirement
OR replay cannot cover retained history

→ resync_required

→ operator activates:
   Reload conversation

→ GET authoritative REST history
→ rebuild local timeline atomically
→ reseed lastAppliedSequence
→ fresh ticket
→ new EventClient generation
→ hello
→ replay
→ replay_complete
→ connected
```

Do not turn every reconnect into a REST reload.

---

# 24. Source task specification

The binding R8E task is:

```text
Phase R8E — Replay, Resync & Interrupted-Stream Recovery
```

Use the supplied R8E taskbook as the detailed implementation contract.

If this handoff summary and the R8E taskbook appear to conflict:

```text
1. existing accepted runtime contracts
2. R8E taskbook
3. this handoff summary
```

in that order.

Do not resolve contradictions silently.

Report them.

---

# 25. Recovery ownership

Prefer a dedicated browser recovery layer, for example:

```text
src/remote/ui/recovery/
  recovery-controller.js
  resync-controller.js
  timeline-reconciler.js
```

Exact file decomposition may differ if the existing project architecture suggests a cleaner equivalent.

However, preserve clear ownership:

```text
components
→ display + user action

recovery controller
→ orchestration

ApiClient
→ REST transport

EventClient
→ WS transport
```

Components should not orchestrate REST + ticket + WS directly.

---

# 26. Recovery generation

Every resync/reload chain must be generation-protected.

Example:

```text
Session A:
  recovery generation 11 starts

user switches to Session B

A REST response returns late
```

Required:

```text
generation 11 is stale
→ ignore result
```

Never overwrite B.

Use AbortController where existing ApiClient design allows it, but generation checks remain required because cancellation is not a correctness guarantee.

---

# 27. Entering `resync_required`

Possible triggers:

```text
client sequence gap

server explicit resync_required

replay retention miss / replay unavailable
```

Once entered:

```text
connectionState = resync_required
```

Normal future frame application must stop/be isolated.

Never continue applying sequence N+5 while N+1…N+4 are unknown.

---

# 28. Resync UX

Existing UI text:

```text
Conversation changed while you were offline.

[ Reload conversation ]
```

Substates:

```text
ready_to_reload
loading
reconnected
reload_failed
```

These are local resync substates.

Do NOT create a seventh UI connection state.

---

# 29. Do not clear timeline before reload succeeds

When the operator presses:

```text
Reload conversation
```

the existing timeline remains visible.

Transition:

```text
existing timeline
+ loading indication
```

REST reload happens in the background.

Only after successful validation is the replacement applied atomically.

On failure:

```text
existing timeline remains
retry remains available
```

A blank page is not acceptable.

---

# 30. Authoritative REST resync

Use existing ApiClient:

```text
GET /api/v1/sessions/:id

GET /api/v1/sessions/:id/messages
```

The browser does not parse the Gateway durable journal directly.

The browser does not call DSH directly.

REST history is the browser's authoritative reset view.

---

# 31. Timeline replacement must be atomic

Required pattern:

```text
fetch
↓
normalize into replacement state
↓
validate session
↓
validate recovery generation
↓
validate sequence seed
↓
commit once
```

Forbidden:

```text
clear old state
↓
fetch
↓
fail
↓
user has nothing
```

---

# 32. Preserve local user work

During full resync preserve where applicable:

```text
composer draft

unsent text

local file selections

UI scroll intention
```

Do not:

```text
log the user out
clear the draft
drop attachment selection
```

unless an explicit security/error contract requires it.

---

# 33. Server history wins

After successful REST reload:

```text
server-derived history is authoritative
```

Optimistic browser messages may be retained only if identity proves they correspond to an unsynchronized logical operation.

If identity is insufficient:

```text
do not guess
```

Prefer authoritative server history.

---

# 34. Message identity limitation

R8C submissions already use stable:

```text
requestId
```

Audit whether REST history exposes enough identity to reconcile:

```text
optimistic user message
↔ durable user message
```

If it does:

use it.

If it does not:

record:

```text
R8E_MESSAGE_IDENTITY_LIMITATION
```

Do not invent an ID correlation algorithm.

Do not modify the backend unless this makes R8E impossible.

---

# 35. Interrupted stream + normal replay

Scenario:

```text
assistant.start
chunk A
chunk B
disconnect
```

Partial:

```text
AB
```

Replay:

```text
chunk B
chunk C
assistant.end
```

Final:

```text
ABC
```

not:

```text
ABBC
```

Existing R8D dedup logic should make this possible.

Reuse it.

---

# 36. Interrupted stream + full resync

If replay cannot recover:

```text
partial transient message exists
```

then REST reload provides authoritative history.

A local interrupted transient must not survive beside its final server version as a duplicate.

Do not blindly append the REST history to the existing timeline.

Reconcile/replace.

---

# 37. Sequence reseeding

After successful authoritative reload:

new `lastAppliedSequence` must come from server-derived state only.

Preferred:

```text
session.last_sequence
```

or equivalent existing REST authoritative metadata.

Never use:

```text
gap.received
Date.now()
history.length
local counter
```

After reseeding, old gap metadata may be cleared.

---

# 38. WS after full resync

After successful REST reload:

```text
invalidate old EventClient generation

obtain NEW one-time WS ticket

construct/connect new EventClient

send/use new last_sequence seed

wait for:
hello
replay
replay_complete
```

Only after:

```text
replay_complete
```

may connection state become:

```text
connected
```

---

# 39. Replay dedup after REST reload

Example:

```text
REST seed = 40

replay:
38
39
40
41
42
```

Expected:

```text
38–40 ignored

41–42 applied

lastAppliedSequence = 42
```

No duplicate message/event side effects.

---

# 40. A new gap after resync is still a gap

If:

```text
REST seed = 40
```

and first live/replay durable event is:

```text
45
```

then:

```text
resync_required
```

again.

Do not relax gap checks merely because a resync just happened.

---

# 41. Single-flight resync

Repeated clicks:

```text
Reload conversation
Reload conversation
Reload conversation
```

must produce:

```text
one REST reload chain
one ticket request
one new socket
```

until the active attempt completes or fails.

---

# 42. Session switch during recovery

Example:

```text
Session A resync loading
→ user selects B
```

Required:

```text
invalidate A recovery generation

abort A requests when possible

cancel A reconnect/recovery work

continue B normally

ignore all late A callbacks
```

This is a correctness requirement.

---

# 43. Recovery error classes

## 401

```text
clear Phone credential
→ auth_required
```

Stop recovery.

Do not request another WS ticket.

## Network failure

```text
preserve credential
preserve timeline
show retry/unavailable state
```

Do not return to token entry.

## 404 session

```text
session unavailable/disappeared
stop reconnecting that session
refresh session list
```

Use existing error vocabulary where possible.

Do not invent backend codes unnecessarily.

---

# 44. Recovery loops must be bounded

Protect against:

```text
reload
→ connect
→ immediate resync_required
→ reload
→ connect
→ immediate resync_required
→ ...
```

No infinite loop.

After a bounded number of automatic transitions:

```text
remain in resync_required / reload_failed
wait for explicit user action
```

---

# 45. Security remains binding

All data from:

```text
REST history
WS replay
WS live frames
```

is untrusted.

Continue using existing safe DOM rendering.

Test hostile content such as:

```text
<script>
<img onerror=...>
javascript:
```

Nothing may execute.

---

# 46. CSP

Keep:

```text
connect-src 'self'
```

Do not widen it.

---

# 47. Fixture isolation

All:

```text
#fixture=...
```

modes remain completely offline:

```text
0 REST
0 WS
0 ws-ticket
```

Recovery fixtures may simulate states locally.

They must not accidentally trigger real network code.

---

# 48. Gateway protocol protection

Do not modify:

```text
R4 WS frame semantics

R5 journal format

R5 sequence allocator

R5 replay retention

R6 one-time ticket semantics

DshAdapter protocol

Supervisor

DshProcess
```

If R8E genuinely cannot be implemented without changing any of these:

STOP.

Report:

```text
R8E BLOCKED — PROTOCOL GAP — STOPPING HERE.
```

Do not silently repair the backend.

---

# 49. Current runtime regression baseline

After accepted R8D:

```text
R8D tests:
85 pass / 0 fail

Full project suite:
1309 total
1300 pass
0 fail
9 skipped

R5A compliance:
PASS
```

The 9 skips are existing R7 live-smoke-related skips.

Do not convert them into fabricated passes.

---

# 50. Required test families

Expected R8E coverage includes at least:

```text
recovery controller

full resync

normal replay reconciliation

stream reconciliation

session-switch races

error handling

security

end-to-end REST + WS integration
```

Suggested files:

```text
tests/remote/r8e-recovery-controller.test.mjs
tests/remote/r8e-resync.test.mjs
tests/remote/r8e-replay-reconciliation.test.mjs
tests/remote/r8e-stream-reconciliation.test.mjs
tests/remote/r8e-session-switch.test.mjs
tests/remote/r8e-recovery-errors.test.mjs
tests/remote/r8e-security.test.mjs
tests/remote/r8e-integration.test.mjs
```

Names may differ if equivalent coverage is clearer.

---

# 51. Mandatory scenarios

At minimum prove:

```text
normal reconnect → replay → live
without REST reload

client sequence gap → resync_required

explicit server resync_required

authoritative REST reload

failed REST reload retains old timeline

401 clears credential

network failure preserves credential

404 stops reconnect for missing session

double Reload is single-flight

session switch invalidates old recovery

old socket callback ignored

old REST result ignored

fresh WS ticket after successful reload

replay <= snapshot seed is deduplicated

replay > seed applies normally

second post-resync gap re-enters resync

interrupted stream recovered through replay

interrupted stream reconciled through full reload

draft survives recovery

local attachment selection survives

hostile content remains inert
```

---

# 52. Full integration test

At least one test must use:

```text
real ApiClient

real EventClient

real recovery controller

real UI state/component path

controlled real HTTP fixture

controlled real WebSocket fixture
```

It should exercise something equivalent to:

```text
connected

→ assistant stream begins

→ partial content arrives

→ socket disconnects

→ reconnect attempt

→ replay cannot fully recover / resync_required

→ REST authoritative reload

→ new ticket

→ new WebSocket

→ replay_complete

→ connected
```

Final assertions:

```text
no duplicate messages

draft preserved

partial/final assistant history coherent

one current socket

correct sequence watermark

old generation cannot mutate state
```

---

# 53. Live DSH / production smoke

Do NOT automatically start the R7 production Supervisor.

R7 lifecycle is still not production-qualified.

If a safe Gateway is already running, a read-only smoke may use:

```text
sessions

messages

ticket

WS connect

disconnect/reconnect
```

Do not automatically generate a model prompt.

Otherwise record:

```text
live_resync_smoke = deferred_to_R8G
```

This does not block R8E if production-class integration tests satisfy the contract.

---

# 54. Documentation obligations

Do not rewrite older reports.

Preserve historical audit data.

Create:

```text
PHASE-R8E-REPORT.md

docs/remote-mobile/_evidence/r8e-recovery.json
```

If needed append/update only narrowly relevant R8 contract documentation.

Do not rewrite R8A–R8D reports to make them look as though R8E behavior existed earlier.

---

# 55. DSH continuity requirements

This section is especially important.

DSH will resume the project after Codex completes R8E.

Therefore:

### Preserve naming

Do not gratuitously rename:

```text
ApiClient
EventClient
LiveSession
SessionViewStore
existing UI state concepts
existing event names
```

### Preserve directories

Prefer adding:

```text
src/remote/ui/recovery/
```

rather than moving existing `api/`, `ws/`, `components/`, or `state/`.

### Preserve frozen contracts

Do not redesign:

```text
REST response shapes
WS frames
state vocabulary
auth vocabulary
error vocabulary
```

### Minimize edits

Prefer:

```text
new recovery modules
small integration changes
focused tests
focused documentation
```

Avoid broad formatting or cleanup changes.

### Do not reformat unrelated files

This project has no normal VCS safety net.

Byte changes matter for audit.

### Preserve evidence style

Later DSH phases expect:

```text
machine-readable evidence
explicit test counts
honest N/A / deferred entries
exact stop statement
```

Keep that pattern.

---

# 56. Do not alter unrelated projects

Out of scope:

```text
D:\DSH-testing\dsh-gpt-planner-bridge

codex-dsh-bridge

manual-loop
```

Do not repair their unrelated test failures.

Known external baselines remain external.

---

# 57. No broad process killing

Never use:

```text
Stop-Process -Name node
taskkill /IM node.exe
```

or any image-name-wide kill.

Only exact owned PID actions are permitted where the existing project already authorizes them.

R8E should not need process termination at all.

---

# 58. Encoding/process discipline

Continue existing project discipline:

```text
UTF-8
no BOM
no U+FFFD
no invalid UTF-8
```

Avoid destructive Windows text-writing patterns that previous compliance checks prohibit.

Use Node filesystem APIs for generated text where appropriate.

---

# 59. Regression commands

At completion run:

```text
npm run test:r8e
npm run test:r8d
npm run test:r8c1
npm run test:r8c
npm test
npm run compliance:r5a
```

Expected:

```text
R8E:
0 failures

R8D:
85 pass / 0 fail baseline preserved or intentionally expanded without regression

R8C:
86 pass / 0 fail baseline preserved

R8C.1:
14 pass / 0 fail baseline preserved

Full suite:
0 failures
existing R7 skips remain honestly reported

R5A:
PASS
```

Also run the project's existing encoding/process gate.

---

# 60. Evidence file

Create:

```text
docs/remote-mobile/_evidence/r8e-recovery.json
```

At minimum record actual values for:

```json
{
  "phase": "R8E",
  "implementation_owner": "Codex",
  "normal_replay_without_reload": true,
  "sequence_gap_enters_resync": true,
  "rest_reload_atomic": true,
  "draft_preserved": true,
  "local_attachments_preserved": true,
  "old_generation_ignored": true,
  "fresh_ticket_after_resync": true,
  "replay_dedup_after_reload": true,
  "interrupted_stream_reconciled": true,
  "double_reload_single_flight": true,
  "resync_loop_bounded": true,
  "unsafe_html_sinks": 0,
  "session_retention_decision": "A_keep_union",
  "live_resync_smoke": "deferred_to_R8G",
  "r8f_started": false,
  "r9_started": false
}
```

Do not blindly write `true`.

Use measured results.

---

# 61. Required R8E report

Create:

```text
PHASE-R8E-REPORT.md
```

The report must explicitly say:

```text
Implementation owner for R8E:
Codex
```

and answer:

```text
Is normal replay handled without REST reload?

What exactly triggers full resync?

Can frames continue applying after a gap?

Is REST reload atomic?

Does the existing timeline survive reload failure?

Are drafts preserved?

Are local attachment selections preserved?

How is last_sequence reseeded?

Can replay duplicate REST-loaded history?

Can interrupted streaming duplicate a final assistant message?

Does full resync obtain a fresh WS ticket?

Can an old socket affect the new connection?

Can a stale REST response overwrite another session?

Are repeated Reload clicks single-flight?

Can resync loop indefinitely?

How are 401, network failure and 404 distinguished?

Was any R4/R5/R6 protocol changed?

Was session retention behavior changed?

Expected:
NO — Option A retained.

Was R8F started?

Was R9 started?
```

---

# 62. Explicit DSH resume section

At the end of `PHASE-R8E-REPORT.md`, add:

```text
## DSH Resume Notes
```

This must concisely list:

```text
files added

existing files modified

new recovery ownership boundaries

new public/internal APIs introduced

new UI substates

test files added

known limitations

deferred live smoke

whether any accepted contract changed

exact recommended next phase
```

The purpose is that DSH can resume R8F without reverse-engineering Codex's implementation.

---

# 63. Handoff compatibility note

Prefer new internal APIs that are:

```text
small
explicit
documented
stable
```

Avoid clever hidden coupling.

If you create a recovery controller API, document something like:

```text
start(...)
reload(...)
cancel(...)
switchSession(...)
dispose(...)
```

only if those concepts match the actual implementation.

Do not invent API names merely to satisfy this document.

Report the real interface you implemented.

---

# 64. R8F must not begin

Even if R8E passes all tests:

STOP.

Do not implement:

```text
R8F
R8G
R9
```

The next phase must be approved by the human and resumed under DSH.

---

# 65. Exact completion statements

Success:

```text
R8E COMPLETE — STOPPING HERE.
```

Protocol blocker:

```text
R8E BLOCKED — PROTOCOL GAP — STOPPING HERE.
```

Failure:

```text
R8E FAILED — STOPPING HERE.
```

Followed by:

```text
IMPLEMENTATION OWNER:
  CODEX

NEXT OWNER:
  DSH AFTER HUMAN ACCEPTANCE

DO NOT START R8F
DO NOT START R9
```

---

# 66. Final execution principle

For this phase:

```text
Preserve accepted behavior.
Add recovery orchestration.
Prove it with failure-oriented tests.
Document every contract boundary.
Stop exactly at R8E.
```

The best R8E implementation is one where, after acceptance, DSH can read the report and continue to R8F without needing to undo, reinterpret, or reverse-engineer Codex's work.
