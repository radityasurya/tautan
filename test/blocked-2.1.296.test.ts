import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBox } from '../shared/blocked.ts';

// Fixtures captured from Claude Code 2.1.296 in a throwaway tmux (lane 24.2). The folder
// name carries the version; each test names it too.
const read = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures/claude-2.1.296', `${name}.txt`), 'utf8');

describe('readBox on Claude Code 2.1.296', () => {
  test("2.1.296: cursor on the don't-ask-again option, footer collapses to Esc alone", () => {
    const box = readBox(read('approval-dont-ask-again'));
    expect(box.head).toBe('Bash command');
    expect(box.rest).toEqual(['List /etc directory contents', 'ls -la /etc', 'Do you want to proceed?', 'Esc to cancel']);
    expect(box.menu.map(option => [option.number, option.label])).toEqual([
      ['1', 'Yes'],
      ['2', 'Yes, allow reading from /etc from this project'],
      ['3', 'Yes, and switch to auto mode · auto mode handles these prompts for you'],
      ['4', 'No'],
    ]);
    expect(box.menu[1]!.keys).toEqual(['enter']); // the cursor sits on option 2
    expect(box.menu[1]!.detail).toBeUndefined();
  });

  test('2.1.296: background shell and agent running, and the footer adds no chord for them', () => {
    const box = readBox(read('approval-background-agents'));
    expect(box.head).toBe('Bash command');
    // 2.1.296 keeps the plain footer while background work runs — the chord the wave brief
    // expected does not exist in this version. The fixture pins that.
    expect(box.rest).toContain('Esc to cancel · Tab to amend');
    expect(box.menu.map(option => option.number)).toEqual(['1', '2', '3', '4']);
    expect(box.menu[0]!.keys).toEqual(['enter']); // the cursor sits on option 1
  });

  test('2.1.296: a long command scrolls the title off, and a wrapped option label stays one label', () => {
    const box = readBox(read('approval-long-command'));
    // The title is gone from the screen; the card heads with the first line still visible.
    expect(box.head).toBe('line 31 of the ping-pong tournament draw');
    expect(box.rest).toContain('Do you want to proceed?');
    expect(box.menu[1]!.label).toBe(
      'Yes, and always allow access to /tmp/claude-1000/-home-user-projects-taut/ef720fc0-f056-44b2-8f69-5de99aef8a0d/scratchpad/24.2/work from this project',
    );
    expect(box.menu[1]!.detail).toBeUndefined(); // the wrap is not a description
    expect(box.menu.map(option => option.number)).toEqual(['1', '2', '3', '4']);
  });

  test('2.1.296: a description under the longest row on screen stays a detail', () => {
    // Built inline: the option row is the longest line of the detection, shorter than the
    // rule. Measuring the wrap edge by the longest line glues the description onto the label.
    const box = readBox([
      '─'.repeat(80),
      ' Which setting?',
      '  1. No',
      '  2. Yes, and allow access to /tmp/scratchpad/24.2/work f',
      '     Run it only this one time.',
      '  3. Maybe',
    ].join('\n'));
    expect(box.menu[1]!.label).toBe('Yes, and allow access to /tmp/scratchpad/24.2/work f');
    expect(box.menu[1]!.detail).toBe('Run it only this one time.');
  });

  test('2.1.296: a row wrapped at the rule edge keeps its continuation in the label', () => {
    // Built inline: a 100-column rule, a question line as long as the screen gets, and a row
    // one column short of it — within the allowance a wrap leaves. The continuation is a wrap
    // of the label even though a line on screen is longer than the row.
    const question = 'Which setting? ' + 'long '.repeat(17); // 100 columns
    const label = 'Yes, and allow access to /tmp/scratchpad/24.2/work' + 'd'.repeat(44); // 94
    const box = readBox([
      '─'.repeat(100),
      question,
      '  1. No',
      `  2. ${label}`,
      '     from this project only',
      '  3. Maybe',
    ].join('\n'));
    expect(box.menu[1]!.label).toBe(`${label} from this project only`);
    expect(box.menu[1]!.detail).toBeUndefined();
  });

  test('2.1.296: a typed draft replaces the Type something row the cursor sits on', () => {
    const box = readBox(read('question-typed-draft'));
    expect(box.head).toBe('☐ Ship date');
    expect(box.rest[0]).toBe('When do you want to ship?');
    expect(box.menu.map(option => [option.number, option.label, option.keys])).toEqual([
      ['1', 'Today', ['up', 'up', 'up', 'enter']],
      ['2', 'Next week', ['up', 'up', 'enter']],
      ['3', 'Never', ['up', 'enter']],
      ['4', 'maybe friday', ['enter']], // the draft, on the row the cursor sits on
      ['5', 'Chat about this', ['down', 'enter']], // past the menu's own rule
    ]);
    expect(box.menu[0]!.detail).toBe('Ship today.');
    expect(box.menu[3]!.detail).toBeUndefined();
  });
});
