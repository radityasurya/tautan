# 7. Chat deltas ride an idempotent `?since=` cursor, woken by the event stream

Date: 2026-10-07

## Status

Accepted (2026-10-07, by the user, with the eight-generation amendment below)

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
Pane's main view, or one `?agent=` view) it remembers the last **eight** generations, each
as its cursor plus a fingerprint: every Turn's id mapped to a short hash of that Turn's
content — not the Turns themselves. A `since` equal to the current cursor answers nothing
new; equal to any remembered cursor answers the diff against that fingerprint (upsert every
current Turn whose hash differs or whose id is new; `reset` if a remembered id is gone);
anything else (older than eight, forged, from before a restart, another transcript) answers
`reset: true` with the full list. *Amended at approval:* one remembered generation would
send a phone that wakes two or more parses behind — common while an Agent works or under
the fallback poll — a full refetch every time; eight fingerprints cost a few KB per
conversation. Because the cursor hashes the signature of the parse it
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
- The Hub holds the current parse plus eight fingerprints (id → content hash) per watched
  conversation: the parsed-turn memory once, plus a few KB.
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

## Amendment (2026-10-07): inline detail head, and the windowed first load

Wave 11's target — a full first load under ~1 MB uncompressed on the busiest Pane —
failed on the live Hub: the busiest Claude Pane answered 2 985 769 B plain (779 063 B
gzip), with tool `detail` at 46% and `result` at 29%; the busiest pi Pane answered
1 147 051 B plain. Two changes follow, both measured on those Panes' snapshotted
transcripts through the Hub's own parser and serialisation.

**The detail head.** A tool row's inline `detail` keeps its head — the first
`DETAIL_LINES` 6 lines within `DETAIL_CHARS` 300 characters, then `…` — with
`detailTruncated` set and `detailLines` reporting the whole, mirroring the result's
last-40-lines slice and `resultLines`. The whole text serves from
`GET /api/panes/:key/chat/output/:toolId?part=detail` (`part` defaults to `result`;
anything else is a 400), under the same id allow-list, cached-parse lookup and 404
behaviour. The Hub keeps full text only for cut rows, in the same cached value as
`sliced results, so the memory ceiling argument is unchanged. Rows without a native id
(z.ai's, id-less transcripts) keep their whole detail, as before. The one pending tool
(the approval row's target) keeps its whole detail inline — the lens restores what the
parser cut — so an approval row shows the whole command or diff with no fetch.

Head size, from the measurement: Claude detail lengths ran p50 559 B, p90 2 103 B,
p99 4 000 B (18 of 1 529 rows at the old cap). A 6-line/300-character head keeps every
closed row's gist (the row's `brief` already carries the one-line form); 10 lines/600
characters was measured too and bought nothing that changed a decision. The result's
40-line tail stays: trimming it to 15 lines saves ~60 KB on the busiest Pane and
changes no decision, so the closed row does not change.

**The windowed first load.** Detail alone does not reach the target — with the
harshest trim measured (3 lines/200 characters head, 15-line result tail) the busiest
Pane still answers 1 732 541 B, because Turn text (418 KB) and the remaining row
overhead (312 KB) are irreducible. So the first load is windowed:

- `?since=&limit=N` — a reset answers the newest N Turns and reports `total`, the
  conversation's whole Turn count.
- `&after=<oldest held Turn id>` — a non-reset diff considers only Turns from `after`'s
  index on, so the client never receives an upsert it cannot place (unknown ids append
  at the end, which would misorder a windowed view) and a Turn it holds outside the
  window never goes stale. An `after` that names no Turn of the current parse — even
  against the current cursor — answers a reset.
- `?before=<oldest held Turn id>&limit=N` — `Load earlier` fetches the page before it,
  shaped as a delta (`reset: false`, `upserts` prepend; `before` gone from the parse
  answers a reset so the client replaces its list). `after`/`before` use the output
  route's id allow-list.
- Route rules, from the review: `limit` rides a `since` or `before` ask only — with
  neither, or with `since` and `before` together, the answer is a 400, not a silently
  ignored parameter. A `before` ask without `limit` takes the page default
  (`CHAT_PAGE_TURNS`); a `since` ask without it stays unwindowed and reports no `total`.
  A `limit` that is not an integer 1..500 is a 400. Otherwise absent parameters keep
  today's behaviour, so an old client against a new Hub is unchanged apart from the
  shorter details.
- A parse whose Turns lack ids is never windowed, whatever `limit` says: `Load earlier`
  names the oldest held Turn, an id-less one cannot be named, and the older Turns would
  go silently missing. Such a reset keeps today's whole-list answer and reports no
  `total`.

N is 100 (`CHAT_PAGE_TURNS`, shared by client and Hub): the busiest Claude Pane's last
100 Turns, head cap applied, serialise to 568 789 B — 43% under the 1 MB budget —
while 150 Turns (845 383 B) leaves too little room for a conversation that grows.

Measured, Hub's own serialisation on the snapshotted transcripts (before → after):

| Pane | full load plain | full load gzip | detail share | first load (limit 100) | one-Turn delta |
|---|---|---|---|---|---|
| Claude `wM:p1` | 2 960 609 → 1 988 998 B | 779 065 → 544 350 B | 46.5% → 18.2% | 584 091 B plain / 155 984 B gzip (100 of 329 Turns) | 4 283 → 3 924 B |
| pi `w8:p2Z` | 1 136 861 → 928 122 B | 260 826 → 215 346 B | 31.8% → 15.4% | 928 154 B plain (whole conversation, 20 Turns) | 2 149 → 1 495 B |

Both Panes land under 1 MB uncompressed on the windowed first load, and every delta
stays far under Wave 11's 50 KB.

Tests for the amendment, beside 11.2's: a long detail keeps its head, marker and whole
text by `part=detail` (200/400/404 as for `result`); the pending tool keeps its whole
detail; a windowed reset serves the newest Turns with `total`; a diff honours `after`;
`earlier` serves the page before an id and answers a reset for an unknown one; a
later Turn changes nothing about a cut row; a reset whose Turns lack ids is never
windowed; `limit` without an ask, `since` with `before`, and `before` without `limit`
follow the route rules above.
