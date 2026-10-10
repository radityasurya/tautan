# tautan UI, as built

One section per screen: what it renders today, which file owns it, and the
behaviour worth knowing. Reasoning lives in [DESIGN.md](./DESIGN.md), mockups
in [design/](./design/).

## Run it

- Mock data: `pnpm dev:web`, then `http://127.0.0.1:5173/?mock`. `main.tsx`
  calls `installMock()`, which patches `fetch`, `EventSource` and
  `XMLHttpRequest` with the fixtures in `web/mock.ts`.
- Real data: `pnpm dev` (Hub on 7700, Vite on 5173), then
  `http://127.0.0.1:5173/`.

Screenshot helpers, all under `?mock`: `&still` freezes the ticker, `&theme=`
forces a theme, `&open=switch|more|newtab|newworkspace|add-host` opens a
sheet. `&open=diff` is the one that opens a screen instead: it sets the hash to
the Workspace whose fixture diff is cut short.

## Tokens

| Token | Value | Used by |
|---|---|---|
| `rounded-chip` | 8px | chips, buttons, key caps |
| `rounded-composer` | 10px | composer, search field, sheet fields |
| `rounded-card` | 12px | Host cards, blocked card, dialog |
| `rounded-tabbar` | 14px | bottom tab bar |
| `rounded-drawer` | 16px | drawer top, Pane dock top |
| `text-caption` | 12/1.35 | meta lines, mono text |
| `text-body` | 15/1.45 | rows, fields |
| `text-title` | 17/1.25/600 | screen and sheet titles |

On a touch screen every text field is at least 16 px (`web/theme.css`, `pointer: coarse`),
because iOS zooms the page into a smaller field when it takes focus and stays zoomed.

## Motion

Four movements, all in `web/theme.css`, all off under
`prefers-reduced-motion: reduce`.

| Movement | What |
|---|---|
| Screen push | `::view-transition-new(root)`, 200 ms; `navigate()` skips the transition entirely under reduced motion |
| Tab underline | one accent bar under the Tab strip, `transition: transform, width` 200 ms ease-out, measured from the selected tab |
| Blocked card | `.rise`: `translateY(10px)` and opacity over 200 ms, same curve as the push |
| Press | `.press`: `scale(0.97)` while `:active`, 120 ms ease-out, on rows, chips, tabs and key caps |

Colours come from `data-theme` on `<html>`: System, Light, Dark and five named
palettes — Catppuccin Latte, Frappé, Macchiato, Mocha, and Gruvbox Dark
(`web/palettes.ts`). `applyTheme()` in `web/app.tsx` lays the palette over the
Halaska Kit tokens and points tautan's CSS variables at the kit, so every kit
component follows the palette with no kit edit. A named palette becomes its own
`data-theme` and carries its 16 ANSI colours (`--ansi-0` … `--ansi-15`) inline
from the palette's published values; plain light and dark keep the two ANSI
palettes that `web/theme.css` defines.

Mono text uses `web/public/tautan-box.woff2`: 8,976 bytes, 372 glyphs, subset
from DejaVu Sans Mono with `pyftsubset` (no Nerd Font on this machine). Its
`unicode-range` covers box drawing, blocks, Braille, arrows, geometric shapes
and the check/cross agents print; the rest falls through to the system stack.

## Agents (`#/`) — `web/home.tsx`

The screen title is `tautan`, with `<hosts> · <panes>` counts, a collapse/expand-all
toggle, a `+` that opens New Workspace, and the search field under them. Host chips appear
under the header only when there is more than one Host.

Unseen `blocked` and `done` Panes lift out into a **Needs you** section; `working`
Panes lift out into a **Running** section under it, most recently changed first. Both headers
fold like a group header — chevron, count, persisted — and a search forces them open.
Rows in a pinned section carry their Workspace label as context. Everything else groups by
Workspace, most urgent Status first. A group whose Panes are all
lifted keeps its header, so its menu stays reachable. A group header is a button: tap
collapses (persisted in `localStorage`), long-press (500 ms, cancelled by 10 px of movement)
or the ⋯ button opens the group menu. Collapsed, it summarises the most urgent Status of
*all* its Panes, for example `2 blocked`.

**Workspace order.** The group order in the list is tautan's own: herdr has no
Workspace reorder, so the order lives on this device (`tautan.workspaceOrder`,
per Mux) and is never written to a Mux. On desktop, drag a group header; a drop
mark shows above or below the group you cross. On the phone, the group menu's
**Move up** and **Move down** do the same one step at a time, disabled at the
ends. Renaming a Workspace changes its id, so a rename resets its place.

**Needs you card.** A blocked Pane in Needs you is a card, not a row: `Needs you · <Agent>`
with its Workspace and Tab, the command from Explain, and three buttons.

- **Phone.** **Yes**, **No** and **Open**. Yes and No send the Pane's own plain yes/no keys,
  from `yesNoKeys()`, through `sendBlocked()` and its stale-prompt guard. Open goes to the
  Pane.
- **Desktop sidebar.** Two lines with **Yes** only: the title, then the Agent, its Workspace
  and Tab, and its Host when there are several. **No** stays in the Pane; the row itself opens
  it.

Explain loads once per card, so only blocked Panes cost a fetch. The card refetches after
the Pane's revision has been still for 2 s, drops a response that arrives late, and locks
after you send an answer. A 409 shows **Re-read** in place of the buttons. A prompt with an
Always option, or no plain yes/no, shows **Open** only.

A **search field** sits under the title, always. It matches the agent, the title and the
Workspace label — the same rule the Switch drawer uses — and filters every section; an
empty section hides, except an unreachable Host, which stays. **Collapse all** folds the
pinned sections with the groups.

On a herdr Mux a Pane row swipes left to reveal **Rename** and **Close** (a tap on an open
row closes it instead of navigating), and long-press opens the same two as a menu — the
desktop path. tmux rows have no actions: the Mux does not write.

On a new device, an empty local Seen map is seeded from the first snapshot's
current Pane revisions, so old `done` work does not immediately fill **Needs you**.
A `blocked` Pane is always actionable and appears there regardless of Seen history.

A row is one link with one `aria-label`; every visual part inside it is
`aria-hidden`. Line 1 is the Agent name plus the title; line 2 is the Pane's
last line, or `basename(cwd)` in mono when there is none. The 8 px Dot is
filled when unseen and a 1.5 px ring when seen — decoration only, since the
label carries the fact. An offline Host adds a red row linking to Hosts. While
`state` is null the list is three skeleton rows; with nothing to show it reads
`No panes yet.` above an `Add a Host` link.

## Pane (`#/pane/<key>`) — `web/pane.tsx`

The Pane screen is `PaneHeader` (`web/header.tsx`), then the Tabs, then the grid, the blocked
card and the composer. One component draws the header at both widths.

**Header, phone.** Row of back chevron, then the title (16 px, truncates) over one Status
line: Dot, the Status word, the Agent (`shell` when there is none) and the Tab, then ⌄. The
two lines are one button that opens the Switch drawer. The Status word never truncates;
the Agent and the Tab give way first. On the right: the lens as two icons (Chat and Screen;
agent Panes only), then ⋯. **Read aloud** is a row in the ⋯ sheet. Wrap, Fit and Theme colors are
rows there too; no setting lives in the header.

