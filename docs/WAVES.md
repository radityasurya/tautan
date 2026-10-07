# Delivery waves

A delegation plan for the orchestrator. Each wave is a goal, a set of lanes, and one
verification step you run on a real device. Hand a wave to `/lead` and the orchestrator routes
its lanes.

This file plans the work. The next plan, for the gaps found against herdr-web-ui 0.3.52 on
2026-10-07, is [WAVES-PARITY.md](./WAVES-PARITY.md). [ROADMAP.md](./ROADMAP.md) records what landed — when a wave passes
its verification, tick its phase there. Vocabulary is in [../CONTEXT.md](../CONTEXT.md); use
its terms (Hub, Host, Mux, Workspace, Tab, Pane, Agent, Status, Seen, Screen, Explain).

Source of the decisions: a UI and UX audit of tautan against `devswha/herdr-web-ui` 0.3.50,
run on 2026-10-05. Behaviour claims about that project come from its own `DESIGN.md`,
`docs/chat-mode-audit.md` and `docs/terminal-flow-control.md`.

## How to run a wave

1. Read the wave's **Goal** and **Why now**.
2. Run `/lead <the wave's goal, plus the files it names>`.
3. The orchestrator plans, then routes each lane to the specialist named in the lane table.
4. Every GLM and Codex brief ends with the same return contract: what changed, files
   modified, validation run, remaining risks or decisions.
5. Run the wave's **Verify** step on a real phone before you tick anything.
6. Commit the wave once its verify passes. Waves interleave inside `web/pane.tsx` and
   `server/http.tsx`; a retrospective split of several waves cannot keep the intermediate
   commits compiling, so the per-wave history only exists if each wave lands as itself.

Run one wave at a time. Lanes inside a wave may run in parallel where the table says so.

## Standing constraints

These hold for every wave. If a lane has to bend one, stop and ask.

| Constraint | Record |
|---|---|
| The Hub renders Mux snapshots. It never renders from a PTY. | [adr/0001](./adr/0001-render-mux-snapshots-not-a-pty.md) |
| A herdr geometry lease may attach a PTY only to size a Pane for a phone. | [adr/0004](./adr/0004-phone-width-geometry-lease.md) |
| The chat lens is a second Pane view; any failure falls back to the Screen. | [adr/0005](./adr/0005-chat-lens-second-view.md) |
| The Hub reaches Hosts over SSH, not through a Mux relay. | [adr/0002](./adr/0002-hub-reaches-hosts-over-ssh.md) |
| Interactivity comes from recognised text and mouse forwarding. | [adr/0003](./adr/0003-interactivity-from-recognised-text-and-mouse-forwarding.md) |
| Write tests run only on throwaway servers. The live socket never receives a write. | [../CLAUDE.md](../CLAUDE.md) |
| Add a dependency only when a few lines cannot do the job. | [../CLAUDE.md](../CLAUDE.md) |

Four things make tautan a different product, not a smaller one: the Affordance layer, SGR
mouse forwarding, the Diff screen, and the measured grid column. No wave may weaken them.

## Routing

| Lane shape | Specialist | Model |
|---|---|---|
| Anything a user sees or reads | `frontend` | opus |
| Net-new backend code, tests, fix loops | `glm-run` | glm-5.3 |
| Rename, stub, one-file tweak | `fast-worker` | sonnet |
| Where does X live, what does the code do today | `recon` | sonnet |
| Run the app, reproduce, confirm a fix | `qa` | sonnet |
| Install, deploy, CI, quota | `ops` | sonnet |
| README, changelog, ADR prose | `scribe` | sonnet |
| A conclusion needed before code | `deep-reasoner` | opus |

Before a fan-out of more than two specialists, the orchestrator runs the quota gate.

---

# Wave 0 — Correct the three small things

**Goal:** close one security hole and two documentation lies. No phase; these are chores.

**Why now:** each is under twenty lines, and one of them is exploitable.

| # | Lane | Specialist | Files |
|---|---|---|---|
| 0.1 | Refuse a request that carries `Tailscale-Funnel-Request` | `fast-worker` | `server/http.ts` |
| 0.2 | Settle the grid default: read the code, then fix whichever side is wrong | `recon`, then `fast-worker` or `scribe` | `web/pane.tsx`, `docs/DESIGN.md`, `docs/ROADMAP.md` |
| 0.3 | Print the Status word on every Pane row, not only `blocked` and `done` | `frontend` | `web/home.tsx` |

**0.1 brief.** Funnel publishes the Hub to the public internet. The Origin check does not see
it, because the request carries a real Origin. Refuse any request whose headers include
`Tailscale-Funnel-Request`, before the Origin check. Answer 403 with `{error: 'funnel'}`.
Add one test. Record the reason in `docs/SECURITY.md`.

**0.2 brief.** `docs/UI.md` records `tautan.wrap.agent` as `on`. `docs/DESIGN.md` and
ROADMAP phase 4b say the grid is scrolled by default. Both cannot be true. Read
`web/pane.tsx` first and report which the code does. If the code scrolls, flip the default to
Wrap for agent Panes and leave shell Panes scrolled. If the code already wraps, correct the
two stale documents instead.

