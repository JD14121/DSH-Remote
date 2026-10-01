# R8 UX Contract

> **Status: restored at UI-R1 closure.** This document describes the **current, accepted** behaviour of
> `src/remote/ui` as measured on a real Android device. It is not a reconstruction of the original R8
> intention, and where the two differ this document records what the code actually does.
>
> Restored because `design/README.md` referenced it while it did not exist.

---

## 1. Shell model

**Phone-first.** The shell is a single document with one chat column. The session list is not a second
column on a phone; it is an overlay.

| Width | Layout |
|---|---|
| < 768 px | Single chat column. Session list is an **overlay drawer**. |
| ≥ 768 px | **Persistent rail** (300 px) + chat pane. The overlay drawer is disabled. |

The rail and the drawer render the *same* session list; only one is visible at a time. The rail is
`display: none` below 768 px and the overlay rule does not apply at or above 768 px — the two are scoped
to disjoint media queries and cannot both apply.

### Measured reference values

```text
phone   360 x 770 CSS  (HONOR FNE-AN00, Android 14, 1080x2400 @480dpi, dpr 3)
tablet  768 x 1024 CSS (simulated)
```

## 2. Drawer

- On phones the drawer is an **overlay** with a scrim, not a layout column.
- It may leave only a **small visual edge** of the underlying page. The accepted implementation is
  `width: calc(100vw - var(--space-s6))`, which measured **336 px on a 360 px phone** and **366 px on a
  390 px phone** — a **24 px** edge in both cases.
- **A drawer must never leave a wide, unusable content strip.** The original `300 px` drawer on a 360 px
  phone left a 60 px sliver: too narrow to read or tap, wide enough to look like broken layout. That is
  the defect this contract exists to prevent.
- Tapping the scrim closes the drawer. The scrim is `rgba(8, 10, 14, 0.62)`.
- Android **Back** closes the drawer before it exits the app.
- No horizontal page scroll in any shell state.

## 3. Top bar

- **Connection state must never rely on colour alone.**
- The status label **remains visible at 360 px**. The full label is shown; it is never abbreviated into
  an ambiguous short form.
- **Superseded rule:** an earlier revision set `.connection-badge__label { display: none }` below 380 px,
  leaving a bare coloured dot. That is **no longer the contract** and must not be restored.
- The **title** is the element that yields space on a narrow bar (`flex: 1 1 auto; min-width: 0`, with
  `text-overflow: ellipsis`). The **badge** does not shrink (`flex: 0 0 auto`) and must never be clipped
  or overlapped.
- The `.top-bar__spacer` must **not** grow; it previously competed with the title and collapsed it to
  0 px.

Measured at 360 px: `✓ Ready` = 81 px, `↻ Reconnecting` = 126 px, `✕ Gateway Unavailable` = 166 px —
all fully readable with no horizontal overflow.

## 4. Composer

- **Auto-grows** with content, including soft-wrapped lines. Height is measured from `scrollHeight`, so
  wrapping counts.
- **Bounded maximum height.** The cap comes from the CSS `max-height` (currently ~196.8 px, about six
  lines). After the cap the textarea scrolls internally (`overflow-y: auto`).
- Collapses back down when the draft is cleared.
- The send and attachment controls stay visible and tappable at every composer height.

Measured on device: 6 lines → 156 px; 10 lines → 197 px, capped, scrolling internally.

## 5. Keyboard / IME

- On the tested host the **Android WebView is resized** by the system; it is not overlaid. The composer
  therefore stays fully above the soft keyboard with **no** `visualViewport` handling.

```text
keyboard closed   innerHeight 770   visualViewport.height 770
keyboard open     innerHeight 492   visualViewport.height 492
                  composerBottom 492, sendBottom 480, clipped false
```

- **Do not introduce visualViewport keyboard offsets.** They would double-correct a host that already
  resizes correctly.
- The host sets `fitsSystemWindows(true)` so the composer is not laid out under the navigation bar.

## 6. Scroll intent

**User scroll intent must be preserved.** The rule is about *who moved the view*, not about what
arrived.

| User position | Behaviour |
|---|---|
| At or near the bottom | New content may keep following; the latest message stays visible. |
| Intentionally scrolled away from the bottom | **Must not** be snapped to the bottom by a stream chunk, by focusing the composer, or by the composer growing. |

Verified on device by focusing the composer and typing while scrolled to `scrollTop = 0`: the position
was unchanged (`forcedToBottom: false`).

## 7. Accessibility

- **Minimum touch target 44 × 44 px.**
- Icon-only controls carry an accessible name. The connection badge is a `role="status"` region with
  `aria-live="polite"` and an `aria-label` such as `Connection: Ready`, so the state is announced even
  where the visual label is compact.
- Status is conveyed by **text + icon**, never by colour alone.
- Focus is always visible (`--focus` token).

## 8. Theming and tokens

- Components consume **semantic token names** (`--surface-*`, `--text-*`, `--status-*`, `--space-*`), never
  literal colours.
- The shell is currently **dark-only** (`color-scheme: dark`). A light theme is future work (R1.7) and is
  not part of this contract.

## 9. Known deferred defect

**R1.4-M1 — code block horizontal overflow / clipping.** Long code lines are visually cut at the right
edge on a real phone (confirmed in `deferred-code-clipping.png`). Owned by the Message Surface phase
(R1.4). Recorded here so it is not mistaken for intended behaviour.

## 10. Out of scope for this contract

No DSH/Gateway lifecycle control exists anywhere in the UI (see `R7-KNOWN-LIMITATION-01`). Session create
and rename are **backend-dependent and not implemented**.
