# 8. Layout editing writes to the Mux; the Workspace order is tautan's

Date: 2026-10-07

## Status

Proposed (awaiting the user's approval)

## Context

Gap E: tautan could zoom a Tab but not rearrange it. Split, swap, move and resize sat on the
ROADMAP's "Later" list; herdr-web-ui already reorders Workspaces.

herdr 0.9 has `pane split`, `pane swap`, `pane move` (to a Tab, a new Tab or a new Workspace)
and `pane resize`, and no command to reorder Workspaces. tmux has `split-window`,
`swap-pane`, `join-pane`/`break-pane` and `resize-pane`. The Hub's write routes already await
a tree refresh before replying, answer `502 {error: code}` for a herdr error code and `501`
for `Error('unsupported')`.

A probe on a throwaway herdr 0.9.2 (2026-10-07) settled the undocumented units: `pane.split`
`ratio` names the share the split Pane keeps (`ratio: 0.7` on a 120-column Tab leaves it 84
columns and gives the new Pane 36); `pane.resize` `amount` is a fraction of the Tab's cell
size (`0.5` moves the divider 60 columns, `0.1` moves 12), clamped at a 12-cell Pane minimum;
a negative amount behaves like its absolute value. A move to a new Workspace changes the
Pane's id (`w1:p1` → `w2:p1`); herdr keeps the old id as an alias.

## Decision

ADR 0006 holds: the Mux owns geometry. Split, swap, move and resize are Mux writes the user
asks for, the same class as zoom. tautan never invents a layout; a Workspace order is
tautan's own flag, like Seen, and is never written to a Mux.

### Action mapping

`r` is the API ratio (the share the **new** Pane takes), `cells` a whole number of columns
or rows. herdr's split ratio is the complement, so the adapter sends `1 − r`; tmux's `-l`
percentage is the new Pane's share directly.

| Action | herdr (JSON-RPC) | tmux |
|---|---|---|
| Split right/down, ratio, cwd | `pane.split {target_pane_id, direction, ratio: 1−r?, cwd?, focus: false}` → `.pane.pane_id` | `split-window -d -h` (right) or `-v` (down) `-t <pane> -l <r×100>% -c <cwd> -P -F '#{pane_id}'` |
| Swap with a target Pane | `pane.swap {source_pane_id, target_pane_id}` | `swap-pane -d -s <src> -t <dst>` |
| Move to an existing Tab | `pane.move {pane_id, destination: {type: 'tab', tab_id, split, target_pane_id?, ratio?}}` | `join-pane -d -h`/`-v` `-t <dst pane> -s <pane>` |
| Move to a new Tab | `pane.move {pane_id, destination: {type: 'new_tab'}}` → `.move_result.pane.pane_id` | `break-pane -d -s <pane>` |
| Move to a new Workspace | `pane.move {pane_id, destination: {type: 'new_workspace', label?}}` — the Pane's id changes | `new-session -d -s <label> -c <cwd>`; `join-pane -d -s <pane> -t <label>:`; `kill-pane -a -t <pane>` |
| Resize | `pane.resize {pane_id, direction, amount: cells ÷ Tab cells}` | `resize-pane -t <pane> -L\|-R\|-U\|-D <cells>` |

herdr names the acted-on Pane inconsistently: `target_pane_id` in split, `source_pane_id` in
an explicit swap, `pane_id` in move and resize. A move-to-Tab ratio rides the same field as
split's; 15.2's contract test pins the landed rect rather than trusting the complement.

### Hub routes (15.2)

- `POST /api/panes/:key/split {direction: 'right'|'down', ratio?, cwd?}` → `201 {paneKey}`
  of the new Pane. A split always starts a shell; Agents start from New Tab, as herdr does.
- `POST /api/panes/:key/swap {target: paneKey}` → `204`. Both keys must resolve on one Mux;
  the Mux validates the rest.
- `POST /api/panes/:key/move` → `201 {paneKey}`. Exactly one of `tab` (a Tab key, with
  required `split: 'right'|'down'` and optional `ratio`), `newTab: true`, or `newWorkspace:
  true` with optional `label` — presence discrimination, as `/api/rename` does. The response
  names the moved Pane's current key, because a cross-Workspace move changes it.
- `POST /api/panes/:key/resize {direction: 'left'|'right'|'up'|'down', amount}` → `204`.
  `amount` is whole cells, 1–500, and names the direction the Pane grows.

Each route resolves, writes, awaits the tree refresh, then replies, like `/zoom`. Body checks
reuse the helpers in `server/http.ts` (`validCwd`, `validLabel`); `ratio` must be 0–1
exclusive. `Error('unsupported')` answers `501`; a herdr error code answers `502`.

501s: `HerdrMux` gates all four writes on its reported version — a Mux that says it is older
than 0.9 throws `unsupported`. (The `layout.updated` fallback learns 0.8 by refused
subscription; a write should not learn it by firing a doomed RPC, so the gate reads the
version the snapshot already carried.) A Mux whose version is unreadable attempts the call
and lets herdr's own error surface. `TmuxMux` implements all four (its older writes stay
`501`).

