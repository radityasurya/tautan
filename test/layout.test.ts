import { describe, expect, test } from 'bun:test';
import { classify } from '../shared/layout.ts';

const kinds = (text: string) => classify(text, 120).join(',');

describe('classify', () => {
  test('a Claude permission box: borders are structure, words are prose', () => {
    const box = [
      '┌──────────────────────────────────────────┐',
      '│ Do you want to proceed?                  │',
      '│ ❯ 1. Yes                                 │',
      '│ 2. No, and tell Claude what to do        │',
      '└──────────────────────────────────────────┘',
      '',
      'esc to cancel · enter to confirm',
    ].join('\n');
    expect(kinds(box)).toBe('structure,structure,structure,structure,structure,prose,prose');
  });

  test('the contract-test prompt shape: only the rule is structure', () => {
    const prompt = [
      'Bash command',
      'echo tautan-blocked',
      'Do you want to proceed?',
      '❯ 1. Yes',
      "2. Yes, and don't ask again…",
      '3. No, and tell Claude what to do differently (esc)',
      '────────────────────────────────',
      'esc to cancel · enter to confirm',
    ].join('\n');
    expect(kinds(prompt)).toBe('prose,prose,prose,prose,prose,prose,structure,prose');
  });

  test('column alignment is structure, two columns are not', () => {
    expect(kinds('name    status    time    note')).toBe('structure');
    expect(kinds('Mem:  8G   Swap:  2G')).toBe('structure'); // three gaps: aligned output
    expect(kinds('Mem:  8G')).toBe('prose');
    expect(kinds('a  b')).toBe('prose');
  });

  test('a long markdown table row is structure', () => {
    expect(classify('| tautan | the wide grid | phone-first | two panes | wrap |', 80)[0]).toBe('structure');
    expect(classify('| a | b |', 80)[0]).toBe('prose'); // short: not worth pinning
  });

  test('prose with long words and single spaces stays prose', () => {
    expect(kinds('The prompt changed. Read it again before you answer.')).toBe('prose');
    expect(kinds('superlongidentifier_with_underscores and-dashes-here')).toBe('prose');
  });

  test('a git diff is prose: nothing to pin, lines reflow acceptably', () => {
    const diff = ['diff --git a/web/pane.tsx b/web/pane.tsx', '@@ -231,7 +231,7 @@', ' const wrap = wraps[kind];', '-  agent: localStorage.getItem(\'tautan.wrap.agent\') === \'on\','].join('\n');
    expect(kinds(diff)).toBe('prose,prose,prose,prose');
  });

  test('a box with prose inside it: the inside line carries no glyph and stays prose', () => {
    const inside = ['┌────┐', '│    │', 'Do you want to proceed?', '└────┘'].join('\n');
    expect(kinds(inside)).toBe('structure,structure,prose,structure');
  });

  test('empty lines are prose and the count always matches the lines', () => {
    const text = 'one\n\nthree';
    const result = classify(text);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe('prose');
  });
});
