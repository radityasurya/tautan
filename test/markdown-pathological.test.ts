import { describe, expect, test } from 'bun:test';
import { parseBlocks, inline } from '../web/markdown.tsx';

// Markdown is untrusted Agent output, so the parser owes every input a bounded parse.
// Each test feeds one pathological shape and holds the whole parse — blocks plus every
// inline pass, i.e. what BlockView would render — under 100 ms, without throwing.
type AnyBlock = { kind: string; text?: string; blocks?: AnyBlock[]; items?: AnyBlock[][]; head?: string[]; rows?: string[][] };

/** Inline every text-bearing block the way BlockView does, without paying for React. */
const inlineAll = (blocks: AnyBlock[]): void => {
  for (const b of blocks) {
    if (b.kind === 'quote') inlineAll(b.blocks!);
    else if (b.kind === 'list') b.items!.forEach(inlineAll);
    else if (b.kind === 'table') {
      inline(b.head!.join('\n'));
      b.rows!.forEach((row) => inline(row.join('\n')));
    } else if (b.kind !== 'code' && b.text !== undefined) inline(b.text);
  }
};

// The budget buys the parse's own cost: this machine runs other lanes' builds while the
// tests run, so wall-clock alone measures the scheduler too. One warm-up absorbs JIT and
// regex compilation, then the best of three holds the CPU time a parse owes on its own.
const parseMs = (source: string): number => {
  inlineAll(parseBlocks(source));
  let best = Infinity;
  for (let n = 3; n--; ) {
    const start = performance.now();
    inlineAll(parseBlocks(source));
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

const BUDGET = 100;
const inBudget = (source: string): number => {
  const ms = parseMs(source);
  expect(ms).toBeLessThan(BUDGET);
  return ms;
};

describe('pathological input parses in under 100 ms', () => {
  test("1 MB of '(' — no inline construct starts there, so no position may be rescanned", () => {
    inBudget('('.repeat(1_000_000));
  });

  test("1 MB of '_' — rule validation must not backtrack through the nested \\s*", () => {
    inBudget('_'.repeat(1_000_000));
  });

  test("1 MB of '*' — rule validation must not backtrack through the nested \\s*", () => {
    inBudget('*'.repeat(1_000_000));
  });

  test("1 MB of '[' — a '[' with no ']' ahead must not rescan to end of line", () => {
    inBudget('['.repeat(1_000_000));
  });

  test("1 MB of '_*[' mixed — dense triggers with no closing bracket", () => {
    inBudget('_*['.repeat(333_333));
  });

  test("a '\\(' formula left open over 10,000 lines", () => {
    inBudget('\\(' + 'a_1^2 + b_2^2 = c_2^2\n'.repeat(10_000));
  });

  test('a 10,000-item list', () => {
    inBudget(Array.from({ length: 10_000 }, (_, i) => `- item ${i}`).join('\n'));
  });

  test("one line of 100,000 '+' — a bare marker must not recurse once per character", () => {
    inBudget('+'.repeat(100_000));
  });

  test("a URL followed by 10,000 ')'", () => {
    inBudget('https://example.com/x' + ')'.repeat(10_000));
  });

  test('block quotes nested 1,000 deep', () => {
    inBudget('> '.repeat(1_000) + 'deep');
  });
});