The reason Wrap is now safe: ROADMAP 4b rejected it because a wrapped prompt box read worse
than a scrolled one. That objection no longer holds, because `web/blocked.tsx` lifts the box
out as a card with its options as rows. You never need to read the ASCII box.

Shell Panes stay scrolled. An 80-column grid at a readable size does not fit a 390 px phone,
and Fit scales it to about 8 px, which is under the 11 px floor in `docs/UX.md`.

**0.3 brief.** `docs/UX.md` §7 says the dot must never carry Status alone. Line 2 prints the
word for `blocked` and `done` today. Print it for `working`, `idle` and `unknown` too, in the
Status colour, before the existing text.

**Verify:** `curl -H 'Tailscale-Funnel-Request: 1' …/api/state` returns 403. On the phone, an
agent Pane fills the width with no sideways drag, and every row names its Status.

---

# Wave 1 — Trust the answer

**Phase 11. Goal:** an answer can never land in a prompt that already moved on.

**Why now:** this is the only behaviour in tautan that can approve something you did not
agree to. `POST /api/panes/:key/input` sends the key with no check that the box on screen is
still the box the card drew.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 1.1 | Prompt id, the working-line normaliser, and the 409 | `glm-run` | with 1.2 |
| 1.2 | Rebuild the blocked card, and dock it on the composer column | `frontend` | with 1.1 |
| 1.3 | Contract test on a throwaway herdr | `glm-run` | after 1.1 |
| 1.4 | Drive a real permission box end to end | `qa` | after 1.1, 1.2 |
| 1.5 | Review the diff | `/code-review`, then `/glm:adversarial-review` | last |

**1.1 brief (GLM).** In `shared/blocked.ts`, add `promptId(explain, screen)`. It returns a
12-character hash of the detection plus the whole visible Screen.

One line of the Screen changes every second and must not count. Claude Code prints
`✢ Tempering… (1m 55s · ↓ 10.0k tokens · esc to interrupt)` while it works. Normalise that
line to `* <doing> (<time> · <tokens>)` before hashing. Match the whole line exactly, token
count and arrow included, and only when no other line of the Screen has that shape.

Salt the hash with a random value generated once per Hub process, so an id cannot survive a
restart.

`GET /api/panes/:key/explain` returns the id. `POST /api/panes/:key/input` accepts an optional
`promptId`. When the body carries one, the Hub re-reads the Pane, re-derives the id, and
answers `409 {error: 'prompt_changed'}` on a mismatch. A body with no `promptId` keeps the
current behaviour, so the key bar and the quick replies are unaffected.

Write tests for: a match, a mismatch, a ticking working line that must still match, a Hub
restart that must not match, and a body with no id.

**1.2 brief (frontend).** Rebuild `web/blocked.tsx` to this spec:

- Options are flat full-width rows. Each row is the menu's number as a mono keycap, the
  label, and its description under it in `--muted`. No row is filled, outlined or chosen by
  default; herdr has no ground to recommend one.
- A picked row takes the accent tint, an accent border and an accent keycap.
- The card caps at `max(60dvh, 240px)`. Only the detection excerpt gives way: six lines at
  rest, two at the least. The header, the options and the action row never shrink.
- The excerpt scrolls in itself with `overscroll-behavior: contain`, so a drag past its top is
  never the page's own gesture.
- The card renders inside the dock, above the composer, on the composer's width and gutter.
  It is no longer a floating card with its own margins.
- The card lives in an `aria-live="polite"` region that stays mounted at zero height. A live
  region that appears together with its content is not announced.
- Send posts the chosen key with the `promptId` the card was drawn from. On `409` the card
  replaces its action with **Re-read**, prints "The prompt changed. Read it again before you
  answer.", and refetches `explain`.

Keep `offeredKeys()` as the source of the options. Keep the excerpt in the Agent's own colours.

**1.4 brief (qa).** Start a throwaway herdr from `test/harness.ts`. Start the real `claude`
binary. Trigger a permission box. Confirm the card draws the options as rows. Then let the
Agent move past the box and tap Send. Expect the refusal, not an approval. Report with
screenshots at 390 px.

**Verify:** on a real phone, trigger a permission box, let Claude move on, then tap Send. The
card says the prompt changed. Then answer a live box and watch the Status move to `working`.

**Done when:** `bun test` is green, the qa evidence shows the refusal, and `/code-review`
returns no correctness finding on `shared/blocked.ts` or `server/http.ts`.

---

# Wave 2 — Know you are needed

**Phase 12. Goal:** when a Pane you are not looking at needs you, the app says so.

**Why now:** the background case is covered by push, the app badge and the **Needs you**
section. The foreground case has no signal at all. With tautan open on one Pane, nothing tells
you another Pane just asked a question.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 2.1 | In-app alert | `frontend` | with 2.2 |
| 2.2 | Wake lock, connection chip, document title | `fast-worker` | with 2.1 |
| 2.3 | Two Panes, one asks | `qa` | after both |

