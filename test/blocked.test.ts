import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asksYesNo, readBox } from '../shared/blocked.ts';

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

describe('a menu the cursor answers', () => {
  // Claude Code's folder trust, as the user pasted it: no numbers, the cursor on "No, exit".
  const trust = [
    ' Accessing workspace:',
    '',
    ' /home/tama/projects/internetbox.com/docs/request',
    '',
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');

  test('an unnumbered menu reads its rows, and each goes out from the cursor', () => {
    const box = readBox(trust);
    expect(box.menu.map(({ number, label, keys }) => ({ number, label, keys }))).toEqual([
      { number: '1', label: 'No, exit', keys: ['enter'] },
      { number: '2', label: 'Yes, I trust this folder', keys: ['down', 'enter'] },
    ]);
    expect(box.rest.join('\n')).not.toContain('Yes, I trust this folder');
  });

  test('enter is no Yes when the cursor row is not Yes', () => {
    // A Yes that sent enter picked "No, exit" and quit Claude.
    expect(asksYesNo({ ruleId: 'live_blocked_form', state: 'blocked', detection: trust, hintKeys: [] })).toBe(false);
    const moved = ['Do you want to proceed?', '  1. Yes', '❯ 2. No', 'Esc to cancel'].join('\n');
    expect(asksYesNo({ ruleId: 'bash_permission_prompt', state: 'blocked', detection: moved, hintKeys: [] })).toBe(false);
    const fresh = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'].join('\n');
    expect(asksYesNo({ ruleId: 'bash_permission_prompt', state: 'blocked', detection: fresh, hintKeys: [] })).toBe(true);
  });
});
