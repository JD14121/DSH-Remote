# dsh-remote-gateway

Phases **R1-R6** of the DSH Remote Mobile task book, plus the **R5A** compliance
remediation gate.

* **R1** — DSH Adapter Boundary & Contract Tests
* **R2** — Session / Message / Event Domain Model
* **R3** — Loopback REST API v1 & StatusService
* **R4** — Realtime WebSocket Event Stream
* **R5** — Durable Event Journal, Recovery & Cross-Restart Replay
* **R5A** — Compliance Remediation & Acceptance Gate (no new features)
* **R6** — Phone Authentication & Security Hardening

This project is the **single, stable, testable boundary** between a future mobile
chat client and the DSH instance already running on this machine, plus the domain
model, loopback REST surface, WebSocket event stream, durable journal and
authentication layer built on top of it.

> **Current scope.** The full R1-R6 stack.
> **Not yet built:** the supervisor and credential bootstrap, the debug UI, and
> SSH/Tailscale transport.

> **Honest status.** R5's implementation passed its tests but its **process gate was
> violated** — see `PHASE-R5-REPORT.md` for the two violations, retained in the audit
> record. R5A closed them structurally and re-verified acceptance; see
> `PHASE-R5A-REPORT.md`.

---

## Authentication is also an explicit decision

The server factory **requires** both a durability decision and an auth decision.
Omitting either is a programming error, not an implicit default:

```js
createRemoteHttpServer({ ...services, auth, persistenceConfig: {} })
createRemoteHttpServer({ ...services, auth: null, persistence: null })  // synthetic fixture
createRemoteHttpServer({ ...services })                                 // TypeError
```

That shape exists because R5's incident was caused by an implicit default: a test
that never mentioned persistence wrote the real `$DSH_HOME\remote`. An implicit
*safety* default is a hazard; an implicit *unsafe* one is worse.

### The two-credential model

```text
REST     Authorization: Bearer <PHONE_TOKEN>     long-lived, header only
WS       ?ticket=<one-time ticket>               30 s, single use, bound
```

A browser cannot set `Authorization` on a WebSocket, and a long-lived secret must not
go in a URL. A **ticket** bridges that gap: short-lived, single-use, session-bound and
origin-bound, so a leak is bounded rather than permanent.

```powershell
npm run fixture:r6   # the full auth flow, synthetic credential, never printed
```

Docs: [`docs/r6-auth-contract.md`](docs/r6-auth-contract.md) ·
[`docs/r6-security-model.md`](docs/r6-security-model.md) ·
[`docs/r5-persistence-design.md`](docs/r5-persistence-design.md) ·
[`docs/r4-websocket-contract.md`](docs/r4-websocket-contract.md).

---

## Durability is an explicit decision

The server factory **requires** a durability decision. Omitting it is a programming
error, not an implicit production default:

```js
createRemoteHttpServer({ ...services, persistence: null })            // no journal
createRemoteHttpServer({ ...services, persistenceConfig: {} })        // %DSH_HOME%\remote
createRemoteHttpServer({ ...services, persistenceConfig: { root } })  // an explicit root
```

That requirement exists because the implicit default caused the R5 incident: a test
that simply did not mention persistence silently inherited `%DSH_HOME%\remote` and
wrote the real state root. Automated tests now use `makeTempStateRoot()`, which
refuses a root inside `DSH_HOME`, and `tests/remote/r5a-poisoned-env.test.mjs`
proves the property in a child process with a deliberately poisoned environment.

```powershell
npm run compliance:r5a   # read-only acceptance gate; exits non-zero on any failure
npm run smoke:r5a        # temp-root durability smokes
```

---

## Try it without DSH

```powershell
npm run fixture       # synthetic REST server
npm run fixture:ws    # synthetic WebSocket walkthrough
npm run fixture:r5    # synthetic journal + restart + reconciliation walkthrough
```

All three serve **fixture data only**, print a SYNTHETIC banner, never contact DSH
and read no credential. The R5 fixture uses an OS temp directory for its state root
and refuses to run against the real `$DSH_HOME`.

```powershell
curl http://127.0.0.1:9445/api/v1/health
curl http://127.0.0.1:9445/api/v1/sessions
```

