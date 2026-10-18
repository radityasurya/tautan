# Changelog

## Unreleased

- **Adding a Host never replaces another.** A label that matches an existing Host, or an
  address that already is one, shows why in the sheet and keeps Save off. Before, saving
  silently dropped the other Host.
- **The event stream keeps every event after herdr drops events.** herdr 0.9.2+ ends a
  subscription that fell behind with `events_lost`; the Hub now subscribes again with the
  same events and re-reads everything. It used to drop one optional event, `layout.updated`
  first, until the next restart.
- **Filled buttons read in dark mode.** Text and marks on the blue, red and green fills are
  the dark palette's ink instead of white: 6.9:1, 6.3:1 and 10.0:1, where white was 2.5:1,
  2.8:1 and 1.7:1. Send, Save, Close, Remove worktree, switch knobs and checkmarks follow;
  the named palettes already worked this way.

## 0.2.0 — 2026-10-18

tautan now shows an Agent's conversation beside its Screen, edits layout, files and branches
from the Pane, and fits a desktop window as well as a phone. The UI moves onto Halaska Kit.
This release covers phases 10–38 of [docs/ROADMAP.md](docs/ROADMAP.md). The work is built and
driven in an emulated phone; it awaits a check on a real device.

### Changes to know before you upgrade

- **The herdr plugin needs herdr 0.9.2.** Layout editing needs herdr 0.9, and order writes
  need herdr 0.8. An older herdr answers `501` for the feature it lacks; the rest works.
- **The look changes.** The six old themes give way to the kit's light, dark and system
  modes, plus six named palettes: Catppuccin Latte, Frappé, Macchiato and Mocha, Gruvbox Dark,
  and Nord. vaul and the Radix dialog go with the components that wrapped them.
- **Agent Panes open in the Chat view** when the Hub finds a transcript. The Screen stays the
  fallback, and you can switch at any time.
- **A shell Pane types directly by default.** An Agent Pane still composes.
- **Desktop Agent Panes lose the esc, ^C, `/` and `@` bar buttons.** Esc and ^C lead the Keys
  strip. The phone bar keeps all four.
- **herdr owns Workspace order.** tautan deletes the stored per-browser order for a herdr
  Mux. tmux Workspaces keep the order on that device.
- **The Hub refuses a Tailscale Funnel request** with `403`, before the `Origin` check.

### Chat view

- **Read the conversation.** Claude, pi, Codex and omp Panes show Markdown, tool rows that
  open with what each tool returned, images, and Artifact cards with a sandboxed HTML preview.
  An ambiguous transcript match shows the Screen.
- **Stay current.** The view loads only new turns, loads the first 100 turns, offers Load
  earlier, and loads full tool output when you open a row.
- **Follow the work.** Each turn starts a new bubble. Each tool call carries a time, and a
  running call pulses. The Working line shows the spinner's token count and mode.
- **Fold runs of calls.** Finished calls read "Ran 3 shell commands, read 2 files, edited 1
  file". Edit, MultiEdit and Write rows show added and removed lines with counts.
- **Highlight code.** A fenced js, ts, json, css, html, md, py or yaml block gains colour on
  demand and stays plain offline.
- **Run a `!` command.** A shell command Claude suggests becomes a card with Copy and Run.
- **Answer from the row.** A blocked turn shows one approval row per pending tool, with the
  Agent's own numbered choices.
- **Watch subagents.** A switcher lists running subagents as a tree, then ended ones, newest
  first. A subagent ends by its handback, and a stopped or failed one says so.
- **See Claude's queue.** A queued message shows as a dimmed Queued bubble. Send now
  interrupts the turn and sends all of them.
- **Hold through a gap.** After `/clear` or `/resume` the view shows the new conversation at
  once and keeps its turns while the transcript lands.

### Screen and typing

- **Type directly.** The Composer shrinks to one bar, and each key goes to the Pane. Arrows,
  Home, End, Page keys, F1–F12 and Enter send every modifier in its xterm form. Echo arrives
  in under 200 ms. The caret follows a wrapped or multi-line Claude input.
- **Tap what the Screen shows.** Recognised text becomes Affordances: tap an option row, send
  mouse clicks and wheel moves to a program that takes them, and open a link, including one the
  terminal wrapped over several rows.
- **Search terminal history.** Find in terminal opens from the Pane ⋯ menu or with `⌘⇧F`. It
  shows a match count, Older and Newer, and each match with context.
