# 11. Claude accounts: found folders, resolved from the Pane's own Claude process

Date: 2026-10-12

## Status

Proposed (2026-10-12, lane 25.1 of WAVES-PARITY-2). The account roots and the Add account
folder extend the user's 2026-10-11 decision (`~/.claude-*` only) and need the user's yes
before Batch 6. The rest follows from the probe.

## Context

Claude Code keeps an account in the folder `CLAUDE_CONFIG_DIR` names. tautan reads `~/.claude`
only (`server/chat.ts`, `server/complete.ts`). Lane 25.1 probed a throwaway herdr 0.9.3 with an
isolated `HOME`, a fake `claude` and the real Claude Code 2.1.296, a throwaway tmux 3.4, and
the live machine read-only. Probes: `bun …/scratchpad/25.1/probe-env.ts`, `probe-claude.ts`,
`probe-resolve.ts`, `sh probe-tmux.sh`; results in `results-*.json`.

- This machine already has three more accounts, none at `~/.claude-*`. The user's
  `claude-profile` helper (dotfiles `297c5ff`, 2026-10-11) keeps each at
  `~/.config/claude-profiles/<name>/` with its own `.claude.json`, `.credentials.json` and
  `sessions/`, and links `settings.json`, `hooks`, `skills`, `plugins` and `projects/` back to
  `~/.claude`. Every conversation id is therefore in every account's `projects/`.
- Claude 2.1.296 writes `<folder>/sessions/<pid>.json` (`sessionId`, `cwd`, `procStart`, …)
  once its prompt is up, not at the login screen, and deletes it on exit: 26 live `claude`
  processes, 26 files, none stale. `procStart` is field 22 of `/proc/<pid>/stat`.
- herdr's `agent_session` can be wrong. On the live server 2 of 23 Claude Panes report an id
  that is not the process's current conversation: one points into another project, one was
  last written 2026-09-23 by a process still running. The pid file named the live one both
  times.
- A new folder gets `.claude.json` at Claude's welcome screen, before any login; `projects/`
  comes with the first conversation. With no `CLAUDE_CONFIG_DIR`, Claude reads
  `$HOME/.claude.json`, outside the folder. With it set, Claude reads `<folder>/.claude.json`,
  and on macOS the Keychain item becomes `Claude Code-credentials-<8 hex of sha256(folder)>`.
  A relative value resolves against the working directory.
- The config file of a signed-in account holds `oauthAccount`. `.credentials.json` holds tokens
  and also exists for MCP sign-ins alone (`mcpOAuth`).
- herdr's `env` on `tab.create`, `pane.split` and `workspace.create` reaches the shell and the
  process `agent.start` launches. It is per Pane: a later Tab, or a split without `env`, has
  none. `worktree.create` takes no `env`. tmux `new-window -e` and `split-window -e` are per
  Pane; `new-session -e` sets the Workspace's environment, which later windows inherit.
- Without herdr's hook, a Claude reports `agent: "claude"`, Status from the screen (`idle` at
  the login screen and the prompt, `done` after a turn) and no `agent_session`.
- `herdr integration install claude` runs without the server and writes
  `hooks/herdr-agent-state.sh` and a `SessionStart` entry in `settings.json` of the folder
  `CLAUDE_CONFIG_DIR` names. `integration.list` answers for the herdr server's own folder only.
- Medians of 20 on this machine: pid file 0.09 ms, `/proc` environ 0.07 ms, an id lookup over
  221 project folders 2.1 ms.

## Decision

**An account** is `~/.claude`, named **default**, or a directory
`~/.config/claude-profiles/<name>/` or `~/.claude-<name>/` that holds `.claude.json` or
`projects/`, named `<name>`. A name matches `[A-Za-z0-9][A-Za-z0-9_-]*` and is never
`default`. The profiles root is read first, and a later folder with a taken name is skipped. A
plain file in the profiles root (an old setup-token profile) is not an account.

**Signed in** means the account's config file contains `oauthAccount`: `$HOME/.claude.json`
for **default**, `<folder>/.claude.json` for the others. This works on macOS, where the token
is in the Keychain. The Hub never reads `.credentials.json` and never runs `claude`, which
writes into the folder.

**Colours.** **default** first, then the others by name; account *n* takes entry *n* mod 6,
light / dark: violet `#7c3aed` / `#a78bfa`, pink `#db2777` / `#f472b6`, cyan `#0891b2` /
`#22d3ee`, lime `#4d7c0f` / `#a3e635`, orange `#ea580c` / `#fb923c`, indigo `#4f46e5` /
`#818cf8`. Each passes 3:1 on the kit's `bg` and `bgElevated`. No entry is a Status hue
(`web/home.tsx:29`: blue, amber, green, grey).