**Header, desktop.** A 64 px row: back, then the `host / workspace / tab` path over the
title, then the Status chip (`● status · agent ⌄`, tinted with its Status colour, one button
that opens Switch), then the lens as a labelled control and ⋯. The Status
word for `blocked` reads `needs you`.

**Blocked.** A 2 px `--warn` line draws under the header while Status is `blocked`, and the
Status word reads `needs you`. That is all the header does: the lens stays, and the header
offers no answer. The answer lives in the blocked card, which is always on screen: the
composer's card in the Screen view, the approval row in the Chat view. While the Chat view
loads its transcript, the composer keeps its card.

**Approval rows (Chat view).** While the Pane is blocked, every pending tool of the final
assistant turn (`pendingTools()` in `shared/chat.ts`), oldest first, becomes its own
approval row: a `--warn` border and an 8 % `--warn` fill, the tool name, **Needs your
approval**, the tool's input open in mono, and the blocked card's choices under it (the
card component with `bare`, so the same pick-then-Send rows on the phone and one-click
buttons on desktop, the same `sendBlocked()` and 409 guard). The first row is the one the
on-screen prompt asks about; the rows behind it read **Also needs your approval** and wait
their turn. With no matching tool row (a question, not a tool), the whole card is the last
item of the transcript instead. The composer drops its own card in the Chat view and keeps
its text box. When the first row appears the view scrolls to it; if the user reads further
up, a **Needs your approval ↓** pill appears instead and scrolls to the row and focuses
its first choice. After an answer each answered row says **Sent · waiting for Claude**
until the Status moves on, then turns back into a normal tool row when the result arrives.
The choices come back after 10 s if the Status never moves.

Switching Pane inside the screen — a Tab, a Pane pill, a Switch drawer row, a
swipe — calls `navigate()` without the View Transition, which plays only when
the first path segment changes (`#/` ↔ `#/pane/…`). The screen stays mounted;
the grid holds the last Pane's Screen until a `screen` event whose `key` is the
new Pane arrives, and falls back to the skeleton after 800 ms. A held Screen is
never measured, marked Seen, read aloud or given Affordances.

**Tabs.** Under the header, the Workspace's Tabs, each with a 6 px Dot rolled up from its
Panes, its label, and its Pane count when it holds several. A **+** for a new Tab (herdr
Muxes only) comes after the Tabs. Close keeps the Phase 14 confirm: a Tab whose close would
stop work asks first, and any other Tab closes at once.

- **Phone.** An underline strip: one accent bar slides along the hairline under the open
  Tab. Past five Tabs the strip becomes one picker button that shows the open Tab, its
  position and a dot per Tab, and opens Switch at Tab level; long-press opens the Tab's
  menu. A horizontal **touch** swipe on the strip moves between Tabs. Chromium gives a
  horizontal drag to the nearest scroller and fires `pointercancel`, so the gesture reads
  `touchend`, and it is ignored when the strip itself scrolled. A drag that starts on the Pane
  chips row (`data-noswipe`) is that row's scroll, never a Tab switch.
- **Desktop.** Browser tabs: the open Tab takes the Pane's background and a 2 px accent
  top edge. Close (×) shows on hover and always on the open Tab. Right-click opens the Tab's
  menu. Press ⌘1–⌘9 to open Tab *n* and ⌘T for New Tab. Both are **Meta only**: Ctrl+T and
  Ctrl+digits belong to the browser and the terminal, so there is no Ctrl fallback, and the
  hint beside the strip shows only on a Mac. The shortcuts read `code`, so an AZERTY row
  still counts as digits.
- **Pane chips.** When the open Tab holds more than one Pane, a row of Pane chips sits
  under the Tabs, at both widths. On desktop, the split view replaces it while its rule
  holds; when the rule breaks, the chips row comes back.

**Split view, desktop.** From 1024 px up, the open Tab's 2 to 4 Panes draw side by side at
the Mux's own proportions: 1 px dividers and a 24 px title row per cell (Dot, title, agent).
Focus is quiet: the focused cell's title row is in the body colour with a 2 px accent
underline, like the open Tab; the other cells' titles are muted and their content sits at
90 % opacity until you hover the cell. Keyboard focus on a title row draws the kit's ring
inside the row. Each cell renders its Pane's Screen by the single Pane's Wrap rules, measured
against the cell's own width: an agent Pane wraps, a shell wraps line output at the normal
font size and keeps the grid for a full-screen program, and the Wrap and Fit settings still
win. A grid wider than its cell scales down to fit, never below
`splitFloor(devicePixelRatio)` (`web/split-floor.ts`): 0.75 at 1×, falling with the square
root of the ratio — 0.53 at 2× — and clamped at 0.45, because legibility follows device
pixels but a finer pixel is also a harder glyph to read. Past the floor the cell scrolls
sideways inside itself, never the page. In the Chat lens the focused cell shows the Chat view and the other cells keep
their Screen; switching the lens keeps the split. The chips row takes over when the Tab is
zoomed — a zoomed Tab reports no cell origins — when this view holds a Phone width lease, or
when a cell would measure under 420×180 px in the space the composer leaves. **Split view** in ⋯ turns it off; it is on by default (`tautan.split`).

Focus is the route. A click on a cell, or Enter on its title, navigates with `replace` and
sends nothing to the program, so the stream stays open. The other cells are view-only: no
Affordances, no mouse forwarding, no Chat lens, no composer. A view-only cell marks its
Pane Seen after its Screen has stayed on display for 3 s while the page is visible.