**2.1 brief (frontend).** The SSE `state` event already carries every Status transition, and
`shared/seen.ts` already knows what is unseen. This is a presentation layer; add no transport.

Draw one card from the top edge when an unseen Pane enters `blocked` or `done`:

- It hangs from `env(safe-area-inset-top)` alone. Do not detect the device.
- At 768 px and under it is one line, 44 px high, as wide as its text to 340 px: the Pane's
  title, then what happened. Cut a long title. Never cut what happened.
- One at a time. A newer card folds the current one away first.
- A tap opens the Pane. A flick up dismisses it. It leaves 3.6 s after its text shows, and the
  timer waits while a finger is on it.
- Never for the Pane already open. Never while the document is hidden, because push covers
  that.
- Under `prefers-reduced-motion`, it fades in where it rests.

**2.2 brief (fast-worker).** Three small changes in `web/app.tsx`:

- Hold a screen wake lock while a Pane is open. Release it on hide and on unmount, including a
  request that resolves after the Pane closes. Wrap every call in try/catch.
- The reconnect bar becomes a `role="status"` that stays in the DOM while the connection is
  live and takes no room. Never `display: none`, so a screen reader can read it.
- Set `document.title` to `<Pane title> · tautan` while a Pane is open.

**Verify:** open tautan on a Pane. Make a second Pane ask a question. The card drops in and
the tap opens that Pane. The screen does not sleep while you watch an Agent work.

---

# Wave 3 — Reach what the Agent made

**Phase 13. Goal:** tap a path on the Screen and see the file.

**Why now:** `shared/affordances.ts` already finds paths and already makes them tappable. A
tap copies. `docs/UI.md` records that open was dropped because a Pane path belongs to the
Host — but the Hub reads the Host already, the same way the Diff screen runs git.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 3.1 | Hub file route, local and over SSH | `glm-run` | first |
| 3.2 | Challenge the containment rule | `/glm:adversarial-review` | after 3.1 |
| 3.3 | File screen | `frontend` | after 3.1 |
| 3.4 | Long-press a path Affordance to open it | `frontend` | with 3.3 |
| 3.5 | Open a chart an Agent wrote | `qa` | last |

**3.1 brief (GLM).** Add `GET /api/panes/:key/file?path=`. Resolve the path against the Pane's
own `cwd`. Refuse anything that escapes it, after resolving symlinks and `..`. Cap the
response. Answer the media type. Run it locally or over the Host's SSH connection, the way
`server/http.ts` already runs the diff.

Containment is the whole risk in this lane. Write the traversal tests first: `..`, an absolute
path, a symlink out of the tree, and a path that is legal but enormous.

**3.3 brief (frontend).** A full-screen viewer at `#/file/<paneKey>?path=`. Render an image
inline. Render text in the mono stack with the Diff screen's gutter conventions. Reuse the
Diff screen's state blocks for missing, too large and binary. Back returns where you came
from.

**3.4 brief (frontend).** A long press on a path Affordance opens the viewer. The tap keeps
copying and keeps the `Copied` chip. Follow the existing 500 ms and 10 px rules.

**Verify:** let an Agent write a chart. Long-press its path on the phone. The chart opens.

---

# Wave 4 — Fewer taps on a phone

**Phase 14. Goal:** remove the four places where the phone costs more taps than the desktop.

**Why now:** every item here is independent, so the wave fans out. None of them changes a
contract.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 4.1 | Held messages above the composer | `frontend` | all four in parallel |
| 4.2 | Tab rename and close from the Tab strip | `frontend` | |
| 4.3 | Prefill the worktree branch | `fast-worker` | |
| 4.4 | One-shot Ctrl on the key bar | `fast-worker` | |
| 4.5 | Recording pill for the mic | `frontend` | |
| 4.6 | Drive all five on a phone | `qa` | last |

**4.1 brief.** A message sent while the Agent works lands in the Agent's own queue, unseen.
List what you wrote above the composer instead. Each row carries its text and a remove
control. When the Status leaves `working`, the list offers **Send now**. Fold the list to its
caption while the blocked card is open, and never fold it while it asks for your action.

**4.2 brief.** `POST /api/rename` already takes a `tabId`, and `docs/UI.md` records that Tab
rename is unreachable from the phone. A long press on a Tab opens a menu: the Tab's Panes when
it holds several, then **Rename tab**, then **Close tab** in the danger colour.

Close the Tab without a confirm, unless the close costs more than the Tab: an Agent in it is
`working` or `blocked`, or it is the Workspace's last Tab. Then ask.

**4.3 brief.** The New Workspace sheet asks for a branch in an empty field. herdr generates
`worktree/<adjective>-<noun>-<4 hex>` itself. Fill the field with that name and select it, so
typing replaces it. Derive the label from the branch until the user types over it.

