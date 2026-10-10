import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBox } from '../shared/blocked.ts';

const rule = '─'.repeat(80);

describe('readBox', () => {
  test("reads Claude's question form: the question first, every numbered row, arrows to each", () => {
    const box = readBox(readFileSync(join(import.meta.dir, 'fixtures/claude-question.txt'), 'utf8'));
    expect(box.head).toStartWith('The landing card says');
    expect(box.rest).toEqual(['←  ☐ Ranking  ☐ Pricing  ✔ Submit  →', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
    expect(box.menu.map(option => [option.number, option.label, option.keys])).toEqual([
      ['1', 'Search filters', ['enter']],
      ['2', 'Keep smart ranking', ['down', 'enter']],
      ['3', 'Type something.', ['down', 'down', 'enter']],
      ['4', 'Chat about this', ['down', 'down', 'down', 'enter']], // past the menu's own rule
    ]);
    expect(box.menu[0]!.detail).toStartWith('"Find and compare items');
    expect(box.menu[1]!.detail).toBe('Keep the copy as given. The card then promises a feature that is out of scope for this release.');
    expect(box.menu[2]!.detail).toBeUndefined();
  });

  test('a permission box keeps its command in the excerpt and counts arrows from the cursor', () => {
    const box = readBox([
      'Earlier output', rule,
      ' Bash command', '', '   rm -rf dist', '   Clean the build', '',
      ' Do you want to proceed?',
      '   1. Yes',
      ' ❯ 2. Yes, and don’t ask again for rm commands',
      '   3. No, and tell Claude what to do differently (esc)', '',
      ' Esc to cancel · Tab to amend',
    ].join('\n'));
    expect(box.head).toBe('Bash command');
    expect(box.rest).toEqual(['rm -rf dist', 'Clean the build', 'Do you want to proceed?', 'Esc to cancel · Tab to amend']);
    expect(box.menu.map(option => option.keys)).toEqual([['up', 'enter'], ['enter'], ['down', 'enter']]);
  });

  test('a box without a numbered menu keeps every line and offers no menu', () => {
    const box = readBox([rule, 'Allow this edit?', 'esc to cancel · enter to confirm'].join('\n'));
    expect(box).toEqual({ head: 'Allow this edit?', rest: ['esc to cancel · enter to confirm'], menu: [] });
  });
});