**Layout editing.** The ⋯ sheet's **Layout** group (hidden while the Tab is zoomed) holds
**Split right**, **Split down**, **Swap with…** (the Tab's other Panes), **Move to…** (a
new Tab in this Workspace, a new Workspace, or a place below any Tab's Panes) and
**Resize…** (a pad of Grow buttons — left, right, up, down — 5 cells a step, which stays
open for more than one step). On desktop, dragging a split divider is CSS-only while you
drag and sends one `/resize` on release. A herdr older than 0.9 answers 501 and the sheet
says so.

The grid renders the `visible` screen as styled ANSI spans, pinned to the
bottom until you scroll up, when a **New output** pill appears. Content wider
than the phone fades at the right edge instead of showing a scrollbar. There is
no Screen/Recent switch: tautan only ever shows the visible grid, and Wrap (in
More) reflows it client-side.

**Width.** The Pane fills the space it is given. Below 1024 px that is the window. From
1024 px up it is the space beside the sidebar, or the whole window while ⌘B has hidden
the sidebar. The Pane's root element carries a `ResizeObserver` that reads its own
`clientWidth` and measures the grid again, so Fit and Wrap follow a sidebar toggle and a
window resize with no reload. The grid width is the `<pre>`'s `scrollWidth`, measured after
every screen update and once `document.fonts.ready` resolves, because the mono subset swaps
in after first paint. There is no centred, content-sized column any more, and no per-Workspace
width memory.

The header, the Tab strip, the grid, the blocked card and the composer all fill that width.
A 120-column grid is 867 px at 12 px, so a desktop shows it whole. Fit stays for
the phone, where the window is narrower than the grid: it scales the `<pre>` to the room
the scroller leaves after its own padding, is **off** until you ask for it in ⋯, and the
row there is hinted with the grid size.

| Setting | Default | Key |
|---|---|---|
| Fit | off | `tautan.fit` = `on` \| `off` |
| Theme colors | on | `tautan.themedColors` = `on` \| `off` |
| Key grid, agent Panes | closed | `tautan.tray.keys.agent` = `on` \| `off` |
| Key grid, shell Panes | open | `tautan.tray.keys.shell` = `on` \| `off` |
| Suggestions, agent Panes | open | `tautan.tray.suggest.agent` = `on` \| `off` |
| Suggestions, shell Panes | closed | `tautan.tray.suggest.shell` = `on` \| `off` |
| Wrap, agent Panes | on | `tautan.wrap.agent` = `on` \| `off` |
| Wrap, shell Panes | off | `tautan.wrap.shell` = `on` \| `off` |
| Sidebar, desktop | open | `tautan.sidebar` = `open` \| `closed` |
| Split view, desktop | on | `tautan.split` = `on` \| `off` |
| Smart replies | off | `tautan.smart` = `on` \| `off` |
| Mouse taps | the App profile | `tautan.mouse.<paneKey>` = `on` \| `off` |

Wrap is remembered per kind, not per Pane: agent output is prose and wants
reflowing, a shell Pane is htop and logs, where the columns are the layout. What
counts as a full-screen program — the thing that keeps its grid — comes from a real
signal, not a guess: mouse forwarding on, then the alternate screen when the Mux reports
it, then the drawn share of the grid: 40 % on a first read, then past 50 % to turn
full-screen and under 30 % to turn back, so a table scrolling through does not flip the
view on every update. An Agent's own Screen is never read full-screen from its text: a
Claude Code Markdown table is not a TUI, so only mouse forwarding or the alternate screen
make it one. The wrap width itself is the text's
own widest prose line, so one long code row no longer locks the whole reflow wide.

**Affordances** (`shared/affordances.ts` finds them, `web/affordances.tsx`
places them) are the tappable tokens tautan reads off the Screen: a Hint
such as `esc to cancel`, `<d> describe` or `F9Kill`, a row of an option
list, one of Claude Code's status items, a URL or a path. Each one is a
transparent button drawn over the grid — no visible text, because the
grid's own text is what you read — with a 1.5 px accent underline exactly
under the token and a hit area of at least 44 px, grown around the token
in both directions. The layer lives inside the `<pre>`, so it is in the
grid's own coordinate space and Fit's transform scales it along with the
text; the 44 px is divided by that scale, so a fitted grid keeps a
thumb-sized target. A tap sends the key, types the text, runs the command
with Enter, or copies. An option row moves the cursor by as many `↑` or
`↓` as it is away; a long-press (500 ms, cancelled by 10 px) moves **and**
confirms, in one send. Every send carries the same haptic the dock's keys
do. The set is recomputed once per screen update, and only the rows near
the viewport are drawn.

The same Hints appear as **pills in the dock**, after the keys a blocked
prompt offers and before the quick replies, deduped by label and by key
against both — so `esc to cancel` next to a preset `No esc` is listed
once. Eight at most. They are keys, not coordinates, so they stay while
Wrap is on, unlike the boxes on the grid.

**Mouse on the grid.** For an App profile with mouse forwarding on — k9s,
htop, btop, lazygit, nvim, less — a gesture on the grid becomes a mouse
report at a cell, built by the Hub and written to the pty as SGR. An
Affordance box wins any tap it covers.

| Gesture | Report |
|---|---|
| Tap | click (press and release) at the cell |
| Second tap within 300 ms on the same cell | double click |
| Long-press, 500 ms, cancelled by 10 px | right click |
| Vertical drag | one wheel report per row of movement, dragging down looks back up the buffer |

While forwarding is on, the grid carries `touch-action: pan-x`: the
vertical drag belongs to the program, sideways scrolling stays the
scroller's, so a 120-column grid is still readable across. A **mouse**
chip sits at the right end of the Tab strip row while it is on. It is off
while Wrap is on, because a cell needs the grid, and off for every program
tautan does not know — an unknown program would type the bytes as text.

**Mouse taps** in the ⋯ sheet is the per-Pane override. Its secondary line
says where the state came from: `from k9s profile`, `overridden` once you
touch it, or `off while Wrap is on` when Wrap has the last word. It writes
`tautan.mouse.<paneKey>`; removing the key returns the Pane to its
profile.

**Copied chip.** Tapping a URL or a path copies it and prints a small
`Copied` chip above the token for 1.5 s, counter-scaled so it reads at its
own size under Fit. No toast: the chip stays where your thumb is.

When Status is `blocked`, `web/blocked.tsx` draws a card in the place the quick replies
take: the detection's first line as a heading, the rule id, up to two excerpt lines in the
agent's colours, and one button per offered key plus ↑/↓. On the phone each option is a 44
px row; on desktop the options sit on one line. A button shows the key it sends, spelled
by `keyGlyph()` (`↵`, `esc`), and not `1 2 3`, because tautan's order is not the Agent's own
numbering. The card rises into place over 200 ms and fades 150 ms after the Status clears.
Every answer, from the card, the approval row or the Pane list, goes through `sendBlocked()`
and its stale-prompt guard: if the Hub answers 409, the prompt has moved on, and **Re-read**
replaces the buttons.

`shared/blocked.ts` decides which keys the card offers, and the Hub applies the
same function on the way out, so `GET /api/panes/:key/explain` already carries
them. A prompt whose rule id names a permission or approval, **or** whose box
offers Yes / Allow / Accept as its first option, leads with the preset
`enter` = **Yes** and `esc` = **No**; the Mux's own hint keys follow, minus the
duplicates, because the footer's `esc to cancel` and `enter to confirm` are the
preset under another name. The id alone is not enough: a real Claude Code
permission box matches `live_blocked_form`, never `bash_permission_prompt`.
`yesNoKeys()` returns the Yes and No keys only for a plain yes/no prompt, never for one
with an Always option. The Pane list uses it for its Yes and No.

The composer is the only place with input: one box, and two trays that open above it.

| Part | Agent Pane | Shell Pane |
|---|---|---|
| Suggestions tray | the pills, one scrolling row; open by default | recent commands; closed by default |
| Keys tray | the key grid; closed by default | the key grid; open by default |
| Box, line 1 | the field, behind `›` | the field, behind the `$` prompt |
| Box, line 2, phone | ✦ and Keys toggles, `esc` `^C`, attach, `/` `@`, then the mic or Send | ✦ and Keys toggles, attach, then the mic or Run |

`esc` and `^C` sit on an Agent Pane's resting row in every Status: `esc` backs out of a
menu or a prompt, `^C` stops the run. On pi it is the other way round, as pi binds them:
`esc` aborts (danger red) and `^C` clears the editor. Neither sits beside Send, where a slip
would interrupt instead of reply. A shell's keys are in its tray, which opens by default.

The open tray is a four-column grid on the phone (48 px caps) and a wrapping row on desktop
(44 px caps). Each cap has two lines: the key as a footer prints it (`^O`, `⌥P`, `esc esc`)
and, under it, what the key does on this Pane (`transcript`, `model`, `rewind`). The groups
follow the Pane: **Control** (an Agent's `^D` reads as exit, in red; pi gets `esc` abort, `^C`
clear), the Agent's own keys (**Claude**: mode, rewind, transcript, tasks, background,
model, thinking, from Claude Code 2.1.296's keybinding table; **pi**: thinking level, model,
next model, tool output, show thinking, follow-up, dequeue, from pi's
`docs/keybindings.md`), **Menu** (`1`…`5` for a numbered menu on an Agent Pane), then
**Navigate** and **Edit**. Alt chords go out as `ESC` plus the letter. It is the only place
the arrows, `tab` and `⇧tab` live for an agent Pane.

