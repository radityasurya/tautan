# 7. Chat deltas ride an idempotent `?since=` cursor, woken by the event stream

Date: 2026-10-07

## Status

Proposed (awaiting the user's approval)

## Context

The Chat view polls `GET /api/panes/:key/chat` with If-None-Match and repaints the whole
conversation on every change: 3.2–4.0 MB on the busiest Claude Pane, 0.54–0.88 MB on a pi
Pane. The 4 000-character tool-result cap and the pasted-image budget in `shared/chat.ts`
exist only to keep those refetches small. Wave 12 reuses this transport for Codex and omp
transcripts, so the protocol cannot lean on Claude's file shape.

`ChatLens` already caches parsed turns per Pane on the transcript's `inode + size + mtime`
signature; a change means one fresh parse of the whole file. That parse is holistic:
adjacent same-role entries merge into one Turn, a tool result attaches by id to a tool row
in an earlier Turn, z.ai outputs pair with calls from earlier messages, image ids are
numbered in file order, and pi renders only the branch that ends at the last entry.

## Decision

A hybrid. Option (a) is the source of truth: `GET /api/panes/:key/chat?since=<cursor>`
returns only what changed. Option (b) becomes a wake-up: a `chat` event on the existing
`/api/events` stream says "this Pane moved", and the client then makes the same idempotent
GET. Reconnect correctness never depends on SSE delivery — a missed event only delays the
next fetch, and every GET is valid on its own.

### Turn ids

Each Turn gains an `id`: the native id of the run's first contributing entry — Claude's
entry `uuid`, pi's entry `id`, and Codex's `turn_id` (Wave 12.1). Ids come from the file,
so they survive re-parsing, cache eviction and a Hub restart. A merged Turn that keeps
growing keeps its id, because its first entry never changes. Per Wave 12.1, ids are never
synthesized from array position: a transcript without native ids gets no deltas — every
fetch answers `reset: true`, which is today's behaviour and stays correct.

### The cursor

The cursor is an opaque string: the hash of `sessionId, agent, inode, size, mtime` — the
existing strong ETag minus its volatile parts (`at`, the subagent digest), so it names
exactly the parse its Turns came from. The server never decodes it. Per conversation (a
Pane's main view, or one `?agent=` view) it remembers the previous generation — the turns
it replaced on the last re-parse — with the cursor that names them. A `since` equal to the
current cursor answers nothing new; equal to the remembered one answers the diff;
anything else (older, forged, from before a restart, another transcript) answers
`reset: true` with the full list. Because the cursor hashes the signature of the parse it
names, a match guarantees the baseline turns were parsed from identical bytes.

### Reset or upsert

The delta is a diff of parsed Turn lists by id, so it is content-based, not
append-based. One uniform shrink rule covers every loss: an id present in the remembered
generation and absent now means `reset`.

| Change | Answer |
|---|---|
| A merged assistant Turn keeps growing | Upsert: same id, new content |
| A tool result lands on an old tool row | Upsert of that old Turn by id (this also covers a z.ai output pairing with an earlier message's call) |
| pi switches branch | Reset: the replaced branch's Turns cease to exist |
| Transcript replaced or truncated | Reset: the signature moved, the cursor names nothing |
| A `?agent=` view | Its own cursor over the subagent's file; a subagent no longer listed is the existing 404 |
| Cache evicted or Hub restart | Reset: no remembered generation |
| Transcript without native ids | Reset every time |

### Response shape

```ts
/** `GET /api/panes/:key/chat?since=<cursor>[&agent=<id>]` */
interface ChatDelta {
  sessionId: string;      // as today
  cursor: string;         // names this parse; send it back as ?since next time
  reset: boolean;         // true: upserts is the whole conversation, replace the list
  upserts: Turn[];        // transcript order; merge by id
  subagents?: Subagent[]; // the whole tree, when the conversation has one, as today
  agent?: string;         // set on a subagent view, as today
}
```

The client keeps its Turns as a list plus an id map. On `reset` it replaces the list.
Otherwise each upsert replaces the Turn with its id, or appends when the id is new — a new
Turn can only follow the last existing one in an append-only transcript, and every other
shape arrived as a reset. React keys become Turn ids, so an open tool row stays open
across a delta. Scroll pinning, the "New messages" pill and the approval row read the
merged list and do not change.

### Out-of-band payloads

- `GET /api/panes/:key/chat/output/:toolId` serves a tool's whole result as text. The id
  is the native one already on the row (Claude `toolu_…`, pi `toolCallId`, a Codex call
  id), validated like the agent id (`^[A-Za-z0-9_-]{1,64}`) and looked up in the Hub's
  cached parse for that Pane and view. The id never names a path, so there is nothing to
  traverse; an unknown id is a 404. The Hub keeps full text only for results over the
  inline slice, inside the cached value, so the ceiling is one transcript's text per
  watched Pane. z.ai rows have no native id and get no route; z.ai already cut them.
- Pasted images move to `GET /api/panes/:key/chat/image/:id`, the route and numeric
  counter Read images already use. Both id kinds are assigned in file order, which
  append-only transcripts keep stable; a pi branch switch renumbers, and its reset
  re-renders.
- The inline tool-result slice becomes the last 40 lines in the current tail-keeping
  shape; `resultLines` still reports the whole. The pasted-image caps
  (`PASTED_MAX/PER_TURN/TOTAL`, the 4 MB budget) are removed once images ride by id. The
  4 000-character caps on Turn text and tool `detail` stay: they bound echoes, not
  results. `RESULT_MAX` stays as the Hub's per-image memory bound.

### ETag, and the wake-up

A plain GET (first load) keeps its strong ETag and 304 path untouched. A `?since=` GET
ignores If-None-Match and always answers 200; "nothing changed" is
`{cursor, reset: false, upserts: []}` at the same stat-and-cache cost as a 304. The
client stops sending If-None-Match once it holds a cursor.

The `chat` event fires when the Hub produces a new generation for a watched Pane — its
existing lens poll or any GET-triggered refresh — with payload
`{pane, cursor, agent?}`. One event per generation per Pane, so the lens timer bounds the
rate; nothing else is needed. A client holding the same cursor skips the fetch. The Chat
view's fallback loop stays for a dead SSE stream, at its slow tier (15 s, 30 s idle),
plus the existing revision, send and Status nudges. Update latency follows the lens watch
timer (4 s today); 11.2 may tighten it for Panes whose Status is working, at one stat per
tick. The protocol does not depend on that choice.

### Tests for 11.2

1. One appended Turn: `reset: false`, one upsert, the cursor moved.
2. A result arriving on an old tool row: that Turn's id is the upsert, with `result` set.
3. A pi branch switch: `reset: true`.
4. A `?agent=` view: its own cursor, the tree riding when present.
5. A cursor from before a Hub restart, and any unknown cursor: `reset: true` with the
   full list.
6. `?since=` equal to the current cursor: empty upserts; a plain GET still 304s.
7. `/chat/output/:toolId`: full text served, unknown id 404, malformed id 400.
8. A pasted image serves from `/chat/image/:id`; no data URL rides the Turns.

## Consequences

- A change costs the changed Turns, not the history; with results and images out of band,
  a new Turn stays under Wave 11's 50 KB target.
- The Hub holds two generations per watched conversation, about twice the parsed-turn
  memory.
- Correctness never depends on event delivery; a dropped stream only slows the view to
  the fallback poll.
- pi branch switches and truncations still pay one full refetch.
- Wave 12 readers must keep native ids (Wave 12.1's rule) or their Panes degrade to
  resets, never to wrong Turns.
- ADR 0005 holds throughout: an unresolved transcript still answers no-session and the
  Pane keeps its Screen.

Rejected: pushing Turns on `/api/events` — reconnect correctness would depend on event
delivery, and a stream shared by up to four Panes' screens would carry megabyte payloads
inline. Rejected: byte- or line-offset deltas parsed from the tail — the parse is
holistic, so a tail parsed alone differs from the same tail parsed whole. Rejected: a
delete list beside upserts — only the pi branch switch needs it, and that case resets.
