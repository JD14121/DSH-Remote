# R1 fixture provenance — `tests/remote/fixtures/`

R1 §17.2 requires every fixture to state what it is. This file is the record.
R1 §17.1 governs hygiene: **no fixture in this directory contains a real DSH
token, a real DSH session cookie, a real API key, real credentials, a complete
user prompt, or personal information.**

## Common metadata

| Field | Value |
| --- | --- |
| Captured / derived | 2026-09-19 |
| Observed DSH version | `@deepseek-ai/dsh@0.1.5-rc.2` |
| Observed authority | `127.0.0.1:3080` (loopback only) |
| DSH Home used for observation | `D:\DSH-work-test\.dsh` |
| Wire surface | unary `POST /api/<namespace>/<method>`; streams `WS /api/remote.mux` |

Every fixture carries a `_fixture` block stating its `kind`. The three legal
kinds are exactly the ones R1 §17.2 names:

| Kind | Meaning |
| --- | --- |
| `real-wire-derived` | The **shape** was taken from a real DSH wire exchange or from the generated descriptor table, then redacted and re-keyed. It is **not** a byte-for-byte capture. |
| `hand-constructed` | Authored from the documented contract, not observed on the wire. |
| `negative-test-only` | Deliberately invalid input used to prove a failure path. |

**Nothing in this directory is a verbatim recorded session.** Where a fixture is
`real-wire-derived`, the `fieldsRedactedOrReplaced` list says exactly what was
changed. No fixture claims to be a live capture without that marker.

## Inventory

### `version.json` — hand-constructed
Version observation input for `DshVersionGuard` and the version-guard test
matrix. Contains the observed DSH package name and version, the authority, and
the two transport forms. No credentials.

### `session-list.response.json` — real-wire-derived
Endpoint `session/list`. Shape taken from the generated descriptor and from a
read-only live `session/list` call. Three sessions chosen to cover
`running: true`, `running: false`, and `blank: true`.

Redacted/replaced: every `sessionId` → deterministic
`session-00000000-0000-0000-0000-00000000000N`; `cwd` → `D:\workspace`;
`updatedAt` → fixed epochs; `projections` reduced to a `sessionStats` subset;
any `parentSessionId` (subagent lineage) removed.

### `session-page.response.json` — real-wire-derived
Endpoint `session/page`, request `{ address, throughSeq: 42, maxMessages: 2 }`.
Three records chosen to exercise one record per translator path: `user/message`,
`tool/call`, `tool/result`.

Redacted/replaced: `sessionId`; message bodies → short synthetic strings; tool
`arguments` → a synthetic JSON string; `time` → fixed epochs; `source.rpcId` →
a synthetic client id.

> Note: DSH's page cursor is a numeric sequence, not an opaque string. The
> fixture keeps real sequences (40, 41, 42) because the translator's ordering
> behaviour is what is under test.

### `prompt.accepted.response.json` — real-wire-derived
Endpoint `session/prompt`. Shows the request branch with
`requestId: "client-message-id-fixture-1"`, demonstrating the
`client_message_id → requestId` identity R1 §10 requires, plus a
`duplicateResponse` branch for the same id.

Redacted/replaced: `sessionId`; `requestId` → synthetic; prompt text → synthetic.

### `cancel.success.response.json` — real-wire-derived
Endpoint `session/cancel` for a session with a live Agent → `{ accepted: true }`.

Redacted/replaced: `sessionId`.

### `cancel.cold.response.json` — real-wire-derived
Endpoint `session/cancel` for a session with no live Agent. The Host reports
`session/not-found` with the message `… not found (not attached)`, because
`cancel` reads the in-process Agent registry only and never resumes.

This fixture exists to pin R1 §15: the adapter maps it to **`SESSION_COLD`**,
must not return success, and must not fall back to any process kill.

Redacted/replaced: `sessionId`.

### `follow.snapshot.json` — real-wire-derived
`session/follow` opening snapshot delivered as a mux `item`. Carries `cursor`,
`records`, `hasMore`, `projections` and an `assistantStream` baseline.

Redacted/replaced: `header.id`; `createdAt`; `cwd`; `attemptId`; `projections`
reduced.