Each toggle is outlined while its tray is closed and accent-tinted while it is open.
The pills scroll behind the same right-edge fade the grid uses (`FADE`). A toggle
carries `aria-pressed` and remembers its tray per kind (`tautan.tray.keys.agent`,
`tautan.tray.suggest.shell`, …), and the tray it opens rises into place with `.rise`,
which reduced motion turns off. Both trays can be open at once; they stack. Which caps
the grid holds is the App profile's call (`web/profiles.ts`): an agent Pane gets the
agent set, htop and less also get `F1`…`F10`, because their own footer offers them.

**Type directly.** On the Screen and on a shell, a **Type directly** toggle (the terminal
icon) stops the field composing a line: each key goes to the Pane as it is typed, in typing
order. The Composer shrinks to one bar: the ✦, Keys and Type directly toggles, then a status
that reads **Typing into the Pane** beside a blinking caret, or **Tap to type** when the
field has lost focus. The field itself stays mounted out of sight, so the phone's keyboard
still opens for it; a tap on the status or on the Screen focuses it. While it has focus, the
Screen draws a blinking `▍` where the input most likely is (`caretAt` in
`shared/layout.ts`: Claude's `❯` row, else the row inside pi's editor, else the last row with
text), because herdr reports no cursor. Reduced motion keeps both carets steady. Text rides `beforeinput`, an IME's word goes out whole at
`compositionend`, and Enter, Backspace, esc, Tab, the arrows, Home/End/PgUp/PgDn/Delete and
Ctrl or Alt chords go out as keys (`web/keys.ts` `directKey`); a Cmd chord stays the
browser's. An armed `ctrl` or `alt` folds into the next typed key. The toggle is remembered
per kind (`tautan.direct.agent`, `tautan.direct.shell`) and is hidden in the Chat view, where
a line is what the Agent reads.

No control in the dock takes focus from the field: each one prevents `pointerdown`'s
default, as the completion list does, so a tap on a key, a pill or a toggle leaves the
phone's keyboard up.

**Quick replies** (`web/replies.ts`, a pure function; `web/composer.tsx` renders
them) scroll horizontally in one row, 8 px radius, 13 px:

| Pill | Looks like | A tap |
|---|---|---|
| Key, primary | accent fill, the key glyph at 11 px mono, 70 % opacity | sends the key at once |
| Key, secondary | `--bg`, hairline border, the glyph in `--muted` | sends the key at once |
| Draft (generated) | `--bg`, hairline border, `✦` in accent, label in `--fg` | fills the composer |
| Preset (static) | `--bg`, hairline border, label in `--fg`, Send's arrow in `--muted` | sends the reply at once |

A key pill is a short label and a compact glyph, because it shares one scrolling
row with every other: `pillLabel()` in `web/replies.ts` drops a parenthesised
aside and the `on` or `off` of a mode, then cuts at 14 characters, so
`auto mode on (shift+tab to cycle)` prints `auto mode ⇧⇥`. The glyph is
`keyGlyph()` from `web/keys.ts`, the same map the key caps spell from. The full
text stays in the accessible name.

The order is: the keys `shared/blocked.ts` offers for the blocked prompt
(`Yes ↵`, `No esc`, then the Mux's own hint keys); then the Hints the Screen
itself printed — the arrows live in the open key grid, so a numbered
list adds no arrow pills; then up to three drafts from
`StatePane.suggestions`; then the presets for the Agent — Claude Code gets
Continue · Run the tests · Commit and push · Explain the diff · Stop here, Pi
gets Continue · Run the tests · Show me the plan, any other Agent gets
Continue. A draft that repeats a preset is listed once, as the draft. A blocked Pane
drops the presets: the prompt's own choices answer it, and the approval rows own that
state.

A preset is a whole reply: one tap sends it, like any reply while the Agent works,
and whatever is half-typed in the field stays there. A `✦` draft is not an answer yet: it
lands in the composer for review, appended after what you have already typed, like
dictation. On a touch screen the field is not focused, so the keyboard stays down and
Send is one tap away. Drafts appear only while **Smart replies** is on (`tautan.smart`); a
blocked Pane with no drafts for the current revision asks the Hub for one, once, with
`POST /api/panes/:key/suggest`. A blocked prompt opens the suggestions tray by itself only
while it holds a draft for the prompt, and closing the tray then dismisses only that
prompt's opening. Hint pills come only from this Pane's own Screen, never from the last
Pane's Screen held on the grid during a switch.

**Theme colors** (on by default, `tautan.themedColors`, toggled in ⋯) snaps every
256-colour and truecolour span to the nearest of the theme's own 16, so one Pane
reads as one picture instead of carrying whichever palette the agent shipped.
`web/pane.tsx` reads `--ansi-0` … `--ansi-15` off `<html>` once per theme, picks
the nearest by squared RGB distance, and memoises the answer per colour string,
because a screen repeats the same few colours thousands of times. Palette
indices 0–15 already resolve through the same variables and are left alone. Off,
the span renders exactly what the agent sent. A palette with no orange, such as
the Catppuccin sixteen, sends a peach 256-colour to its pink slot; that is the
rule working, and the toggle is there for when you want the agent's own colours.

**Composer.** `web/composer.tsx` draws the one composer at both widths. On desktop, Enter
sends and Shift+Enter inserts a newline. On a touch screen (`pointer: coarse`) an Agent's
Return inserts a newline (`enterkeyhint="enter"`) and the Send button sends, because a
reply typed on a phone keyboard is easy to send half-written; a shell's Return still runs
the line. Nothing sends while an input method is composing, and Safari's closing Enter
(keyCode 229) counts as composing. A trailing newline does not go out. A transcript from
the mic lands in the field for review and is never sent on its own.

- **Phone.** The trays above, then the box: the field with the agent's glyph before the
  placeholder, and under it the ✦ and Keys toggles, `esc` `^C`, attach, `/` and `@`, then
  one slot on the right — the mic while the field is empty or while it listens, **Send**
  as soon as there is text. With no `webkitSpeechRecognition` the slot is always Send.
- **Desktop.** The trays above a bordered box. The box has a two-line textarea and a
  toolbar: the ✦ and Keys toggles, `esc` `^C`, attach, `/`, `@`, the mic, then the mode
  chip, model and context left, and Send. The mode chip sends `shift+tab`, and the next
  Screen says which mode the Agent landed in.
- **Keyboard, phone.** iOS keeps the layout viewport when the keyboard opens and ignores
  `interactive-widget`, so `web/app.tsx` follows `visualViewport`: the Pane screen is
  `fixed` at `--vv-top` and `--vv-h` tall, and the composer sits on the keyboard.
  `--safe-b` drops the home-indicator inset while the keyboard is up. A pinned Chat or
  Screen stays on its newest line as the keyboard shrinks it; a reader who scrolled up
  stays where they were. A pinch zoom (`visualViewport.scale` above 1) moves nothing.
- **Mode, model and context** come only from this Pane's Screen, through
  `toolbarFromScreen()` in `web/profiles.ts`. The Claude Code recogniser reads the last 15
  lines: the `⏵⏵` or `⏸` mode line, a literal model name on that line, and a context
  figure that says `left`. A value the Screen does not state is hidden, never guessed, so
  default mode shows no chip. A held Screen from the previous Pane states nothing. Profiles
  without a recogniser show none of the three.
- **Shell Panes** get a mono `$` prompt in place of the agent's glyph, and the chips are
  the recent commands sent from this device (eight at most). A line typed while the last
  non-empty Screen line asks for a password, passphrase, PIN, token or secret is not
  stored. That keyword match is a guess; a prompt that does not use those words is not
  caught.

**Completion** (`web/complete.tsx`). Typing `/` at the start of the field opens the
Agent's own commands; `@` after a space or at the start opens files from the Pane's cwd;
`/model ` followed by a word opens the models the Agent offers. The list filters as you
type (a 120 ms debounce, 50 items at most), moves with ↑/↓, picks with Enter and closes
with Esc — and stays closed until the text changes again. On the phone it sits in the
flow above the input; on desktop it pops above the field. Picking a command or a file
inserts its text and nothing sends; picking a directory inserts `/` and keeps the list
open; picking a model sends `/model <name>` at once, and a bare `/model` sent by hand
opens the list instead of sending. Sources: the Agent's built-ins plus `.claude/commands`
and skills for Claude Code, the command list for pi, the Pane's files for `@` (git-ignored
paths excluded; type a path to reach one anyway). Completion is an Agent Pane's — a shell
has no picker. Models come from the Agent itself (`pi --list-models`; the models Claude
Code offers).

