import { expect, test } from 'bun:test';
import { capInput, directKey, modified, trayGroups, type Cap } from '../web/keys.ts';

const cap = (label: string) => trayGroups({ shell: true, claude: false, profileKeys: [] })
  .flatMap((group) => group.caps).find((c) => c.label === label) as Cap;

test('a named key goes by name, and the keys herdr has no name for go as xterm bytes', () => {
  expect(capInput(cap('▲'), null)).toEqual({ keys: ['up'] });
  expect(capInput(cap('home'), null)).toEqual({ raw: '\x1b[H' });
  expect(capInput(cap('pgdn'), null)).toEqual({ raw: '\x1b[6~' });
  expect(capInput(cap('del'), null)).toEqual({ raw: '\x1b[3~' });
});

test('an armed modifier folds into the sequence', () => {
  expect(capInput(cap('▶'), 'ctrl')).toEqual({ raw: '\x1b[1;5C' });
  expect(capInput(cap('◀'), 'alt')).toEqual({ raw: '\x1b[1;3D' });
  expect(capInput(cap('pgup'), 'ctrl')).toEqual({ raw: '\x1b[5;5~' });
  expect(capInput(cap('⌫'), 'alt')).toEqual({ raw: '\x1b\x7f' });
  // Nothing to fold into: the cap goes out as it is.
  expect(capInput(cap('^C'), 'alt')).toEqual({ keys: ['ctrl+c'] });
  expect(capInput(cap('⌫'), 'ctrl')).toEqual({ keys: ['backspace'] });
  expect(modified('ctrl', 'R')).toBe('ctrl+r');
});

test('groups follow the Pane: line editing for a shell, the App keys first after Control', () => {
  const shell = trayGroups({ shell: true, claude: false, profileKeys: ['esc', 'f1', 'f10'] });
  expect(shell.map((g) => g.label)).toEqual(['Control', 'App', 'Navigate', 'Edit']);
  expect(shell[0]!.caps[0]!.keys).toEqual(['ctrl+c']);
  expect(shell[1]!.caps.map((c) => c.label)).toEqual(['F1', 'F10']);
  const claude = trayGroups({ shell: false, claude: true, profileKeys: [] });
  expect(claude[0]!.caps.map((c) => c.label)).not.toContain('^W');
  expect(claude.map((g) => g.label)).toEqual(['Control', 'Claude', 'Menu', 'Navigate', 'Edit']);
  expect(claude[1]!.caps.slice(0, 2).map((c) => c.keys)).toEqual([['shift+tab'], ['esc', 'esc']]);
  expect(claude.at(-1)!.caps.some((c) => c.keys?.join() === 'shift+tab')).toBe(false);
  // Claude's alt chords go out as ESC and the letter, whatever modifier is armed
  const model = claude[1]!.caps.find((c) => c.hint === 'model')!;
  expect(capInput(model, 'ctrl')).toEqual({ raw: '\x1bp' });
  // pi aborts on esc, and its ^C only clears the editor
  const pi = trayGroups({ shell: false, claude: false, pi: true, profileKeys: [] });
  expect(pi[0]!.caps.map((c) => [c.label, c.hint])).toEqual([['esc', 'abort'], ['^C', 'clear'], ['^D', 'exit']]);
  expect(pi[1]!.label).toBe('pi');
  expect(capInput(pi[2]!.caps[0]!, null)).toEqual({ raw: '1' });
});

test('typing directly: named keys by name, the rest as xterm bytes, text and Cmd left alone', () => {
  const key = (key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {}) =>
    directKey({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
  expect(key('Enter')).toEqual({ keys: ['enter'] });
  expect(key('Backspace')).toEqual({ keys: ['backspace'] });
  expect(key('Tab', { shiftKey: true })).toEqual({ keys: ['shift+tab'] });
  expect(key('PageUp')).toEqual({ raw: '\x1b[5~' });
  expect(key('C', { ctrlKey: true })).toEqual({ keys: ['ctrl+c'] });
  expect(key('p', { altKey: true })).toEqual({ raw: '\x1bp' });
  expect(key('a')).toBeNull(); // text comes through beforeinput
  expect(key('v', { metaKey: true })).toBeNull(); // paste stays the browser's
});