### Phone and desktop

Everything is a discrete, undoable action, so every action reaches the phone's ⋯ menu:
**Split right**, **Split down**, **Move to…** (a picker: another Tab, New Tab, New
Workspace), **Swap with…** (a picker), and **Resize** as four direction steps of 5 cells.
The menu hides these on a zoomed Tab and offers Unzoom instead — a zoomed Tab shows one
Pane, so an edit would be invisible.

Two gestures are desktop-only, because touch cannot make them precise:

- **Drag a split divider.** The drag itself is CSS on the mirrored cells; one `/resize` with
  the total cell delta goes out on release, and the next `state` event corrects any clamp.
  One write per drag, never a stream of writes mid-drag.
- **Drag a Workspace row** in the Home list. On touch, a drag fights scrolling (Chromium
  fires `pointercancel`, the reason the Tab strip swipe is built on `touchend`), so the phone
  reorders through the row menu: **Move up** / **Move down**.

### Workspace order

herdr has no reorder, and tmux cannot reorder Workspaces either, so the order never leaves
tautan: one `localStorage` key, `tautan.workspaceOrder`, holding `{ [muxKey]: [workspaceId,
…] }` — `muxKey` already names Host and Mux, the same stability `tautan.watched` relies on.
One sort in front of `web/home.tsx`'s `groups` (and the `spaces` list `bySpace` follows)
orders each Mux's Workspaces: ids in the stored order first, Workspaces the state added
after them in snapshot order. Writes drop ids that left the state. The order inside a group
(`agentRows`) is untouched. The order is per device; another phone keeps its own.

### Leases and mirrored geometry

ADR 0004's lease restores a rect it recorded at acquisition. A split, swap, move or resize
on a Tab the write touches would make that rect stale, so the Hub releases every lease held
on a Pane of the source or destination Tab before writing — restore first, then edit, and
the Mux stays the one owner of geometry. The user can take the lease again afterwards.

The reply awaits the tree refresh (ADR 0006), so the first `state` event after the write
already carries the new rects on every Mux; herdr 0.9 also fires `layout.updated`. A Tab
pushed past 4 Panes or under ADR 0006's cell minimums falls back to the Pane chips row by
the existing rule.

### Contract tests (15.2, throwaway servers only)

- herdr: split with and without `ratio` → two Panes, rects sum to the Tab, the new Pane's
  share is `r` (±1 cell); swap → the two rects exchange; move to a Tab with `ratio` pins the
  landed rect; move to a new Workspace → the `201` key differs from the old one, the old Tab
  lost the Pane, the new Workspace exists; resize → the divider moves the asked cells and
  clamps at the 12-cell minimum; every reply is already reflected in `GET /api/state`.
- A stub Mux reporting version 0.8 answers `501` on all four routes.
- tmux: split `-h -l 30%` → two Panes and the new pane id from `-P -F`; swap; join-pane
  keeps the pane id; break-pane; the three-command Workspace move leaves one Pane and no
  seed window; `resize-pane -R 5` grows the Pane 5 columns.
- Both: `400` for a bad direction, ratio or amount bounds, and a `move` body whose target
  keys are not exactly one of the three.

## Consequences

- herdr's resize fraction rounds against the Tab's cell size, so a cells request can land a
  cell off. The `state` event is the truth; tautan never corrects it locally.
- The tmux Workspace move is three commands, not atomic. A failure between them leaves a
  seed Workspace the user sees and can close; `refreshAfterWrite` reconciles the tree either
  way, and Retry re-runs the sequence. `// ponytail:` in `server/tmux.ts` should name this
  ceiling and the upgrade path — a single `move-pane -t` once tmux grows one.
- A cross-Workspace move changes the Pane's key, so the client navigates to the `201` key it
  got back; routes on the old key stop resolving in the Hub even though herdr keeps the
  alias.
- A phone-width lease drops when its Tab is edited, so a split from the phone costs the
  lease until the user takes it again — visible, not silent, per ADR 0004.
- The Workspace order does not follow a Host rename (a rename changes `muxKey` and the order
  resets to snapshot order). Acceptable: renames are rare, and a silent key rewrite is worse.

## Rejected alternatives

- A layout kept only in tautan (its own split ratios and order, mirrored nowhere) — ADR 0006
  rejected the idea; two geometries drift, and the operator's herdr would disagree.
- One generic `/api/panes/:key/layout` RPC — four small routes match the per-action routes
  `server/http.ts` already has; a generic RPC re-exposes the Mux's API and validates nothing.
- Fraction at the Hub boundary — tmux, the only Mux that takes a count, speaks cells, and a
  divider drag produces cells; only the herdr adapter divides.
- tmux Workspace move by killing the seed window first — that kills the fresh Workspace; the
  `kill-pane -a` must come last.
- The Workspace order on the Hub (`state.json`) — order is a per-device view choice, like
  `tautan.collapsed`; the Hub has no concept of Workspace order.