**4.4 brief.** Add a one-shot `ctrl` cap to the shell key preset. Arm it on a tap; the next key
goes out as `ctrl+<key>`; then it disarms. It turns a two-row preset into one row for every
`^x` a shell needs.

**4.5 brief.** The mic has no recording state today, so nothing says it is listening and
nothing cancels it. Add a pill over the composer: Cancel, a **Recording** label, level bars
driven by the live microphone, a mono timer, and Done. Under `prefers-reduced-motion`, show
one level bar updated at 4 Hz and keep the label and the timer.

**Verify:** type while an Agent works, then send the queue. Rename a Tab from the phone.
Create a worktree without typing a branch. Send `ctrl+r` with two taps.

---

# Wave 5 — Install on a phone

**Phase 15. Goal:** one command installs tautan, and the phone gets a QR code.

**Why now:** the install path is `bunx`, systemd or Docker, plus a manual `tailscale serve`.
That is the hardest step in the product, and it is the step a new user hits first.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 5.1 | `herdr-plugin.toml` and `scripts/plugin.ts` | `glm-run` | first |
| 5.2 | QR in half-block characters | `glm-run` | with 5.1 |
| 5.3 | Install it on this machine and report | `ops` | after both |
| 5.4 | README install section | `scribe` | after 5.3 |

**5.1 brief (GLM).** Add a herdr plugin manifest with `[[build]]`, `[[startup]]` and
`[[actions]]` for start, stop and status, plus a `[[panes]]` entry titled **Phone setup** that
opens zoomed. `scripts/plugin.ts` implements those verbs. Phone setup prints the tailnet
address and its QR code.

**5.2 brief (GLM).** Render the QR with half-block characters, in the terminal, with no
dependency. If a correct encoder needs more than a few hundred lines, say so and stop; do not
add a package without asking.

**Verify:** run `herdr plugin install radityasurya/tautan` on this machine. Open Phone setup.
Scan the QR with a phone and add tautan to the Home Screen.

---

# Wave 6 — Chores

Independent, small, and safe to pick up between waves. Each is one lane.

| # | Chore | Specialist | Files |
|---|---|---|---|
| 6.1 | Settings section labels: Appearance · Notifications · Replies · Access · About | `frontend` | `web/settings.tsx` |
| 6.2 | Version row: tautan's own and the herdr the Hub talks to | `frontend` + `glm-run` | `web/settings.tsx`, `server/http.ts` |
| 6.3 | Quota rows from `quota-axi --json`. Shell out; do not reimplement it | `glm-run` | `server/`, `web/settings.tsx` |
| 6.4 | ~~Group the Agents list by folder~~ — replaced by the Pane list choice (tautan / herdr) | `frontend` | `web/home.tsx`, `web/spaces.ts` |
| 6.5 | Sticky file header on the Diff screen | `fast-worker` | `web/diff.tsx` |
| 6.6 | Refusal escalation in the confirm dialog | `frontend` | `web/sheets.tsx` |

**6.1 note.** Six flat rows read fine. Ten do not, and 6.2 and 6.3 add two.

**6.4 note.** Superseded. Folder grouping was built, then removed in 1006c21 at the user's
request: Settings › Appearance › Pane list now offers **tautan** (grouped by Workspace) or
**herdr** (Spaces above Agents, grouped by Priority or Spaces), and the Workspace/Folder
switcher is gone. Do not rebuild folder grouping.

**6.6 note.** When a write comes back refused for a reason the user can overrule, print the
Hub's own words and relabel the action. A dirty checkout becomes **Delete anyway**, not a
generic Retry.

---

# Wave 7 — Read the wide grid

**Phase 16. Goal:** prose fills the phone's width; structure keeps its columns.

**Why now:** wave 0.2 made Wrap the default for agent Panes, and on a phone it mangles
what herdr draws — the browser reflows every line alike, so a box's right border lands at a
different column per line and tables lose their alignment. The same flip changed the desktop
too: while Wrap is on the measured column is skipped and falls back to 672 px, so a desktop
browser that used to show a 120-column grid whole now reflows it at 672 px. The other
project never wraps: it resizes the source (interact) or scrolls (observe), and its own
chat lens scrolls a wide table instead of squeezing it (their commit e3f1789). Wrap stays
tautan's answer, but it must know what it is wrapping — and when to step aside.

Until this wave passes its phone verify, wave 0.2's default is provisional; a user who
sees mangled boxes flips `tautan.wrap.agent` back to `off`.

| # | Lane | Specialist | Files |
|---|---|---|---|
| 7.1 | The wrap guard: wrap only when the grid does not fit | `fast-worker` | `web/pane.tsx` |
| 7.2 | The line classifier: structure or prose | `glm-run` | `shared/layout.ts` (new), `test/layout.test.ts` (new) |
| 7.3 | The mixed grid: wrapped prose, unwrapped blocks | `frontend` | `web/pane.tsx` |
| 7.4 | Drive the mixed grid at 390 px and at desktop width, then the phone | `qa` | — |

