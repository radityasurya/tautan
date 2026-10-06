import { describe, expect, test } from 'bun:test';
import { boxInner, classify } from '../shared/layout.ts';

const kinds = (text: string) => classify(text, 120).join(',');

describe('classify', () => {
  test('a Claude permission box: edges and rows are box chrome, the hint is prose', () => {
    const box = [
      '┌──────────────────────────────────────────┐',
      '│ Do you want to proceed?                  │',
      '│ ❯ 1. Yes                                 │',
      '│ 2. No, and tell Claude what to do        │',
      '└──────────────────────────────────────────┘',
      '',
      'esc to cancel · enter to confirm',
    ].join('\n');
    expect(kinds(box)).toBe('box-top,box-row,box-row,box-row,box-bottom,prose,prose');
  });

  test('the contract-test prompt shape: only the rule is chrome', () => {
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
    expect(kinds(prompt)).toBe('prose,prose,prose,prose,prose,prose,rule,prose');
  });

  test('column alignment is structure, two columns are not', () => {
    expect(kinds('name    status    time    note')).toBe('structure');
    expect(kinds('Mem:  8G   Swap:  2G')).toBe('structure'); // three gaps: aligned output
    expect(kinds('Mem:  8G')).toBe('prose');
    expect(kinds('a  b')).toBe('prose');
  });

  test('a long markdown table row is structure', () => {
    expect(classify('| tautan | the wide grid | phone-first | two panes | wrap |', 80)[0]).toBe('structure');
    // A short row still keeps its columns, so a header lines up with the long body rows.
    expect(classify('| a | b |', 80)[0]).toBe('structure');
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
    expect(kinds(inside)).toBe('box-top,box-row,prose,box-bottom');
  });

  test('empty lines are prose and the count always matches the lines', () => {
    const text = 'one\n\nthree';
    const result = classify(text);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe('prose');
  });

  // Claude Code draws its chrome at the desktop's width: 160 columns here.
  const W = 158;
  const row = (t: string) => `│ ${t}${' '.repeat(W - 2 - t.length)} │`;

  test('full-width rules around the input are rules, the prompt is prose', () => {
    const input = ['─'.repeat(159), '> ', '─'.repeat(159), '  ? for shortcuts'].join('\n');
    expect(classify(input, 160).join(',')).toBe('rule,prose,rule,prose');
    expect(kinds('  ━━━━━━━━   ')).toBe('rule');
    expect(kinds('──')).not.toBe('rule'); // two glyphs: a dash or an arrow, not a rule
  });

  test('a rounded box with a title and prose rows, at 160 columns', () => {
    const box = [
      `╭${'─'.repeat(W)}╮`,
      row('Bash command'),
      row(''),
      row('  pnpm exec tsc --noEmit -p . && bun test'),
      row("  2. Yes, and don't ask again for pnpm commands"),
      `╰${'─'.repeat(W)}╯`,
      `┌─ Permission required ${'─'.repeat(40)}┐`,
    ].join('\n');
    expect(classify(box, 160).join(',')).toBe('box-top,box-row,box-row,box-row,box-row,box-bottom,box-top');
  });

  test('a drawn table stays structure: inner separators, ┬ and ┼', () => {
    const grid = ['┌──────┬──────┐', '│ name │ size │', '├──────┼──────┤', '│ a.ts │ 2 kB │', '└──────┴──────┘'].join('\n');
    expect(kinds(grid)).toBe('structure,structure,structure,structure,structure');
  });

  test('a box around aligned columns keeps them', () => {
    expect(kinds('│ NAME    STATUS    AGE    NODE │')).toBe('structure');
  });

  test('a short markdown table: header, separator and rows all keep their columns', () => {
    const md = ['| File | Change |', '|------|--------|', '| a.ts | new |'].join('\n');
    expect(kinds(md)).toBe('structure,structure,structure');
  });

  test('boxInner drops borders and pads, keeps the indent and the title', () => {
    const r = row('  pnpm exec tsc');
    const [s, e] = boxInner(r, 'box-row');
    expect(r.slice(s, e)).toBe('  pnpm exec tsc');
    const empty = row('');
    const [s2, e2] = boxInner(empty, 'box-row');
    expect(e2 - s2).toBe(0);
    const top = `┌─ Permission required ${'─'.repeat(40)}┐`;
    const [s3, e3] = boxInner(top, 'box-top');
    expect(top.slice(s3, e3)).toBe('Permission required');
    const plain = `╰${'─'.repeat(W)}╯`;
    const [s4, e4] = boxInner(plain, 'box-bottom');
    expect(e4 - s4).toBe(0);
  });
});
