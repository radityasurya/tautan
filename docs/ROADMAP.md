# Roadmap

**Status (2026-09-12):** every phase is built; 0.1.1 is released. `[~]` marks work that is
built and verified in an emulated phone but not yet on a real device.

Each phase is a tracer bullet: it ships something you can use from the phone, end to end.
Tick a box when the verification step passes on a real device. Details of the design live
in [ARCHITECTURE.md](./ARCHITECTURE.md); vocabulary in [../CONTEXT.md](../CONTEXT.md).

## Phase 0 — UI skeletons (every screen, mock data, no Hub)

Goal: walk the whole app on the phone and judge the look and the interaction model before
anything is wired. Later phases replace mock data with real calls; the screens stay.

- [x] `web/mock.ts`: one fixture set covering every state: two Hosts, herdr and tmux Muxes,
      Panes in all five Statuses, seen and unseen, a blocked Pane with a permission prompt
      and hint keys, an offline Host, an empty Workspace
- [x] `?mock` in the URL (or `VITE_MOCK=1`) swaps the API layer for fixtures; SSE simulated
      with a timer so screens "tick"
- [x] Home: grouped list, status dots, unseen emphasis, host chips, empty state, offline banner
- [x] Pane: top bar (back, title, status line → Switch, actions), Tab strip with + and Fit,
      grid with Wrap, blocked card with buttons, key bar presets, composer with mic, attach and
      send, read-aloud
- [x] Settings: theme chips (all six + system), push toggle, haptics toggle, "add to Home
      Screen" hint, trusted login and served-by rows. Hosts live in their own tab as cards
- [x] Sheets: new Tab, new Workspace / worktree, rename, close confirm
- [x] PWA shell: manifest, icons, safe-area insets; installed to an iPhone home screen and
      running standalone (2026-09-11)
- [x] Floating bottom tab bar on Home, phone style: Panes · Hosts · Settings, with a badge
      for unseen `blocked`
- [x] Agent-aware Pane chrome: when the Pane runs Claude Code or Pi, the composer reads as
      that agent's prompt box, and a chip row at the top switches between the Agents of the
      same Workspace; shell and monitor Panes (htop, logs) render as a plain grid

Verify: open `https://<hub>:5173/?mock` on iPhone and Android; walk every screen in all
six themes; nothing needs a running herdr.

Built after phase 1 lands (phase 1 was started first); reuses its Home, Pane and theme code.

## Phase 1 — see and reply to a local herdr Pane

- [x] Glossary (`CONTEXT.md`), ADRs 0001 and 0002
- [x] `shared/types.ts` — Mux interface and API payloads
- [x] `shared/ansi.ts` — SGR parser to styled spans
- [x] `server/herdr.ts` — one-request-per-connection client, event subscription, snapshot
- [x] `server/mux.ts` — Hub: Mux registry, state projection, Seen, SSE fan-out
- [x] `server/http.ts` — `/api/state`, `/api/events`, screen, input, static, Origin check
- [x] `server/main.ts` — XDG paths, local Mux discovery, start
- [x] `web/` — Home list, Pane screen (grid, key bar, composer), themes

Verify:
1. `pnpm dev`, then `tailscale serve --bg 5173` on the Hub.
2. On the phone: Home lists panes; open a Claude Code pane; send a reply; the screen updates in under 300 ms.
3. `curl -H 'Origin: http://evil' -X POST http://127.0.0.1:7700/api/panes/x/input` returns 403.

## Phase 2 — triage

`[~]` = built on mock data, awaiting verification on a real phone.

- [~] Explain card: driven end to end in an emulated iPhone against a real Claude Code
      permission box in a throwaway herdr — herdr matched `live_blocked_form`, the card
      offered Yes/enter and No/esc, and a tap sent `enter` to the Pane. Real phone pending
- [~] Seen: driven end to end in an emulated iPhone — a fresh device starts with an empty
      **Needs you**, an unseen `done` Pane enters it, opening the Pane POSTs
      `/api/panes/:key/seen`, and the row leaves. A throwaway herdr freezes every `revision`
      at 0, so the unseen comparison was fed a seeded value; verify it on a real device