- **Read the wide grid.** Wrap reflows prose and keeps box frames and tables scrollable.

### Panes, Tabs and Workspaces

- **Edit the layout.** Split, swap, move and resize Panes. A phone uses the menu; desktop
  drags a divider. Zoom and unzoom a Pane from one Zoomed chip.
- **Reorder through herdr.** Move Workspaces and Tabs by menu or by drag.
- **See a split.** A Tab with two to four Panes shows side by side on desktop, in herdr's
  own proportions, over one stream. A click focuses a cell.
- **Drag and drop on desktop.** Drag a Pane onto a cell to swap, or onto a Tab, a Space or
  `+` to move it. A drop on a Space lands in the Tab open there.
- **Use desktop menus.** The Pane ⋯, Tab, Workspace and Pane-row menus open at the pointer,
  and right-click opens them. A phone keeps sheets.
- **Duplicate.** Duplicate Tab and Duplicate Pane start a fresh Agent of the same kind in the
  same folder. They never copy the conversation.
- **Label shells.** A shell Pane reads `running · make` or `shell`, not `unknown`.
- **Browse for a folder.** New Tab and New Workspace take a folder from a Browse list.
- **Remove a worktree after its branch merges.** Remove worktree… checks the branch first and
  reports Merged into origin/main, or the commits not in it, with the pull request link.
  Uncommitted files turn the action into Remove and discard changes. A merged branch is
  deleted by default.

### Files and branches

- **Browse and preview.** Files opens a folder as a table with its README, and a file as a
  card with Preview and Source. Desktop adds an Explorer column. HTML runs in a sandbox, and
  video, audio and PDF play. Any file downloads.
- **Edit.** CodeMirror loads on the first Edit tap. A save sends an etag, and a conflict shows
  Copy my text and Reload. A back swipe asks before it discards edits.
- **Switch branches.** The branch chip opens a sheet that shows git's refusal word for word.
  With more than one worktree it lists them, and Diff reads each one.

### Composer

- **Reply quickly.** One Suggestions row holds quick replies and smart replies. A z.ai smart
  reply no longer thinks first and takes under three seconds.
- **Complete in the field.** `/` lists every command the Agent knows, ranked in five tiers.
  `@` lists the Pane's files. `/model` and `/effort` open a card. A draft survives a reload.
- **Use the desktop box.** One full-width box holds Suggestions, Keys and Type directly. Drag
  to reorder Keys.
- **Hold a reply.** A reply waits for Claude's empty box and arrives whole. A draft in the
  terminal shows "Waiting: the terminal's box has text". Invisible characters are removed.
- **Type on an iPhone.** Fields are 16 px, the keyboard does not cover the bar, and Return
  inserts a newline.

### Agents and Status

- **Read the Agent's box.** A numbered menu or question form becomes choices. A permission
  box offers Yes, Always and No by number.
- **Detect blocked from the live Screen.** A working Agent whose Screen shows a question reads
  blocked at the next poll, even when herdr is slow. A footer under Claude's box is no longer
  taken for the question.
- **Push once per question,** naming the Agent.
- **Compare Seen by revision.** A herdr restart no longer hides a Pane from Needs you, and
  Seen syncs across devices.
- **Refuse a stale answer.** An answer to a prompt that moved on returns `409`, and the card
  re-reads.

### Hosts and herdr

- **Add a Host from your tailnet.** Add Host lists the machines on the Hub's tailnet. A tap
  fills Address and Label and runs Test connection. A failed test names the fix: SSH refused,
  herdr missing, or an unknown host key.
- **Use the new sheet.** Add Host and Edit Host open as a sheet on a phone and a modal on
  desktop. `user@host` splits into two fields.
- **Run plugin actions.** Plugin actions… in the Pane and Workspace menus lists herdr actions.
  A failed command shows its exit code and last error line.
- **Name Agents.** An Agent's name leads the Pane header and rows. Rename Agent… sets or
  clears it.
- **Check integrations.** Settings › About lists each Agent integration per herdr Host, with
  Current, Outdated or Not installed, and a Copy for the install command.
- **Start from herdr.** The plugin adds Start, Stop, Status and a Phone setup pane with a QR
  code.
- **Watch tmux faster.** tmux Panes stream through control mode.

### Look and feel

- **Halaska Kit.** The UI takes the kit's Geist type, palettes, controls and agentic
  patterns. Routing, state and the Hub contract stay the same. The grid keeps its own ANSI
  palettes. The blocked card is the kit's `ApprovalCardPattern`.
