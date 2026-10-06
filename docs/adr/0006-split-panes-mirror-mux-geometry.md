# 6. Split Panes mirror the Mux's geometry over one multi-Pane stream

Date: 2026-10-06

## Status

Accepted

## Context

On a desktop, a Tab with several Panes showed one Pane at a time behind a Pane chips row.
The app holds one EventSource that streamed the Screen of one watched Pane. The Hub polls a
watched Pane because herdr emits no event on raw output. The state stream carries only
`lastLine`, so it cannot draw a live grid for a second Pane.

herdr's `session.snapshot` reports each Tab's layout: an `area`, a `rect {x, y, width,
height}` in cells per Pane, the split ratios, and `zoomed`. tmux reports `pane_left`,
`pane_top`, `pane_width` and `pane_height`. In the live snapshot on 2026-10-06, Tabs held 1
to 4 Panes. A Screen payload was 3–9 KB.

## Decision

- `GET /api/events` accepts `pane=` up to 4 times. The Hub polls each watched Pane in its own
  loop, with its own backoff (250 ms after a change, ×1.5 while quiet, at most 2 s). The
  `screen` event is unchanged: it already names its Pane by `key`. One key is the phone's
  request and behaves as before. A fifth key is a 400.
- The desktop split mirrors the Mux's rects as proportions of the Tab. tautan never invents a
  layout and never writes geometry back to the Mux. A zoomed Tab, a Tab with more than 4
  Panes, or a cell narrower than 420 px or shorter than 180 px falls back to the Pane chips
  row.
- The focused Pane is the route's Pane. Only the focused Pane has the Composer, the keys,
  the blocked card, the header Status, the Chat lens, Affordances and mouse forwarding. A
  click on another cell only moves focus.
- A visible Pane that is not focused is marked Seen after its Screen stays on display for
  3 s while the page is visible. The focused Pane keeps the 1 s delay. Seen stays tautan's own
  flag. A `blocked` Pane stays unseen by rule (`shared/seen.ts`).
- A Phone width lease belongs to the stream that asked for it. Before this ADR the reaper kept
  a lease while *any* listener watched its Pane, so a desktop showing that Pane in a split
  kept a phone's lease alive after the phone left. The lease now records the owner stream's
  id, and the reaper releases it when that stream ends, whoever else is watching.
- ADR 0001 holds: every cell renders the Mux's snapshot. A split view never takes a Phone
  width lease (ADR 0004).

## Consequences

- A desktop with a 4-Pane split makes up to 2 `pane.read` calls per second when idle, and up
  to about 16 per second while 4 Agents work. That is up to about 150 KB/s of SSE in the
  worst case. Only changed Screens are sent.
- Focus moves inside the watched set, so it does not reconnect the stream. A Tab change
  reconnects, as it did before.
- A resize made in herdr reaches tautan on the next tree refresh (at most 15 s), because
  herdr emits no layout event.
- A lease request must name its stream, so the client sends the id the stream announced. A
  request without one falls back to the old rule (kept while any listener watches) so older
  clients keep working.
- Split ratios cannot differ from the Mux until a later version adds a ratio kept only in
  tautan.
