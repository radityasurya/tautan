// A line diff for the Chat view's edit rows: an Edit's old and new text, or a Write's file.
// The Hub counts `+N −M` with it at parse time and the browser draws the same lines, so the
// closed row and the open one always agree.
import type { DiffLine } from './types.ts';

/** A text's lines; a final newline ends the last line rather than opening an empty one. */
export const textLines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

// ponytail: an O(n·m) LCS table over the part between the common head and tail, capped at
// 1M cells (2 MB). A bigger middle reads as old-then-new, still correct, just less tight;
// switch to Myers if real edits land there often.
const CELLS = 1_000_000;

/** Every line of `a` → `b`, in order: `ctx` lines carry both 1-based numbers, `del` the old
 *  one, `add` the new one. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: DiffLine[] = [];
  const ctx = (i: number, j: number) => out.push({ type: 'ctx', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
  const del = (i: number) => out.push({ type: 'del', text: a[i]!, oldNo: i + 1 });
  const add = (j: number) => out.push({ type: 'add', text: b[j]!, newNo: j + 1 });
  for (let k = 0; k < head; k++) ctx(k, k);
  const n = a.length - head - tail, m = b.length - head - tail;
  if (n * m > CELLS) {
    for (let i = 0; i < n; i++) del(head + i);
    for (let j = 0; j < m; j++) add(head + j);
  } else {
    // lcs[i][j]: the longest common run of a[head+i..] and b[head+j..].
    const w = m + 1;
    const lcs = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    let i = 0, j = 0;
    while (i < n || j < m) {
      // A tie takes the deletion first, so a changed line reads old above new.
      if (i < n && j < m && a[head + i] === b[head + j]) ctx(head + i++, head + j++);
      else if (i < n && (j === m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) del(head + i++);
      else add(head + j++);
    }
  }
  for (let k = tail; k > 0; k--) ctx(a.length - k, b.length - k);
  return out;
}

/** The `+N −M` of a list of changes. */
export const diffStat = (lines: DiffLine[]) => ({
  additions: lines.filter((line) => line.type === 'add').length,
  deletions: lines.filter((line) => line.type === 'del').length,
});

/** A run of unchanged lines folded away, as the Diff view's hunks fold them. */
export interface Skip { type: 'skip'; count: number }

/** The changed lines with `context` unchanged lines around each, the rest folded into skips. */
export function foldContext(lines: DiffLine[], context = 3): (DiffLine | Skip)[] {
  const near = new Uint8Array(lines.length);
  lines.forEach((line, n) => {
    if (line.type === 'ctx') return;
    for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) near[k] = 1;
  });
  const out: (DiffLine | Skip)[] = [];
  lines.forEach((line, n) => {
    if (near[n]) return void out.push(line);
    const last = out.at(-1);
    if (last?.type === 'skip') last.count++;
    else out.push({ type: 'skip', count: 1 });
  });
  return out;
}
