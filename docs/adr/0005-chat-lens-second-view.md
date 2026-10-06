# 5. Keep the chat lens a second view of a Pane

Date: 2026-10-06

## Status

Accepted

## Context

A Pane's Screen shows the Agent's current terminal state, but long answers are easier to read
as structured turns, work blocks, and tool rows. Claude Code stores that structure in a
transcript. A transcript lens can improve reading, but transcript discovery and reads can
fail, return stale data, or select an unrelated transcript.

The tempting fallback is to choose the newest transcript with the Pane's `cwd`. Several
Agents and old runs can share that directory, so recency is not evidence that a transcript
belongs to the Pane.

## Decision

The chat lens is a second view of a Pane, not a replacement for its Screen. The Screen remains
the fallback and the authority. If tautan cannot resolve or read the transcript, it shows the
Screen. It never guesses a transcript.

Tautan trusts exactly two transcript resolution sources: herdr's reported `agent_session`
reference, or an open rollout descriptor found in the Pane's own processes. The latter ties
the transcript to a running Agent process and its command line. Tautan never chooses the
newest transcript for a `cwd`.

Transcript reads are cached by `inode + size + mtime`. Tautan captures this signature before
the read; size alone cannot detect a same-size file replacement. It schedules the next poll
only after the current poll completes, so slower reads cannot arrive out of order.

Version 1 reads only Claude Code transcripts. It reads them on the local Host or over that
Host's SSH connection, through the same execution boundary the Diff screen uses for Git.
Other Agents keep the Screen.

## Consequences

- Transcript resolution or reading can fail without making the Pane unusable; the Screen
  remains available.
- A valid transcript may go undiscovered rather than risk showing another Agent's work.
- Replacements invalidate the cache even when their byte count is unchanged.
- Sequential polling may wait for a slow read, but it cannot publish an older result after a
  newer one.
- Supporting another Agent requires an explicit transcript reader and trusted resolution
  source; there is no generic directory scan fallback.
