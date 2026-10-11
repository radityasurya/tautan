import { describe, expect, test } from 'bun:test';
import { searchHistory } from '../server/history.ts';
import { hitsIn } from '../web/history-logic.ts';
import { TmuxMux } from '../server/tmux.ts';

describe('searchHistory', () => {
  const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

  test('matches literally, case-insensitively: regex characters never parse', () => {
    const found = searchHistory(['call a.b(x)', 'call axb(x)', 'CALL A.B(X)', 'nothing'], 'a.b(');
    expect(found.total).toBe(2); // `axb(` and `nothing` do not match
    expect(found.matches.map(match => match.line)).toEqual([3, 1]); // newest first
  });

  test('caps matches at 50 newest first; total still counts every match', () => {
    const lines = numbered(120).map((line, i) => (i % 2 ? `${line} hit` : line)); // hits on even line numbers
    const found = searchHistory(lines, 'hit');
    expect(found).toMatchObject({ lines: 120, total: 60 });
    expect(found.matches).toHaveLength(50);
    expect(found.matches[0]!.line).toBe(120);
    expect(found.matches.at(-1)!.line).toBe(22);
  });

  test('before pages: only matches below it; total keeps the whole read', () => {
    const lines = ['alpha one', 'filler', 'alpha two', 'filler', 'alpha three'];
    expect(searchHistory(lines, 'alpha', 5).matches.map(match => match.line)).toEqual([3, 1]);
    expect(searchHistory(lines, 'alpha', 1).matches).toEqual([]);
    expect(searchHistory(lines, 'alpha', 1).total).toBe(3);
  });

  test('context is up to five lines each side, clamped at both ends', () => {
    const lines = numbered(12);
    const first = searchHistory(lines, 'line 2').matches[0]!;
    expect(first.before).toEqual(['line 1']);
    expect(first.after).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
    const last = searchHistory(lines, 'line 12').matches[0]!;
    expect(last.before).toEqual(['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
    expect(last.after).toEqual([]);
  });

  test('no match answers an empty result', () => {
    expect(searchHistory(['a', 'b'], 'zzz')).toEqual({ lines: 2, total: 0, matches: [] });
  });

  test('folds like the client highlight: neither İ for i nor ſ for s counts', () => {
    // toLowerCase() counted İ (it maps to i + U+0307) while the client's non-unicode
    // RegExp did not highlight it. Both sides now build the same escaped RegExp, and the
    // pair stays pinned: a `u` flag on either side would fold ſ back to s alone.
    // The filler lines hold neither search letter, so only the folded char can count.
    expect(searchHistory(['İstanbul', 'trace'], 'i').total).toBe(0);
    expect(hitsIn('İstanbul', 'i')).toEqual([]);
    expect(searchHistory(['ſomething', 'clear'], 's').total).toBe(0);
    expect(hitsIn('ſomething', 's')).toEqual([]);
  });
});

describe('TmuxMux history', () => {
  test('captures -S -10000 joined, and drops trailing empty lines', async () => {
    const calls: string[][] = [];
    const mux = new TmuxMux({ id: 't', socket: 'unused', exec: async args => {
      calls.push(args);
      return { stdout: 'old\nmatch here\n\n\n', stderr: '', code: 0 };
    } });
    expect(await mux.history('%1')).toEqual(['old', 'match here']);
    expect(calls).toEqual([['capture-pane', '-p', '-J', '-S', '-10000', '-t', '%1']]);
  });
});