Docs: [`docs/r3-rest-contract.md`](docs/r3-rest-contract.md) ·
[`docs/r4-websocket-contract.md`](docs/r4-websocket-contract.md) ·
[`docs/r4-reconnect-semantics.md`](docs/r4-reconnect-semantics.md) ·
[`docs/r5-persistence-design.md`](docs/r5-persistence-design.md).

---

## Two channels, one port

```text
REST = commands   POST /api/v1/sessions/:id/messages | /cancel | /uploads
                 GET  /api/v1/agent-presets | /models
                 PUT  /api/v1/sessions/:id/agent-preset | /model
WS   = events     GET  /api/v1/events?session_id=…&last_sequence=…
```

The authenticated composer settings read the live DSH Agent preset and model catalogs. The
phone may select only a listed preset; DSH still chooses the session workspace and path. Model
selection includes an optional catalog-listed reasoning strength. Assistant history messages
carry provider-reported `usage` and `duration_ms` when DSH recorded them; duration is the DSH
step interval through its assembled assistant reply, not Gateway/network wait time.

Both share `127.0.0.1:9445`, the same loopback restriction, the same Host fence and
the same lifecycle. There is no second listener.

### Open the supervised DSH Web UI on 3081

When the production supervisor is `READY`, run this from PowerShell on the DSH host:

```powershell
.\scripts\dsh-browser-login.ps1
```

The script requests a one-use ticket through the protected local control directory,
verifies the response ACL, and opens the default browser. The browser receives a
session-only `HttpOnly` DSH cookie and redirects to `http://127.0.0.1:3081/`. The
ticket expires after 120 seconds and is consumed once. The script does not print the
ticket, Phone Bearer, or DSH cookie. This handoff uses the existing `127.0.0.1:9445`
listener and does not expose 3081, 9445, or a new port to the LAN or FRP.

The socket accepts exactly one client frame, `client_ping`. Prompts go over REST —
a test asserts that sending one over the socket closes with `4004`.

---

## Durability in one paragraph

The Gateway appends every event to a **segmented, checksummed journal** *before* it
updates the ring or fans out to any client, so a phone can never receive a sequence
the disk does not hold. On start it acquires a single-writer lock, verifies every
journal, repairs only an unterminated final record, loads the newest valid snapshot,
seeds each session's sequence allocator from the journal's high-water mark, and
preloads the ring as a cache — all **before** binding the port. Retention deletes
only whole closed segments and never lowers the high-water mark. A restart therefore
replays history instead of resyncing, and a gateway restart is no longer a data-loss
event.

What it cannot do is recover what it never observed: assistant token deltas, a
live-only `waiting_input`, or durable DSH facts committed while it was down. Those
missed **durable** facts are closed by **reconciliation**, which reads DSH history
through the adapter and emits **new** Gateway events with **new** sequences.

---

## What exists

| Layer | File | Responsibility |
| --- | --- | --- |
| **HTTP** | `src/remote/server.mjs` | Server factory: recovery before bind, loopback, Host fence, graceful stop |
| **HTTP** | `src/remote/http/*` | Config, routing, envelopes, errors, validation, pagination, multipart |
| **WS** | `src/remote/ws/server.mjs` | Same-port upgrade, Origin fence, registry, fan-out |
| **WS** | `src/remote/ws/client-session.mjs` | One socket = one session; replay/live handoff |
| **WS** | `src/remote/ws/replay.mjs` | The four replay cases and the atomic handoff |
| **WS** | `src/remote/ws/backlog.mjs` | Bounded queue, single-writer pump, no silent drop |
| **WS** | `src/remote/ws/protocol.mjs` | The frame vocabulary, in one place |
| **Persistence** | `src/remote/persistence/journal.mjs` | Segmented append-only JSONL, checksums, rotation, retention |
| **Persistence** | `src/remote/persistence/persistence.mjs` | Startup recovery, write-ahead sink, snapshots, health |
| **Persistence** | `src/remote/persistence/record.mjs` | Record encoding and the canonical checksum |
| **Persistence** | `src/remote/persistence/lock.mjs` | Single-writer lock; quarantines a stale lock, never kills |
| **Persistence** | `src/remote/persistence/snapshot.mjs` | A/B snapshot slots; never restores a stale status |
| **Persistence** | `src/remote/persistence/cursor.mjs` | Durable reconciliation checkpoint |
| **Persistence** | `src/remote/persistence/reconcile.mjs` | Downtime reconciliation via the adapter |
| **Persistence** | `src/remote/persistence/config.mjs` | State root, path containment, limits |
| **State** | `src/remote/status-service.mjs` | control/follow → domain state; follow lifecycle |
| **State** | `src/remote/uploads.mjs` | Upload intake and safety |
| Adapter | `src/remote/dsh-adapter.mjs` | The only place mobile vocabulary meets DSH vocabulary |
| **Domain** | `src/remote/model/*`, `src/remote/state/*` | Session, message, event, status, sequence, signals |
| **Service** | `src/remote/sessions.mjs`, `messages.mjs`, `events.mjs` | Domain services |

