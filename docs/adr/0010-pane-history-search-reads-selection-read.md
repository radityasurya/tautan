# 10. Pane history search: herdr's `pane.selection.read` over the whole scrollback, not `pane.read`

Date: 2026-10-11

## Status

Accepted (2026-10-11, lane 22.1 of WAVES-PARITY-2)

## Context

Wave 22 searches a Pane's terminal history from the Hub. The Hub already reads the Screen
with `pane.read` (`server/herdr.ts`), whose 0.8.0 cost note records ~30 ms per line past the
Pane height on a Claude Pane. The lane measured every candidate read on a throwaway herdr
0.9.2 shell Pane (1,000–50,000 printed lines, a third wrapping past 120 columns) and once,
read-only, on a Claude Pane of the live server (which reports 0.9.0).

`pane.read` cannot serve history whatever `lines` asks: its recent ring answers with at most
~78 KB — 430 unwrapped rows (`recent_unwrapped`) or 1,000 wrapped rows (`recent`) — and
`truncated: true` every time, so it never reaches the ~9,300-row scrollback herdr keeps. On
the live server the 0.8.0 cliff still lives: height + 20 rows on an idle Claude Pane cost
274–377 ms across two runs, 13.7–18.8 ms per extra row.

`pane.copy_search` looks like the answer — server-side matches with coordinates — but its
required `content_revision` is exposed by no read-only surface. `pane.get` and snapshot pane
records carry no such field, and `pane.read`'s result revision is always 0 while the record
revision moves (14 against 0 on the live server). Every candidate revision failed
`stale_content`, at rest and after title, scroll and output bumps.

`pane.scroll` reaches any row but moves the shared viewport: herdr's own window scrolls with
it. That is a write on the user's live Mux, rejected under ADR 0001 since a read-only path
exists.

## Decision

The Hub reads a Pane's history for search with one `pane.get` plus one `pane.selection.read`:

- `pane.get` gives `scroll.max_offset_from_bottom` and `scroll.viewport_rows`; the ring depth
  is their sum.
- `pane.selection.read` with `anchor {row: 0, col: 0}` and `cursor {row: depth - 1, col: 0}`,
  no `content_revision`, returns the whole kept scrollback in one call. Its rows are grid
  rows but its text is joined logical lines, so a match on a wrapped line arrives whole and
  line numbers count logical lines.
- Columns are always 0: a column past a row's width fails with `selection_unavailable`.
- The ring trims from the top while the Pane prints, so row addresses drift; a retry re-reads
  rather than reusing coordinates.
- tmux stays on `capture-pane -p -J -S -10000`, clamped by each Pane's `history-limit`.

Measured medians on the throwaway Pane: full ring (rows 0…9301, ~3,988 joined lines, 732 KB)
29.9–132.6 ms across two runs; half the ring 21.4–114.3 ms. It answers while the Pane is busy
(6.5 ms for a small range), and herdr reads do not block other clients (a `session.snapshot`
during a big `pane.read` took 0.8–3.1 ms against a sub-5 ms baseline).

The cap is herdr's own ring, not a Hub constant: `scroll` reports it per Pane. tautan sets
no `history-limit` for tmux, so a tmux Pane holds the default 2,000 lines unless its server
says otherwise.

## Consequences

- Search cost per herdr Pane is one `pane.get` plus one bounded read (~130 ms at the observed
  ring ceiling), and the Hub searches plain text it already holds.
- `pane.read` stays the Screen path only; nothing raises its `lines` past the Pane height, so
  the live 0.8.0 cliff stays out of the Hub's request path.
- `pane.selection.read` is not confirmed on the running live server (0.9.0; the 0.9.2 binary
  is installed but the server predates it). Routes must map an `unknown variant` error to 501
  instead of guessing from the version string.
- If a herdr release exposes `content_revision`, revisit `pane.copy_search`: it returns
  matches without shipping the scrollback, which would beat a Hub-side scan on Panes with
  very long histories.

## Rejected alternatives

- `pane.read recent_unwrapped` with a large `lines`: capped at ~78 KB and `truncated` every
  time; it cannot reach scrollback, and on the live server the per-row cliff persists.
- `pane.copy_search`: no read-only source for its required `content_revision`.
- `pane.scroll` plus `pane.read visible`: moves the user's shared viewport; a write.
