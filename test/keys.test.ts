import { expect, test } from 'bun:test';
import { capInput, modified, trayGroups, type Cap } from '../web/keys.ts';

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
  expect(claude[1]!.caps.map((c) => c.keys)).toEqual([['shift+tab'], ['esc', 'esc']]);
  expect(claude.at(-1)!.caps.some((c) => c.keys?.join() === 'shift+tab')).toBe(false);
});