- [x] Wrap and Fit on the grid (replaced the Recent mode; see DESIGN.md "Terminal width on a phone")
- [~] Swipe between Tabs on the strip: exercised with emulated touch, which found that
      Chromium cancels the pointer stream mid-drag; the gesture now reads `touchend` and the
      grid never receives it. Real finger pending
- [~] Read-aloud and mic: exercised in an emulated iPhone against stubbed engines —
      read-aloud speaks the last block, the mic is absent with no engine, and a transcript
      lands in the composer without sending. Real iOS dictation and voices pending
- [x] `test/mux.contract.test.ts` and `test/blocked.contract.test.ts` for herdr on a
      throwaway socket (`test/ansi.test.ts`, `test/herdr.test.ts`, `test/mux.test.ts` exist)

Verify: trigger a permission prompt in a real Pane; the card shows buttons; a tap answers.
`bun test` is green. Confirm `herdr server` honours `HERDR_SOCKET_PATH` first.

## Phase 3 — push

`[~]` = built and driven in an emulated phone, awaiting verification on a real device.

- [x] VAPID keys generated on first run into `state.json` — `server/push.ts` encrypts
      (RFC 8291) and signs (RFC 8292) with WebCrypto, `server/mux.ts` keeps the pair and
      the subscriptions; `test/push.test.ts` covers aes128gcm, TTL, urgency, the
      `Authorization` header and pruning a subscription the push service answers with 410
- [x] `web/public/sw.js`, `manifest.webmanifest`, install hint on iOS — the worker shows
      the notification, routes the tap and caches the shell from the `self.__PRECACHE`
      list that the `tautan-sw-precache` plugin in `vite.config.ts` stamps into it;
      `web/push.ts` subscribes and `web/settings.tsx` owns the toggle and the install hint
- [x] Push only on Status → `blocked`; app badge for unseen `blocked` + `done` —
      `server/mux.ts` sends on the transition only; `web/app.tsx` writes the badge from
      SSE state with `setBadge()` from `web/push.ts`
- [x] Installed PWA receives a notification — confirmed on the maintainer's iPhone on
      2026-09-11 after the VAPID subject fix (Apple rejects a `mailto:` subject without a domain)

Verify: installed PWA on iPhone and Android receives a notification; tapping opens the Pane.

## Phase 4 — attachments

`[~]` = built and driven in emulated mobile Chromium, awaiting verification on a real phone.

- [~] Attach button (image/video); raw-body POST with `X-Name`; path appended to composer —
      driven in an emulated iPhone 13 against `?mock`: a pick showed the progress line and
      a chip, the absolute path landed in the field, removing the chip took the path back
      out and aborted an upload in flight, Send cleared both, and an empty file showed
      `empty file` with Retry. `test/attach.test.ts` covers the Hub route. A real photo
      from a real phone, and the HEIC → JPEG hand-off (see UI.md), are pending
- [ ] Remote Hosts: stream into `ssh target 'cat > ~/.cache/tautan/…'` — needs the SSH
      forwarders of phase 5

Verify: a photo from the phone lands in `~/.cache/tautan/` on the Host and the agent reads it.

## Phase 4b — grid width and quick replies

`[~]` = built and driven in emulated Chromium against `?mock`, awaiting a real phone.

- [x] Grid: desktop/tablet column grows to the grid's natural width (no scaling below the
      window width); Fit off by default; Wrap on by default for agent Panes since the
      blocked card lifts the prompt box out (4b rejected Wrap because a wrapped box read
      worse than a scrolled one — the card removed that box); shell Panes stay scrolled;
      both remembered
      — at 1600 px the 120-column mock Pane renders at 12 px, `<pre>` 867 px wide and
      centred, `scrollingElement.scrollWidth` 1600 = `innerWidth`, no transform
