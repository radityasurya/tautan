import type { HistoryResult } from '../shared/types.ts';

/** Wave 22 (ADR 0010): one literal, case-insensitive scan of a history read. `q` arrives
 *  validated (1–200 chars) and never parses as a regex. `total` counts every match in the
 *  read; `before` narrows only `matches` (line < before), newest first, capped at 50. */
export function searchHistory(lines: string[], q: string, before?: number): HistoryResult {
  // The same escaped, case-insensitive RegExp the client highlights with (hitsIn in
  // web/history-logic.ts, minus its `g`): one fold rule on both sides. toLowerCase()
  // counted İ (U+0130) for `i` — it maps to i + U+0307 — while the client's RegExp did
  // not highlight it. No `u` flag here either: with one, ſ (U+017F) would fold to `s`.
  const find = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const hits: number[] = []; // 0-based indexes, oldest first
  for (let i = 0; i < lines.length; i++) if (find.test(lines[i]!)) hits.push(i);
  const matches = hits
    .filter(i => before === undefined || i + 1 < before)
    .reverse()
    .slice(0, 50)
    .map(i => ({ line: i + 1, text: lines[i]!, before: lines.slice(Math.max(0, i - 5), i), after: lines.slice(i + 1, i + 6) }));
  return { lines: lines.length, total: hits.length, matches };
}
