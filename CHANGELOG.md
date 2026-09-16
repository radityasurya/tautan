# Changelog

## Unreleased — Halaska Kit

The whole UI moves onto Halaska Kit (MIT, one file, `web/halaska-kit.jsx`): Geist type, the
kit palettes and controls, and its agentic UX patterns. Routing, state, the Hub contract and
the terminal grid are unchanged; the grid keeps its tautan-box mono and its own ANSI
palettes.

- **Theming drops to light/dark/system.** The kit palette is the one source of colour;
  `applyTheme()` re-points tautan's CSS tokens at it, so the custom rows and bars follow the
  kit. The four Catppuccin themes are gone; vaul and the Radix dialog go with the shadcn
  components that wrapped them.
- **Home:** kit IconButton, SearchInput, Chip filters, Skeleton rows, EmptyState.
- **Hosts:** Cards with StatusDot, Button and LinkButton actions, a controlled-TextInput sheet.
- **Settings:** the theme Select, SwitchToggle settings rows.
- **Sheets:** the kit Sheet and AlertDialog everywhere, with controlled inputs; the wrapper
  unmounts a closed panel so nothing focusable lives off-screen.
- **Pane:** the blocked card is `ApprovalCardPattern` — herdr's offered keys as radio rows,
  Approve sends the chosen key, Hold waits — plus IconButton header actions. The composer,
  key bar and reply pills stay tautan's own; kit inputs cannot express them.
- **Diff:** scope as a SegmentedControl. **Switch:** a kit Sheet with Home's search rule.

Also kept from the on-device feedback round: Home pins a **Running** section beside
**Needs you**, folds pinned sections like groups, and searches under the title; Workspace
menus can close the Workspace; Hosts counts itself and names who owns each entry.

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