- [x] Research "Resize to phone": can a herdr 0.9 client view size a Pane independently of
      the desktop layout? If yes, design it; if no, keep it a v2 explicit action — Verdict:
      not possible in herdr 0.9 — `PaneReadParams` has no width, `pane.resize` changes the
      shared split; see DECISIONS.md 2026-09-12 and DESIGN.md "Terminal width on a phone"
- [x] Dock order: suggestion pills · composer · key bar (keyboard accessory row at the bottom)
      — read back from the DOM in an emulated iPhone 13 as Quick replies, composer, Keys
- [~] Quick replies: key pills send immediately; text pills fill the composer for review.
      Static set per agent (Claude Code, Pi) plus three generated from the last screen block
      by a small model (GLM via z.ai first, Anthropic behind the same adapter), one call per
      Status change, cached by revision, off until "Smart replies" is enabled in Settings
      — `web/replies.ts` decides the pills and `test/replies.test.ts` covers the rules; the
      blocked Claude Code Pane offers Yes ↵, No esc, ↑, ↓, three ✦ drafts and five texts
- [x] Mockup updated in docs/design (pane-agent) before the build — the export already
      shows the pill row above the composer and the key bar last

Verify: on the desktop browser a 120-column pane renders at 12 px with no sideways scroll;
on the phone a blocked Claude Code pane offers Yes/No plus three sensible replies.
Verified 2026-09-12: a throwaway Hub on 7716 with `TAUTAN_SUGGEST=zai` answered
`POST /api/panes/:key/suggest` with HTTP 200 and three pills from glm-5.2.

## Phase 5 — remote Hosts

`[~]` = built, awaiting the verification step on a real remote Host.

- [~] `server/hosts.ts`: `hosts.json` + `herdr machine list --json` merge — `GET /api/state`
      now carries offline Hosts too (`online: false`, `error` = the last ssh stderr line),
      ordered local → machines → config, and `source` says which list a Host came from, which
      is what decides Edit and Remove on the Hosts screen — `test/hosts.test.ts` covers the
      merge, the socket-path guard, `runtimeDir()` and the probe, retry, settings and login
      routes
