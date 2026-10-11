# Parity waves, second round

A delegation plan for the orchestrator, in the same shape as [WAVES.md](./WAVES.md) and
[WAVES-PARITY.md](./WAVES-PARITY.md): each wave is a goal, a set of lanes, and one
verification step. Hand a wave to `/lead`, and the orchestrator routes its lanes. Vocabulary
is in [../CONTEXT.md](../CONTEXT.md). The [standing constraints](./WAVES.md#standing-constraints)
and the [routing table](./WAVES.md#routing) in WAVES.md hold here too.

[ROADMAP.md](./ROADMAP.md) records what landed. When a wave passes its verification, add its
phase there (Phase 32 onwards) with its Verify step. Agents never tick a ROADMAP box; the user
does, on a real device.

**Source.** A comparison of tautan (HEAD `98108a7`, 2026-10-11) with `devswha/herdr-web-ui`
v0.4.0–v0.4.6 (released 2026-10-08 to 2026-10-10), made from those releases' full changelogs,
plus the API schema of herdr 0.9.2 (`herdr api schema --json`) on this machine. herdr 0.9.3's
schema is identical. Most of herdr-web-ui's new features rest on herdr API methods that tautan
does not call yet.

Item 8 came later (2026-10-11), from two pages on running several Claude Code accounts on one
machine: [a blog post](https://www.boxblinkracer.com/blog/claude-code-multi-account) and
[AgentsRoom's multi-account feature](https://agentsroom.dev/features/claude-multi-account).

**Scope.** Every item the user chose from that comparison:

| # | Item | herdr-web-ui 0.4.x | tautan today | Wave |
|---|---|---|---|---|
| 1 | Workspace and Tab order written to herdr | drag and menu, shared with herdr's own window | Workspace order per browser (`web/order.ts`); no Tab order | 19 |
| 2 | A held reply waits for an empty input box | 0.4.3 | `web/pending.ts` types a held reply over a draft typed in the terminal | 20 |
| 3 | Invisible characters do not stop a send | a card to send or discard | Claude Code 2.1.294 keeps the message in its box; tautan shows it as late | 20 |
| 4 | herdr plugin actions | in the command palette | none | 21 |
| 5 | Search a Pane's terminal history | Find in terminal, with match count | none | 22 |
| 6 | Agent names | shown, set with `herdr agent rename` | none | 21 |
| 7 | Agent integration status | Settings › Agent integrations | none | 21 |
| a | Code highlighting in the Chat view | TanStack Highlight in a worker | plain code blocks | 23 |
| b | Slash command matching by fragment, description and letters in order | 0.4.4 | prefix, then substring of the label | 23 |
| c | An `/effort` card | 0.4.1 | `/effort` goes to the Screen | 23 |
| d | The Markdown parser survives pathological input | 0.4.0–0.4.1 | untested | 24 |
| e | Newer Claude Code approval footers | 0.4.3–0.4.4 | untested | 24 |
| 8 | Claude accounts, one `CLAUDE_CONFIG_DIR` each | (AgentsRoom: an account per project or Agent) | `~/.claude` only | 25 |

The user weighed a density setting on 2026-10-11 and kept the
[WAVES.md rejection](./WAVES.md#what-this-plan-does-not-do): one scale, and if desktop feels
loose, tune that scale. The other rejections stand too: no command palette (plugin actions go
in the ⋯ menus), no token gate, no xterm.js. Out of scope: patch notes in the app, anonymous
telemetry, Windows and macOS path fixes, and Chat for Devin, OpenCode 2 and Gajae (add them
when the user runs those agents). For item 8, sharing skills, plugins and `CLAUDE.md` across
Claude accounts stays with the user's dotfiles, and switching a Pane to another account at a
limit is on the ROADMAP's "Later" list, optional.

## Facts the waves depend on

- The live herdr on this machine is 0.9.3, protocol 22: the user moved the server from 0.9.0
  with `herdr update --handoff` on 2026-10-11, and every Pane survived. Batch 1 probed
  throwaway servers on 0.9.2; the 0.9.3 API schema is identical to 0.9.2's (no method, event
  or field added or removed), so its findings hold. The live server answers
  `pane.selection.read` (a read-only call on a missing Pane returns `pane_not_found`, not
  `unknown variant`). The schema has these methods that tautan does not call:
  `workspace.move_block`, `agent.rename {target, name|null}`, `integration.list`,
  `plugin.list`, `plugin.action.list`, `plugin.action.invoke`, `pane.copy_search`, and
  `pane.scroll {pane_id, offset_from_bottom}`. Its events include `workspace.reordered`,
  `workspace.moved`, `tab.moved` and `pane.moved`. Wave 19 subscribes to all four
  (`server/herdr.ts:320`).
- This fact replaces one in WAVES-PARITY.md and [ADR 0008](./adr/0008-layout-editing.md):
  "herdr has no command to reorder Workspaces" is no longer true. Wave 19.1 found the
  versions ([ADR 0009](./adr/0009-reordering-workspaces-and-tabs.md)): `pane.move` and
  `pane.moved` came in 0.7.0; `workspace.move`, `tab.move`, `workspace.moved` and
  `tab.moved` in 0.7.2; `workspace.move_block` and `workspace.reordered` in 0.8.0. Events
  are subscribed with dotted names and arrive with underscored names (`workspace_moved`).
- The snapshot lists Workspaces and Tabs in herdr's order, each with a `number`.
- herdr's `AgentInfo` has `name` (set by `agent.rename`) and `display_agent`. The snapshot
  leaves `name` out when it is unset.
- `integration.list` returns `IntegrationInfo {target, label, command, available, state}`;
  `state` is `not_installed | current | outdated`. Targets include `claude`, `codex`, `pi`,
  `omp` and 13 more.
- `plugin.action.list` returns `PluginActionInfo {plugin_id, action_id, title, description?,
  command, contexts?, platforms?}`; a context is `global | workspace | tab | pane | selection`.
  `plugin.action.invoke {action_id, plugin_id?, context?}` takes a context with
  `workspace_id`, `tab_id`, `focused_pane_id`, cwd fields and more. This machine has 5 plugins
  and 16 actions: Hunk diffs (`pane`, `workspace`), the file viewer, reviewr, Herdr Plus, and
  Vim navigation (`global`).
- `pane.read` sources are `visible | recent | recent_unwrapped | detection`. On herdr 0.8.0, a
  `recent` read costs about 30 ms per line past the Pane's height on a Claude Pane
  (`server/herdr.ts:109`). Wave 22.1 measured 0.9.2; see its table under Wave 22.
- Claude, pi and omp queue a reply sent mid-turn themselves (`QUEUES`, `web/composer.tsx`),
  so the Chat view sends it at once and tautan holds replies only for other Agents. Since
  Wave 20, every Chat-view reply carries `held: true`; on a Claude Pane the Hub reads the box
  first and answers `409 {error: 'draft'}` when it holds text or is in bash mode
  (`server/mux.ts` `input()`, `shared/inputbox.ts`). A reply refused that way waits, held.
- `server/complete.ts:128` ranks slash commands in five tiers: label prefix, word start in
  the label, label substring, description substring, then label letters in order. A bare
  `/effort` opens the effort card, and `effort` stays in `SCREEN_COMMAND`
  (`web/composer.tsx:48`), so the text sent as typed goes to the Screen.
- The editor (Phase 31) installed `@lezer/highlight` and seven `@codemirror/lang-*` packages,
  loaded as lazy chunks outside the precache. They can highlight static code with no new
  dependency.
- tmux reorders windows (Tabs) with `move-window` and `swap-window`. tmux sessions
  (Workspaces) have no order.
- Claude Code keeps an account in the folder `CLAUDE_CONFIG_DIR` names (default
  `~/.claude`): its login, settings, transcripts under `projects/`, skills and plugins. Each
  folder is separate; nothing is shared between them.
- herdr 0.9.3's `tab.create`, `pane.split` and `workspace.create` take `env`; `agent.start`
  takes `args` but no `env`. herdr's Claude hook (`~/.claude/hooks/herdr-agent-state.sh`) is
  set up in `~/.claude/settings.json` only, so a Claude on another folder sends herdr no
  `agent_session` until that folder has the hook too.
- quota-axi reads one account: `CLAUDE_CONFIG_DIR=<folder> quota-axi --provider claude
  --profile-only --json`. The Hub runs plain `quota-axi --json` (`server/http.ts:69`).
- tautan reads `~/.claude` in `server/chat.ts:58` and `:63` (transcripts) and in
  `server/complete.ts:236`, `:237` and `:262` (settings, plugins, commands and skills). No
  `~/.claude-*` folder exists on this machine yet (checked 2026-10-11).
- Write tests and probes run only on throwaway servers from `test/harness.ts`. A probe that
  needs a logged-in Claude Code runs it in a throwaway tmux (`tmux -f /dev/null -S <sock>`),
  which keeps the real `HOME`. The live herdr socket never receives a write.

## Schedule

A wave that shares a file with another waits for it. At most three Claude specialists run at
once; GLM lanes are not capped.

| Batch | Runs in parallel | Why this order |
|---|---|---|
| 1 | 19.1 · 20.1 · 22.1 · 24 | Two decisions and one probe before code; tests only |
| 2 | 19 build · 23 | 19 owns the order path; 23 owns the composer and Markdown |
| 3 | 20 build | 20 owns the input path |
| 4 | 21 | It edits `server/herdr.ts` and the ⋯ menus after 19 |
| 5 | 22 build · 21.4 · 25.1 | 22 edits `server/herdr.ts` and the ⋯ menus after 21; 21.4 closes Wave 21's gaps and waits for 22.2 where both edit `server/herdr.ts`; 25.1 is a probe and an ADR |
| 6 | 25 build · final qa | 25 edits `server/herdr.ts`, the Chat and completion reads, and Settings after 22 |

| Wave | Owns (do not edit from a parallel wave) |
|---|---|
| 19 | `server/herdr.ts`, `server/tmux.ts`, `server/mux.ts`, the move routes in `server/http.ts`, `web/order.ts`, `web/home.tsx` order, the Tab strip in `web/pane.tsx` |
| 20 | `server/mux.ts` `input()`, `shared/types.ts` `InputBody`, `shared/inputbox.ts` (new), `web/pending.ts`, the held row in `web/chat.tsx` |
| 21 | `server/herdr.ts`, `server/mux.ts`, its routes in `server/http.ts`, the ⋯ menus in `web/pane.tsx` and `web/home.tsx`, `web/settings.tsx` |
| 22 | `server/herdr.ts` and `server/tmux.ts` read paths, a history route in `server/http.ts`, `web/history.tsx` (new), the Pane ⋯ menu |
| 23 | `web/markdown.tsx`, `server/complete.ts`, `web/complete.tsx`, `web/composer.tsx` |
| 24 | `test/` only, plus a fix in `web/markdown.tsx` or `shared/blocked.ts` if a test fails |
| 25 | `server/accounts.ts` (new), the account reads in `server/chat.ts` and `server/complete.ts`, `env` on create in `server/herdr.ts` and `server/tmux.ts`, the create routes and the quota route in `server/http.ts`, the create sheets in `web/sheets.tsx`, `web/settings.tsx`, `web/usage.tsx` |

**Progress (2026-10-12).** Batches 1–4 are built and committed on `main`; nothing is
pushed. ROADMAP has Phases 32–36. Batches 5 and 6 are open.

| Batch | Commits | Checks on the final tree |
|---|---|---|
| 1 | `6a6f532`, `0d794ab`, `41eb642`, `2b715cb` | typecheck clean, `bun test` 504 pass |
| 2 | `eb66354`…`9d20b66` (10 commits) | typecheck clean, `bun test` 531 pass, qa 8 of 8 on throwaway servers |
| 3 | `52ad7b1` (e2e), `5a8479e` (Wave 20) | typecheck clean, `bun test` 560 pass, `pnpm e2e` 19 of 19 |
| 4 | `da1bb62`, `02d96be`, `89c66c3`, `cf3bf42` | typecheck clean, `bun test` 573 pass, `pnpm e2e` 22 of 22, qa spec check 5 of 5 (one defect, fixed in `cf3bf42`) |

**The e2e suite is green again (`52ad7b1`).** Before Batch 3 it failed 8 of 18 flows, from
before Batch 2. Each failing flow checked behaviour a later commit changed on purpose, so
only `scripts/e2e.ts` changed:

| Flow | What changed in the app | What the flow does now |
|---|---|---|
| Held messages queue and flush | Claude, pi and omp queue a reply themselves, so a Claude Pane never holds one; the Send lookup also matched the suggestion pills | Reports the Pane as Codex, matches Send exactly, waits for the automatic send |
| Wrap guard | Agent Panes open in the Chat view | Pins the Screen view in `localStorage` |
| Chat lens falls back to the Screen | A 1 s wait ended inside the 5 s Chat grace period | Waits for the Screen text, up to 12 s |
| File viewer folder view | Folders open from the breadcrumbs on desktop | Clicks the breadcrumb, then the file's link |
| Chat view approval row | The menu reads as numbered rows | Uses the numbered radios; checks `["down","enter"]` and a `promptId` |
| Split view | The view choice lives in `localStorage`; the fallback saves nothing | Uses `localStorage`; checks the choice stays `chat` |

The suite has 22 flows now, with the order flow from Wave 19 and Wave 21's three. The browser
closing after the chat view flow did not come back in 7 runs, and nothing fixed it on purpose. If it returns,
diagnose it as a new failure.

---

# Wave 19 — Order Workspaces and Tabs in herdr

**Item 1. Goal:** an order you set in tautan is herdr's order, the same in herdr's own
window and on every device.

**Why now:** ADR 0008 kept the Workspace order in `localStorage` because herdr had no
reorder. herdr 0.9.2 has one for Workspaces and for Tabs, so a per-device order now disagrees
with herdr's window and with the user's other devices.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 19.1 | Probe the move methods and events; write ADR 0009 | `deep-reasoner` | Batch 1 |
| 19.2 | Hub: move routes, adapters, events | `glm-run` | Batch 2, after 19.1 |
| 19.3 | UI: Workspace order through the Hub; Tab reorder | `frontend` | with 19.2, on the agreed shape |

**19.1 brief.** On a throwaway herdr 0.9.2, pin down: what `insert_index` means for
`workspace.move` and `tab.move` (index before or after the item leaves its slot); whether a
move fires `workspace.reordered`, `workspace.moved` or `tab.moved`, and their payloads; what
`pane.moved` carries; and which herdr version introduced each method (read herdr's
changelog; gate writes on the snapshot's version, as ADR 0008 gates split). Decide:

- herdr Muxes: the order lives in herdr only. Delete the stored `tautan.workspaceOrder`
  entries for herdr Muxes; do not write them back to herdr. (Decided by the user, 2026-10-11:
  a write-back would reorder the live herdr window unasked, and devices disagree on order.)
- tmux Muxes: Tabs move with `move-window` or `swap-window`. Workspaces keep the
  `localStorage` order, because tmux sessions have no order.
- The route shape: `POST /api/workspaces/:key/move {index}` and `POST /api/tabs/:key/move
  {index}`, or a `before` key like `moveWorkspace` takes today.

Record the decision as ADR 0009. It supersedes ADR 0008's "Workspace order" section; mark
that section superseded and leave the rest of ADR 0008 as it is.

**Done (2026-10-11):** see [ADR 0009](./adr/0009-reordering-workspaces-and-tabs.md).

**19.2 brief.** Implement ADR 0009. Each route follows the write-route pattern: resolve,
write, await a tree refresh, then reply; a herdr error code answers 502; `unsupported`
answers 501. Gate the move routes on herdr ≥ 0.8 (not 0.9), else 501. The route's `index`
passes to herdr's `insert_index` unchanged — a pre-move splice index — so the tmux adapter
must translate it to `move-window` semantics. Never send `workspace_id` with `tab.move`: it
cannot cross Workspaces, and extra params are silently ignored. Add the four events to the
subscription in `server/herdr.ts:298` with the same refused-subscription fallback that
`layout.updated` uses for herdr 0.8; subscribe to both `workspace.moved` and
`workspace.reordered`, because the probe could not show which one herdr's own drag fires.
A move to the item's own index succeeds and fires no event. Read Tab order from array
position, never Tab `number` (it is a creation ordinal). Contract tests on a
throwaway herdr and tmux: a Workspace move and a Tab move are reflected in `GET /api/state`
when the reply arrives; a stub Mux older than the gate answers 501; a herdr-side move reaches
the Hub through the event, not the slow poll.

**19.3 brief.** Desktop drag and the phone's **Move up** / **Move down** call the Hub for a
herdr Mux and keep the local order for a tmux Mux (a tmux Workspace move stays local; the
route answers 501). **Move up** sends `index: from − 1`; **Move down** sends
`index: from + 2` (the count appends); a drag sends the index of the item it drops before.
Tabs: drag in the Tab strip on desktop;
**Move left** / **Move right** in the Tab menu on every width (a touch drag fights scrolling,
see ADR 0008). Wait for the `state` event; do not reorder locally first.

**Done (2026-10-11):** the routes are `POST /api/workspaces/:key/move {index}` and `POST
/api/tabs/:key/move {index}`. They answer 204; 400 `body` when `index` is not a non-negative
integer; 404 `unknown-workspace`/`unknown-tab`; 501 `unsupported`; 502 with herdr's own code.
Contract tests: `test/reorder.contract.test.ts`. The subscription now carries
`workspace.moved`, `workspace.reordered`, `tab.moved` and `pane.moved`; a refused subscription
drops the newest variant and reconnects. tmux moves a Tab with `move-window -b` (tmux 3.1 or
later); `swap-window` is unused. The UI has no herdr version gate: on herdr older than 0.8 the
Move controls still show, and the 501 reads "Move failed · This Mux does not support that".
Home deletes a herdr Mux's stored `tautan.workspaceOrder` entry; tmux entries stay, and the
Switch drawer ignores herdr entries too (`web/switch.tsx`). Tab menus open on tmux as well
when a Workspace has two or more Tabs, with **Move left** and **Move right** only. `?mock`
answers both move routes.

**Verify:** on the phone, move a Workspace up; see the same order on the desktop and in
herdr's own window. On desktop, drag a Tab to the first slot; see herdr's window follow.
Reorder a tmux Workspace and see the order survive a reload.

---

# Wave 20 — Held replies and invisible characters

**Items 2 and 3. Goal:** a reply goes into an empty box, and arrives whole.

**Why now:** both are silent failures. A held reply typed over a draft corrupts both texts.
A message with a zero-width space stays in Claude's box, and tautan reports it late.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 20.1 | Probe Claude Code's input box and its invisible-character hold | `qa` | Batch 1 |
| 20.2 | Hub: the empty-box check and the character strip | `glm-run` | Batch 3 |
| 20.3 | Chat view: a held reply that waits for the box | `frontend` | with 20.2 |

**20.1 brief.** Run Claude Code in a throwaway tmux server (real `HOME`, so it is logged in).
Capture the visible screen, redacted, for: an empty input box; a box with a one-line draft; a
multi-line draft; bash mode (`!`); a pasted-text placeholder. Then send text that contains
each of U+200B, U+200C, U+200D, U+2060 and U+FEFF, one at a time, and record which ones make
Claude keep the message, and what its screen shows then. Include U+200D inside an emoji
sequence. Save the screens as fixtures under `test/fixtures/` with the Claude Code version.

**Done (2026-10-11), Claude Code 2.1.296:** fixtures are in `test/fixtures/claude-2.1.296/`
(`inputbox-*.txt`, `held-*.txt`). All five characters (U+200B, U+200C, U+200D, U+2060,
U+FEFF) make Claude hold the message on Enter: Claude strips the character, keeps the
cleaned text in the box, and shows `Removed 1 invisible character · review and press Enter
to send` above the box; a second Enter submits it. Bracketed paste behaves the same. U+200D
inside an emoji sequence (👨‍👩‍👧) is not held: the message submits with the emoji intact, so
20.2 strips U+200D only outside an emoji sequence. After each turn Claude shows a dim
predicted prompt in the box, and an empty box shows a dim placeholder (`Try "…"`); in plain
text both read as a draft, so the 20.2 parser reads the ANSI screen and treats dim text
(`ESC[2m`) as empty, or every held reply answers `409 draft` (tmux's visible read already
keeps escapes, `-e`; check what herdr's visible read returns before building on it). The
box is a full-width `─` rule, a line starting `❯ ` (or `! ` in bash mode), continuation
lines indented two spaces, and a second rule; a paste shows
`❯ [Pasted text #1 +30 lines]`. Hint lines above and below the box change with state —
anchor the parser on the two rules and the `❯`/`!` line.

**20.2 brief.** Add `held?: true` to `InputBody`. For a held reply to a Claude Pane, the Hub
reads the visible screen before it types. If the input box holds text or is in bash mode, it
answers `409 {error: 'draft'}` and types nothing. The box parser lives in
`shared/inputbox.ts`, tested on 20.1's fixtures: it reads the ANSI screen, treats dim text
(`ESC[2m`) as empty, and anchors on the two rules and the `❯ `/`! ` line. Before
`sendText` on a Claude Pane, remove
only the characters 20.1 proved Claude holds: all five, but U+200D only outside an emoji
sequence — emoji stay whole.

**20.3 brief.** A `409 draft` keeps the reply held and shows the reason on its row: "Waiting:
the terminal's box has text". **Send now** stays off for that reason. The existing `stuck`
map retries when the Pane's revision moves. Other 409s and errors keep today's behaviour.

**Done (2026-10-11), `5a8479e`:**

- herdr 0.9.3's visible ANSI read keeps dim text (`ESC[0m ESC[2m …`); tmux reads with `-e`.
  Seven ANSI fixtures are in `test/fixtures/claude-2.1.296/inputbox-*.ansi.txt`. In this
  probe no dim predicted prompt appeared after a turn, so only one 2-line fixture covers it.
- `inputBox(screen, ansi)` in `shared/inputbox.ts` returns `'empty' | 'draft' | 'bash' |
  null`. `stripInvisible()` uses `Intl.Segmenter`, so an emoji joined by U+200D stays whole.
  Every text to a Claude Pane goes through the strip; other Panes are unchanged.
- `/api/panes/:key/input` answers 400 for a `held` other than `true`, and maps the `draft`
  error to 409 before the rule that turns a herdr error code into 502.
- Tests: `test/inputbox.test.ts`, `test/held.contract.test.ts` (throwaway herdr), a route
  test in `test/write.test.ts`, and `test/pending.test.ts`.

Two changes from the briefs:

1. **Every Chat-view reply sends `held: true`, not only held ones.** Claude queues a reply
   itself, so a check on held replies only would never run on a Claude Pane. A reply the Hub
   refuses for a draft becomes a held reply with the reason.
2. **A draft-held reply retries every 3 s** (`DRAFT_RETRY_MS`, `web/pending.ts`) while its
   Pane is `idle` or `done`, and the timer stops when no such reply is left. The brief's
   trigger, a revision change, never fires: herdr's revision does not move on screen output.
   Replies held for other reasons keep the revision rule.

**Gaps.**

- Release after the box is cleared is covered by unit tests only. No e2e flow covers the
  draft row, and a throwaway herdr cannot show it end to end.
- A draft typed between the Hub's read and its typing is still typed over. Accepted.
- A question menu whose cursor row sits right below a rule reads as `'draft'`. This fails
  safe: the Hub holds the reply instead of typing into the menu. No fixture has this layout.
- The parser fits Claude Code 2.1.296. When a later version changes the box, re-run the 20.1
  probe and add its fixtures.

**Verify** (replaces the plan's first wording, which assumed Claude replies are held):

1. While Claude works, type a word in Claude's box in herdr's own window.
2. Send a reply from the phone. Its row says "Waiting: the terminal's box has text", and
   **Send now** is hidden.
3. Let the turn end. The reply stays held with the same reason.
4. Clear the box in herdr's window. Within about 3 s, the reply goes out.
5. With Claude idle, put the box in bash mode (`!`) and send a reply. It is held the same way.
6. Send a reply with an empty box. It goes out at once; the dim `Try "…"` text does not hold
   it.
7. Paste text with a zero-width space and send it. Claude receives it on the first try.
8. Send 👨‍👩‍👧. It arrives whole.

---

# Wave 21 — herdr's own features: plugin actions, Agent names, integrations

**Items 4, 6 and 7. Goal:** what herdr knows about plugins and Agents is in reach from the
phone.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 21.1 | Hub: plugin actions, Agent rename, integrations | `glm-run` | Batch 4 |
| 21.2 | UI: Plugin actions in the ⋯ menus, Agent names, the integrations list | `frontend` | with 21.1 |

**Decisions (2026-10-11):**

- **Plugin actions** list only the `pane`, `tab` and `workspace` contexts. `global` and
  `selection` actions drive herdr's own window (Vim navigation, for example) and are hidden.
  An action with no `contexts` shows on the Pane menu.
- A plugin action is a write the user asks for, like a rename. It can move focus in herdr's
  own window. The Hub still never calls a `*.focus` method itself.
- After an action, if a Pane appears in that Workspace within 5 seconds, tautan opens it.
- The integrations list is read-only. tautan never runs `integration.install`; it shows the
  command with a Copy button.

**21.1 brief.** In `server/herdr.ts`: `pluginActions()` from `plugin.action.list`, cached per
Mux with a short TTL; `invokePluginAction(paneId, actionId, pluginId)` builds the context from
the Pane's Workspace, Tab and cwd; `renameAgent(paneId, name | null)` through
`agent.rename`; `integrations()` from `integration.list`, cached like `quotaReport()`. tmux
throws `unsupported` for all four. Routes: `GET /api/panes/:key/actions`, `POST
/api/panes/:key/actions/:actionId`, an `agent` field on `/api/rename`, and the integrations in
the existing Settings data per Host. The tree carries each Pane's Agent `name`. Contract tests
on a throwaway herdr with a test plugin linked through `plugin.link`: list, invoke with a
context, the 501 on tmux, and a rename that shows in `GET /api/state`.

**From Batch 3.** Two rules for 21.1:

- The tree's `agent` field stays the Agent type (`claude`, `codex`). Four places read it to
  recognise Claude: the box check and the strip in `server/mux.ts` `input()`, `QUEUES` in
  `web/composer.tsx`, and `server/complete.ts`. Put the user's Agent name in its own field.
- Keep Wave 20's code in `Hub.input()` (the `held` check and `stripInvisible`) and the
  `draft` → 409 mapping in the `server/http.ts` catch, ahead of the 502 rule.

**21.2 brief.** **Plugin actions…** in the Pane and Workspace ⋯ menus opens a list grouped by
plugin, with titles and descriptions; on a phone it is a sheet. A running action shows on its
row; a failure shows herdr's message above the list. The Agent name leads the Agent's row
and the Pane header when set; **Rename Agent** sits in the Pane ⋯ menu, and an empty name
clears it. **Settings › About** gains an **Agent integrations** list per Host: Agents found on
the Host first, each with **Current**, **Outdated** or **Not installed**, and the install
command with Copy for the last two.

**Verify:** on the phone, run **Hunk worktree diff in tab** from a Pane's menu and see the new
Tab open. Rename an Agent and see the name in `herdr agent list`. Settings › About shows each
integration's state, and Copy puts the install command on the clipboard.

**Done (2026-10-12), `da1bb62`…`cf3bf42`:**

- `da1bb62` (21.1, glm-5.3), `02d96be` (21.2 prep, glm-5.3), `89c66c3` (21.2, frontend),
  `cf3bf42` (review and qa fixes).
- Hub: `GET /api/panes/:key/actions` answers `{actions}`. `POST
  /api/panes/:key/actions/:actionId` with `{pluginId}` answers 204 after a tree refresh,
  `502 {error}` with herdr's whole message on a refusal, and 400 for an empty `pluginId`.
  `/api/rename` takes `agent: true`, only with `paneId`; an empty label clears the name.
  `GET /api/settings` carries `integrations: HostIntegrations[]` per herdr Host, and a failed
  Host carries `error`. tmux answers 501. The Hub caches per Mux: 30 s for actions, 60 s for
  integrations. It never caches a rejection.
- The tree's `agent` stays the Agent type. The name is in `agentName`.
- UI: **Plugin actions…** is in the Pane ⋯ menu (actions with `pane` or `tab`) and the
  Workspace ⋯ menu (actions with `workspace`). One sheet serves both widths, grouped by plugin.
  The running row says "Starting…", and herdr's refusal shows above the list. After a 204, a
  Pane that appears in that Workspace within 5 s opens. The Agent name leads the Pane header,
  the Home and sidebar rows, the Needs you cards and the Switch drawer, and a push names the
  Agent. **Rename Agent** is in the Pane ⋯ menu on herdr Panes with an Agent; an empty field
  turns the button into **Clear name**. **Settings › About › Agent integrations** lists each
  herdr Host, Agents found first.

Facts found:

- herdr's snapshot carries Agent names in a top-level `agents` array keyed by `pane_id`. The
  Pane record has no `name`.
- The `target` of `agent.rename` takes a Pane id or a unique Agent name. The Hub passes the
  Pane id.
- A plugin manifest is TOML: `id`, `name`, `version`, `min_herdr_version`, top-level
  `platforms`, and `[[actions]]` with `id`, `title`, `description`, `contexts`, `command`. A
  plugin command gets `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_WORKSPACE_ID` and `HERDR_BIN_PATH`.
- herdr 0.9.3 runs a plugin command asynchronously: `plugin.action.invoke` answers
  `status: "running"`. A 204 means "started". herdr does not report a command that exits
  non-zero. The only failure the UI shows is herdr's refusal (for example
  `plugin_action_not_found`).
- `PluginInvocationContext` has no field that names the invoking context, so the invoke route
  takes `pluginId` only.
- Live actions carry `platforms`. herdr refuses a platform-incompatible invoke, and the Hub
  also hides one. Only `linux` is probed.
- In `integration.list`, `command` is the Agent's executable (`claude`, `cursor-agent`), not
  an install command. The UI shows `herdr integration install <target>` with `_` mapped to
  `-`, because herdr lists `antigravity_cli` but its CLI takes `antigravity-cli`. The CLI has
  `herdr integration status`, not `list`.
- On this machine, "Hunk worktree diff in tab" (`hunk.diff`) has the contexts `pane` and
  `workspace`, so it shows in both ⋯ menus. The 4 Vim navigation actions are `global` and
  hidden. Several Herdr Plus and file viewer actions have no contexts and show on the Pane
  menu.

Four changes from the briefs:

1. **Copy and the install command show only for Agents found on the Host** (`available:
   true`). On this machine that is 2 rows of 17 (droid, hermes); the brief's rule gives 11.
   Agents not found show "not found". The orchestrator accepted this. To follow the brief,
   remove `i.available &&` in the `Integrations` list in `web/settings.tsx`.
2. **A Workspace action runs through the Workspace's first Pane** in herdr's order.
   `StateWorkspace` has no active Tab.
3. **The Tab context folds into the Pane ⋯ menu.** tautan has no Tab ⋯ menu.
4. **A push for a named Agent uses the name.** This was a review finding.

Tests: `test/plugins.contract.test.ts` (a throwaway herdr with `linkTestPlugin` from
`test/harness.ts`: two plugins, the actions `mark`, `global-only`, `plain`, `scratch`,
`boom`), `test/plugin-actions.test.ts`, route cases in `test/write.test.ts`, and a case in
`test/push.test.ts`. `scripts/e2e.ts` links the same plugins and has three new flows (Plugin
actions, Rename Agent, Settings › About): 22 flows in all.

Checks on the final tree (`cf3bf42`): `pnpm typecheck` clean; `bun test` 573 pass, 0 fail
(2707 assertions; 560 before Wave 21); `pnpm e2e` 22 of 22 (was 19). A `qa` spec check passed
5 of 5 with one defect (the `antigravity_cli` target), fixed in `cf3bf42`. A GLM review found
two low-severity issues (the empty `pluginId`, the push title), both fixed in `cf3bf42`.

**Gaps.**

- A freshly linked plugin can take up to 30 s to show (the action cache).
- A rename made in herdr's own window shows on the next tree read.
- Focus goes back to the ⋯ button after the sheet closes, but not on iOS Safari, where a tap
  does not focus a button.
- Copy is hidden over plain http (the existing `CopyButton` behaviour). The command stays
  selectable.
- `macos` and `windows` platform names are not probed.
- The Pane ⋯ menu asks for the action list when the Pane opens, so each Pane view costs one
  GET (cached 30 s by the Hub).
- No step ran on a real device.

**Verify** (replaces the plan's one-line wording):

1. On the phone, open a Pane's ⋯ menu and tap **Plugin actions…**. The list groups actions by
   plugin, and no Vim navigation action shows.
2. Run **Hunk worktree diff in tab**. herdr opens a new Tab, and within 5 s tautan opens its
   Pane.
3. Open a Workspace's ⋯ menu. **Plugin actions…** lists **Hunk worktree diff in tab** there
   too.
4. Tap **Rename Agent** in a Claude Pane's ⋯ menu and set a name. The name leads the Pane
   header and the Home row, and `herdr agent list` shows it.
5. Rename it again with an empty field and tap **Clear name**. The name goes away in tautan
   and in `herdr agent list`.
6. Open Settings › About. **Agent integrations** lists each herdr Host, Agents found first,
   each with Current, Outdated or Not installed.
7. Tap **Copy** on an Outdated row (droid or hermes on this machine). The clipboard holds
   `herdr integration install <target>`.
8. Let a named Agent ask for input while the phone is locked. The push names the Agent.

## 21.4 — Close Wave 21's gaps (Batch 5)

The user asked for the Batch 4 gaps to be fixed (2026-10-12). One lane per item; each ends by
updating its line in the Gaps list above, as fixed or as a recorded limit.

| # | Gap | Fix | Specialist |
|---|---|---|---|
| 21.4.1 | A plugin command that fails after it starts is not reported | After a 204, read `plugin.log.list {plugin_id, limit}` for the entry with the same `action_id` that started after the invoke (the log carries no invocation id). Poll until its `status` is `succeeded` or `failed`, for at most 10 s. On `failed`, show the exit code and the last line of `stderr` in the sheet, or as a notice when the sheet has closed. | `glm-run`, then `frontend` |
| 21.4.2 | A newly linked plugin takes up to 30 s to show, and each Pane view costs one GET | Ask for the actions when **Plugin actions…** opens, not when a Pane opens, and bypass the Hub's cache for that read. Show the menu entry on every herdr Pane, with an empty state when no action fits. | `frontend`, with a Hub flag from `glm-run` |
| 21.4.3 | A rename made in herdr's own window shows only on the next tree read | Probe on a throwaway herdr which event `agent.rename` fires (`pane.updated`, `pane.agent_detected`, or none). If one fires, re-read the tree on it. If none fires, record it as a herdr limit. | `glm-run` |
| 21.4.4 | Focus does not return to the ⋯ button on iOS Safari | Keep the opener element when a sheet opens and call `focus()` on it when the sheet closes. Check it in WebKit. If iOS still refuses, record it as a platform limit. | `frontend` |
| 21.4.5 | Copy is hidden over plain HTTP | `CopyButton` falls back to a hidden `textarea` and `document.execCommand('copy')` when the Clipboard API is missing, and hides only when both fail. | `frontend` |
| 21.4.6 | `test/blocked.contract.test.ts`, "a stale prompt id is refused", fails on timing now and then | Find the race and fix it at its root, not with a longer timeout or a retry. | `glm-run` |
| 21.4.7 | `macos` and `windows` platform names not probed | Resolved without a probe: herdr 0.9.3's schema lists `PluginPlatform` as `linux`, `macos`, `windows`. Add a unit test for the filter on each name. | `glm-run` |

**Verify:** after `herdr plugin link` of a new plugin, its actions show the next time
**Plugin actions…** opens. A test action that exits non-zero shows its exit code and last
error line. A rename in herdr's own window shows in tautan within a second, or the limit is
recorded. **Copy** works on a plain-HTTP LAN address.

---

# Wave 22 — Search a Pane's terminal history

**Item 5. Goal:** find a line printed long ago, from the phone, and read it in context.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 22.1 | Decide the history source | `deep-reasoner` | Batch 1 |
| 22.2 | Hub: a history search route | `glm-run` | Batch 5 |
| 22.3 | UI: Find in the Pane, and a history view | `frontend` | with 22.2 |

**From Batch 4.** Three facts for 22.2 and 22.3:

- The Pane ⋯ menu now holds **Plugin actions…** (after Read aloud) and **Rename Agent**.
  **Find in terminal** joins the same menu. Keep the menu short on a phone.
- The `Mux` interface gained four methods, and 13 fake-Mux test files needed stubs. Wave 22's
  history read adds another. Expect the same stub churn, or make the new method optional on
  `Mux`.
- `test/harness.ts` has `linkTestPlugin`, and `scripts/e2e.ts` links the test plugins. The
  e2e suite has 22 flows.

**22.1 brief.** Compare, on a throwaway herdr 0.9.2:

- (a) `pane.read` with `recent_unwrapped` and a large `lines` count, searched in the Hub.
  Measure the cost per line on 0.9.2 against the 0.8.0 cliff in `server/herdr.ts:109`.
- (b) `pane.copy_search`, herdr's native search. It returns match ranges, but showing the
  lines around a match needs a read, or `pane.scroll`. `pane.scroll` moves the shared
  viewport, so herdr's own window scrolls too: that is a write on the user's live session,
  and it is rejected unless no read-only path works.

tmux reads history with `capture-pane -p -J -S -<n>`, which is cheap. Prefer a read-only path
(ADR 0001: the Hub renders Mux snapshots). Name the line cap and the cost at that cap. Record
an ADR only if the read path changes.

**22.1 decision.** herdr reads its history with `pane.selection.read`, not `pane.read` (ADR
0010). One `pane.get` gives `scroll.max_offset_from_bottom` and `scroll.viewport_rows`; one
read-only `pane.selection.read` from `{row: 0, col: 0}` to `{row: max + viewport - 1, col: 0}`
then returns the whole kept scrollback as unwrapped logical lines in one call — wrapped rows
are joined, so a match on a wrapped line arrives whole. The cap is herdr's own ring (about
9,300 grid rows, ~4,000 joined lines, ~730 KB on the probe Pane), not a number the Hub picks.
`pane.read` is rejected as a history source: whatever `lines` asks, its recent ring answers
with at most ~78 KB (430 unwrapped rows, or 1,000 wrapped rows) and `truncated: true` every
time, so it never reaches scrollback — and on the live 0.9.0 server a Claude Pane read at
height + 20 still costs 274–377 ms (13.7–18.8 ms per extra row across two runs; the 0.8.0
cliff lives on). tmux reads
`capture-pane -p -J -S -10000`: 10,000 lines is the Hub's cap there, clamped by each Pane's
`history-limit`.

| Read | Where | Result | Median |
|---|---|---|---|
| `pane.read recent_unwrapped lines=N`, N = 1k…50k | throwaway 0.9.2, shell Pane | always 430 rows / 78.5 KB, `truncated` | 2.8–15 ms (some runs ~105 ms) |
| `pane.read recent lines=N`, same N | throwaway 0.9.2, shell Pane | always 1,000 rows / 79 KB, `truncated` | 17–59 ms |
| `pane.read recent_unwrapped lines=height+20` | **live 0.9.0, Claude Pane** | 70 rows / 3.2 KB | **274–377 ms** |
| `pane.selection.read`, full ring (rows 0…9301, col 0→0) | throwaway 0.9.2 | 3,988 joined lines / 732 KB, all of the ring | 29.9 ms (an earlier run: 132.6) |
| `pane.selection.read`, half the ring | throwaway 0.9.2 | 1,995 lines / 366 KB | 21.4 ms (earlier: 114.3) |
| `pane.copy_search`, every revision source | throwaway 0.9.2 | `stale_content: pane content changed` | — |
| `capture-pane -p -J -S -10000` | throwaway tmux | 7,538 lines / 1.38 MB | 82.2 ms (earlier: 45.2) |
| `capture-pane -p -J -S -50000` | throwaway tmux | 37,539 lines / 6.9 MB | 281.0 ms (earlier: 219.1) |

Also measured: a `session.snapshot` during a big `pane.read` took 3.1 ms against a 0.7 ms
baseline, so reads do not block other clients. `pane.copy_search` is unusable today: the
`content_revision` it requires is exposed by no read-only surface (`pane.get` and snapshot
records have no such field; `pane.read`'s result revision is always 0 — on the live server the
record said 14 while the read result said 0). Every candidate failed `stale_content`, at rest
and after title, scroll and output bumps. `pane.scroll` is a viewport write (the visible text
changed and `offset_from_bottom` moved to 5) and is rejected. `pane.selection.read` columns
must be 0; a column past a row's width fails with `selection_unavailable`, and it answers
while the Pane is busy (6.5 ms), though its rows shift as herdr trims the ring, so a retry
must re-read. Probe: `bun …/scratchpad/22.1/probe.ts` (add `--live` for the read-only live
pass), output beside it in `probe-output.txt`.

**22.2 brief.** `GET /api/panes/:key/history?q=&before=` returns matches, newest first, each
with its line number and a few lines of context, from one read searched in the Hub: herdr
reads `pane.get` for `scroll`, then `pane.selection.read` over the whole ring at column 0
(ADR 0010); tmux reads `capture-pane -p -J -S -10000`. Context lines come from the same text;
no second read. Literal, case-insensitive search. If `pane.selection.read` answers
`unknown variant` (a herdr server older than the method), the route answers 501. Tests: a match past
the visible screen, no match, the cap, a tmux Pane.

**22.3 brief.** **Find in terminal** in the Pane ⋯ menu, and ⌘⇧F on desktop, opens a search
field with a match count and previous/next. The history view is read-only text with the
matches highlighted, rendered as spans from `shared/ansi.ts`. Paths and links in it open as
they do on the Screen. On a phone it is a full-height sheet.

**Verify:** in a shell Pane, print a word, then 1,000 more lines. On the phone, find the word
and read the lines around it.

---

# Wave 23 — Chat and composer small items

**Items a, b and c. Goal:** code reads as code, commands are easy to find, and effort is a
tap.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 23.1 | Code highlighting; the `/effort` card | `frontend` | Batch 2 |
| 23.2 | Slash matching; the effort levels | `glm-run` | Batch 2 |

**23.1 brief.** Highlight fenced code in `web/markdown.tsx` with the installed
`@lezer/highlight` and `@codemirror/lang-*` parsers; add no dependency. Load the highlighter
as a lazy chunk on the first code block, outside the precache, as Phase 31 loads the editor.
Map the fence label to a parser (js, jsx, ts, tsx, json, css, html, md, py, yaml); any other
label stays plain. A block over 100 KB stays plain. Colours come from tautan's tokens and
work in both themes. Copy still copies the source. `/effort` on a Claude Pane opens a card
like the `/model` card; a pick sends `/effort <level>`. Remove `effort` from `SCREEN_COMMAND`
(`web/composer.tsx:48`).

**23.2 brief.** In `server/complete.ts:115`, rank: label prefix, word start in the label,
label substring, description substring, then label letters in order. Tests for each tier and
for the order between tiers. Serve the effort levels the way the `/model` card's models are
served, from Claude Code's own list (check the installed version's `/effort`).

**Done (2026-10-11), Claude Code 2.1.296:** ranking runs in five tiers: label prefix, word
start in the label, label substring, description substring, then label letters in order. A
slash command that reaches no tier drops out of the list, and a leading `/` in the query is
ignored. The effort levels come from Claude Code 2.1.296's own bundle: low, medium, high,
xhigh, max, auto (`kind=effort` on the complete route; `[]` for every other Agent). `/review`
is not in tautan's built-in list, so `/rvw` finds it only when the user's Claude Code has a
`/review` command or skill. One deviation from the brief: `effort` stays in `SCREEN_COMMAND`.
A user who closes the card with Esc and sends `/effort` gets Claude Code's own menu, and
without the entry the Chat view would not switch to the Screen to show it; `/model` keeps its
entry for the same reason. The card still opens for `/effort ` (the text the box then holds).
Highlighting lives in `web/highlight.ts`: a `lazy-highlight-*` chunk outside the precache,
reusing the editor's language chunks — the first TypeScript block costs about 120 kB gzip.
The labels js, jsx, ts, tsx, json, css, html, md, py and yaml, and their aliases, load a
parser; other labels and blocks over 100,000 characters stay plain. The colours are the
palette's ANSI hues mixed 60/40 with `--fg`.

**Verify:** on the phone, a reply with a TypeScript block shows colours in light and dark.
Type `/rvw`: `/review` is in the list. Type `/effort`, pick a level, and see Claude's footer
show it.

---

# Wave 24 — Hardening tests

**Items d and e. Goal:** two failure classes herdr-web-ui hit are pinned by tests in tautan.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 24.1 | Markdown parser under pathological input | `glm-run` | Batch 1 |
| 24.2 | Claude Code approval footers | `glm-run` | Batch 1, after 20.1's tmux setup |

**24.1 brief.** Feed the parser in `web/markdown.tsx`: 1 MB of `(`; 1 MB of `_`, `*` and `[`;
a `\(` formula left open over many lines; a 10,000-item list; a line of 100,000 `+`; a URL
followed by 10,000 `)`; deeply nested block quotes. Each parse finishes under 100 ms. Fix any
quadratic path at its root, and name the input that found it in the test.

**24.2 brief.** Capture real Claude Code screens, redacted, from a throwaway tmux: an
approval with the cursor on "Yes, and don't ask again" (its footer may be `Esc to cancel`
alone); an approval while background agents run (herdr-web-ui saw the footer add the chord
that stops them; check whether it does);
an approval whose long command pushed the title off the screen; a question whose
typed-answer row holds a draft. Add them as `shared/blocked.ts` fixtures with the Claude Code
version. Fix `readBox` if a card reads wrong.

**Done (2026-10-11), Claude Code 2.1.296:** fixtures are in
`test/fixtures/claude-2.1.296/` (`approval-*.txt`, `question-typed-draft.txt`), tests in
`test/blocked-2.1.296.test.ts`. In 2.1.296 the approval footer does not gain a chord while
background agents run (it stays `Esc to cancel · Tab to amend`); `readBox` now joins a
label that wraps at the box width instead of reading the rest as a description.

**Verify:** the tests pass, and each fixture names the Claude Code version it came from.

---

# Wave 25 — Claude accounts

**Item 8. Goal:** a Claude Pane on any account works in tautan as one on `~/.claude` does,
and a new Claude Pane starts on the account you pick.

**Why now:** Claude Code keeps an account in the folder `CLAUDE_CONFIG_DIR` names. A Claude
Pane on a second account gets no Chat view, no slash commands from that account and no
usage numbers, because tautan reads `~/.claude` only, and herdr's Claude hook is set up in
`~/.claude` only.

**Decisions (the user, 2026-10-11):**

- Accounts are found, not configured: `~/.claude` and each `~/.claude-*` folder on a Host.
  There is no settings form for them.
- tautan never writes into an account folder. **Add account** opens a Tab that runs Claude on
  the new folder; Claude creates it, and the user signs in with `/login` on the Screen.
- tautan shows herdr's hook state for each account and the command that installs it, with
  Copy. It never runs the command.
- Out of scope: sharing skills, plugins, `CLAUDE.md` and MCP servers across accounts (the
  user's dotfiles can render the same files into each account folder). Switching a Pane to
  another account when its account hits a limit is on the ROADMAP's "Later" list, optional.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 25.1 | Probe and decide: what an account is, a Pane's account, `env` on start, herdr's hook per account; ADR 0011 | `deep-reasoner` | Batch 5 |
| 25.2 | Hub: accounts, a Pane's account, reads from that account, `env` on create, quota per account | `glm-run` | Batch 6 |
| 25.3 | UI: the account picker, Add account, hook state, a meter per account, a colour dot | `frontend` | with 25.2 |

**25.1 brief.** On a throwaway herdr 0.9.3 with an isolated `HOME` that holds two account
folders, find out:

- whether `env` on `tab.create` reaches the Claude process that `agent.start` launches in
  that Tab (read `/proc/<pid>/environ`), and whether tmux `new-window -e` and
  `split-window -e` do the same;
- whether `herdr integration install claude` installs into the folder `CLAUDE_CONFIG_DIR`
  names, and what herdr reports (`agent`, `agent_session`, Status) for a Claude without the
  hook;
- how to read a Pane's account: its conversation id found in exactly one account's
  `projects/` folder (ADR 0005's exact-id rule), and on Linux `CLAUDE_CONFIG_DIR` from
  `/proc/<pid>/environ` through `pane.process_info`. On a macOS remote Host, only the id
  lookup works. Two folders that hold the same id leave the Chat view unavailable, as
  herdr-web-ui 0.4.6 does;
- what marks a folder as an account: a login file, a `projects/` folder, or either. On
  macOS the login can be in the Keychain, not in the folder.

Name each account from its folder suffix (`~/.claude` is **default**), and give it a colour
from a fixed list by order. Record the decisions as ADR 0011. The probe never writes to the
user's real account folders; a probe that needs a logged-in Claude runs in a throwaway tmux
with the real `HOME` and only reads.

**25.2 brief.** A new `server/accounts.ts` lists a Host's accounts, locally and over SSH,
with a TTL cache, and resolves a Pane's account as 25.1 decides. `server/chat.ts` and
`server/complete.ts` take the Pane's account folder in place of `~/.claude`. The new Tab,
Split and New Workspace routes take an optional `account` and pass `CLAUDE_CONFIG_DIR` as
herdr's `env` or tmux's `-e`. An account name must match a found account, or the route
answers 400. **Add account** takes a new name (letters, digits and `-`) and opens a Tab that
runs Claude with `CLAUDE_CONFIG_DIR=~/.claude-<name>`. The quota route reads each account
with `quota-axi --provider claude --profile-only`. The state carries each Claude Pane's
account name, and each account's hook state and install command. Tests: two account folders
in an isolated `HOME`; a Pane resolved by its id; two folders that hold one id; a new Tab's
`env`; an unknown account name.

**25.3 brief.** When a Host has two or more accounts, the New Tab, Split and New Workspace
sheets show an account picker for Claude. The default is the account of the Workspace's other
Claude Panes, otherwise **default**. Each account's colour shows as a dot on the Pane row,
the Agent row and the Pane header. Settings lists each Host's accounts: name, folder, signed
in or not, herdr's hook state with Copy for its install command, and a usage meter. **Add
account** asks for a name and opens the sign-in Tab.

**Verify:** on the phone, add an account with **Add account** and sign in with `/login` on
the Screen. Start a Claude Tab on it: the Chat view shows its conversation, `/` lists that
account's commands, and its dot colour differs from a Pane on **default**. Settings shows a
meter for each account. A Claude started in herdr's own window with
`CLAUDE_CONFIG_DIR=~/.claude-<name> claude` also gets its Chat view.

---

## Final qa

After Batch 6, `qa` drives the built app on a throwaway herdr and a throwaway tmux at
390 × 844 and 1440 × 900, over every screen these waves touched, and lists the Verify steps
for the user's real devices. `scribe` updates `docs/UI.md`, `docs/ARCHITECTURE.md` and the
ROADMAP phases.
