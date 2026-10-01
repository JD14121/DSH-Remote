# R8 State Contract

> **Status: restored at UI-R1 closure.** The two axes below are the accepted model and were **not
> modified** by UI-R1. Source of truth: `src/remote/ui/state/ui-state.js`.

---

## 1. Two independent axes

```text
domain state      !=  connection state
```

They are **orthogonal**. A design that cannot express `running + reconnecting` is wrong, because that
combination is both legal and meaningful: the task is still running server-side while the phone has
temporarily lost its transport.

**Forbidden:** collapsing both axes into one enum, or deriving one from the other.

## 2. Domain state — exactly eight, server-derived

```text
idle · queued · running · waiting_input · completed · failed · cancelled · disconnected
```

- These are **facts about the task**, produced by the server.
- **No ninth value may be added** without changing the transport contract.
- The UI reflects them; it does not invent them.

## 3. Connection state — exactly six, client-only

```text
auth_required · connecting · connected · reconnecting · resync_required · gateway_unavailable
```

- These describe **this client's link**, not the task.
- They are UI-owned and never sent to the server as task state.

## 4. Legal combinations (illustrative, not exhaustive)

| Domain | Connection | Meaning |
|---|---|---|
| `running` | `reconnecting` | The task continues; this phone is re-establishing transport. |
| `queued` | `reconnecting` | The work is queued server-side while the link recovers. |
| `waiting_input` | `reconnecting` | The task awaits an answer; the prompt cannot be delivered yet. |
| `idle` | `connected` | Nothing in flight; the link is healthy. |
| `completed` | `gateway_unavailable` | The result is known and readable; no new work can be sent. |
| `failed` | `connected` | A task failure, **not** a connection failure. |

The last two matter most in practice: they are why the axes must stay separate. A user must be able to
tell **"my task failed"** from **"my phone cannot reach the gateway"** — the remedies are entirely
different.

## 5. Derived render inputs

`ui-state.js` derives, rather than stores:

| Function | Purpose |
|---|---|
| `canSend(connection)` | Whether the composer's primary action is enabled. |
| `primarySendLabel(domain)` | `Send` / `Queue` / `Steer` — **the label must match the actual effect**; the primary action never silently changes queue/steer meaning. |
| `steerAvailable(domain)` | Whether steering an in-flight task is offered. |
| `sendIntent(domain)` | The intent the primary action will carry. |

## 6. Transitions and validation

- `createUiState(overrides)` builds a valid state.
- `reduceState(state, patch)` applies a patch.
- `validateState(state)` rejects values outside the two enums — an unknown state is a bug, not a new state.

## 7. Streaming

- Streaming **appends to one message**. A chunk is never its own message.
- The stream assembler owns chunk→message assembly; the timeline is not re-created per chunk.

## 8. Reconnect, resync and history

- **Reconnect never clears history** and never returns the user to authentication.
- `resync_required` offers **exactly one** action: reload the conversation.
- Reconnect/replay is handled by `recovery/recovery-controller.js` with
  `recovery/timeline-reconciler.js`; the reconciler merges the replayed timeline rather than replacing
  the DOM wholesale.

## 9. Verification recorded at UI-R1 closure

```text
domain axis     8 values, unchanged
connection axis 6 values, unchanged
orthogonality   preserved; no file in state/ was modified by UI-R1
```

Real-device evidence for two connection states (fixtures, no network manipulation):

| Fixture | Badge | Content |
|---|---|---|
| `reconnecting` | `↻ Reconnecting` | 2 messages still visible; banner "Reconnecting… your history is safe" |
| `gatewayUnavailable` | `✕ Gateway Unavailable` | explanatory card + retry |

Both are distinguishable from a **task** failure, which is the point of keeping the axes apart.