**A Pane's account**, first answer wins, cached per Host and pid. The pid is the Pane's
`claude` process from `pane.process_info`, matched on `foreground_process_group_id`.

1. `sessions/<pid>.json` exists in exactly one account's folder.
2. On Linux, `CLAUDE_CONFIG_DIR` in `/proc/<pid>/environ` names an account's folder, compared
   by realpath; unset means **default**. A value outside the found folders is unknown.
3. The conversation id is in exactly one account's `projects/*/<id>.jsonl`. Folders whose
   `projects/` resolve to one real directory count as one.

An unknown account shows no dot, and completion reads **default** as it does today. The Chat
view opens when the id names exactly one real transcript file across all accounts, and is
unavailable when it names two, as herdr-web-ui 0.4.6 does.

On a remote Host, steps 1 and 2 run as one SSH command per new pid, over ADR 0002's path.
Step 2 is skipped where `/proc` is missing (macOS). Only the `CLAUDE_CONFIG_DIR` line leaves
the Host: the rest of the environment holds secrets.

**Conversation id (amends ADR 0005).** For a Claude Pane, the pid file's `sessionId` is a
trusted source, because it ties the id to the running process. It wins over herdr's
`agent_session`, which can go stale. herdr's report and argv remain the fallbacks.

**`env` on create.** An account other than **default** is sent as
`env: {CLAUDE_CONFIG_DIR: <absolute folder>}` on `tab.create`, `pane.split` and
`workspace.create`, and as `-e CLAUDE_CONFIG_DIR=<absolute folder>` on tmux `split-window`
(tautan's tmux adapter creates no Tabs or Workspaces). **default** sends no `env`: an explicit
`~/.claude` moves the config file into the folder and renames the Keychain item, so the
account would look signed out. New Workspace with a branch (`worktree.create`) takes no
account. Split and New Workspace start no Agent; the value lands in the shell, and a `claude`
typed there uses it.

**Add account** opens a Tab with `CLAUDE_CONFIG_DIR=$HOME/.config/claude-profiles/<name>` and
starts Claude. Claude writes `.claude.json` at once, so the account is listed, signed out,
before `/login`. The user's `claude-profile` lists and runs it like its own.

**herdr's hook per account** is `installed` when the account's `settings.json`, links
followed, has a hook command containing `herdr-agent-state.sh`, and `missing` otherwise. The
command shown with Copy is `herdr integration install claude` for **default** and
`CLAUDE_CONFIG_DIR=<absolute folder> herdr integration install claude` for the others. The
About screen keeps herdr's `current | outdated | not_installed` for the folder
`integration.list` covers.

**Out of scope**, per the user: sharing skills, plugins, `CLAUDE.md` and MCP servers between
accounts, and switching a Pane's account at a limit. tmux Panes have no process info in
tautan, so they read **default** and show no dot.

## Consequences

- With the user's linked profiles, step 3 never decides an account; steps 1 and 2 do. The Chat
  view still works there, because the transcript is one real file.
- The Chat view no longer needs herdr's hook for a Claude that writes pid files. The hook
  state stays visible for herdr's own use of the session.
- The pid file is undocumented Claude Code state. If its format changes, step 1 stops
  answering and steps 2 and 3 remain. A test fixture from 2.1.296 pins the fields read.
- direnv or a shell file that exports `CLAUDE_CONFIG_DIR` overrides the account tautan sent.
  The dot follows the process, so it shows the account Claude actually uses.
- herdr's `env` cannot unset a variable. If the herdr server itself runs with
  `CLAUDE_CONFIG_DIR`, sending no `env` does not mean **default**.
- A pid file left by a crash, whose pid a Claude on another account reuses before its prompt
  is up, resolves wrongly. Upgrade path: compare `procStart` on Linux.
- An account made by Add account has no links until the user runs `claude-profile add <name>`,
  and that helper links `projects/` only while the folder has none.

## Rejected alternatives

- `~/.claude-*` only: it finds none of the three accounts this machine has.
- The id lookup first: herdr's id can be stale, and with linked `projects/` every id is in
  every account.
- `/proc` environ first: it answers only on Linux, and it cannot name the conversation.
- `.credentials.json` as the marker or the sign-in test: it holds tokens, macOS keeps the login
  in the Keychain, and an MCP sign-in alone creates it.
- `claude auth status` per account: it creates `.claude.json` in the folder (probed).
- `herdr integration status` per account: a process per account per refresh, and `herdr` may
  not be on `PATH` in a non-interactive SSH shell.
- The kit's `AVATAR_COLORS`: hashed by name, so two accounts can share a colour; it has no dark
  tones, and four of its hues are Status colours.
