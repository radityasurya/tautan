# 4. Lease a PTY for phone-width geometry, not rendering

Date: 2026-10-06

## Status

Accepted

## Context

ADR 0001 chose Mux screen snapshots over a PTY render source. Exact phone-width geometry
seemed unavailable because herdr exposed Screen reads and shared layout resizing, but no API
for an independently sized client surface.

A throwaway herdr 0.9.2 probe on 2026-10-06 changed that premise. The PTY size of
`herdr terminal attach` drives the Pane's PTY, and `stty` follows changes during the attach.
`pane.read` keeps serving while the attach is active. Attach slots are exclusive and support
`--takeover`. The operator's layout rect stays unchanged while the Pane's grid narrows.

## Decision

For a herdr Pane, the Hub may hold `herdr terminal attach` in a `Bun.Terminal` solely as a
geometry lever. The Hub records the operator's rect, resizes the attached PTY to the phone's
geometry, and restores the recorded rect before it releases the lease. It discards the attach
stream and continues to render only Mux screen snapshots.

This narrowly amends ADR 0001: the Hub never renders from a PTY, rather than never attaching
one. A tmux Pane never has a geometry lease and answers `501`.

## Consequences

- The desktop's copy of the Pane draws narrow content while the lease runs, although its
  layout rect does not change. Warn before acquisition, release on Pane close, navigation
  away, or watch loss, and restore the recorded rect after release.
- An attach slot may already be held. A refused lease offers **Take over** or **Cancel** and
  never silently removes the current holder.
- Screen snapshots remain available throughout the lease and remain the only render source.
- Reliable restoration is part of the lease contract; a lease must not outlive the phone
  watching that Pane.