- [~] `ssh -L` unix-socket forwarders with reconnect; ControlMaster for tmux commands —
      `POST /api/hosts/:id/retry` re-dials any Host, not only a local one, and answers with
      the updated `StateHost`; the SSE `state` event repaints the card. `test/hosts.test.ts`
      covers the forwarder argv, the reconnect backoff and the remote attach command; the ssh
      forwarder is verified by that argv test only, because `ssh localhost` on this box fails
      at publickey auth — the live reconnect check is manual, in
      [UI.md](./UI.md#manual-check-forward-a-throwaway-herdr-over-ssh)
- [~] Settings screen: hosts, theme, push, trusted user — `web/hosts.tsx` owns the Host cards
      and the Add Host sheet (Label, SSH target, herdr Mux, **Probe**, Save through
      `PUT /api/settings {hosts}`), `web/settings.tsx` owns the Access rows (Login, Trusted
      login with Lock and Unlock through `PUT /api/settings {trustedUser}`), and `web/mock.ts`
      answers `/api/hosts/probe`, `/api/hosts/:id/retry` and `GET`/`PUT /api/settings` from
      fixtures. Driven in an emulated iPhone 13 against `?mock`: an empty target showed
      `Enter a target like user@host`, a refused target showed the ssh error, a reachable one
      listed its Muxes, Save wrote the entry with the id taken from the target host
      (`dev@ok-box…` → `ok-box`), Edit came back prefilled and kept the id, Remove took the
      entry out, Retry disabled itself while the call was out, and Unlock then
      **Lock to this login** returned `trustedUser` to the login the Hub saw. Then against a
      real throwaway Hub on 7716 with a throwaway herdr and one unreachable `hosts.json`
      entry: the local card listed its real `herdr default · 3 panes`, the config card showed
      the Hub's own ssh line (`Host key verification failed.`), Retry answered 200 with the
      `StateHost`, Probe printed the same ssh line, and Settings with no Tailscale header read
      `no identity header · not behind tailscale serve` with **Lock to this login** disabled.
      No horizontal scroll at 390 px on any screen, mock or real

Verify: kill a forwarder; it reconnects. Remote Panes show a Host chip.

## Phase 6 — tmux

- [x] `server/tmux.ts` local (13 tests on a throwaway tmux) and remote over ssh (wired, `[~]` until a real remote tmux Host is added); polling; write ops hidden in the UI
- [x] tmux contract tests (`tmux -f /dev/null -S <sock>`): tree, send, keys, onChange, agent detection

Verify: tmux Panes show Status `unknown`; read and send work.

## Phase 7 — write operations (herdr)

- [x] New Tab + start Agent; new Workspace / worktree; rename; close Pane

Verify: start `claude` in a new Tab from the phone.
Evidence: `bun test` 48 pass, 0 fail (contract tests on a throwaway herdr, Agent start with
the real `claude` binary; `test/write.test.ts` covers 201/204/400/404/501/502), plus phone
screenshots of all four flows against a throwaway Hub on 7715.

## Phase 8 — diff review

- [x] Hub runs `git diff --no-color -U3` (working tree, `--staged`, and base…HEAD with the
      base resolved like herdr-hunk-diff: upstream → `origin/HEAD` → main/master) in the
      Workspace cwd, local or over SSH; `GET /api/workspaces/:key/diff?scope=`
- [x] the Hub parses the unified diff with a hand-written `shared/diff.ts`, and the PWA
      renders it itself in `web/diff.tsx`: unified view, per-file collapse, hunk headers,
      Wrap, and a scope control. No `gitdiff-parser` and no `react-diff-view`; see
      DECISIONS.md. Opened from the Pane's ⋯ menu and the Workspace long-press menu
- [x] hunk itself is a TUI with no web or JSON mode, so it is not embedded; a hunk pane still
      opens like any other Pane

Verify: after an agent edits files, open Diff from the Pane; hunks render with syntax-free
coloring; staged and unstaged scopes switch.
Evidence: `shared/diff.ts` (parser), `GET /api/workspaces/:key/diff?scope=working|staged|base`
in `server/http.ts`, `web/diff.tsx` at `#/diff/<workspaceKey>`, fixtures and the fake route in
`web/mock.ts` (`?mock&open=diff`). `bun test` 80 pass, 0 fail, `test/diff.test.ts` 7 of them.
Phone and desktop screenshots against a throwaway Hub on 7718 with a throwaway herdr.

## Phase 9 — ship

- [x] `Dockerfile` (`oven/bun`), README install paths (`bunx tautan`, systemd, Docker on Unraid)
- [x] `npm publish` — 0.1.0 published by hand; `release.yml` is the trusted publisher for later tags

Verify: `docker compose up -d` on a second machine; the phone reaches the containerised Hub
over `tailscale serve` and lists the host's real Panes.
Evidence: `Dockerfile` (multi-stage `oven/bun:1-alpine`, non-root `tautan` uid 1000, XDG paths
under `/data`, healthcheck on `/api/state`), `compose.yaml` (`network_mode: host`,
`TAUTAN_BIND=127.0.0.1`, the herdr socket and `~/.ssh` read-only, `tautan-data:/data`),
`.github/workflows/release.yml` (on `v*`: image to `ghcr.io` as `{{version}}` and `latest`,
npm publish with `--provenance` through trusted publishing (OIDC, no secret), GitHub release with
generated notes), README "Install" with the three paths and the Unraid template, and
`CHANGELOG.md` 0.1.0.

## Phase 10 — interactive screen

Design: [ADR 0003](./adr/0003-interactivity-from-recognised-text-and-mouse-forwarding.md);
terms Affordance, Hint, App profile, Mouse forwarding in [../CONTEXT.md](../CONTEXT.md).

- [~] App profiles (`web/profiles.ts`): by command name; mouse on/off, hint patterns, static
      keys and quick replies (the per-agent sets move here); generic fallback
      — `web/profiles.ts` (`PROFILES`, `profileFor`, `mouseAllowed`), read by `web/pane.tsx`
      for the key bar, the pills and the switch; `StatePane.command` fills from
      `HerdrMux.foregroundCommand` and tmux's `pane_current_command`
- [~] Hints → Affordances: four generic patterns; in place on the grid with a 44 px hit area,
      and as pills in the dock ahead of the quick replies
      — `shared/affordances.ts`, `web/affordances.tsx` (`AffordanceLayer`, `hintPills`),
      `test/affordances.test.ts` "recognises k9s and htop Hint runs"
- [x] Option lists with a `❯` cursor: tap a line to move the cursor there (arrow keys relative
      to the current row); long-press moves and confirms with Enter
      — the layer sends and confirms (`AffordanceLayer` `onHold`); the option regex strips a
      leading and trailing frame char, so a framed permission box matches too
      (`test/affordances.test.ts` "maps option rows inside a framed permission box")
- [~] Mouse forwarding through `pane.send_input`: SGR press + release on tap, right click on
      long-press, wheel on vertical drag, double click on double tap; only for profiles with
      mouse on or the per-Pane switch; off while Wrap is on; Fit scale compensated
      — `web/affordances.tsx` (`useMouseForward`, `useCell`), `server/mux.ts` (`mouseBytes`),
      `test/mouse.test.ts`; a drag over the grid posted four `wheelDown` reports for five rows
- [~] Claude Code status items: `N shells` / `N agents` → `/tasks` + Enter; `auto mode on` →
      Shift+Tab; footer badges → Footer navigation keys
      — `PROFILES.claude.statusItems`, `test/affordances.test.ts` "recognises Claude status,
      generic key Hints, and URLs"; the fixture footer is in `web/mock.ts` (`CLAUDE_VISIBLE`)
- [~] URLs and paths: tap to copy, long-press to open (URLs)
      — copy and the 1.5 s `Copied` chip are in `web/affordances.tsx`; long-press to open is
      not built, because a Pane path belongs to the Host, not to this phone
- [x] Contract test on a throwaway herdr: htop selection moves on a forwarded tap; an unknown
      program never receives mouse bytes
      — `test/mux.contract.test.ts` "forwarded htop click moves its highlighted process row"
      and "mouse-off rejects before a plain shell receives bytes"; the same file's key-name
      contract resolves `f1`, `f5`, `f10`, `shift+f`, `ctrl+d` and `shift+tab`

Verify: on the phone, tap a k9s row and it selects; tap `<d>` in its header and the describe
view opens; tap option 2 in a Claude Code permission prompt and the cursor moves; tap
`1 shell` and the tasks panel opens.

Verified in an emulated phone (390×844, touch): a tap on a real htop through a throwaway Hub
moved the highlighted row, read back from `GET /api/panes/:key/screen`; the k9s and Claude
Code fixtures underline their Hints and list them as dock pills.

## Phase 11 — trust the answer

Wave 1. Design: [ADR 0001](./adr/0001-render-mux-snapshots-not-a-pty.md) still holds; the
prompt id is a snapshot-side check.

- [ ] `promptId()`: salted hash of detection + visible Screen, the ticking Claude working
      line normalised to literal placeholders — `shared/blocked.ts`, `test/prompt-id.test.ts`
      (match, mismatch, ticking line, restart, twin shapes)
- [ ] Explain carries the id; input with a stale id answers `409 prompt_changed` before
      anything is sent — `server/http.ts`, `test/write.test.ts`, `test/blocked.contract.test.ts`
- [ ] The blocked card as flat rows docked above the composer, mounted aria-live region,
      Re-read on refusal — `web/blocked.tsx`, `web/pane.tsx`

Verify: on the phone, trigger a permission box, let Claude move on, tap Send — the card says
the prompt changed; answer a live box and watch the Status move to `working`.

## Phase 12 — know you are needed

Wave 2.

- [ ] The top-edge alert card: one at a time, 3.6 s leave that pauses under a finger,
      flick-up dismiss on `touchend`, tap opens the Pane — `web/alert.tsx`
- [ ] Wake lock while a Pane is open (stale-request guarded); reconnect region always
      mounted as `role="status"`; `document.title` follows the Pane — `web/app.tsx`
- [ ] SSE delivery survives Bun's early `req.signal` abort (cleanup on enqueue failure;
      the emit loop survives a dead subscriber) — `server/http.ts`, `server/mux.ts`

