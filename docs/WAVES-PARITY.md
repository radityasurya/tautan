# Parity waves

A delegation plan for the orchestrator, in the same shape as [WAVES.md](./WAVES.md): each wave
is a goal, a set of lanes, and one verification step. Hand a wave to `/lead`, and the
orchestrator routes its lanes. Vocabulary is in [../CONTEXT.md](../CONTEXT.md). The
[standing constraints](./WAVES.md#standing-constraints) and the
[routing table](./WAVES.md#routing) in WAVES.md hold here too.

[ROADMAP.md](./ROADMAP.md) records what landed. When a wave passes its verification, add its
phase there with its Verify step. Agents never tick a ROADMAP box; the user does, on a real
device.

**Source.** A comparison of tautan (HEAD `d289ca5`, 2026-10-07) with
`devswha/herdr-web-ui` v0.3.52 (released 2026-10-06), made from that project's releases
v0.3.48–v0.3.52, README, DESIGN.md and docs/guide.md, plus tautan's own `// ponytail:`
comments and the open risks recorded in recent commits. The deliberate rejections in
[WAVES.md](./WAVES.md#what-this-plan-does-not-do) still hold: herdr-web-ui did not change
those areas between 0.3.50 and 0.3.52.

**Scope.** Every gap the user chose from that comparison:

| # | Gap | herdr-web-ui | tautan today |
|---|---|---|---|
| A | Chat data size | polled, cheaper per poll in 0.3.52 | the whole conversation on every change, about 4 MB on the busiest Pane |
| B | Chat for more agents | Claude, Codex, omp, omo, gjc, pi | Claude and pi |
| C | `/` commands, `@` file mentions, `/model` card | yes | `/` and `@` only type the character |
| D | Folder browser for new Tab, Workspace and worktree | yes, with a filter | a typed path |
| E | Reorder Workspaces; split, move and swap Panes | reorder | neither; "Later" in the ROADMAP |
| F | Files: PDF, video, audio, download, folder browse | yes | images and text |
| G | Usage meters | per provider | quota rows as text in Settings › About |
| H | More palettes (Catppuccin and others) | five palettes | System, Light, Dark |
| I | The medium-impact optimisations | — | listed in Wave 17 |
| J | The low-impact optimisations | — | listed in Wave 18 |

Gap B was the comparison's top-ranked gap. Drop Wave 12 if it is not wanted. i18n, density
modes and device pairing stay out of scope.

## Facts the waves depend on

- herdr 0.9 has `pane split`, `pane swap`, `pane move` (to a Tab, a new Tab or a new
  Workspace) and `pane resize`. It has no command to reorder Workspaces, so a Workspace order
  lives in tautan only and is never written to the Mux.
- tmux has `split-window`, `swap-pane`, `join-pane`/`break-pane` and `resize-pane`.
- The Hub already shells out to `quota-axi --json` (`server/http.ts`, `quotaReport()`, with a
  TTL cache) for the Settings quota rows.
- Themes are `system | light | dark` (`web/app.tsx` `THEMES`). The Halaska Kit is light/dark
  only; `applyTheme()` points tautan's CSS tokens at the kit palette, and the grid's ANSI
  palettes live in `web/theme.css`.
- The Chat route already serves images (`/chat/image/:id`) and previews (`/chat/preview/:id`)
  out of band, and answers `If-None-Match` with 304.

## Schedule

Waves touch different files where the table says so, and run in the same batch. A wave that
shares a file with another waits for it. At most three Claude specialists run at once; GLM
lanes are not capped.

| Batch | Runs in parallel | Why this order |
|---|---|---|
| 1 | 11 design · 12 design · 13 · 16 · 17a | Two decisions before code; three UI waves on separate files; tests only |
| 2 | 11 build · 14 · 15 design | 11 owns the chat route and view; 14 owns the file routes and sheets |
| 3 | 12 build · 15 build · 17b | 12 builds on 11's transport; 15 and 17b own the Mux adapters, split by file |
| 4 | 18 · final qa | Low-impact items touch many files, so they go last |

| Wave | Owns (do not edit from a parallel wave) |
|---|---|
| 11 | `server/chat.ts`, `shared/chat.ts`, `web/chat.tsx`, the `/chat` routes in `server/http.ts` |
| 12 | the same files as 11, after 11 lands |
| 13 | `web/composer.tsx`, `web/keys.ts`, `web/replies.ts`, a new `/api/panes/:key/complete` route |
| 14 | `server/files.ts` (new), the `/api/files*` routes, `web/file.tsx`, `web/sheets.tsx` |
| 15 | `server/herdr.ts`, `server/tmux.ts` (write methods), `server/mux.ts` (write methods), `web/home.tsx` order, the ⋯ menus in `web/pane.tsx` |
| 16 | `web/theme.css`, `web/app.tsx` themes, `web/settings.tsx`, `web/usage.tsx` (new) |
| 17a | `test/` only |
| 17b | `server/mux.ts` (watch loop), `server/tmux.ts` (control mode), `web/app.tsx` (streams), `web/affordances.tsx` |
| 18 | anything left; one lane per item |

---

# Wave 11 — Send only what changed in the Chat view

**Gap A. Goal:** a change in a busy conversation costs the new turns, not the whole history.

**Why now:** the Chat view refetches the whole conversation on every change: 3.2–4.0 MB on
the busiest Claude Pane (1 444 of 1 529 tools carry a result), 0.54–0.88 MB on a pi Pane.
The 4 000-character tool-output cap (`shared/chat.ts:257`) and the 4 MB pasted-image budget
(`shared/chat.ts:239`) exist only to keep that size down. Wave 12 builds on this transport.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 11.1 | Decide the protocol: `?since=` deltas or a push on the event stream | `deep-reasoner` | first (Batch 1) |
| 11.2 | Hub: deltas, out-of-band tool output and pasted images | `glm-run` | after 11.1 |
| 11.3 | Chat view: merge deltas, load large outputs on demand | `frontend` | with 11.2, on the agreed shape |
| 11.4 | Measure payloads on the user's real Panes, read-only | `qa` | after 11.2 and 11.3 |

**11.1 brief.** Compare (a) `GET /chat?since=<cursor>` returning only turns after a cursor,
plus the subagent list when it changed, with (b) a `chat` event on the existing
`/api/events` stream when the transcript moves. Account for: the parsed-turn cache in
`ChatLens`; turns that change after they first appear (a tool result arriving, a merged
assistant turn growing); branch changes in pi; subagent views (`?agent=`); and the ETag the
client already sends. Record the decision as ADR 0007.

**11.2 brief.** Implement the decision. Move tool output past a first slice (for example,
the last 40 lines) to `GET /api/panes/:key/chat/output/:toolId`, and pasted images to
`/chat/image/:id` like Read images, so the turns stay small. Raise or remove the 4 000-char
and 4 MB caps once nothing large rides in the turns. Tests: a delta after one appended turn,
a result arriving on an old tool row, a pi branch switch, a subagent view.

**11.3 brief.** Merge deltas by turn identity; keep scroll pinning and the "New messages"
pill; fetch a tool's full output when its row opens; keep the approval row working.

**Verify:** on the busiest Claude Pane, a new turn costs under 50 KB on the wire, and a long
Bash output opens in full from its row.

---

# Wave 12 — Chat for Codex, then omp, omo and gjc

**Gap B. Goal:** the Chat view works for Codex Panes, with the same parse-and-fallback rules
as Claude and pi (ADR 0005: never guess a transcript).

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 12.1 | Session resolution and transcript shape per agent | `deep-reasoner` | Batch 1 |
| 12.2 | Codex parser and resolution | `glm-run` | Batch 3, after Wave 11 |
| 12.3 | omp, omo, gjc, one lane each, only where 12.1 found a trusted source | `glm-run` | after 12.2 |
| 12.4 | Agent badges and any agent-specific rows in the Chat view | `frontend` | with 12.2 |

**12.1 brief.** For each agent: where its session file lives (`CODEX_HOME`, profile
directories), what herdr reports as `agent_session` for it, how the transcript marks turns,
tool calls, results, images and the end of a turn. Name the trusted source for each, or
record that none exists (then that agent keeps the Screen only). Follow ADR 0005.

**Verify:** a Codex Pane on herdr 0.9 opens in the Chat view with its turns and tool rows;
an agent with no trusted source falls back to the Screen with no error.

---

# Wave 13 — Slash commands, file mentions and a model card

**Gap C, plus two composer items from Wave 17. Goal:** a phone can run an Agent's own
commands and point at a file without typing a path.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 13.1 | Hub: list the Agent's slash commands and the Pane's files for completion | `glm-run` | Batch 1 |
| 13.2 | Composer: `/` and `@` pickers, a `/model` card | `frontend` | with 13.1 |
| 13.3 | Keep drafts across a reload; choose which keys the key bar shows | `frontend` | with 13.2 |

**13.1 brief.** `GET /api/panes/:key/complete?kind=slash|file&q=` — slash commands from the
Agent's own sources (Claude Code: built-ins plus `.claude/commands` and skills in the Pane's
cwd and `~/.claude`; pi: its command list), files from the Pane's cwd with the same
containment as the Phase 13 file route, git-ignored paths last. Cap and rank the results.

**13.2 brief.** Typing `/` at the start of the input opens a list of the Agent's commands;
`@` anywhere opens a file list filtered as you type. Picking one inserts text; nothing is
sent until the user sends. `/model` shows the models the Agent offers as a card, and picking
one sends `/model <name>`. Keyboard: arrows, Enter, Esc. Phone: a sheet above the keyboard.
The WAVES.md rejection of a command palette stands: this is completion inside the input,
not a global palette.

**13.3 brief.** Drafts move from memory to `sessionStorage` per Pane
(`web/composer.tsx:40`). The Keys tray gains an "Edit keys" mode to pick and order the caps,
kept per agent/shell kind in `localStorage`.

**Verify:** on the phone, type `/`, pick a command, and send it; type `@`, pick a file, and
see its path in the input; reload with a half-typed draft and find it still there.

---

# Wave 14 — Folder browser and a fuller file viewer

**Gaps D and F. Goal:** pick a folder instead of typing one, and open any file an Agent made.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 14.1 | Hub: list a folder, and stream files with ranges and downloads | `glm-run` | Batch 2 |
| 14.2 | Folder browser in New Tab, New Workspace and New worktree | `frontend` | with 14.1 |
| 14.3 | Viewer: PDF, video, audio, download, folder browse | `frontend` | after 14.1 |

**14.1 brief.** A new `server/files.ts`: `GET /api/files/list?host=&path=` (directories
first, a filter, hidden files on request) and `GET /api/files/raw?…` with `Range` support,
`content-type` by extension, and `content-disposition: attachment` when asked. Reuse the
Phase 13 realpath containment and decide the roots: the Host's home and the Pane's cwd.
Remote Hosts go over the existing ssh path. Tests: containment escapes (`..`, symlinks),
ranges, large files.

**14.2 brief.** A folder field with a browse button opens a sheet listing folders, with a
filter box, recent folders first, and breadcrumbs. Same on both widths.

**14.3 brief.** PDF in the browser's own viewer inside a sandboxed frame; `<video>` and
`<audio>` with range requests; a Download button; and a folder view one level up from the
file. Clickable paths in the Screen and the Chat view keep opening the viewer.

**Verify:** create a worktree from the phone without typing a path; long-press a PDF path
and read it; play a short video an Agent produced.

---

# Wave 15 — Layout editing: split, move, swap, and a Workspace order

**Gap E. Goal:** rearrange Panes from tautan, and order Workspaces in the list.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 15.1 | Decide the gestures and the herdr/tmux mapping | `deep-reasoner` | Batch 2 |
| 15.2 | Hub write routes: split, swap, move, resize | `glm-run` | Batch 3 |
| 15.3 | UI: ⋯ actions, a drag order for Workspaces | `frontend` | with 15.2 |

**15.1 brief.** Map each action to herdr (`pane split`, `pane swap`, `pane move` to a Tab /
new Tab / new Workspace, `pane resize`) and tmux (`split-window`, `swap-pane`,
`join-pane`/`break-pane`, `resize-pane`). Decide which actions reach the phone (the ⋯ menu)
and which are desktop-only (drag a split divider, drag a Workspace). herdr has no Workspace
reorder: the order is tautan's own, per Host, in `localStorage`, never written to the Mux.
Record as ADR 0008, and move "Split / move / layout editing" off the ROADMAP's "Later" list.

**15.2 brief.** `POST /api/panes/:key/split {direction, ratio?, cwd?}`, `/swap {target}`,
`/move {tab | newTab | newWorkspace, split?}`, `/resize {direction, amount}`, each following
the write-route pattern (await a tree refresh; herdr error code → 502; unsupported → 501).
Contract tests on a throwaway herdr and tmux.

**Verify:** split a Pane from the phone and see the new shell; drag a split divider on
desktop and see herdr follow; drag a Workspace up the list and see the order survive a
reload.

---

# Wave 16 — Usage meters and more palettes

**Gaps G and H. Goal:** see each provider's remaining quota at a glance, and pick a palette
beyond light and dark.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 16.1 | Usage meters from `quota-axi` | `frontend` | Batch 1 |
| 16.2 | Palettes: Catppuccin Latte, Frappé, Macchiato, Mocha; plus one or two more | `frontend` | with 16.1 |

**16.1 brief.** A `web/usage.tsx` meter per provider and window (bar, percent left, reset
time, pace), from the existing quota report. Show it in Settings, and as a compact strip in
the desktop sidebar footer when any provider is under 30 %. No new Hub call: reuse
`quotaReport()` and its TTL cache.

**16.2 brief.** Extend `THEMES` with named palettes. Each palette sets tautan's tokens and the
grid's 16 ANSI colours from the palette's published values, picks the kit's light or dark
base, and shows a swatch in Settings. Contrast: text at least 4.5:1 on its surface; Status
colours (blocked, working, done) stay distinguishable. Palettes do not touch layout.

**Verify:** pick Catppuccin Mocha and see the sidebar, the composer and a Claude Screen in
its colours; see a quota meter turn amber below 30 %.

---

# Wave 17 — Medium-impact optimisations

**Gap I.** Two halves so the tests can start while other waves run.

| # | Lane | Specialist | Parallel |
|---|---|---|---|
| 17a.1 | Fix the htop click contract test (it fails every run) | `glm-run` | Batch 1 |
| 17a.2 | Contract test for herdr 0.8's layout fallback (no `layout.updated`) | `glm-run` | Batch 1 |
| 17b.1 | Polling cost: tmux control mode; slow down a long-blank Pane | `glm-run` | Batch 3 |
| 17b.2 | One stream on the first visit to a split Tab | `glm-run` | Batch 3 |
| 17b.3 | Batched mouse reports; `wcwidth` tap ranges | `glm-run` | Batch 3 |
| 17b.4 | Remove the Safari SSE debug counters; the tmux "awaiting" timeout | `fast-worker` | Batch 3 |

**17a.1 brief.** `mux.contract.test.ts` "forwarded htop click moves its highlighted process
row" failed in every run on 2026-10-07, also on clean HEAD. Find out whether it is the test
(timing, htop start time on a 42k-task machine) or a real regression, and fix it at the root.

**17b.1 brief.** tmux: `server/tmux.ts:157` caps at about 30 watched Panes at one capture a
second; move to `tmux -C` control mode for output events. herdr: a Pane that stays blank
costs 4 reads a second (`server/mux.ts:450`); back off after a few seconds of blank, but
re-read at once on any `pane.updated`. Measure reads per second before and after.

**17b.2 brief.** `web/app.tsx:548` records that the first visit to a split Tab opens the
stream twice. Open with the Tab's Pane keys from the first state the client has.

**17b.3 brief.** Mouse moves send 8 events per move (`web/affordances.tsx:305`): batch them
into one POST. Tap ranges use UTF-16 indexes (`shared/affordances.ts:36`): use display width.

**Also reproduce first** (reported by an agent, not by the user): a draft lost when focus
moves between split cells, and the Screen's scroll position reset when switching from Chat
back to Screen. `qa` reproduces both before any fix lane.

---

# Wave 18 — Low-impact optimisations

**Gap J.** One small lane each, in any order, after the other waves. Each starts from the
`// ponytail:` comment named here and ends by updating or removing that comment.

| # | Item | Where |
|---|---|---|
| 18.1 | Markdown: reference links, task lists, HTML-safe images in tables | `web/markdown.tsx:3` |
| 18.2 | z.ai tool blocks without the exact markers | `shared/chat.ts:152` |
| 18.3 | HTML preview for an Edit of an `.html` file; previews over 2 MB | `shared/chat.ts:227`, `:336` |
| 18.4 | Several pending tools at once, each with its own approval row | `shared/chat.ts:78` |
| 18.5 | Subagent files read past the first 256 KB for their start time | `server/chat.ts:65` |
| 18.6 | `pi --session <uuid>` resolution by a directory scan | `server/chat.ts:233` |
| 18.7 | A Workspace cwd from herdr instead of its first Pane | `server/herdr.ts:93` |
| 18.8 | Tell the user when `localStorage` is blocked | `web/spaces.ts:31` |
| 18.9 | A grid font floor that follows device pixel ratio | `web/pane.tsx:558` |
| 18.10 | Wrap slack and full-screen detection from a real signal | `shared/layout.ts:110`, `:140` |
| 18.11 | A generated precache list in the service worker | `web/public/sw.js:4` |
| 18.12 | Load the mock fixtures only with `?mock` | `web/main.tsx:9` |

**Verify:** each lane's own check, then one `qa` pass at 390 × 844 and 1440 × 900 over the
screens it touched.

---

## Final qa

After Batch 4, `qa` drives the built app on a throwaway herdr at 390 × 844 and 1440 × 900
over every screen these waves touched, compares payload sizes with Wave 11's baseline, and
lists the Verify steps for the user's real devices. `scribe` updates `docs/UI.md`,
`docs/ARCHITECTURE.md` and the ROADMAP phases.
