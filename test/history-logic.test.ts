import { expect, test } from 'bun:test';
import { blocksOf, hitsIn, pathsIn, step } from '../web/history-logic.ts';
import type { HistoryMatch } from '../shared/types.ts';

const match = (line: number, before: number, after: number): HistoryMatch => ({
  line,
  text: `L${line}`,
  before: Array.from({ length: before }, (_, i) => `L${line - before + i}`),
  after: Array.from({ length: after }, (_, i) => `L${line + 1 + i}`),
});

test('matches whose context touches merge into one block, oldest first', () => {
  // Newest first, as the Hub sends them: 40 (36–42), 30 (25–35, touching 36), 10 (8–12).
  const blocks = blocksOf([match(40, 4, 2), match(30, 5, 5), match(10, 2, 2)]);
  expect(blocks.map((b) => [b.from, b.lines.length])).toEqual([[8, 5], [25, 18]]);
  expect(blocks[1]!.lines[0]).toBe('L25');
  expect(blocks[1]!.lines.at(-1)).toBe('L42');
  // Every line sits at its own number, so the match line reads its own text.
  expect(blocks[1]!.lines[30 - 25]).toBe('L30');
});

test('a match near the start of history carries fewer lines before it', () => {
  expect(blocksOf([match(2, 1, 5)])).toEqual([{ from: 1, lines: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] }]);
});

test('hits are literal and case-insensitive', () => {
  expect(hitsIn('Error: error.ts (ERROR)', 'error')).toEqual([[0, 5], [7, 12], [17, 22]]);
  expect(hitsIn('a.b axb', 'a.b')).toEqual([[0, 3]]);
  expect(hitsIn('cost $5 (x)', '$5 (')).toEqual([[5, 9]]);
  expect(hitsIn('anything', '')).toEqual([]);
});

test('paths come from the Screen recogniser, in string offsets past a wide glyph', () => {
  expect(pathsIn('edit /home/me/a.ts now')).toEqual([{ start: 5, end: 18, path: '/home/me/a.ts' }]);
  // 日本 is four columns but two UTF-16 units.
  expect(pathsIn('日本 ~/x/y.md')).toEqual([{ start: 3, end: 11, path: '~/x/y.md' }]);
  // A Hint is a key to send on the Screen; in history it stays text.
  expect(pathsIn('esc to cancel')).toEqual([]);
});

test('a step stops at both ends and loads the next page past the loaded matches', () => {
  expect(step(0, 50, 120, -1)).toBeNull();
  expect(step(0, 50, 120, 1)).toEqual({ at: 1, load: false });
  expect(step(49, 50, 120, 1)).toEqual({ at: 50, load: true });
  expect(step(119, 120, 120, 1)).toBeNull();
  expect(step(3, 4, 4, 1)).toBeNull();
});