### `follow.event.json` — real-wire-derived
A durable `SessionEventEntry` (`user/message`, `seq: 43`) arriving on the live
journal after the snapshot. Its position relative to the assistant frames is
significant; the stream tests assert ordering.

Redacted/replaced: message body; `source.rpcId`.

### `follow.assistant-start.json` — real-wire-derived
`assistant-stream` `start`: `{ attemptId, revision, startedAfterSeq, turn, step }`.

Redacted/replaced: `attemptId` → deterministic synthetic id.

### `follow.assistant-chunk.json` — real-wire-derived
`assistant-stream` `chunk`. **This is the opaque-payload fixture.**

The `chunk` field is a `JsonValue` owned by the LLM adapter. R1 asserts only
that it is present and JSON-representable. Two deliberately different shapes are
provided (`shapeBVariant` is an array, the primary is a nested object) so the
tests can prove the adapter passes both through unchanged and never assumes a
string or a token-object schema.

Redacted/replaced: `attemptId`; chunk payloads → synthetic shapes.

### `follow.assistant-end.json` — real-wire-derived
`assistant-stream` `end` in both forms: `outcome.kind: "committed"` (with
`eventType` and `seq`) and an `abandonedVariant`.

Redacted/replaced: `attemptId`.

### `error.401.json` — real-wire-derived
Observed live: an unauthenticated unary request to `127.0.0.1:3080` returns
HTTP **401** with body `unauthorized`. This is a **channel-level** rejection: the
body is plain text, not a JSON envelope.

### `error.403.json` — real-wire-derived
Observed live: a request whose `Origin` did not match the request authority, and
separately one carrying `Sec-Fetch-Site: cross-site`, return HTTP **403** with
body `forbidden`. Both fixtures in one file because the adapter maps them
identically.

Note the ordering this pins down: the Host/Origin fence runs **before** browser
authentication, so a bad Origin is 403 even with no credential present.

### `error.invalid-envelope.json` — negative-test-only
**Explicitly not a live capture.** Eight hand-constructed negative cases, each
with an `expectedAdapterCode`, proving R1 §6.1's rule that a `200` carrying
anything short of a well-formed `server-response` must fail visibly:

| Case | Proves |
| --- | --- |
| `not-json` | a non-JSON 200 body is not success |
| `missing-type` | the discriminator is required |
| `wrong-type` | only `server-response` is accepted |
| `rpcId-mismatch` | response correlation is enforced |
| `result-not-object` | `result` must be the discriminated union |
| `ok-without-value` | `ok: true` requires a `value` |
| `error-without-code` | a failure requires a usable code |
| `list-missing-required-summary-field` | a well-formed envelope with an invalid `SessionListValue` still fails |

### `control.baseline.json` — real-wire-derived (added in R2)
Endpoint `session/control`, the Host-wide live control stream introduced by R2 §21.

`session/control` takes **no session selector**: one baseline frame reports
queues, jobs and projections for every session. The fixture carries a `baseline`
frame plus `queueFrame` and `jobsFrame` replacements, covering all three frame
kinds the adapter maps.

Redacted/replaced: every `sessionId`; job ids; queued-message ids and `rpcId`;
prompt text → synthetic; projection values reduced to a representative subset;
`startedAt` → a fixed epoch.

Two sessions are included on purpose — one with a queued item and a running job,
one with neither — so a test can assert the baseline distinguishes them, which is
the whole reason R2 needed this capability (`QUEUE_EMPTY` has no other
authoritative source).

## What is deliberately absent

* No real session id, no real `rpcId` from a live exchange.
* No `dsh-auth-*` cookie value, in whole or in part.
* No launch token, and no URL carrying one.
* No `.credentials.yaml` content.
* No API key, and no environment dump.
* No real prompt text from any actual conversation.

## Reproducing an observation

Read-only observations were made with unauthenticated probes for the 401/403
fixtures, and with a read-only `session/list`, `session/page`, `session/control`
and `session/follow` against the running DSH for the shape fixtures. No prompt
was submitted for a fixture, and no file outside this project was written.
