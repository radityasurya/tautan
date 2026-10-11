// Find in terminal (Wave 22): the pure half of web/history.tsx. The Hub searches the Pane's
// history and sends matches with their context (ADR 0010); this lays them out, finds what to
// mark on a line, and says where a step lands.
import { findAffordances } from '../shared/affordances.ts';
import type { HistoryMatch } from '../shared/types.ts';
import { strWidth } from '../shared/wcwidth.ts';

/** A run of consecutive history lines, oldest first. `from` is the line number of `lines[0]`. */
export interface Block {
  from: number;
  lines: string[];
}

/**
 * The matches as the view draws them: each match and its context placed by line number,
 * oldest first like the terminal, and runs that touch merged into one block, so a word
 * printed on ten lines in a row reads as one passage, not ten overlapping ones.
 */
export function blocksOf(matches: HistoryMatch[]): Block[] {
  const text = new Map<number, string>();
  for (const m of matches) {
    m.before.forEach((t, i) => text.set(m.line - m.before.length + i, t));
    text.set(m.line, m.text);
    m.after.forEach((t, i) => text.set(m.line + 1 + i, t));
  }
  const out: Block[] = [];
  for (const n of [...text.keys()].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && last.from + last.lines.length === n) last.lines.push(text.get(n)!);
    else out.push({ from: n, lines: [text.get(n)!] });
  }
  return out;
}

const literal = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where `q` occurs in `text`, as [start, end) offsets: literal and case-insensitive, like the Hub. */
export function hitsIn(text: string, q: string): [number, number][] {
  if (!q) return [];
  return [...text.matchAll(new RegExp(literal(q), 'gi'))].map((m) => [m.index, m.index + m[0].length]);
}

/** The UTF-16 offset where display column `col` starts: `findAffordances` places in columns. */
function indexAt(text: string, col: number): number {
  let width = 0;
  let i = 0;
  for (const ch of text) {
    if (width >= col) break;
    width += strWidth(ch);
    i += ch.length;
  }
  return i;
}

/**
 * The paths on one line, found by the Screen's own recogniser. Only its `copy` Affordances
 * count: a Hint printed long ago (`esc to cancel`) is history, not a key to send.
 */
export function pathsIn(text: string): { start: number; end: number; path: string }[] {
  return findAffordances([[{ text }]], {}).flatMap((a) =>
    'copy' in a.action ? [{ start: indexAt(text, a.colStart), end: indexAt(text, a.colEnd), path: a.action.copy }] : [],
  );
}

/**
 * Where a step from match `at` lands, `by` 1 toward older and -1 toward newer, or null at
 * either end. Matches are newest first; `load` says the step is past the loaded ones, so the
 * next page must arrive before it can land.
 */
export function step(at: number, loaded: number, total: number, by: 1 | -1): { at: number; load: boolean } | null {
  const to = at + by;
  if (to < 0 || to >= Math.max(loaded, total)) return null;
  return { at: to, load: to >= loaded };
}