### Isolation rules (enforced by test)

* All DSH wire knowledge lives in `dsh-adapter.mjs` and `src/remote/wire/*`.
* Everything else — services, `http/*`, `ws/*`, `persistence/*` — must **not**
  import `wire/` and must **not** name a DSH endpoint. Tests read the source files
  and fail otherwise.
* `model/` never imports `wire/`; `wire/` may import `model/`.
* `persistence/*` imports only Node built-ins, and never opens a listener.

---

## The four identities — never confuse them

| Identity | Who mints it | Where it appears |
| --- | --- | --- |
| HTTP `request_id` | the Gateway, per request | `data.request_id`, `error.request_id` |
| `client_message_id` / DSH `requestId` | the client, one identity | prompt body; echoed on submit |
| DSH durable source sequence | DSH's session log | `source_sequence`; history `page.*_seq` |
| Gateway event sequence | the Gateway, per session | `last_sequence`; WS `event.sequence` |

`last_sequence` is process-local. After R5 it survives a restart, because the
journal is authoritative and the allocator is seeded from its high-water mark.

---

## Status vocabulary — 8 values, not 9

```text
idle · queued · running · waiting_input · completed · failed · cancelled · disconnected
```

The task book calls this the "nine-state" machine, but the enumeration contains
**eight** unique values. R2 took the enumeration as authoritative and invented no
ninth state.

`waiting_input` is **live-only**: it is reported only while this process has
actually observed a pending question. After a restart its absence is *not* proof of
`idle` — and a recovered session deliberately starts `disconnected` rather than
restoring whatever status the snapshot happened to record. A phone disconnect never
marks a session `disconnected`; that status means the *Gateway* lost *DSH*.

---

## Replay in one paragraph

The Gateway keeps a durable per-session journal (default 50 000 events or 64 MiB,
whichever comes first, in 4 MiB segments) and a ring that is only a **cache**. On
connect a client may send `last_sequence`; the server replays everything after it,
strictly ascending, no duplicates, no gaps, **all before `replay_complete`** — which
is the seam between history and live. Replay reads the journal when the ring no
longer has the range, so ring eviction alone never causes a resync. If the range has
genuinely been evicted by retention, or the watermark is ahead of this process, the
server sends `resync_required` and closes `4001`. If a client falls too far behind,
it gets `overflow` and closes `4003`. Nothing is ever silently dropped.

---

## Persistence health

```json
{ "data": { "gateway": "ready",
            "persistence": { "status": "ready", "format_version": 1 } } }
```

`status` is `ready`, `degraded` or `failed`. When durability is `failed`, events are
not published at all and mutating commands answer `503` — reads keep working. The
real state root, `DSH_HOME` and journal filenames are **never** reported.

---

## Security posture

* **Loopback only.** `0.0.0.0`, `::`, LAN and public hosts are rejected at
  configuration time.
* **Host fence on the upgrade too.** Node's `upgrade` event bypasses the HTTP route
  handler, so the same R3 validator is re-applied before any `101`.
* **Origin fence.** A WebSocket is not protected by browser CORS, so a hostile page
  is refused with `403`. CSWSH is closed now, not deferred to R6.