- **A desktop frame.** At 1024 px and wider the Pane list is a sidebar, and `⌘B` hides it.
  Settings and Hosts get a section nav. `⌘1–9` picks a Tab.
- **Needs you.** A card with Yes, No and Open answers a prompt from the list. Home pins
  Needs you and Running.
- **Usage meters.** Settings › About shows each provider's percent left, reset and pace.
- **Thin scrollbars** where scrollbars take space. The sidebar's hides until you use it.

### Fixes worth naming

- A Claude Pane reads its own Claude's conversation, not a background daemon's.
- The `[PONYTAIL]` status line no longer shows as a blocked card.
- The Diff view's added and removed tints are back.
- `/login`, `/model` and `/resume` from Chat open the Screen, where their menus live.
- A blocked browser `localStorage` shows a notice and keeps choices in memory.
- A remote Host's HTML preview resolves symlinks before it serves a file.
- The dev server skips the Babel pass for the 650 KB vendored kit, which silences the
  "deoptimised the styling" note and speeds dev transforms.

## 0.1.1 — 2026-09-12

Release process only; the app is unchanged from 0.1.0.

- npm releases go through trusted publishing: the release workflow is registered on npmjs.com
  as the package's publisher and signs each release with provenance. No token, no secret.
- The workflow skips the npm step when the tagged version is already on the registry, so a
  re-run or a hand-published version never fails the release.

## 0.1.0 — 2026-09-12

First release. Run one Hub on an always-on machine, open it on your phone over Tailscale,
and work with every coding agent you have running.

- **See every Pane.** Home lists Panes across all your machines, grouped by Workspace, with
  the agent's Status: working, blocked, done, idle. Unseen blocked Panes sort first. A tab bar
  switches between Panes, Hosts and Settings, and badges unseen blocked work.
- **Open a Pane.** A rendered screen, not a terminal emulator: a grid of styled spans with
  Wrap and Fit, a Tab strip you can swipe, a key bar, and a composer. When the Pane runs
  Claude Code or Pi, the composer reads as that agent's prompt box.
- **Answer a blocked agent with one tap.** herdr classifies the prompt; tautan turns that into
  buttons, so a permission box offers Yes and No instead of a keystroke to remember.
- **Get told.** An installable PWA with Web Push. One notification per Pane that enters
  blocked, an app badge for unseen work, and no push for `done`.
- **Reply faster.** Quick reply pills per agent. Turn on Smart replies and a small model
  drafts three more from the last screen; off by default, on the Hub and on the phone.
- **Attach a photo or a video.** Pick a file in the composer; the Hub writes it on the Pane's
  Host and puts the path in the field.
- **Dictate and listen.** A mic button fills the composer from speech, and read-aloud speaks
  the last block of output.
- **Reach other machines.** Add a Host in the Hosts tab with an SSH target, probe it, and save.
  The Hub forwards each remote herdr socket over `ssh -L` and reconnects on its own. Offline
  Hosts show the last SSH error and a Retry button.
- **Read tmux too.** Local and remote tmux servers appear beside herdr, read and send only.
- **Start work from the phone.** Create a Tab and start an agent in it, create a Workspace or
  a git worktree, rename a Workspace, Tab or Pane, and close a Pane.
- **Review the diff.** Open Diff from a Pane or a Workspace: working tree, staged, or against
  the base branch, with per-file collapse and hunk headers.
- **Choose a look.** Six themes plus system, haptics on Android, and safe-area insets.
- **Lock it down.** The Hub binds to loopback behind `tailscale serve`, checks `Origin` on
  every write, and can lock itself to one Tailscale login.
- **Install it three ways.** `bunx tautan` with a systemd user unit, the container image
  `ghcr.io/radityasurya/tautan` with a compose file and an Unraid layout, or from source.

### Known gaps

- Several flows are built and driven in an emulated phone, but not yet confirmed on a real
  device: the Explain card, Seen, swiping between Tabs, iOS dictation and voices, an installed
  PWA receiving a push notification, a real photo attachment, and the SSH forwarder reconnect.
  They are marked `[~]` in [docs/ROADMAP.md](docs/ROADMAP.md).
- tmux reports Status `unknown` for every Pane. It has no agent detection of its own, so
  tautan cannot tell working from blocked there.
- No resize to phone. herdr 0.9 shares one width between all clients, so a Pane keeps the
  desktop's column count; use Wrap or scroll sideways.