Verify: open tautan on a Pane, make a second Pane ask a question — the card drops in and
the tap opens it; the screen does not sleep while you watch an Agent work.

## Phase 13 — reach what the Agent made

Wave 3.

- [ ] `GET /api/panes/:key/file?path=`: realpath containment local and remote, caps, media
      types; the review's five findings fixed (SVG as text + `nosniff`, bounded reads,
      finite caps, root cwd, BSD `stat`, no service-worker caching) — `server/http.ts`,
      `test/write.test.ts`, `docs/SECURITY.md` “File viewer”
- [ ] The viewer at `#/file/:key?path=` (image inline, text in Diff gutter conventions)
      and the long-press Affordance that opens it — `web/file.tsx`, `web/affordances.tsx`

Verify: let an Agent write a chart, long-press its path on the phone — the chart opens.

## Phase 14 — fewer taps on a phone

Wave 4.

- [ ] Held messages above the composer with an ordered **Send now** once the Status leaves
      `working`; folded to its caption while the card asks — `web/pane.tsx`
- [ ] Tab rename and close from the strip (confirm only when it costs more than the Tab);
      branch prefill in herdr's `worktree/<adj>-<noun>-<hex>` shape — `web/pane.tsx`,
      `web/sheets.tsx`
- [ ] One-shot `ctrl` on the shell preset; the recording pill (Cancel/Done, live levels,
      4 Hz bar under reduced motion) — `web/keys.ts`, `web/pane.tsx`

