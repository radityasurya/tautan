# tautan — notes for agents

Vocabulary is in `CONTEXT.md`. Use its terms (Hub, Host, Mux, Workspace, Tab, Pane, Agent,
Status, Seen, Screen, Explain). "session" is banned: it means Mux in herdr and Workspace in tmux.

Work is tracked in `docs/ROADMAP.md`: one phase at a time, tick a box only when its
verification step passed on a real device. Design lives in `docs/ARCHITECTURE.md`; reasons
behind the two irreversible choices live in `docs/adr/`.

## Gotchas the code cannot tell you

- The live herdr on this machine (`~/.config/herdr/herdr.sock`) is the developer's real
  session. Read from it freely (`session.snapshot`, `pane.read`, `agent.explain`). Send
  text or keys, close, rename, create, or focus only on a throwaway server started for tests.
- herdr closes the socket after one response. Open a connection per request; keep only the
  `events.subscribe` connection open, and send nothing else on it.
- `pane.read` may return `revision: 0`; the pane record's `revision` is the real one.
- Throwaway tmux servers must run `tmux -f /dev/null -S <sock>`; the developer's tmux
  config restores saved sessions on start.
- Start throwaway herdr with isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and
  `HERDR_SOCKET_PATH`; copy `~/.local/state/herdr/agent-detection/remote` into the isolated
  state tree when contract tests need the downloaded agent manifests.
- `HERDR_SOCKET_PATH` overrides local Mux discovery in the Hub, which is useful for tests.
- Remote Host SSH is deliberately non-interactive (`BatchMode=yes`). Forwarders also need
  `ExitOnForwardFailure=yes`, `StreamLocalBindUnlink=yes`, server-alive probes, and a
  `ControlPath` below tautan's private runtime directory; removing any of these changes failure
  or stale-socket behaviour.
- Unix socket paths must be shorter than 100 bytes. Remote forwarders use readable
  `<host>-<mux>.sock` names when they fit and a short SHA-1-derived name otherwise.
- herdr before 0.9 has no `machine list`; this is a supported empty discovery source, not a
  startup error.
- `hub.close()` owns transport shutdown too: it must terminate every SSH forwarder and remove
  its local forwarded sockets.
- `pane.report_agent` with a `state` gives the reporter authority: herdr's screen rules still
  classify (`agent.explain` says blocked) but `agent_status` keeps the reported state. To
  simulate a blocked Agent, report `--state blocked` explicitly after printing the prompt.
- herdr fires `pane.updated` on the title, cwd and Status, never on raw output: a shell
  printing for ten seconds emits nothing (probed on 0.8.0, and 0.9's docs say the same;
  `pane.output_matched` needs a pattern and a catch-all regex matches the existing screen at
  once). A watched Pane is therefore polled by the Hub, fast after a change and backing off
  to 2 s while quiet. There is no surface-stream subscription in either version.
- The Hub never calls any `*.focus` method. Seen is tautan's own flag, never written to a Mux.
- A real Claude Code permission box matches `live_blocked_form`, not `bash_permission_prompt`.
  `live_blocked_form` has priority 980 and reads `after_last_horizontal_rule`;
  `bash_permission_prompt` has 850. Every real box ends in a rule plus
  `esc to cancel · enter to confirm`, so the first rule always wins. Never key behaviour off
  `ruleId.includes('permission')`; `shared/blocked.ts` reads the box instead.
- A throwaway herdr has no client attached, and then it does almost nothing on its own:
  `pane.updated` fires only on a structural change (title, cwd, agent status), never on raw
  output — `printf '\033]0;x\007'` (OSC title) triggers it, `echo` does not; on subscribe
  it replays a backlog of `*_created` first. It leaves
  every Pane `revision` at 0, and it never re-derives `agent_status` from the screen —
  `agent.explain` classifies on demand but does not write the result back to the snapshot.
  So a contract test or a browser drive must set Status with `pane.report_agent` and force a
  Hub re-read with `POST /api/hosts/:id/retry`. `pane.report_agent` takes
  `idle|working|blocked|unknown`; herdr turns idle-after-working on an unfocused Pane into
  `done`. Seen cannot be exercised through revisions there, because they never move.
- Chromium hands a horizontal touch drag to the nearest scroller and fires `pointercancel`,
  so `pointerup` never arrives. A swipe gesture must be built on `touchend`, not pointer
  events; the Tab strip swipe was mouse-only until this was found.
- herdr's Workspace snapshot never carries `cwd` — only `workspace_id`, `number`, `label`,
  `focused`, `pane_count`, `tab_count`, `active_tab_id`, `agent_status`. Only Panes carry
  `cwd`, so `tree()` derives a Workspace's `cwd` from its first Pane, and `newWorkspace`
  falls back to the root pane from the create result.
- `agent.start` requires `kind` (the agent id: `claude`, `pi`, `codex`) alongside `name`;
  `name` is only the display label, and omitting `kind` is a schema error. The adapter
  retries once after 1 s on `agent_not_ready`, then rethrows and leaves the new Tab in
  place — the user sees it and can close it, and Retry from the sheet makes a new Tab.
- `worktree.create` needs only `{cwd, branch, label, focus: false}` — no `base`, `path`, or
  `workspace_id`. The branch may be new; herdr picks the worktree path itself and returns it
  as the root pane's `cwd`. `cwd` here is the source repo, not the worktree destination.
- The Hub's write routes (`/api/muxes/:key/tabs`, `/api/muxes/:key/workspaces`,
  `/api/rename`, `/api/panes/:key/close`) all await a tree refresh before replying, so the
  next `state` SSE event already reflects the write. A herdr error code is the text before
  the first `: ` in the Error message and surfaces as `502 {error: code}`; `Error('unsupported')`
  is `501`.
- Mouse reports are **SGR only** (`ESC [ < b ; col ; row M`, release `m`). The legacy X10
  form `ESC [ M` is not recognised by `xterm-256color` and lands as keystrokes — it opened
  htop's sort menu instead of moving the selection.
- A press and its release must go out in **one** `pane.send_input` call. Split across two
  calls, the program sees a press that never ends and the next tap does nothing.
- `pane.process_info` returns `foreground_processes` in no particular order — it is not
  parent-ordered, so the first entry is not the program on screen. Match
  `foreground_process_group_id` first, then a known command name.
- Write tests run only on throwaway servers from `test/harness.ts`; the live socket at
  `~/.config/herdr/herdr.sock` must never receive a write. For a manual check, start the Hub
  with `TAUTAN_PORT=7715 HERDR_SOCKET_PATH=<tmp>/h.sock` — never a Vite dev server proxying to
  7700.

## Conventions

- Runtime is Bun; the package manager is pnpm. Scripts are in `package.json`.
- Add a dependency only when a few lines cannot do the job. There is no router, state
  library, or UI kit by decision.
- Terminal output is rendered as spans from `shared/ansi.ts`, never through `innerHTML`.
- Mark a deliberate shortcut with a `// ponytail:` comment naming its ceiling and upgrade path.
- Commit messages end with a `Co-Authored-By` trailer for the agent that wrote the change.
