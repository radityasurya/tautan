import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asksPrompt, readBox } from '../shared/blocked.ts';

// Captured from Claude Code 2.1.303 in a throwaway tmux at 160x48, writing and editing a file
// outside the project. A long preview fills the Screen: the box's top rule and `Edit file` are
// off it, and only the dashed rule over the question is left.
const read = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures/claude-2.1.303', `${name}.txt`), 'utf8');
// The Hub keys its push on the last 40 trimmed rows of the Screen (server/mux.ts).
const excerpt = (text: string) => text.split('\n').map(row => row.trim()).filter(Boolean).slice(-40).join('\n');

describe('readBox on Claude Code 2.1.303 file previews', () => {
  test.each([
    ['write-long', 'Do you want to create memo.md?'],
    ['edit-long', 'Do you want to make this edit to memo.md?'],
  ])('2.1.303: %s taller than the Screen heads with its question, not a preview line', (name, question) => {
    for (const text of [read(name), excerpt(read(name))]) {
      const box = readBox(text);
      expect(box.head).toBe(question);
      expect(box.rest[0]).toMatch(/^\d+ [ +-]?- memo line/); // the preview stays on the card
      expect(box.menu.map(option => option.label.slice(0, 20))).toEqual(['Yes', 'Yes, and switch to a', 'No']);
      expect(asksPrompt(box)).toBe(true);
    }
  });

  test('2.1.303: a preview that fits keeps its `Edit file` head', () => {
    const box = readBox(read('edit-short'));
    expect(box.head).toBe('Edit file');
    expect(box.rest[0]).toBe('../outside/memo.md');
    expect(box.menu.length).toBe(3);
  });

  test('2.1.303: a label Claude broke before a long path, short of the edge, stays one label', () => {
    // Row 2 ends at column 138 of 160: the 95-character path did not fit, so it went below.
    const option = readBox(read('edit-short')).menu[1]!;
    expect(option.label).toMatch(/always allow access to \/tmp\/\S+\/outside for this session \(shift\+tab\)$/);
    expect(option.detail).toBeUndefined();
  });
});