**Drafts.** A half-typed reply lives in `sessionStorage` per Pane
(`tautan.draft.<paneKey>`), so it survives a reload and dies with the tab. Switching Panes
brings back that Pane's own draft, and the 1024 px frame change — which remounts the
composer — rides through it. Sending clears the draft with the field.

**Edit keys.** The open key tray ends in an **Edit keys** button. It replaces the caps
with one row per cap the App profile carries: a switch for whether it shows, its glyph and
name, and ▲▼ to move it. Every change saves at once; **Reset** puts the profile's default
order back, **Done** returns to the caps.

Attach opens the photo library, never the camera: the hidden input has
`accept="image/*,video/*"`, `multiple`, and no `capture`. Each file goes out on
its own XMLHttpRequest as a raw body with the name in `X-Name`; `post()` is JSON
only, and an upload needs progress and an abort. While any upload runs, a 2 px
accent line under the composer shows the average progress. Each file gets a
chip with its name, its size and a × that removes it; the × also aborts an
upload in flight and takes the path back out of the field. On 200 the Hub's
absolute `path` is appended to the field, space-separated, because Claude Code
and Pi read an absolute image path out of the prompt; the chip's tooltip shows
the `~` form. A failure writes one muted line under the composer
(`IMG_0001.jpeg failed · too large`) with a **Retry** button. Send clears the
text and every chip that is not still uploading. `?mock` swaps in a small
`XMLHttpRequest` stand-in that ticks progress three times and answers from the
fake Hub.