**7.1 brief.** Wrap engages only when the grid is wider than the room: compare the grid's
own width (`pane.cols` × the mono `ch` + the scroller's padding) with the room, and when it
fits, render unwrapped at the measured column whatever the wrap setting says. Measure the
column under Wrap from the longest line in `ch` units instead of skipping measurement, so
the 672 px fallback only ever serves a grid that genuinely does not fit. This lane lands
first and alone fixes the desktop: a 120-column grid shows whole again at `lg` and up.

**7.2 brief.** `classify(text)` returns a kind per line. A line is structure when: it carries
**7.2 brief.** `classify(text)` returns a kind per line. A line is structure when: it carries
a box-drawing glyph (the `BOX` class `shared/blocked.ts` already defines), or it holds three
or more runs of two-plus spaces with content between them (column alignment), or it is a
`|`-table longer than half the grid. Everything else is prose. Ship it in `shared/` so the
Hub can reuse it. Test with real fixtures: a Claude permission box, a diff, a markdown
table, prose, and a box with prose inside it.

**7.3 brief.** In Wrap, consecutive structure lines render as one unwrapped block (`w-max`);
prose lines keep `whitespace-pre-wrap`. The page scroller still pans a block sideways — no
per-block scroller, the page's own gesture already works. Affordances stay off in Wrap
(unchanged today) and mouse forwarding is unchanged. No new dependency.

**Superseded 2026-10-07.** One full-width Claude Code rule or box made the whole page pan on
a phone. Now a rule-only line is a CSS hairline, and a `│ … │` box with prose inside is a
bordered block whose text wraps (`rule`, `box-*` kinds in `shared/layout.ts`). Tables and
aligned columns still keep their columns, but each run pans inside its own `overflow-x`
block, so the page never pans.

**Verify:** on the phone, open an agent Pane holding a permission box. The prose fills the
width; the box stays square and pans; no border lands mid-word. On the desktop browser, a
120-column agent Pane renders whole at the measured column, unwrapped.

**Done when:** `bun test` is green, the mock drive at 390 px shows the box intact and the
desktop-width drive shows the grid whole, and the phone verify passes.

---

# Wave 8 — Phone width

**Phase 17. Goal:** an explicit action makes the agent draw at the phone's columns.

**Why now:** probed on a throwaway herdr 0.9.2 (2026-10-06): `herdr terminal attach` resizes
a pane's pty to the attach terminal (`stty` follows mid-flight), `pane.read` keeps serving
while an attach holds the slot, slots are exclusive with `--takeover`, and `Bun.Terminal`
gives the Hub an in-process pty with `resize()`. The Hub can hold that attach as a geometry
lever and keep rendering snapshots. Probes: `/tmp/attach-probe*.py`, `/tmp/lease-probe.py`.

This bends ADR 0001's letter — the Hub spawns a pty — so the ADR lane lands first. The Hub
still never renders from the lease; snapshots stay the only render source.

The desktop TUI itself cannot be "fixed" from tautan: herdr renders the pane's grid, and
while the phone holds the lease that grid is narrow — inherent to one shared pty, and the
whole point of the wave. What tautan owes the desktop is a warning before, the narrowest
possible window (auto-release), and a reliable restore after.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 8.1 | ADR 0004: the lease is a geometry lever, never a render source | `deep-reasoner`, then `scribe` | first |
| 8.2 | `server/lease.ts` and the routes | `glm-run` | after 8.1 |
| 8.3 | The Phone width toggle | `frontend` | with 8.2 |
| 8.4 | Contract tests on a throwaway herdr, then the drive | `glm-run`, then `qa` | after 8.2 |

**8.2 brief.** Hold `herdr terminal attach <terminal_id>` in a `Bun.Terminal` and resize it
explicitly after start — the initial size does not re-assert on a takeover (probed). Release
resizes back to the operator's recorded rect (from `session.snapshot` layouts) before it
closes. A refused attach (slot held) surfaces as a choice — Take over or Cancel — never a
silent kick. The lease never outlives the phone that asked for it: it auto-releases when
the Pane closes, on navigation away, and from a Hub-side safety TTL when no client is
watching the Pane any more. Routes: `POST /api/panes/:key/lease` with `{cols, rows,
takeover?}`, `DELETE` to release; the state SSE carries the lease. herdr Panes only; tmux
answers `501`.

**8.3 brief.** **Phone width** joins ⋯ beside Wrap and Fit, with the warning that it
narrows the pane on the desktop until you leave or release it. While a lease runs, wrap
turns itself off — the grid is the phone's own width, and `pane.cols` shrinks with it.

**8.4 brief.** On a throwaway herdr: the lease resizes the pane, reads keep flowing during
it, refusal and takeover both behave, and release restores the operator's rect. Then drive
the built app at 390 px: toggle Phone width on a blocked agent and watch Claude redraw its
box at the phone's columns.

**Verify:** on the phone, toggle Phone width on a blocked agent Pane. The box redraws at
your columns with no wrap and no drag. Navigate away, and the desktop's width comes back
without a manual release.

---

# Wave 9 — The chat lens

**Phase 18. Goal:** read each Agent's own transcript and render it as chat, with the Screen as
the fallback. Landed 2026-10-07. On herdr 0.9.2 the lens is fallback-only in practice: that
version never surfaces `agent_session` (a 0.9.3 API) and Claude Code re-execs without its
resume flag, so neither trusted resolution source can fire. The resolution, parsing and
fallback are unit- and drive-tested; the happy path activates when the Host runs herdr 0.9.3+.

| # | Lane | Specialist |
|---|---|---|
| 9.1 | Write the ADR: what the lens is, and what it never does | `deep-reasoner`, then `scribe` |
| 9.2 | Claude Code transcripts only, with session resolution | `glm-run` |
| 9.3 | The lens itself: turns, work blocks, tool rows | `frontend` |
| 9.4 | Confirm the fallback on every failure | `qa` |

**9.1 brief.** Decide and record: the lens is a second view of a Pane, not a replacement. When
the session cannot be resolved with confidence, the Pane shows the Screen. Never guess a
transcript.

**9.2 brief.** Three traps are already known, from the other project's own audit:

- Resolve the session from herdr's `agent_session`, or from an open rollout descriptor in the
  Pane's processes. Never from "the newest session with this cwd".
- The cache signature is inode plus size plus mtime, captured **before** the read. Size alone
  misses a same-size replacement.
- Schedule the next poll after the last one completes. An interval returns out of order.

---

# Wave 10 — One look on desktop and phone

**Phases 19–22. Goal:** build the recommended variant of every screen on the design canvas,
so the desktop and the phone share one set of parts.

**Source:** the canvas "tautan screens" (claude.ai/artifact/CKCZc8dyzhzzeKkisc3LjW),
2026-10-06. Each feature row there has a Desktop board and a Mobile board. This wave builds
the variant marked "recommended" on each board, and nothing else.

**Why now:** on a desktop the Pane is a phone column in the middle of the window, and on a
phone the Pane header fits six controls into 390 px. Both look broken before any feature
work can land.

**How it is cut.** Four phases, one after another. Each phase ships alone and keeps the app
usable. Phase 19 adds the desktop frame. The other phases fill it, and the same component
renders at both widths, so the desktop and the phone cannot drift apart.

## The parts and their recommended variant

| Feature | Desktop (≥ 1024 px) | Phone (< 1024 px) |
|---|---|---|
| Frame | Pane list as a sidebar beside the open Pane | One screen at a time, as today |
| Header | A: path, title, Status chip, Chat/Screen, Read aloud, ⋯. C when blocked | A: Status under the title, lens as two icons, Read aloud in ⋯. C when blocked |
| Tabs | A: browser tabs with close, Pane count, `⌘1–9` | A: underline, + at the end, Pane chips only for a split Tab. C (picker) past five Tabs |
| Composer | A: Claude Code box, suggestions above, toolbar inside. D when blocked. E for a shell | A: keys row, replies, input. B when blocked. C when keys are open |
| Chat / Screen | Same component as the phone, wider measure | Chat: bubbles and tool cards. Screen: the grid |
| Pane list | A: sidebar, Needs you pinned with a Yes button | A: grouped by Workspace, Needs you card with Yes / No / Open |
| Settings | Section nav on the left, content on the right | Grouped cards. Hosts first. Bottom bar has two tabs |
| Hosts | Settings › Hosts: one card per Host, a Mux × Workspace table | A: Host rows in Settings. B: Host detail with each Mux and its Workspaces |

## Lanes

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 10.1 | Desktop frame: breakpoint, sidebar, Settings nav | `frontend` | first |
| 10.2 | Header A and C, both widths | `frontend` | after 10.1 |
| 10.3 | Tabs A, both widths, and the phone picker | `frontend` | with 10.2 |
| 10.4 | Composer A, blocked, shell, keys grid | `frontend` | after 10.2 |
| 10.5 | Toolbar data: mode, model, context from the Screen | `glm-run` | with 10.4 |
| 10.6 | Pane list A, both widths | `frontend` | after 10.1 |
| 10.7 | Settings with Hosts, Mux and Workspace detail | `frontend` | after 10.1 |
| 10.8 | Split Panes side by side on desktop | `deep-reasoner`, then `glm-run` and `frontend` | last, optional |
| 10.9 | Drive both widths, then update `docs/UI.md` and `docs/DESIGN.md` | `qa`, then `scribe` | after each phase |

**10.1 brief.** One breakpoint: `lg` (1024 px). Below it nothing changes. At `lg` and up,
`web/app.tsx` renders the Pane list in a 300 px sidebar beside the route. The sidebar is the
same `Home` list in a compact mode, not a second list. The Pane drops its `max-w-2xl`
column and fills the space. `⌘B` hides the sidebar. Settings and Hosts get a left section
nav at `lg`. The bottom tab bar shows only below `lg`. Keep one `EventSource`: the frame
must not open a second one.

**10.2 brief.** One `PaneHeader` in `web/header.tsx` with two layouts. On the phone, the
title button opens Switch and shows `● status · agent · tab ⌄` under the title. The lens
becomes two 36 px icon buttons. Read aloud moves into the ⋯ sheet. At `lg`, show the
`host / workspace / tab` path above the title, the Status chip, the labelled lens and Read
aloud. When the Status is `blocked`, draw a 2 px warning line under the bar. On the phone,
a **Review** button replaces the lens and scrolls to the blocked card. On desktop, the
header shows the command and the Yes and No choices with their keys. "Always" stays in the
card only.

**10.3 brief.** Move + after the last Tab on the phone. Show the Pane chips row only when
the Tab has more than one Pane. That is how the strip works today; keep it. Past five Tabs,
the phone shows a picker button: `● label · Tab n of m · k blocked ⌄`, with one dot per Tab
under it. The picker opens the existing Switch drawer at Tab level. At `lg`, draw browser
tabs: a 2 px accent top edge on the open Tab, a close button on hover and on the open Tab,
and the Pane count. `⌘1–9` opens a Tab and `⌘T` opens New Tab. Tab close keeps the
confirm rule from Phase 14.

**10.4 brief.** One `Composer` component, moved out of `web/pane.tsx`. Phone layout: the
keys toggle, `esc` and `^C`, a divider, then quick replies, then the input with attach and
mic. Mic becomes Send when the input has text. Desktop layout: suggestion chips above a
bordered box with a two-line textarea. The toolbar inside the box holds attach, `/`, `@`,
the mode chip, `esc`, `^C`, context, model, mic and Send. Below the box, show the shortcut
line. `/` and `@` type that character into the input and send nothing. The Agent's own TUI
shows its own menu, so tautan adds no command palette (see "What this plan does not do").
Blocked: the existing blocked card takes the suggestions' place. On desktop its choices go
in one row with `1 2 3` key labels. On the phone they are full-width 44 px rows. A Pane
with no Agent shows a `$` prompt in mono, keys first, and recent commands as chips. The
open keys preset is a fixed six-column grid, not a scroller.

**10.5 brief.** The mode chip, the model and the context percentage come from the Screen.
Do not ask the Agent. Add a recogniser per App profile to `web/profiles.ts`. For Claude Code,
read the `⏵⏵ … (shift+tab to cycle)` line and the status line. When a value is not on the
Screen, hide its toolbar item. Never show a guess. Tapping the mode chip sends `shift+tab`.
Leave behind unit tests on recorded Screens in `test/`.

**10.6 brief.** Home keeps its Needs you and Running sections. They stay pinned. Change the
blocked row into a card: the Agent, the Workspace and Tab, the command line from Explain,
and Yes / No / Open. Yes and No send the same keys as the blocked card, through the same
stale-prompt `409` guard. At `lg`, the sidebar list uses 36 px rows and the Needs you card
has only Yes. No answers the prompt in the sidebar.

**10.7 brief.** The phone bottom bar goes from three tabs to two: Panes and Settings. Hosts
moves to the top of Settings. Each row shows the Host, its Mux kinds and versions, and its
Workspace count. An unreachable Host shows its error and the retry time. A row opens Host
detail at `#/hosts/<id>`, which lists each Mux with its socket, then its Workspaces with
their Tab and Pane counts and Status. Add and Edit Host reuse the existing sheet in
`web/hosts.tsx`. At `lg`, Settings › Hosts shows one card per Host and a Mux × Workspace
table that scrolls sideways when narrow. `#/hosts` still opens Hosts, so saved links keep
working.

**10.8 brief.** Today the app holds one `EventSource` and watches one Pane. Showing a split
Tab side by side means watching more than one Pane. Decide first, and record it: either the
SSE stream carries a set of watched Panes, or the extra Panes render the last snapshot from
the state stream with no live poll. Only then build it. Until this lane lands, desktop
shows the Pane chips row, the same as the phone. Ship Phases 19–22 without it.

**Decision (2026-10-06): defer.** Superseded the same day, below.

**Decision (2026-10-06, supersedes "defer"): build option A with the Mux's geometry.** See
[ADR 0006](./adr/0006-split-panes-mirror-mux-geometry.md). The `screen` event already carries
`key`, so the protocol change is only the request: `pane=` repeats, up to 4. The split mirrors
herdr's own rects (tmux: `pane_left`/`pane_top`) as proportions of the Tab. Cap 4: the live
snapshot has 14 two-Pane Tabs, 3 three-Pane Tabs and 1 four-Pane Tab.

*Split rule.* At `lg`, show the split only when the Tab has 2–4 Panes that all carry `x` and
`y`, the Tab is not zoomed, "Split view" in ⋯ is on (`tautan.split`, default on), this view
holds no Phone width lease, and every cell would be at least 420 × 180 px in the Pane column
(measured by the `frame` ResizeObserver). Otherwise the Pane chips row stays.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 10.8a | Hub: `x`/`y` on Panes, a watched-Pane set on `/api/events`, per-key backoff, lease owned by its stream | `glm-run` | first |
| 10.8b | Extract `PaneGrid` from `PaneScreen`, no visible change | `frontend` | after the in-flight `web/pane.tsx` edits land |
| 10.8c | `SplitView`, click to focus, e2e flow 14 | `frontend` | after 10.8a and 10.8b |
| 10.8d | Drive flow 14 at 1440 and 1280; update ARCHITECTURE.md and UI.md | `qa`, then `scribe` | last |

**10.8a brief.** `shared/types.ts`: `x?`, `y?` (cells, relative to the Tab) on `Pane` and
`StatePane`. `server/herdr.ts` `tree()` copies `rect.x`/`rect.y` and omits both for every
Pane of a `zoomed` layout. `server/tmux.ts`: add `#{pane_left}`, `#{pane_top}`,
`#{window_zoomed_flag}` to `FORMAT`, same zoom rule. `server/mux.ts`: `HubListener.paneKeys`,
one watch per (listener, key) with its own 250 ms → ×1.5 → 2 s backoff; `changed()` re-polls
only matching keys; `watchedPaneKeys()` is the union; each key's first Screen goes out on
subscribe. `server/http.ts` `/api/events`: `searchParams.getAll('pane')`, de-duplicated;
more than 4 is `400 {error:'too-many-panes'}`; unresolved keys drop; none resolving is 404 as
today. The `screen` event is unchanged. **Lease owner (fixes the keep-alive leak):** the
stream announces an id; a lease request carries it; `LeaseHolder` records it and releases the
lease when that stream ends, whoever else watches the Pane; a request without an id keeps
today's rule. Tests: per-key backoff on a fake Mux, a contract test with two Panes on one
stream on a throwaway herdr, 5 keys → 400, `x`/`y` absent when zoomed, and a lease released
when its owner stream closes while a second stream still watches the Pane.

**10.8c brief.** `useEvents(keys)` keyed on `keys.join(',')`, returning screens by key.
`SplitView` places each `PaneGrid` absolutely at `x/W`, `y/H`, `cols/W`, `rows/H`, with 1 px
dividers, a 24 px title row per cell, and a 2 px accent ring on the focused cell. Focus is the
route: a click on an unfocused cell navigates with `replace` and sends nothing to the
program. Unfocused cells draw no Affordances, no mouse forwarding and no Chat lens.
`forceFit` in split. Seen: 3 s dwell for unfocused visible cells, 1 s for the focused one.
Flow 14 at 1440×900: both cells render, a marker printed in Pane b shows only in cell b,
clicking cell b moves the header and Composer without reopening the EventSource, and at
1100 px the chips row returns.

*Later, not v1:* a next-Pane shortcut (the browser owns ⌘[ ] and ⌘⌥←→), ratios dragged in
tautan only, the Chat lens in unfocused cells, more than 4 Panes.

**10.9 brief.** Drive the built app at 390 × 844 and at 1440 × 900 with `chrome-devtools-axi`
on a throwaway herdr, never the live socket. Check each board against the canvas: same
radii, tokens, row heights, and the Status colours. Take a screenshot per screen per
width. Then rewrite the affected sections of `docs/UI.md` and add the canvas link to
`docs/DESIGN.md` under "How to update the mockups".

**Verify:** open the same blocked agent Pane on the phone and in a desktop browser. On both,
the header reads `needs you`, the Tab strip shows the Tab's Status dot, and Yes answers from
the card, from the header on desktop, and from the Pane list. Resize the desktop window
below 1024 px: the sidebar goes away and the phone layout takes over with no reload.

---

## What this plan does not do

| Rejected | Why |
|---|---|
| xterm.js with a pty attach | ADR 0001. Their own flow-control document prices it: a Node sidecar, an xterm patch, a 256 KiB credit scheme, and stalled-client eviction. |
| A Mux relay for remote Hosts | ADR 0002. SSH forwarders already work. |
| A command palette | The Switch drawer with its search field is the palette a phone needs, and it is two taps to any Pane. |
| A density toggle | One scale, tuned for 390 px. A second set serves a browser tab at the phone's cost. |
| A token gate and a devices panel | Tailscale, the Origin check and the trusted-login row answer who may reach the Hub. Wave 0 closes the one gap. |

## End-to-end

`pnpm e2e` builds the app and drives the real stack — a throwaway herdr and the Hub with the
built web — through 13 flows in headless Chromium: funnel refusal, home open,
wrap guard, the blocked card's 409 and Re-read, the alert card, held messages, the file
viewer long-press, the Phone-width lease, the chat lens fallback, the desktop header's 409
guard with ⌘2, the desktop composer (`/` types only, the mode chip follows the Screen),
the Needs you card answering from the Pane list, and Settings with Hosts. It resolves
playwright-core from `PLAYWRIGHT_CORE` or the local npx cache and never touches the live
socket or port 7700.
