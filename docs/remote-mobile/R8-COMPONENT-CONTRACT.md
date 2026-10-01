# R8 Component Contract

> **Status: restored at UI-R1 closure.** Describes the components that exist in `src/remote/ui/components`
> today. Every entry is grounded in the current source; nothing here claims a capability the code does
> not have.

For each component: responsibility · inputs/state · interactive actions · responsive behaviour ·
accessibility.

---

## TopBar

| | |
|---|---|
| **Responsibility** | Names the current context (session title) and hosts the menu trigger and connection badge. |
| **Inputs** | `title`, `drawerOpen`, `connection` |
| **Actions** | Menu button toggles the drawer. No other chrome actions. |
| **Responsive** | ≥768 px: the rail supplies its own bar and `.top-bar__menu` is `display: none`. Title takes the free space and ellipsises. |
| **A11y** | The menu button has an accessible name and reflects expanded state. Title is a heading. |

## ConnectionBadge

| | |
|---|---|
| **Responsibility** | Shows the **connection** axis (never the domain axis). |
| **Inputs** | `connection` ∈ `auth_required · connecting · connected · reconnecting · resync_required · gateway_unavailable` |
| **Actions** | None. It is a status, not a control. |
| **Responsive** | Label visible at **all** widths including 360 px. Does not shrink (`flex: 0 0 auto`); the title yields instead. Measured: 81–166 px. |
| **A11y** | `role="status"`, `aria-live="polite"`, `aria-label="Connection: <label>"`. Dot is `aria-hidden`. **Never colour-only** — an icon and a text label accompany the dot. |

## SessionDrawer

| | |
|---|---|
| **Responsibility** | Phone-only overlay containing the session list, the "New session" control and Settings. |
| **Inputs** | `open`, `sessions`, `selectedId` |
| **Actions** | Select a session (`onSelectSession`); close via scrim tap or Back (`onToggleDrawer`). |
| **Responsive** | <768 px only: `width: calc(100vw - var(--space-s6))`, overlay with scrim. At ≥768 px the rail replaces it and the drawer is zero-width. |
| **A11y** | `aside` landmark; scrim is `aria-hidden` and click-to-close; rows are buttons with an accessible name including status. |

## SessionItem

| | |
|---|---|
| **Responsibility** | One session row: title, `status · relative time`, and a status dot. |
| **Inputs** | `title`, `domain` state, `updatedAt`, `selected` |
| **Actions** | Select. **Rename is not implemented.** |
| **Responsive** | Titles wrap to two lines then truncate. Wider phone drawers let more titles fit on one line. |
| **A11y** | Selected state exposed (`aria-current`); status conveyed as text, not by the dot alone. |

## Message

| | |
|---|---|
| **Responsibility** | Renders one user, assistant or system message. |
| **Inputs** | `role`, `text`, `blocks` (code fences), timestamps |
| **Actions** | Copy on code blocks. |
| **Responsive** | Width is fluid; code blocks are the known overflow risk (**R1.4-M1**). |
| **A11y** | Author is conveyed textually, not by colour alone. |

## CodeBlock

| | |
|---|---|
| **Responsibility** | Language label + Copy control + the code body. |
| **Inputs** | `language`, `code` |
| **Actions** | Copy to clipboard. |
| **Responsive** | **Known defect R1.4-M1:** long lines are visually clipped at the right edge on a real 360 px phone. Horizontal scrolling is not currently offered. |
| **A11y** | Copy is a real button with an accessible name; a `pre`/`code` pair carries semantics. |

## Composer

| | |
|---|---|
| **Responsibility** | Draft entry, attachment trigger, and the primary send/queue/steer action. |
| **Inputs** | `domain`, `connection`, `draft`, `queueDepth`, `attachments`, `sendState`, `cancelState` |
| **Actions** | Type (emits `onDraft`); attach (opens the system file chooser via a real `<input type=file>`); send; cancel while running. |
| **Responsive** | Single inline row. **Auto-grows** up to the CSS `max-height` (~196.8 px), then scrolls internally. `cols=1` prevents the textarea's intrinsic width from pushing Send off-screen. |
| **A11y** | `aria-label="Message"`; `aria-describedby` when waiting for input; the send control states what it will do (`Send` / `Queue` / `Steer`). |

## Banner

| | |
|---|---|
| **Responsibility** | Region-level notices: reconnecting, reconnected, resync required, fatal error. |
| **Inputs** | `phase`, `unavailable` |
| **Actions** | Resync offers exactly one action: reload the conversation. |
| **Responsive** | Full-width above the content. |
| **A11y** | Banners are announced; they never replace the top-bar status. |

## CredentialDialog

| | |
|---|---|
| **Responsibility** | Collects the Phone Access Token when the connection state is `auth_required`. |
| **Inputs** | `open` |
| **Actions** | Connect, Cancel, reveal/hide the token. |
| **Responsive** | Centred card with a scrim, full height on a phone. |
| **A11y** | Labelled dialog; the token field is a password input with a reveal toggle. Token is held in `sessionStorage` only and is never placed in a URL. |

## EmptyState

| | |
|---|---|
| **Responsibility** | Explains an empty session ("No messages yet — send the first message"). |
| **Inputs** | copy variant |
| **Actions** | None; the composer is the action. |
| **Responsive** | Centred; must not squeeze when the drawer overlays. |
| **A11y** | Plain text, readable at 360 px. |

---

## Not implemented — do not claim

| Capability | Status |
|---|---|
| **Session create** | **Unavailable.** The control renders a disabled placeholder reading "Available after session-create integration". No server route exists. |
| **Session rename** | **Not implemented.** No write path. |
| **Recent-activity ordering** | Not implemented; needs a server-side `last_activity_at`. |
| Light theme | Not implemented. |
| Attachment/image rendering | Upload exists; rendering is minimal. |
| Long-log folding | Not implemented. |