**HEIC.** iOS hands a Photos pick to the page as JPEG, so tautan needs no HEIC
decoder. A reproduction on iOS tried ten `accept` values, from empty through
`image/*` and `image/heic` to explicit lists, and got a JPEG every time, in
Safari, Chrome, Firefox and Edge alike: the conversion lives in iOS WebKit
([zenn.dev test matrix](https://zenn.dev/kou_pg_0131/articles/safari-input-file-heic)).
The value to avoid is `image/heic` in the list: from Safari 17, it makes iOS
convert a JPEG or PNG pick *to* HEIC, renamed `tempImage….heic`
([Apple Developer Forums](https://developer.apple.com/forums/thread/743049)).
So `image/*,video/*` stays. A photo that reached the phone through Files,
AirDrop or Dropbox skips that path and can still arrive as HEIC; the Hub stores
it unchanged. Unverified here: no real iPhone was used for this check, and the
camera's **Formats** setting (High Efficiency or Most Compatible) was not tried.

## Chat (the lens on a Pane) — `web/chat.tsx`

The lens switches an agent Pane between its Screen and its transcript; a subagent
transcript opens from a Task tool row and reads **Back to \<agent\>** to return, with the
subagent bar (type, description, running or done) above it and the subagent Switcher under
the transcript. The transcript renders for Claude, pi, Codex and omp Panes — a badge above
it names which. Every other Agent falls back to the Screen with no error (ADR 0005: never
guess a transcript).

When Main answers 404, the view reads **No turns yet** with a **Show Screen** button and
asks again each second, because a fresh Agent writes its transcript with its first reply.
Still 404 after 5 s, the lens falls back to the Screen for this visit; the saved lens is
not changed. A first load that fails in passing — a 5xx, a dropped connection, a Hub
restart — is asked again 1, 2 and 4 s later before it falls back. Once a transcript has
loaded, a failed ask only waits for the next poll.

**Turns.** An assistant turn is a `--surface` card on the left; a user turn is an accent
card on the right. Text renders as Markdown — reference links and task lists included —
and pasted images load out of band from `/chat/image/:id`. The turn's time rides its last
row. When the Agent works, a **Working** line with the Screen's own spinner sits at the
bottom.

**Thinking.** A turn whose transcript kept the run's reasoning (`Turn.thinking`: pi, and
Claude with thinking summaries on) shows a muted **Thinking** row above its text, folded.
A tap opens it as Markdown under a hairline; the body renders only once opened, and the
chevron's turn is off under reduced motion. A turn without the field shows no row.

**Replies while the Agent works.** Claude and pi queue a reply typed mid-run in their own
prompt (pi steers with it), so tautan sends it at once; its pending turn reads **Queued for
Claude** with the send time until the transcript logs it. Any other Agent's reply is held.
**Held replies.** A held reply shows at once as a pending
turn marked **Held until Claude is idle** (the Agent's own name), and the composer lists it
under **1 held · sends when Claude is idle**. Held replies live in `web/pending.ts`, outside
any one screen, and the App sends them by themselves, oldest first, when that Pane's Status
turns `idle` or `done` — whichever screen is open. Never while `blocked`: text plus Enter
could answer a permission box. Then **Send now**, in the composer or on the pending turn,
sends them at once, and **Remove** (× in the composer) drops one. A send that fails stays
held and is tried again when the Pane next changes. A held reply lives as long as the tab.
A slash command (`/name args`) and a shell line (`!cmd`) are user turns in the transcript,
so their pending turns settle against it like any other reply. A shell line shows its output
under it as a code block, the last 40 lines (Claude's `<bash-stdout>`/`<bash-stderr>`, pi's
`bashExecution` output).

**Tool rows.** Each tool call is one collapsed row: a chip with the tool's name and a line
of its input, a link card when the tool published one, or the subagent's name for a Task.
Opening a row loads what was cut on the way in — the whole input (the head counts it:
`Input · first 6 of 240 lines`) and a result's tail complement each fetch from
`/chat/output/:id`, an image or an HTML preview the Agent wrote loads from its own route,
and a preview over the inline limit serves by id. The output half renders as Markdown; an
`Output cut short by …` line says who cut it.

**Transport.** The view keeps a cursor and asks the Hub for what changed since it
(`?since=`, [ADR 0007](./adr/0007-chat-deltas.md)); a `chat` event on the event stream
wakes the ask, so a busy conversation costs its new turns, not its history. The first
load is windowed to the last 100 turns, and **Load earlier turns** fetches the 100 before
the oldest shown — by itself as the reader scrolls within 600 px of the top, or on a tap.
Every turn carries its clock time (the date too before today), under its text or on its
last tool row. A Hub that predates deltas answers the full Chat response and the view
resets to it. Between events the view polls every 1.5 s while the Agent works, a reply
waits for its turn, or a subagent row still runs (an idle Pane's background subagents
included); 5 s while blocked; otherwise 15 s, then 30 s once quiet.

**Scroll.** The transcript pins to the bottom; read further up and a **New messages** pill
sits at the bottom until you tap it. While blocked and reading elsewhere, the
**Needs your approval ↓** pill takes over instead. The approval rows themselves are
described under Pane, above.

## Diff (`#/diff/<workspaceKey>`) — `web/diff.tsx`

Open it from the Pane's ⋯ menu or from a long press on a Workspace heading on
the Agents screen. Both pass the Workspace key, so the screen always knows
which directory git runs in. The back chevron returns to where you came from
(`history.back()`), which is the Pane in one case and the list in the other.

Top bar: back, the Workspace label, a line with the file count and `+N −M`,
then the **wrap** chip and **Refresh**. Under it, three scope chips —
**Changes · Staged · vs base**. In `vs base` a muted line under the chips names
the branch the Hub resolved, for example `vs main`. Wrap and the scope live in
the component, not in `localStorage`: a diff is a visit, not a setting.

One section per file. The path row is `<dir>/<name>`, with the directory
truncating and the file name never; a rename reads `oldPath → path`. The counts
are `+N` in `--ok` and `−M` in `--danger`. A chevron collapses the file. The
first three files open, the rest start collapsed, which is about one phone
screen of context.

A hunk renders as rows, not as text: two narrow tabular line-number columns
(old, new) in `--muted`, a one-character marker column (`+`, `-`, space), then
the line in mono 12 px. Added rows carry `--ok` at 12 %, removed rows
`--danger` at 12 % (`diff-add` and `diff-del` in `web/theme.css`, one
`color-mix` pair for every theme). The hunk header sits on `--surface` in
`--muted`; a `\ No newline at end of file` line is muted italic. There is **no
syntax highlighting**: the colour in this screen means added or removed, and
nothing else.

Wrap is off by default, so each file scrolls horizontally inside its own
section with the same right-edge fade as the Pane grid (`FADE`, exported from
`web/pane.tsx`). Wrap on reflows the line to the column and keeps the gutters.

| State | What it shows |
|---|---|
| Loading | three skeleton blocks, one per file |
| Empty | `No unstaged changes`, `No staged changes`, or `No changes vs main` — the scope says which |
| Binary | `Binary file` in place of the hunks |
| Cut | `Large diff · the list is cut. Load a file in full below.` plus **Show whole file** under every listed file |
| Not a repository | `Not a git repository` and the Workspace cwd |
| Gone | `Workspace is gone` and a link back |
| No base | `No base branch to compare with` |

**Show whole file** refetches that one file with `?file=<path>`, which the Hub
answers uncapped, and replaces the file's hunks in place. The rest of the list
stays as it is. A failure turns the button into **Try again**.

## File (`#/file/<paneKey>?path=`) — `web/file.tsx`

A clickable path in the Screen or a Chat tool row opens the viewer full screen. The header
is Back (which follows `history.back()`), the file name over the Pane title and the Host
label, then **Folder** and **Download**. **Download** streams the file from
`/api/files/raw` as an attachment. **Folder** swaps the viewer for the folder browser one
level up — the same browser the sheets use, files included — and picking a file there
navigates to it.

The viewer follows the file's extension (`viewerFor` in `web/folders-logic.ts`):

| Kind | What you see |
|---|---|
| PDF | the browser's own viewer, in an unsandboxed frame — Chrome blanks a sandboxed one, and the Hub serves the PDF itself, never HTML |
| Video | `<video>` streaming from `/api/files/raw`, so seeking works |
| Audio | `<audio>` streaming the same way |
| Image | the whole file as a blob, centred |
| Text | mono lines with line numbers, 5 MB at most, no wrap — the view scrolls sideways |
| Anything else | `Binary file` |

Errors read `File not found`, `File is too large`, or `Could not read the file` with the
Hub's code and a **Try again**.

## Hosts (`#/hosts`) — `web/hosts.tsx`

Hosts is the first section of Settings, so `#/hosts` opens Settings on it. On the phone
each Host is a row: an online Dot, the label, the SSH target in mono (or `this machine`),
the Workspace count, and the Mux kinds with their versions. An offline Host replaces those
with its error — the Hub's last ssh stderr line, `unreachable` when there is none — and the
time of the next retry, and never shows a Pane count, because it has none to show. From
1024 px up, each Host is a card with a Mux × Workspace table that scrolls sideways when
narrow. Order is the one `GET /api/state` sends: this machine, then the discovered Hosts,
then the ones in `hosts.json`. The last item is a dashed **Add Host** button.

The actions under a card follow `StateHost.source`, so the screen never offers
a write that the Hub would refuse:

| The Host | Actions | Caption |
|---|---|---|
| `local` | none | — |
| `machines`, from `herdr machine list` | **Retry now** while it is down | `from herdr machine list` |
| `config`, from `hosts.json` | **Retry now** while it is down, **Edit**, **Remove** | — |

**Retry now** POSTs `/api/hosts/:id/retry`, reads `Retrying…` and is disabled
until the Hub answers; the SSE `state` event repaints the card. **Remove** PUTs
`/api/settings` with the same `hosts` array minus that entry, and has no confirm
dialog: it deletes one line of configuration, not a running Pane, and **Add
Host** puts it back. A failed write prints one `--danger` line under the list.

### Host detail (`#/hosts/<id>`)

Tap a Host row to open its detail. The screen lists each Mux with its kind and version,
its socket path, and its Workspaces with their Tab and Pane counts and their Status. A Host
that is down shows its error and the time of the next retry, and keeps **Retry now**. A
hash with an id that does not decode, or a Host the Hub does not list, falls back to the
Hosts section instead of an error screen. The Hub supplies the data: `StateMux` carries
`socket` and `version` (tmux's `-V`, probed once per Mux), and `StateHost` carries `retryAt`.

### Add Host sheet

**Add Host** and **Edit** open the same drawer; Edit arrives prefilled and keeps
the entry's `id`, so a renamed Host keeps its Panes' keys.

| Field | Notes |
|---|---|
| Label | Optional. With none, the `id` is the first part of the target's host, so `dev@vps.example.ts.net` becomes `vps` |
| SSH target | Required, mono, `user@host` |
| herdr Mux | Optional, mono. The herdr session name; empty discovers every running one |

**Probe** POSTs `/api/hosts/probe {target, session?}`, which dials once and
saves nothing. The answer is one line under the button: a green Dot and
`reachable`, with `· herdr: default, work` when the Hub named the Muxes it
found; a red Dot and the ssh error when it was refused; and
`Enter a target like user@host` for the 400 the Hub sends on a target it cannot
parse. Probing is never required — **Add Host** saves a Host whose machine is
still off, which is the point of the offline card.

Save PUTs `/api/settings` with the whole `hosts` array, new entry appended or
the same `id` replaced. The sheet closes when the Hub answers and keeps
everything typed when it does not, the same contract every write sheet follows.

### Manual check: forward a throwaway herdr over ssh

No remote machine needed — the Hub forwards a local socket over `ssh localhost`.
The check is manual: it needs key auth to yourself, which this dev box does not
have (`Permission denied (publickey)`), so no test can run it.

1. Prerequisite: `ssh -o BatchMode=yes -o ConnectTimeout=3 localhost true` must
   exit 0.
2. Start a throwaway herdr with `startThrowawayHerdr()` from `test/harness.ts`
   and note the socket path it returns.
3. Hosts → **Add Host**, target `localhost`. **Probe** lists that Mux only if
   `herdr session list --json` on this machine reports it; otherwise fill in the
   **herdr Mux** field yourself.
4. Expect the card online, and its Panes on the Agents screen.
5. `pkill -f 'ssh -N.*tautan'`. The card goes offline, then comes back on the
   1 s → 30 s backoff, which resets after 60 s of a stable connection.
6. Stop the throwaway herdr.

The forwarder flags and the socket paths are in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Settings (`#/settings`) — `web/settings.tsx`

**Hosts is the first section.** Settings has six sections, each at `#/settings/<id>`:
Hosts, Appearance, Notifications, Replies, Access and About. `#/settings` and `#/hosts`
both open Hosts. On the phone the sections scroll as one screen, and the bottom bar has two
tabs, **Panes** and **Settings**. From 1024 px up, a 240 px section nav on the left lists
the sections and shows `N down` beside Hosts while a Host is offline. The nav marks the
section from the route, not from scroll position.

The Hosts section is described under Hosts below. The other
sections hold the theme picker (`ThemePicker`: the Halaska Kit `Select`, offering System,
Light, Dark and the five named palettes, with the chosen theme's colours as a swatch
beside it; the Pane's ⋯ sheet shows the same picker), a push toggle, a Haptics toggle on
Android only, the iOS install hint, a **Smart replies** toggle, and the **Access** rows.

**About** also carries the usage meters (`web/usage.tsx`): one meter per provider and per
window — a bar, the percent left, the reset time, and a pace line (`using quota fast`
when the window is being spent faster than it refills, `on pace` otherwise). Under
30 % the number and bar turn amber and read `running low`; under 15 % they turn red and
read `low`; a projected runway adds `runs out in 2 h`. The report comes from the Hub's own
`quota-axi` call, cached five minutes and shared by every meter on screen, so the meters
say `Checking usage…` first and `Usage is not available.` when the Hub cannot say. On
desktop the sidebar footer carries a strip of the same data — one line per provider whose
lowest window is under 30 % or whose runway projects exhaustion, nothing at all otherwise
— which opens About.

**Smart replies** reads `GET /api/settings`. With a provider configured the hint
is `provider · model` (`zai · glm-5.2`); with none it reads `not configured ·
set TAUTAN_SUGGEST on the Hub` and the switch is disabled, because there is
nothing to turn on. The state is the **and** of both sides — the Hub's
`suggest.enabled` and this phone's `tautan.smart` — and the switch writes both:
`localStorage` for the pills, `POST /api/settings/suggest {enabled}` for the
drafting. One rule, so a phone that turned it off never shows drafts and a Hub
that never drafts cannot be switched on from one phone only. Under the row, one
muted line says what leaves the Hub; the detail is in
[SECURITY.md](./SECURITY.md).

The push toggle is the only control with a failure state, so it has five:

| State | What you see |
|---|---|
| Off | The plain switch. `tautan.push` in `localStorage` is `0` or absent |
| On | The switch is on. The browser holds a subscription and the Hub has its endpoint |
| Denied | The switch flips back and a muted caption reads "Notifications are blocked for this site. Allow them in your browser settings, then turn this on again." |
| Unsupported | The same caption pattern: "This browser does not support push notifications." |
| iOS, not installed | The install hint sits under the toggle: push reaches only the app you added to the Home Screen |

The caption is one muted `text-caption` line, in the flow under the row. No
toast, no dialog: turning a switch on is not worth an overlay.

### Access

Three rows, each a label with the Hub's own value in mono under it:

| Row | Value | Action |
|---|---|---|
| Login | the `Tailscale-User-Login` header the Hub saw on this request, or `no identity header · not behind tailscale serve` | — |
| Trusted login | `Settings.trustedUser`, or `anyone who can reach the Hub` | **Unlock** while it is set; **Lock to this login** while it is not |
| Served by | `Settings.servedBy`, or the page's own host | — |

Both actions are the same write, `PUT /api/settings {trustedUser}` — the login
to lock to, or `null` to unlock — and the row is repainted from a fresh
`GET /api/settings` afterwards, because only the Hub knows which header it saw.
**Lock to this login** is disabled with no Login, since there would be nothing
to lock to, and the Hub refuses any value other than the one the request itself
carries: a 400 prints one `--danger` line saying to open tautan through
`tailscale serve` and try again. Locking the Hub to a login you cannot present
would lock you out, so neither side allows it.

## Sheets — `web/sheets.tsx`, `web/switch.tsx`

Bottom sheets are the shadcn Drawer (vaul): swipe to dismiss, scroll lock,
focus trap and Escape come from the library. `Sheet` supplies the surface, the
title and the meta line.

- **Switch** (`web/switch.tsx`): the search field, Host chips when there are several Hosts,
  then Home's list in one scroller: **Needs you**, **Running**, and every other Pane under
  its Workspace header. The header shows the Workspace path under the label, cut from the
  left like the Spaces list. The sheet is 320 px wide, the sidebar's width, so it draws the
  sidebar's rows and headers on every device. Rows inset 24 px, like the sheet title, and a
  header is 44 px tall on a touch screen. A blocked Pane is a row, not a card: the drawer
  switches, it does not answer. Groups follow the Spaces sort and rows the Agents sort. A
  header folds its section until the Pane screen closes; a search opens every fold. The open
  Pane is tinted and carries `aria-current="page"`. A pick goes to the Pane and closes the
  drawer, so any Pane is two taps away. The Tab picker opens it as **Switch Tab**, with the
  Workspace's Tabs above the Pane sections; they hide while a search is typed.
- **New Tab**: label, directory (mono) with a **Browse** button, one Agent chip per known
  agent plus `shell only`, as radio inputs. **Browse** swaps the form for the folder
  browser — a second sheet would sit inside the first one's transform — titled **Choose a
  folder**, with ← Back to the form; picking a folder fills the directory and returns.
- **New Workspace**: directory with the same **Browse**, label, an **As git worktree**
  switch, and the branch field it reveals.
- **Move to… / Swap with… / Resize…** (`web/layout.tsx`): the Layout sheets behind the ⋯
  menu's group, described under Pane.
- **Rename**: one field, for a Workspace, Tab or Pane.
- **More**: the ⋯ menu — the theme picker (`ThemePicker` from `web/settings.tsx`,
  the same control the Settings screen shows), then Wrap, **Phone width** with
  `the pane draws at your columns` as its hint, **Fit to width** with the
  grid size as its hint, **Theme colors**, **Mouse taps**, Diff, Rename, Close Pane, and a
  disabled `Resize to phone` marked `v2`. Desktop adds **Split view: on/off**, zoom in and
  out, and the **Layout** group.
- **Close Pane** is a Dialog, not a drawer, so a destructive action cannot be
  swiped into by accident.

### Writes

Four flows reach the Mux, all through `api()` in `web/app.tsx`: one POST, the
Hub's `{error}` code on a failure, `network` when the fetch never landed.

| Flow | Entry point | Defaults | On success |
|---|---|---|---|
| New Tab | `+` at the start of the Pane's Tab strip, or long-press a Workspace header → **New Tab** | directory = the Workspace's `cwd`; Agent chip = the Agent most of that Workspace's Panes run, else `shell only` | opens the new Pane from `{paneKey}` |
| New Workspace | `+` in the Agents header | directory = the parent of the first listed Workspace's `cwd`; worktree off | expands the new group and scrolls it into view once `state` carries it |
| Rename | long-press a Workspace header → **Rename**; ⋯ → **Rename** on a Pane | the current name, 80 characters at most | the new name arrives with the next `state` |
| Close Pane | ⋯ → **Close Pane** → the confirm Dialog | — | returns to Agents |

The Hub takes an absolute directory only, so both placeholders show one; in
practice the field arrives prefilled from State.

A sheet no longer closes on submit: `onSubmit` returns a Promise, the sheet
closes when it resolves, and a rejection keeps everything typed. While the call
is out the action reads `Creating…`, `Renaming…` or `Closing…` and is disabled.
A failure prints one `--danger` line with a **Retry** that sends the same
payload again: `body` is "Check the name and the directory", `unsupported` is
"This Mux does not support that", `agent_not_ready` is "Agent did not start", a
gone Mux or Pane says so, and anything else is "That did not work · `<code>`".
No toast, like the push toggle's caption.

A `tmux` Mux answers 501 to all four, so tautan does not offer them: the Tab
strip's `+`, **New Tab**, **Rename** and **Close Pane** are absent there, and the
Agents header `+` needs one herdr Mux to appear. Collapse, Wrap and every read
stay. A Tab has no menu of its own yet, so Tab rename is unreachable from the
phone even though `POST /api/rename` takes a `tabId`.

Under `?mock` the four routes are answered from the fixtures in `web/mock.ts`:
the new Tab, Pane and Workspace appear in the list, a rename shows, and a closed
Pane leaves (with its Tab, when it was the last one). A label of `fail` answers
502 `agent_not_ready`, which is how to reach the error line.

## Frame — `web/app.tsx`

One breakpoint decides the layout: Tailwind `lg`, 1024 px. `useDesktop()` follows a
window resize, so a window dragged across 1024 px changes layout with no reload. Below
1024 px the app is the phone app. From 1024 px up it has a frame.

| Part | Phone, below 1024 px | Desktop, 1024 px and up |
|---|---|---|
| Pane list | the `#/` screen | a 300 px sidebar beside the route; `#/` shows `Pick a Pane from the list.` |
| Root navigation | the floating tab bar, **Panes** and **Settings** | the sidebar footer, **Settings** and **Hosts** links |
| Settings and Host detail | one scrolling screen | a 240 px section nav replaces the sidebar |
| Pane | one column, the window wide | fills the space beside the sidebar |

The sidebar is the same `Home` list in its `compact` form: two-line rows with no preview, at
least 44 px tall, and a Yes-only Needs you card. A row's first line is the title beside its
Status dot. The second is muted: the Agent by name (`Claude`, `Codex`, `pi`), then its
Workspace and Host when no heading above the row names them; the Host shows only when there
are several. In the herdr list a Space row carries its Workspace path under the label, with
the home directory as `~`; a long path gives up its start, so the project name stays. Press ⌘B to hide or show it. Press Ctrl+B for the same, except
inside an input, a textarea or an editable field, so the tmux prefix still reaches the
terminal. The state is remembered in `tautan.sidebar` (`open` or `closed`). With the sidebar
hidden, `#/` shows the full Pane list.

The sidebar footer holds two links. **Settings** opens `#/settings`. **Hosts** opens
`#/hosts`, which lands on the Hosts section of Settings. Above them sits the usage strip
described under Settings, whenever a provider runs low.

Closing Settings or Hosts returns to the screen they were opened from, not to `#/`. **All
panes** in the section nav and **Panes** in the phone tab bar both go back to that screen, so
an open Pane comes back in the same lens. Browser back does the same through history.

Hash routes use `history.pushState`, so the iOS edge swipe and the Android back button
work, wrapped in a View Transition. There is one `EventSource` for the whole app. It
reopens when the watched set changes — a Tab change reopens it, a focus move inside a
split Tab does not — and a hairline `Reconnecting` bar shows while it is down. The
floating tab bar badges unseen `blocked` Panes and hides itself whenever a text
field has focus, so the keyboard never covers the composer.

The **app badge** on the installed icon counts more than the tab badge does:
unseen `blocked` plus unseen `done`, the same set the **Needs you** section
holds. `web/app.tsx` writes it on every `state` event through `setBadge()` in
`web/push.ts`, which is a no-op where `navigator.setAppBadge` is missing.

When the browser blocks `localStorage` — private mode, blocked site data — every choice
falls back to memory for the page's life, and one notice says so:
`Storage is unavailable, so your choices last until you reload.` (`web/store.tsx`, the
one door to the store). It floats above the tab bar with an ×, once per page load, and a
screen reader hears it without one.

The **service worker** (`web/public/sw.js`) caches the shell it is built with:
`vite.config.ts` stamps `index.html`, the manifest and every hashed asset into
`self.__PRECACHE`, and the cache is named after that list. Navigations and
`/api/*` are network-first and fall back to the cache, hashed assets under
`/assets/` are cache-first, and `/api/events` is never intercepted, because
buffering an SSE stream through a worker stops it. In dev the worker registers
only with `?sw` in the URL, so Vite keeps its own reload path.
