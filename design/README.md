# DSH Remote — Design System (R8A)

> **Design-only phase.** Nothing here is production code, and nothing here may be depended on
> at runtime. This directory is the design source of truth that R8B–R8G implement against.

---

## Contents

| File | What it is |
| --- | --- |
| `mobile-chat.pen` | The Design Source of Truth: five areas — Foundations, Components, Mobile Screens, States, Interaction Flows |
| `design-tokens.json` | The semantic token layer. Code depends on token **names**, never on hex values |

The written contracts live beside the other phase documents:

| Document | Covers |
| --- | --- |
| `docs/remote-mobile/R8-UX-CONTRACT.md` | behaviour, screens, composer semantics, security, accessibility |
| `docs/remote-mobile/R8-COMPONENT-CONTRACT.md` | every component's inputs, states, disabled rules, a11y, dependency |
| `docs/remote-mobile/R8-STATE-CONTRACT.md` | the two state axes, transitions, legal combinations |
| `docs/remote-mobile/R8-INTERACTION-FLOWS.md` | ten flows with diagrams and endpoint maps |

---

## About the `.pen` format

This environment has **no Pen.dev installation** — no CLI, no package, no desktop app (see
`PHASE-R8A-REPORT.md`, "Pen.dev environment"). A native Pen.dev document could therefore not
be produced.

`mobile-chat.pen` is therefore a **structured JSON design document**, and its own
`formatNote` field says so. It carries the same five top-level areas a Pen.dev document
would, follows the same component-before-screen discipline, and is machine-consumable by
R8B. Importing it into a Pen.dev workspace is a **mechanical translation, not a redesign** —
the structure, naming and relationships are already in place.

It is not claimed to be a native Pen.dev binary document, and the inventory evidence records
`pen_native_format: false`.

---

## How to use this

**Implementing R8B:** read the UX contract first for behaviour, then the component contract
per component, then the state contract for the matrix. Take colours and sizes **only** from
`design-tokens.json` by token name.

**Reviewing a design change:** check it against the state contract's component × state
matrix, and against the binding rules at the end of the UX contract.

**Adding a component:** it must be added to `02_Components` in the `.pen` document, to the
component contract, and to at least one screen composition. A component that appears in no
screen is not part of the system.

---

## Binding rules (short form)

1. Domain state (8, fixed, server-derived) and connection state (6, UI-only) are independent.
2. The primary composer action never changes queue/steer meaning silently.
3. Streaming appends to **one** message; a chunk is never its own message.
4. Reconnect never clears history and never returns the user to authentication.
5. Resync offers exactly one action: reload the conversation.
6. The Phone token is never in a URL, never re-rendered after connection, and never in
   `localStorage` or `IndexedDB`.
7. Model output is never injected as HTML.
8. **No DSH/Gateway lifecycle control exists anywhere in the UI** — see
   `R7-KNOWN-LIMITATION-01`.

---

## What is deliberately absent

```text
HTML / CSS / JavaScript production UI · React · Vue · Next.js · PWA · service worker
static asset serving · REST wiring · WebSocket connection · credential storage
real upload · real cancel · real queue/steer
SSH · Tailscale · firewall rules · LAN binding · TLS listener · QR pairing
DSH lifecycle controls
```

All of that is R8B and later. If any of it appears in this phase, that is an
`R8A_SCOPE_VIOLATION`.
