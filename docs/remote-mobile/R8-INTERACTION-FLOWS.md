# R8 Interaction Flows

> **Status: restored at UI-R1 closure.** Documents the flows that are **implemented today**. Flows whose
> backend route does not exist are marked as such and must not be described as working.

---

## 1. Authentication

```text
open → connection = auth_required → credential dialog → token entered
     → connecting → connected
```

- The Phone Access Token is held in `sessionStorage` only.
- It is **never** placed in a URL, never re-rendered after connection, and never written to
  `localStorage` or `IndexedDB`.
- Cancel returns to the previous state; the dialog is not dismissible into an unusable shell.

## 2. Send / queue

```text
draft → primary action (Send | Queue) → sendState = sending → message appended
```

- The primary label is derived from **domain** state, so `Send` and `Queue` are never conflated.
- While a send is in flight the control disables itself rather than relying on the user not
  double-tapping.
- The draft survives a disconnect: the field stays editable; only sending stops.

## 3. Steer

```text
domain = running → "Steer current task" is offered as a SEPARATE control
                → text injected into the running task
```

- `steerAvailable(domain)` is `true` for `queued` and `running`.
- **Corrected at UI-R1.3.** An earlier revision of this document said the primary action "becomes
  Steer". That is **not** what the code does, and the audit verified it on a real device: during
  `running` the composer's primary action is labelled **`Send later`** with intent `queue`, and
  `Steer current task` and `Cancel run` appear as their own controls.
- The primary action therefore never silently changes queue/steer meaning; those are distinct,
  simultaneously visible affordances.

## 4. Streaming

```text
chunk arrives → stream assembler appends to the CURRENT message → render
```

- Chunks never become separate messages.
- Auto-follow applies **only** while the user is at or near the bottom (see §9).

## 5. Reconnect / replay

```text
transport drops → connection = reconnecting → banner "Reconnecting… your history is safe"
               → transport returns → replay → timeline reconciler merges → reconnected
```

- **History is never cleared** and the user is **not** returned to authentication.
- The reconciler merges the replayed timeline; the DOM is not rebuilt from scratch.

## 6. Resync

```text
replay gap detected → connection = resync_required → one action offered:
                      "reload the conversation"
```

- Exactly one action. No partial-recovery choices are offered.
- The composer is disabled while resync is required, with the reason stated.

## 7. Upload

```text
attach tapped → real <input type=file> clicked → Android chooser (WebChromeClient)
             → file chosen → attachment strip rendered → send carries the attachment
```

- The `<input type=file>` must be **in the document** for the WebView to accept it as the chooser
  target; the host supplies the chooser.
- The input's value is cleared after each choice so re-selecting the same file still fires `change`.
- Attachment **rendering** is minimal; image/gallery presentation is future work.

## 8. Cancel

```text
domain = running → cancel control (cancelState) → cancelled
```

- Cancel has its own state so a cancel in flight is visible rather than silent.

## 9. Drawer navigation

```text
menu tapped → drawer opens with scrim → session selected → drawer closes, chat swaps
scrim tapped / Android Back → drawer closes, no navigation
```

- On phones this is an overlay that leaves only a small visual edge (24 px measured).
- At ≥768 px the rail is persistent and the overlay is not used.
- Back closes the drawer **before** the app exits.

## 10. Composer input / auto-grow

```text
focus → keyboard opens (host resizes the WebView) → type
      → field grows with content up to the CSS max-height → then scrolls internally
      → draft cleared → field collapses
```

- Growth is measured from `scrollHeight`, so soft-wrapped lines grow the field too.
- Focusing or growing the composer must **not** move the scroll position (see §11).

## 11. Scroll intent

```text
at/near bottom   → new content may keep the latest message visible
scrolled away    → composer focus, composer growth and stream chunks must NOT snap to bottom
```

Verified on the real device: with the timeline at `scrollTop = 0`, focusing the composer and typing left
the position at `0`.

---

## Backend-dependent — NOT complete

| Flow | Status |
|---|---|
| **Session create** | **Not implemented.** The control is a disabled placeholder: "Available after session-create integration". No server route. |
| **Session rename** | **Not implemented.** No write path. |
| **Recent-activity ordering** | Not implemented. Requires a server-side `last_activity_at`. |

These must not be described as working flows until the corresponding route exists.
