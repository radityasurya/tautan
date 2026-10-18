import { expect, test } from 'bun:test';
import { capInput, directKey, editableCaps, modified, moveRow, moveRowTo, parseKeyPrefs, toKeyPrefs, trayGroups, type Cap } from '../web/keys.ts';

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

test('typing directly: every modifier reaches the Pane in its xterm form', () => {
  const key = (key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'selected', boolean>> = {}) =>
    directKey({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
  // Arrows, Home, End: CSI 1;m — shift 2, alt 3, ctrl 5, ctrl+shift 6.
  expect(key('ArrowUp')).toEqual({ keys: ['up'] });
  expect(key('ArrowLeft', { ctrlKey: true })).toEqual({ raw: '\x1b[1;5D' });
  expect(key('ArrowRight', { altKey: true })).toEqual({ raw: '\x1b[1;3C' });
  expect(key('ArrowUp', { ctrlKey: true, shiftKey: true })).toEqual({ raw: '\x1b[1;6A' });
  expect(key('Home', { ctrlKey: true })).toEqual({ raw: '\x1b[1;5H' });
  expect(key('End', { shiftKey: true })).toEqual({ raw: '\x1b[1;2F' });
  // Insert, Delete, PageUp, PageDown: CSI n;m~.
  expect(key('Insert')).toEqual({ raw: '\x1b[2~' });
  expect(key('Delete', { ctrlKey: true })).toEqual({ raw: '\x1b[3;5~' });
  expect(key('PageUp', { shiftKey: true })).toEqual({ raw: '\x1b[5;2~' });
  // Function keys: by name plain, xterm with a modifier.
  expect(key('F1')).toEqual({ keys: ['f1'] });
  expect(key('F12')).toEqual({ keys: ['f12'] });
  expect(key('F1', { shiftKey: true })).toEqual({ raw: '\x1b[1;2P' });
  expect(key('F5', { ctrlKey: true })).toEqual({ raw: '\x1b[15;5~' });
  // Enter and Backspace with a modifier.
  expect(key('Enter', { shiftKey: true })).toEqual({ raw: '\x1b\r' });
  expect(key('Backspace', { ctrlKey: true })).toEqual({ raw: '\x08' });
  expect(key('Backspace', { altKey: true })).toEqual({ raw: '\x1b\x7f' });
  // Ctrl with a symbol is its control byte; Ctrl+Alt+letter is ESC and the control byte.
  expect(key(' ', { ctrlKey: true })).toEqual({ raw: '\x00' });
  expect(key('[', { ctrlKey: true })).toEqual({ raw: '\x1b' });
  expect(key('\\', { ctrlKey: true })).toEqual({ raw: '\x1c' });
  expect(key(']', { ctrlKey: true })).toEqual({ raw: '\x1d' });
  expect(key('/', { ctrlKey: true })).toEqual({ raw: '\x1f' });
  expect(key('x', { ctrlKey: true, altKey: true })).toEqual({ raw: '\x1b\x18' });
  expect(key('R', { ctrlKey: true, shiftKey: true })).toEqual({ keys: ['ctrl+r'] });
  // Copy and paste stay the browser's, as in VS Code's terminal; Ctrl+C over a selection copies.
  expect(key('c', { ctrlKey: true })).toEqual({ keys: ['ctrl+c'] });
  expect(key('c', { ctrlKey: true, selected: true })).toBeNull();
  expect(key('C', { ctrlKey: true, shiftKey: true })).toBeNull();
  expect(key('v', { ctrlKey: true })).toBeNull();
  expect(key('V', { ctrlKey: true, shiftKey: true })).toBeNull();
  // The browser keeps its zoom, and AltGr text (Ctrl+Alt on a symbol) types as text.
  expect(key('-', { ctrlKey: true })).toBeNull();
  expect(key('=', { ctrlKey: true })).toBeNull();
  expect(key('@', { ctrlKey: true, altKey: true })).toBeNull();
});

test('Edit keys: a drag drops a cap at the target slot, and the order survives a save', () => {
  expect(moveRowTo(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  expect(moveRowTo(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  const same = ['a', 'b'];
  expect(moveRowTo(same, 1, 1)).toBe(same);
  expect(moveRowTo(same, 0, 2)).toBe(same);
  expect(moveRow(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']); // ▼ is a one-place drag
  const groups = trayGroups({ shell: false, claude: true, profileKeys: [] });
  const rows = moveRowTo(editableCaps(groups, null), 5, 0);
  const saved = parseKeyPrefs(JSON.stringify(toKeyPrefs(rows)));
  expect(editableCaps(groups, saved).map((r) => r.cap.label)).toEqual(rows.map((r) => r.cap.label));
});
