import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asksPrompt, readBox } from '../shared/blocked.ts';

// Captured from Claude Code 2.1.302 in a throwaway herdr, with a status line that prints
// `[PONYTAIL]` under the input box (a second footer line).
const read = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures/claude-2.1.302', `${name}.txt`), 'utf8');

describe('readBox on Claude Code 2.1.302 with a status line', () => {
  test('2.1.302: the idle input box and its footer are no prompt', () => {
    // A stale blocked Status over this Screen showed a card asking "[PONYTAIL]".
    const box = readBox(read('idle-statusline'));
    expect(box.head).not.toBe('[PONYTAIL]');
    expect(asksPrompt(box)).toBe(false);
  });

  test('2.1.302: a permission box reads as before', () => {
    const box = readBox(read('approval-statusline'));
    expect(box.head).toBe('Bash command');
    expect(box.menu.map(option => option.number)).toEqual(['1', '2', '3', '4']);
    expect(asksPrompt(box)).toBe(true);
  });

  test('2.1.302: a footer drawn under a prompt is skipped, not read as the box', () => {
    const rule = '─'.repeat(100);
    const box = readBox(`${read('approval-statusline').trimEnd()}\n${rule}\n  [PONYTAIL]\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`);
    expect(box.head).toBe('Bash command');
    expect(box.menu.length).toBe(4);
  });
});
