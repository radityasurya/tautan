// Replies sent from the Composer that the transcript has not caught up with yet. The Chat
// view shows them as pending user turns and drops each one when its real turn arrives.
// ponytail: a module store with one listener set, no state library; it lives as long as the tab.
import type { InputBody } from '../shared/types.ts';
import type { Turn } from '../shared/chat.ts';

export type PendingState = 'held' | 'sending' | 'sent' | 'late' | 'failed';

export interface Pending {
  id: number;
  paneKey: string;
  text: string;
  state: PendingState;
  /** When the send landed; the transcript match ignores user turns older than this. */
  at: number;
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

/** Start tracking a reply. A held one waits for `deliver`. */
export function trackPending(paneKey: string, text: string, held = false): number {
  const id = (nextId += 1);
  pending = [...pending, { id, paneKey, text, state: held ? 'held' : 'sending', at: Date.now() }];
  notify();
  return id;
}

/** Back to held, after a held flush failed: the Composer still lists it with Send now. */
export const holdPending = (id: number) => set(id, { state: 'held' });

/**
 * Type the reply into the Pane and press Enter. Resolves false when the Hub refused it or
 * the request never landed; the entry then reads "Not sent · Retry".
 */
export async function deliver(id: number): Promise<boolean> {
  const entry = pending.find((p) => p.id === id);
  if (!entry) return false;
  set(id, { state: 'sending' });
  const ok = await fetch(`/api/panes/${encodeURIComponent(entry.paneKey)}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: entry.text, keys: ['enter'] } satisfies InputBody),
  }).then((r) => r.ok, () => false);
  if (!pending.some((p) => p.id === id)) return ok; // the transcript caught up first
  // A slash command runs in the Agent and never becomes a transcript turn.
  if (ok && entry.text.trim().startsWith('/')) { dropPending([id]); return ok; }
  set(id, ok ? { state: 'sent', at: Date.now() } : { state: 'failed' });
  if (ok) setTimeout(() => { if (pending.find((p) => p.id === id)?.state === 'sent') set(id, { state: 'late' }); }, LATE_MS);
  return ok;
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
