# Changelog

## Unreleased

Home and Hosts, after on-device feedback:

- **Home pins Running beside Needs you.** Unseen `blocked`/`done` Panes lift out as before,
  and `working` Panes now lift into a **Running** section, most recently changed first. A
  Workspace whose Panes all sit in a pinned section keeps its header, and its summary counts
  every Pane it holds.
- **Home searches.** A search field under the title filters every section by agent, title or
  Workspace label — the same rule the Switch drawer uses. The pinned section headers fold
  like group headers, with their count, and a search forces them open.
- **Collapse all / Expand all** in the Home top bar, next to the counts.
- **Workspace actions are visible.** The group header grows a ⋯ button beside the existing
  long-press, and the menu gains **Close Workspace** (`POST /api/workspaces/:key/close`,
  herdr only; tmux answers 501).
- **Pane rows swipe.** On a herdr Mux, drag a row left to reveal Rename and Close, Apple
  style; a tap on an open row closes it. Long-press opens the same actions as a menu, which
  is also the desktop path. tmux rows offer nothing.
- **Hosts lists itself.** The top bar carries `<hosts> · <panes>` counts and a **+** for Add
  Host (the dashed card is gone). A Host with one Mux no longer prints its Pane count
  twice, and every card's bottom row says who owns the entry — `this machine · not editable`,
  `from herdr machine list`, or Edit and Remove for a `hosts.json` entry.
- **Theme picker is a dropdown.** A native `<select>` (iOS opens its own picker wheel) with
  the current theme's swatch, in Settings and in the Pane's ⋯ sheet.
- **Switch drawer mirrors Home.** Needs you, then Running, then Workspace groups; every row
  says how long ago its Status last changed.

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