Verify: type while an Agent works then send the queue; rename a Tab; create a worktree
without typing a branch; send `ctrl+r` with two taps; dictate with the pill showing.

## Phase 15 — install on a phone

Wave 5.

- [ ] `herdr-plugin.toml` + `scripts/plugin.ts`: build/startup/actions and the zoomed Phone
      setup pane; start refuses a busy port and verifies its child serves — `herdr-plugin.toml`,
      `scripts/plugin.ts`, `server/plugin-start.ts`
- [ ] The dependency-free QR (byte mode, ECC M, v1–5, half blocks) validated by a jsQR
      round-trip — `shared/qr.ts`, `test/qr.test.ts`
- [ ] README install section around one command — `README.md`

Verify: `herdr plugin install radityasurya/tautan` on this machine, open Phone setup, scan
the QR with the phone, add tautan to the Home Screen.

## Phase 16 — read the wide grid

Wave 7.

- [ ] The wrap guard: wrap engages only when the grid does not fit, measured against the
      room the scroller could take — `web/pane.tsx` (`effectiveWrap`, `potentialRoom`)
- [ ] The line classifier and the mixed grid: structure lines pin as scrollable blocks,
      prose reflows — `shared/layout.ts`, `test/layout.test.ts`, `web/pane.tsx`

Verify: on the phone, an agent Pane holds a permission box — prose fills the width, the box
stays square and pans; on the desktop browser the same Pane renders whole, unwrapped.

## Phase 17 — phone width

Wave 8. Design: [ADR 0004](./adr/0004-phone-width-geometry-lease.md).

- [ ] The geometry lease: a herdr terminal attach held in a `Bun.Terminal` purely to size
      the Pane's pty — explicit resize after start, restore with a settle beat, watch-loss
      reaper, `409` slot-held, tmux `501` — `server/lease.ts`, `test/lease.contract.test.ts`
- [ ] The Phone width toggle beside Wrap and Fit; while leased, `pane.cols` shrinks and the
      wrap guard disengages on its own — `web/pane.tsx`

Verify: toggle Phone width on a blocked agent Pane — the box redraws at your columns with
no wrap and no drag; leave the Pane and the desktop's width comes back.

## Phase 18 — the chat lens

Wave 9. Design: [ADR 0005](./adr/0005-chat-lens-second-view.md).

