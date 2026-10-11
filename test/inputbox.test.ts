import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inputBox, stripInvisible } from '../shared/inputbox.ts';

const fixtures = join(import.meta.dir, 'fixtures/claude-2.1.296');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const rule = '─'.repeat(20);
// The suggestion-vs-draft fixture is two bare box lines without rules; wrap each in its own box.
const boxed = (line: string) => `${rule}\n${line}\n${rule}\n`;

describe('inputBox on plain fixtures', () => {
  // Without escapes the dim placeholder cannot be told from a draft, so an empty box reads as one.
  const cases: [string, 'empty' | 'draft' | 'bash'][] = [
    ['inputbox-empty.txt', 'draft'],
    ['inputbox-statusline-empty.txt', 'draft'],
    ['inputbox-draft-oneline.txt', 'draft'],
    ['inputbox-statusline-draft-oneline.txt', 'draft'],
    ['inputbox-draft-multiline.txt', 'draft'],
    ['inputbox-paste-placeholder.txt', 'draft'],
    ['inputbox-bash-mode.txt', 'bash'],
    ['inputbox-bash-mode-draft.txt', 'bash'],
  ];
  for (const [name, expected] of cases)
    test(`${name} → ${expected}`, () => expect(inputBox(fixture(name), false)).toBe(expected));
});

describe('inputBox on ANSI fixtures', () => {
  const cases: [string, 'empty' | 'draft' | 'bash'][] = [
    ['inputbox-empty.ansi.txt', 'empty'],
    ['inputbox-dim-after-turn.ansi.txt', 'empty'],
    ['inputbox-draft-oneline.ansi.txt', 'draft'],
    ['inputbox-draft-multiline.ansi.txt', 'draft'],
    ['inputbox-paste-placeholder.ansi.txt', 'draft'],
    ['inputbox-bash-mode.ansi.txt', 'bash'],
    ['inputbox-bash-mode-draft.ansi.txt', 'bash'],
  ];
  for (const [name, expected] of cases)
    test(`${name} → ${expected}`, () => expect(inputBox(fixture(name), true)).toBe(expected));
});

test('inputBox: dim suggestion is empty, plain text is a draft', () => {
  const [suggestion, draft] = fixture('inputbox-suggestion-vs-draft.ansi.txt').split('\n').filter(line => line.trim() !== '');
  expect(inputBox(boxed(suggestion!), true)).toBe('empty');
  expect(inputBox(boxed(draft!), true)).toBe('draft');
});

test('inputBox: a held message stays a draft', () => {
  for (const name of ['held-u200b.txt', 'held-u200c.txt', 'held-u200d.txt', 'held-u2060.txt', 'held-ufeff.txt'])
    expect(inputBox(fixture(name), false)).toBe('draft');
});

test('inputBox: the question form is not an input box', () => {
  expect(inputBox(fixture('question-typed-draft.txt'), false)).toBe(null);
});

test('inputBox: the last box on the screen wins', () => {
  const screen = `${rule}\n❯ first\n${rule}\n\n${rule}\n❯ second\n${rule}\n`;
  expect(inputBox(screen, false)).toBe('draft');
  const withMarker = screen.replace('❯ second', '! second');
  expect(inputBox(withMarker, false)).toBe('bash');
});

test('inputBox: no rules means no box', () => {
  expect(inputBox('❯ hello there', false)).toBe(null);
  expect(inputBox('', true)).toBe(null);
});

describe('stripInvisible', () => {
  test('removes the always-held characters everywhere', () => {
    expect(stripInvisible('a​b‌c⁠d﻿e')).toBe('abcde');
    expect(stripInvisible('hel​lo')).toBe('hello');
  });

  test('keeps ZWJ inside emoji sequences', () => {
    for (const emoji of ['\u{1F468}‍\u{1F469}‍\u{1F467}', '\u{1F469}\u{1F3FD}‍\u{1F4BB}', '\u{1F3F3}️‍\u{1F308}', '\u{1F441}️‍\u{1F5E8}️'])
      expect(stripInvisible(`a ${emoji} b`)).toBe(`a ${emoji} b`);
  });

  test('removes a ZWJ that joins no emoji', () => {
    expect(stripInvisible('a‍b')).toBe('ab');
    expect(stripInvisible('‍lead')).toBe('lead');
    expect(stripInvisible('trail‍')).toBe('trail');
    expect(stripInvisible('\u{1F916}‍x')).toBe('\u{1F916}x');
  });
});
