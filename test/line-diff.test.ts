import { describe, expect, test } from 'bun:test';
import { diffLines, diffStat, foldContext, textLines, unifiedKinds } from '../shared/line-diff.ts';

const marks = (a: string, b: string) => diffLines(textLines(a), textLines(b)).map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`);

describe('diffLines', () => {
  test('keeps the common lines and marks the changed ones, old above new', () => {
    expect(marks('a\nb\nc\nd', 'a\nB\nc\nd\ne')).toEqual([' a', '-b', '+B', ' c', ' d', '+e']);
  });

  test('numbers lines from 1 on each side', () => {
    expect(diffLines(['x', 'y'], ['y', 'z'])).toEqual([
      { type: 'del', text: 'x', oldNo: 1 },
      { type: 'ctx', text: 'y', oldNo: 2, newNo: 1 },
      { type: 'add', text: 'z', newNo: 2 },
    ]);
  });

  test('a new file is all added; an empty edit side has no lines', () => {
    expect(marks('', 'one\ntwo\n')).toEqual(['+one', '+two']);
    expect(diffStat(diffLines(textLines('gone'), textLines('')))).toEqual({ additions: 0, deletions: 1 });
  });

  test('finds the moved-around common lines a prefix and suffix trim would miss', () => {
    expect(diffStat(diffLines(['1', 'x', '2', '3'], ['1', '2', 'y', '3']))).toEqual({ additions: 1, deletions: 1 });
  });

  test('a middle past the cell cap reads as old-then-new, with the common head and tail kept', () => {
    const a = ['head', ...Array.from({ length: 1_200 }, (_, n) => `a${n}`), 'tail'];
    const b = ['head', ...Array.from({ length: 1_200 }, (_, n) => (n % 2 ? `a${n}` : `b${n}`)), 'tail'];
    const lines = diffLines(a, b);
    expect(lines[0]).toEqual({ type: 'ctx', text: 'head', oldNo: 1, newNo: 1 });
    expect(lines.at(-1)).toEqual({ type: 'ctx', text: 'tail', oldNo: 1_202, newNo: 1_202 });
    // `a1199` matches at the end, so the tail takes it: a 1 199-line middle on each side.
    expect(diffStat(lines)).toEqual({ additions: 1_199, deletions: 1_199 });
    expect(lines.findIndex((l) => l.type === 'add')).toBe(1_200); // every deletion first
  });
});

describe('foldContext', () => {
  test('keeps three lines around each change and folds the rest', () => {
    const a = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const b = a.map((line, n) => (n === 10 ? 'changed' : line));
    const rows = foldContext(diffLines(a, b));
    expect(rows[0]).toEqual({ type: 'skip', count: 7 });
    expect(rows.slice(1, 9).map((r) => ('text' in r ? r.text : r.count))).toEqual(['l7', 'l8', 'l9', 'l10', 'changed', 'l11', 'l12', 'l13']);
    expect(rows.at(-1)).toEqual({ type: 'skip', count: 6 });
  });

  test('two changes closer than twice the context share one hunk', () => {
    const a = Array.from({ length: 12 }, (_, n) => `l${n}`);
    const b = a.map((line, n) => (n === 2 || n === 8 ? `${line}!` : line));
    expect(foldContext(diffLines(a, b)).filter((r) => r.type === 'skip')).toEqual([]);
  });
});

describe('unifiedKinds', () => {
  test('marks a git diff as a terminal colours it, and only inside a hunk', () => {
    const out = [
      'diff --git a/x.ts b/x.ts',
      'index d292c51..ecec7f5 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,3 +1,3 @@ export class Hub {',
      ' keep',
      '-old',
      '+new',
      '',
      '\\ No newline at end of file',
      '----',
      '- a list item',
      'tsc exit 0',
    ].join('\n');
    expect(unifiedKinds(out)).toEqual(['file', 'file', 'file', 'file', 'hunk', '', 'del', 'add', '', '', '', '', '']);
  });

  test('text with no hunk header is no diff', () => {
    expect(unifiedKinds('- a list\n+ not a diff\n--- a rule')).toBeUndefined();
  });
});
