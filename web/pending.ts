// Replies sent from the Composer that the transcript has not caught up with yet, and replies
// held while the Agent works. The Chat view shows them as pending user turns and drops each
// one when its real turn arrives; held ones go out on their own when the Pane is idle again.
// ponytail: a module store with one listener set, no state library; it lives as long as the
// tab, so a reload drops a held reply.
import type { InputBody, Status } from '../shared/types.ts';
import type { Turn } from '../shared/chat.ts';

export type PendingState = 'held' | 'sending' | 'sent' | 'late' | 'failed';

export interface Pending {
  id: number;
  paneKey: string;
  text: string;
  state: PendingState;
  /** When the send landed; the transcript match ignores user turns older than this. */
  at: number;
  /** Why a held reply waits beyond the Agent working: the terminal's own box has text
   *  (`draft`), or a panel or a prompt has taken the box's place (`panel`). */
  reason?: 'draft' | 'panel';
  /** It went out with Claude's Ctrl+Enter, past the queue. */
  now?: true;
}

/** How long a sent reply waits for its turn before it says so. */
export const LATE_MS = 20_000;
/** Hub and browser clocks are not the same clock, and a remote Host's is further off. */
const SKEW_MS = 30_000;

let pending: Pending[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };

export function subscribePending(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A stable array per change, so it can feed useSyncExternalStore. */
export const pendingSnapshot = () => pending;

function set(id: number, patch: Partial<Pending>) {
  pending = pending.map((p) => (p.id === id ? { ...p, ...patch } : p));
  notify();
}

export function dropPending(ids: number[]) {
  if (!ids.length) return;
  pending = pending.filter((p) => !ids.includes(p.id));
  notify();
}

/** Every Agent but Claude runs its slash commands outside its transcript (pi's `/skill:name`
 *  is the one that becomes a turn), so no turn would ever settle such a reply.
 *  ponytail: a pi prompt template becomes a turn too, under its expanded text; it is sent
 *  like a command, and its turn arrives without a pending one. */
export const runsOutside = (agent: string, sent: string) => !agent.startsWith('claude') && /^\/(?!skill:)[\w:.-]+(\s|$)/.test(sent);

/** Start tracking a reply. A held one waits for its Pane to come back to a prompt. */
export function trackPending(paneKey: string, text: string, held = false): number {
  const id = (nextId += 1);
  pending = [...pending, { id, paneKey, text, state: held ? 'held' : 'sending', at: Date.now() }];
  notify();
  if (held) autoDeliver();
  return id;
}

/** One Pane's held replies, oldest first. */
export const heldOf = (list: Pending[], paneKey: string) => list.filter((p) => p.paneKey === paneKey && p.state === 'held');

/**
 * Type the reply into the Pane and press Enter. Resolves false when the Hub refused it or
 * the request never landed; the entry then reads "Not sent · Retry". `now` presses Claude's
 * Ctrl+Enter instead: while it works, the reply and everything queued go at once.
 */
export async function deliver(id: number, now = false, force = false): Promise<boolean> {
  const entry = pending.find((p) => p.id === id);
  if (!entry) return false;
  set(id, { state: 'sending' });
  // `held` asks the Hub to refuse (409 draft, 409 panel) when Claude's own box holds text or is
  // gone; it ignores it elsewhere. `force` is Send anyway: the user saw why it waits.
  const res = await fetch(`/api/panes/${encodeURIComponent(entry.paneKey)}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: entry.text, keys: [now ? 'ctrl+enter' : 'enter'], ...(force ? {} : { held: true as const }) } satisfies InputBody),
  }).catch(() => undefined);
  const ok = !!res?.ok;
  if (!pending.some((p) => p.id === id)) return ok; // the transcript caught up first
  const refused = res?.status === 409 ? (await res.json().catch(() => undefined) as { error?: string } | undefined)?.error : undefined;
  if (refused === 'draft' || refused === 'panel') {
    // Not a failure: the reply waits, and the flush retries once the Pane's revision moves.
    if (!pending.some((p) => p.id === id)) return false;
    set(id, { state: 'held', reason: refused });
    ensureDraftTimer();
    return false;
  }
  // A slash command (`/name args`) and a shell line (`!cmd`) are user turns too, so they
  // settle against the transcript like any other text.
  set(id, ok ? { state: 'sent', at: Date.now(), reason: undefined, ...(now ? { now: true as const } : {}) } : { state: 'failed', reason: undefined });
  if (ok) setTimeout(() => { if (pending.find((p) => p.id === id)?.state === 'sent') set(id, { state: 'late' }); }, LATE_MS);
  return ok;
}

// ---- held replies ----

/** Panes whose held replies are going out now: one flush per Pane at a time. */
const flushing = new Set<string>();
export const isFlushing = (paneKey: string) => flushing.has(paneKey);

/**
 * Type a Pane's held replies, oldest first. A failure puts that reply back to held and stops,
 * so nothing goes out of order; resolves false then.
 */
/** `force` sends past a `panel` hold (Send anyway); the Hub's draft guard still applies to the rest. */
export async function flushHeld(paneKey: string, force = false): Promise<boolean> {
  if (flushing.has(paneKey)) return true;
  flushing.add(paneKey);
  notify();
  try {
    for (const { id } of heldOf(pending, paneKey)) {
      if (!pending.some((p) => p.id === id && p.state === 'held')) continue; // removed meanwhile
      if (!(await deliver(id, false, force))) {
        set(id, { state: 'held' });
        return false;
      }
    }
    return true;
  } finally {
    flushing.delete(paneKey);
    notify();
  }
}

/** Each Pane's Status and revision, as the last `state` said. */
let panes = new Map<string, { status: Status; revision: number }>();
/** The revision a Pane's flush failed at: no retry until the Pane moves again. */
const stuck = new Map<string, number>();

/** A draft-held reply retries this often: `state` events do not come while a Pane is quiet. */
export const DRAFT_RETRY_MS = 3_000;
const lastTry = new Map<string, number>();
let draftTimer: ReturnType<typeof setInterval> | undefined;
/** Runs only while a draft-held reply exists. */
function ensureDraftTimer() {
  if (draftTimer) return;
  draftTimer = setInterval(() => {
    if (!pending.some((p) => p.state === 'held' && p.reason)) {
      clearInterval(draftTimer);
      draftTimer = undefined;
      return;
    }
    autoDeliver();
  }, DRAFT_RETRY_MS);
}

/**
 * Held replies go out on their own, in order, once their Pane is back at a prompt (`idle` or
 * `done`). Never while `blocked`: text plus Enter could answer a permission box. The App
 * calls it with every `state`; a newly held reply calls it too, so a Status that turned
 * before the hold is not missed.
 */
export function autoDeliver(list?: { key: string; status: Status; revision: number }[]) {
  if (list) panes = new Map(list.map((p) => [p.key, p]));
  for (const key of new Set(pending.filter((p) => p.state === 'held').map((p) => p.paneKey))) {
    const pane = panes.get(key);
    if (!pane || (pane.status !== 'idle' && pane.status !== 'done')) continue;
    // A draft in the terminal's box clears without moving the revision, so those retry on time.
    const draft = pending.some((p) => p.paneKey === key && p.state === 'held' && p.reason);
    if (draft ? Date.now() - (lastTry.get(key) ?? 0) < DRAFT_RETRY_MS / 2 : stuck.get(key) === pane.revision) continue;
    lastTry.set(key, Date.now());
    void flushHeld(key).then((ok) => {
      if (ok) stuck.delete(key);
      else stuck.set(key, pane.revision);
    });
  }
}

// Paragraphs with their whitespace collapsed, split by NUL so a match stays paragraph-bound.
const normal = (text: string) =>
  text.split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\0');

/**
 * The pending entries the transcript now holds. Each entry is matched oldest first, and only
 * against a turn newer than the send (less clock skew), so an earlier identical reply does
 * not settle a new one. The transcript folds back-to-back user messages into one turn joined
 * by a blank line, so an entry may match a run of paragraphs, and each run settles once.
 */
export function settled(turns: Turn[], entries: Pending[]): number[] {
  const waiting = entries.filter((p) => p.state !== 'held' && p.state !== 'failed');
  if (!waiting.length) return [];
  // Only the newest user turns: a send lands at the end of the transcript.
  const users = turns.filter((t) => t.role === 'user').slice(-waiting.length - 1)
    .map((t) => ({ at: t.at, rest: `\0${normal(t.text)}\0` }));
  const ids: number[] = [];
  for (const entry of waiting) {
    const needle = `\0${normal(entry.text)}\0`;
    const turn = users.find((t) => (t.at === undefined || t.at >= entry.at - SKEW_MS) && t.rest.includes(needle));
    if (!turn) continue;
    turn.rest = turn.rest.replace(needle, '\0');
    ids.push(entry.id);
  }
  return ids;
}
