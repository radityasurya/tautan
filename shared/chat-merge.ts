import type { ChatDelta, Turn } from './chat.ts';

/** app.tsx forwards each `chat` event from the Hub's stream as this window event. */
export const CHAT_EVENT = 'tautan:chat';

/**
 * Apply a `?since=` answer to the turns on screen (ADR 0007). `reset` replaces the list; else
 * each upsert replaces the turn with the same `id` in place, and a new id appends in order.
 * Returns the same array when nothing changed, so a caller can skip a render.
 */
export function mergeTurns(turns: Turn[], delta: Pick<ChatDelta, 'reset' | 'upserts'>): Turn[] {
  if (delta.reset) return delta.upserts;
  if (!delta.upserts.length) return turns;
  const next = [...turns];
  const at = new Map<string, number>();
  next.forEach((turn, n) => { if (turn.id !== undefined) at.set(turn.id, n); });
  for (const turn of delta.upserts) {
    const n = turn.id === undefined ? undefined : at.get(turn.id);
    if (n === undefined) {
      if (turn.id !== undefined) at.set(turn.id, next.length);
      next.push(turn);
    } else next[n] = turn;
  }
  return next;
}