- [ ] Transcript parsing (turns, tool rows, noise and sidechain filtering) and the cached,
      settle-then-poll reader — `shared/chat.ts`, `server/chat.ts`, `test/chat.test.ts`
- [ ] Resolution only from `agent_session` or a `claude --resume` descriptor, never the
      newest session with a cwd; `GET /api/panes/:key/chat` — `server/chat.ts`,
      `server/herdr.ts`
- [ ] The per-Pane Chat/Screen switch with silent Screen fallback — `web/chat.tsx`,
      `web/pane.tsx`

Verify: on a Host running herdr 0.9.3+, open an agent Pane, switch to Chat — the turns
render; on 0.9.2 the switch falls back to the Screen with no error surface.

## Phase 19 — the desktop frame

Wave 10. Design: the canvas linked in [WAVES.md](./WAVES.md#wave-10--one-look-on-desktop-and-phone).

- [ ] At 1024 px and up, the Pane list is a sidebar beside the open Pane, `⌘B` hides it,
      and the Pane fills the space — `web/app.tsx`, `web/home.tsx`, `web/pane.tsx`
- [ ] Settings and Hosts get a left section nav at the same width — `web/settings.tsx`,
      `web/hosts.tsx`

Verify: open a Pane in a desktop browser — the list stays beside it; shrink the window below
1024 px and the phone layout returns with no reload.

## Phase 20 — header and Tabs

- [ ] One Pane header for both widths: Status under the title on the phone, path and
      Status chip on desktop, a warning line and a quick answer while blocked —
      `web/header.tsx`, `web/pane.tsx`
- [ ] Tabs: underline strip with + at the end on the phone, a picker past five Tabs;
      browser tabs with close and `⌘1–9` on desktop — `web/pane.tsx`

Verify: on the phone, the header shows title, Status, lens and ⋯ with no truncated Status;
on a blocked Pane, Review scrolls to the card. On desktop, `⌘2` opens the second Tab.

## Phase 21 — the composer

- [ ] One composer component: phone keys row and replies; desktop box with suggestions
      above and the toolbar inside; blocked, shell and keys-grid states — `web/composer.tsx`,
      `web/pane.tsx`
- [ ] Mode, model and context read from the Screen per App profile, hidden when absent —
      `web/profiles.ts`, `test/`

Verify: on a Claude Code Pane on desktop, tap the mode chip — the Agent cycles its mode and
the chip follows. On a shell Pane, the `$` prompt and history chips show instead.

## Phase 22 — Pane list and Settings

- [ ] Needs you card with Yes / No / Open on the phone and Yes in the desktop sidebar,
      behind the same stale-prompt guard — `web/home.tsx`
- [ ] Hosts is its own screen beside Settings (the bottom bar keeps three tabs: Panes · Hosts ·
      Settings); Host detail at `#/hosts/<id>` lists each Mux and its Workspaces —
      `web/settings.tsx`, `web/hosts.tsx`, `web/app.tsx`. Phase 22 first merged Hosts into
      Settings; 91edfca split them again at the user's request.

Verify: answer a blocked prompt from the Pane list without opening the Pane. Open Hosts,
tap a Host, and see each Mux with its Workspaces and their Status.

## Phase 23 — layout editing

Wave 15 ([WAVES-PARITY](./WAVES-PARITY.md#wave-15--layout-editing-split-move-swap-and-a-workspace-order)).
Design: [ADR 0008](./adr/0008-layout-editing.md).

- [ ] Split, swap, move and resize Panes from tautan, on herdr 0.9 and tmux; a Workspace
      order in the Home list that belongs to tautan and survives a reload

Verify: split a Pane from the phone and see the new shell; drag a split divider on desktop
and see herdr follow; drag a Workspace up the list and see the order survive a reload.

## Later (explicitly out of v1)

- Split Panes side by side on desktop (Wave 10, lane 10.8) until the SSE stream can watch more than one Pane
- Per-agent prompt grammars (native widgets for select lists)
- Passcode or SSO in front of the Hub
- Per-Workspace push muting; attachment pruning