* **No token in the URL.** `?token=` is refused explicitly.
* **No wildcard CORS.** Never sent.
* **No credential.** `.credentials.yaml` is never read; no launch token is
  captured. That is R7.
* **The journal holds user session data but never credential material.** A
  structural guard rejects credential field names and shapes — and deliberately
  does **not** rewrite user text.
* **A stale lock is quarantined, never killed.** The lock module imports no process
  API and delivers no signal.
* **Until R6, the WebSocket must remain loopback-only.**

---

## Running the tests

```powershell
npm test          # everything: 823 tests
npm run test:r1   # the R1 boundary contract: 82 tests
npm run test:r2   # the R2 domain model: 113 tests
npm run test:r3   # the R3 REST surface: 161 tests
npm run test:r4   # the R4 WebSocket stream: 132 tests
npm run test:r5   # the R5 durable journal: 155 tests
npm run test:r5a  # the R5A compliance guards: 12 tests
npm run test:r6   # the R6 authentication layer: 168 tests
npm run compliance:r5a   # the standing acceptance gate; exits non-zero on failure
npm run smoke:r5a        # temp-root durability smokes
```

Requires Node >= 24. **One runtime dependency: `ws@8.21.3`** (see
`PHASE-R4-REPORT.md` §6). R5 and R6 added **none** — `node:crypto`, `node:fs` and
`node:path` were sufficient, and no database, locking or auth framework was needed.

Every suite is offline and uses an OS **temp directory** for durable state: an
automated test must never write the real `$DSH_HOME\remote`, and helpers refuse such
a root by construction. Credentials in tests are always **synthetic and in-memory**.
Backpressure, heartbeat, TTL and rate-limit tests use injected timers, so no test
sleeps.

```text
tests/remote/
  # R1 boundary      dsh-adapter · wire-envelope · translate-* · version-guard
  # R2 domain        model-* · status-machine · sequence · session-view-store
  # R3 REST          rest-* · status-service
  # R4 realtime      ws-handshake · ws-protocol · ws-events · ws-replay · ws-resync
  #                  ws-backpressure · ws-heartbeat · ws-origin-security
  #                  ws-shutdown · ws-integration
  # R5 durability    persistence-config · persistence-lock · journal-record
  #                  journal-segments · journal-corruption · state-snapshot
  #                  startup-recovery · durable-replay · retention
  #                  downtime-reconcile · persistence-health
  #                  persistence-shutdown · persistence-security · r5-integration
  # R5A gates        r5a-guards · r5a-poisoned-env
  # R6 auth          auth-bearer · auth-rest · auth-health · auth-ticket
  #                  auth-ws-ticket · auth-ticket-race · auth-origin-cors
  #                  auth-rate-limit · auth-connection-limit · auth-upload-quota
  #                  auth-redaction · auth-persistence-boundary · auth-integration
  helpers.mjs · r3-helpers.mjs · r4-helpers.mjs · r5-helpers.mjs · r6-helpers.mjs
  status-harness.mjs · fixtures/
```

## Live manual validation

```powershell
npm run live
```

Auth-free: reads the installed DSH version, proves the version guard accepts it,
proves the unauthenticated endpoint returns HTTP 401, and reports live read-only
calls as **DEFERRED TO R7**. Never reads `.credentials.yaml`.

---

## Not implemented (Stop Gate)

No supervisor, no PID or disk-log files, no production Phone credential file, no
pairing-code UI, no `public/debug/remote/*`, no `scripts/dsh-start.ps1`,
`dsh-stop.ps1`, `dsh-restart.ps1` or `ssh-enable.ps1`. No placeholder files were
created for them either. No TLS listener, no new port, no DSH credential bootstrap,
no Windows ACL hardening, no OAuth/OIDC/JWT, no cookie auth, no malware scanner, no
UI, and no application-level ACK.

R5 deliberately does not create the real `$DSH_HOME\remote`, and R6 verified its
absence rather than creating it: the product supports the default path, but the first
production start — and the credential that goes with it — belongs to the **R7**
supervisor. `sshd` was not enabled, Tailscale was not installed, no firewall port
was opened, the DSH profile was not modified, and `.credentials.yaml` was neither
read nor modified.
