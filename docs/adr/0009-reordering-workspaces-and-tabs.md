# 9. Reordering Workspaces and Tabs: herdr owns the order, tmux Tabs move, tmux Workspaces stay local

Date: 2026-10-11

## Status

Accepted (2026-10-11, by the user)

Supersedes the "Workspace order" section of [ADR 0008](./0008-layout-editing.md); the rest of
ADR 0008 stands.

## Context

Item 1 of WAVES-PARITY-2: the Workspace order ADR 0008 kept in `localStorage` now disagrees
with herdr's own window and with the user's other devices. herdr-web-ui 0.4.x drags both
Workspaces and Tabs and writes the order to herdr.

ADR 0008's premise "herdr has no command to reorder Workspaces" was wrong: herdr has had
`workspace.move` and `tab.move` since 0.7.2, four versions before the layout writes ADR 0008
gated on 0.9. The 2026-10-07 probe never looked for them.

A probe on a throwaway herdr 0.9.2 (2026-10-11, protocol 22) settled the semantics below.
Source archaeology in `herdrdev/herdr` (release notes, the tagged docs, and `src/api/schema.rs`
plus `src/api/subscriptions.rs` in the tagged tarballs) pinned the versions:

| Capability | Introduced | Evidence |
|---|---|---|
| `pane.move` + `pane.moved` | 0.7.0 (#299, protocol 14) | release note names both; docs list them at v0.7.0, not at v0.6.10 |
| `workspace.move`, `tab.move`, `workspace.moved`, `tab.moved` | 0.7.2 | absent from the v0.7.1 source, present in v0.7.2 |
| `workspace.move_block` + `workspace.reordered` | 0.8.0 | absent from the v0.7.5 source, present in v0.8.0 |

### What `insert_index` means

`insert_index` names the slot in the **pre-move** list: insert the item before the element at
that index, with the moved item still counted in its old slot. The final position is
`insert_index` when the item moves up, and `insert_index − 1` when it moves down past its own
slot — the exact splice model `moveWorkspace` in `web/order.ts` already uses
(`ids.splice(from, 1); ids.splice(at, 0, id)`).

| Request on `[A,B,C,D,W,X]` | Result | Final position |
|---|---|---|
| move A(0), `insert_index: 2` | `[B,A,C,D,W,X]` | 1 = 2−1 (down) |
| move D(3), `insert_index: 0` | `[D,A,B,C,W,X]` | 0 (up) |
| move B(1), `insert_index: 5` | `[A,C,D,W,B,X]` | 4 = 5−1 (down) |
| move C(2), `insert_index: 6` (== count) | `[A,B,D,W,X,C]` | appended, no error |
| move any, `insert_index: 99` | error `workspace_move_failed: insert_index 99 is out of bounds` (`tab_move_failed` for tabs) | — |
| move to its own index | success, order unchanged, **no event** | — |

The final position equals `insert_index` when the item moves up, and `insert_index − 1` when
it moves down past its own slot. `insert_index == count` appends; only indices past that
error.

### Results and events

Every result and event payload carries the full post-move list, so the client never guesses
the order from a delta:

- `workspace.move` → `{type: 'workspace_list', workspaces: […]}`; fires `workspace_moved`
  `{workspace_id, insert_index, workspaces: […]}`. Workspace `number` renumbers positionally.
- `tab.move` → `{type: 'tab_list', tabs: […]}`; fires `tab_moved`
  `{tab_id, workspace_id, insert_index, tabs: […]}`. Tab `number` does **not** renumber — it
  stays a creation ordinal (`13, 1, 10, 11, 12` was a valid order), so order comes only from
  array position, which is how tautan already reads the snapshot.
- `workspace.move_block {workspace_ids, before_workspace_id?}` reorders a block; it fires
  `workspace_reordered {workspace_ids, before_workspace_id?, workspaces}`. tautan never needs
  it (one move at a time), but the Hub still subscribes to `workspace.reordered`, because a
  herdr-side drag may take that path.
- `tab.move` cannot move a Tab to another Workspace: it takes no `workspace_id`, and an extra
  parameter is silently ignored (herdr does not strictly validate). Cross-Workspace moves go
  through `pane.move` (ADR 0008), which changes the Pane's id across Workspaces
  (`w5:p0` → `w6:p3`) and fires `pane_moved` with `previous_*` ids, the new `pane`, and
  `created_tab` / `closed_tab_id` as they happen.

Subscription names are dotted (`workspace.moved`), wire event kinds underscored
(`workspace_moved`), as tautan's event loop already handles.

## Decision

ADR 0008 holds everywhere except the Workspace order: reordering is a Mux write the user asks
for, resolved, written, awaited through a tree refresh, then answered — `502 {error: code}`
for a herdr error code, `501` for `Error('unsupported')`.

- **herdr Muxes: the order lives in herdr only.** tautan deletes its stored
  `tautan.workspaceOrder` entries for herdr Muxes and never writes them back. (Decided by the
  user, 2026-10-11: a write-back would reorder the live herdr window unasked, and devices
  disagree on order.) The UI takes herdr's order from the snapshot arrays and stops sorting
  herdr Workspaces through `orderWorkspaces`.
- **tmux Muxes: Tabs move, Workspaces stay local.** A Tab move runs `move-window` (or
  `swap-window` for an adjacent swap, whichever the adapter finds shorter); tmux sessions have
  no order, so a tmux Workspace keeps the `localStorage` order exactly as ADR 0008 had it.

### Hub routes (19.2)

- `POST /api/workspaces/:key/move {index}` → `204`
- `POST /api/tabs/:key/move {index}` → `204`

`index` is the pre-move-list splice index above, passed to `insert_index` unchanged on herdr.
On tmux a Tab move resolves `index` to the target window's position for `move-window`;
a Workspace move answers `501` on tmux (no herdr-style reorder to delegate to — the local
order is the UI's own flag, not a Mux write). Both routes follow the write-route pattern:
resolve, write, await the tree refresh, reply, so the next `state` event already carries the
order.

Version gate: a herdr Mux whose snapshot version is older than **0.8** throws `unsupported`
(→ `501`). The methods date to 0.7.2, but `workspace.reordered` and tautan's compatibility
floor are both 0.8; a 0.7.2 gate would accept a Mux whose event subscription is refused. The
gate reads the version the snapshot already carried, as `assertLayout` does; a Mux whose
version is unreadable attempts the call and lets herdr's error surface.

### Events (19.2)

Add `workspace.moved`, `workspace.reordered`, `tab.moved` and `pane.moved` to the
subscription in `server/herdr.ts`, with the same refused-subscription fallback
`layout.updated` uses. Each one triggers a tree refresh and a `state` emit: a reorder made in
herdr's own window reaches tautan through the event, not the slow tree poll. The payloads
carry whole lists, but the Hub still refreshes from the snapshot — one code path for events
and writes.

### UI (19.3)

Desktop drags and the phone's **Move up** / **Move down** call the Hub for a herdr Mux and
keep the local order for a tmux Workspace. **Move up** sends `index: from − 1`; **Move down**
sends `index: from + 2` (when that equals the count, herdr appends). A desktop drop sends
the index of the item it lands before, or the count to drop last. Tabs drag in the strip
on desktop; **Move left** / **Move right** sit in the Tab menu on every width. The UI waits
for the `state` event and never reorders locally first.

## Consequences

- A move to its own index succeeds silently and fires nothing; the UI's `state`-driven render
  never depends on an event arriving.
- A stale index (two devices reordering at once) can land a slot off by one. herdr validates
  the range but not the intent; the awaited refresh plus the full-list payloads reconcile, and
  the user sees the wrong slot and moves it again.
- The one-time cleanup deletes `tautan.workspaceOrder` entries for herdr Muxes; a device's
  stored tmux order survives untouched.
- `tab.move` gains no cross-Workspace form. Moving a Tab to another Workspace means moving
  its Pane(s) — `pane.move`, already routed under ADR 0008.
- Subscribing to `pane.moved` also refreshes the tree on Pane moves tautan itself initiates,
  which today wait for the write-route refresh; the event just makes herdr-side moves land at
  the same speed.
- The probe ran on a server with no herdr client attached, so it cannot say whether herdr's
  own sidebar drag fires `workspace_moved` or `workspace_reordered`; subscribing to both
  covers either.

## Rejected alternatives

- A `before` key, as `moveWorkspace` takes today — herdr wants an index, tmux's `move-window`
  targets an index, and the Hub would resolve `before` to that index anyway; ids buy stability
  only between the UI's compute and the Hub's resolve, which the awaited refresh already
  reconciles.
- Writing the stored order back to herdr on first sight — reorders the live herdr window
  unasked, and two devices would fight (user-rejected, 2026-10-11).
- `workspace.move_block` for single moves — it takes an anchor, not an index, fires a
  different event, and exists for block drags tautan does not have.
- Gating at 0.7.2 (accepts a Mux whose `workspace.reordered` subscription is refused) or at
  0.9 (refuses a legitimate reorder on 0.8.x Muxes tautan otherwise supports).
