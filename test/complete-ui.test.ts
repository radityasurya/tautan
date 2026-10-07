import { expect, test } from 'bun:test';
import { applyPick, tokenAt } from '../web/complete.tsx';
import { applyKeyPrefs, editableCaps, moveRow, parseKeyPrefs, toKeyPrefs, trayGroups } from '../web/keys.ts';

test('a command is a slash word at the very start; a path is not', () => {
  expect(tokenAt('/rev', 4)).toEqual({ kind: 'slash', q: 'rev', start: 0, end: 4 });
  expect(tokenAt('/', 1)).toEqual({ kind: 'slash', q: '', start: 0, end: 1 });
  expect(tokenAt('/rev now', 8)).toBeNull();
  expect(tokenAt('/home/me', 8)).toBeNull();
  expect(tokenAt('say /rev', 8)).toBeNull();
  expect(tokenAt('/rev', 2)?.q).toBe('rev'); // caret inside the word: the whole word
});

test('@ opens a file list after a space or the start, anywhere in the text', () => {
  expect(tokenAt('look at @src/ap', 15)).toEqual({ kind: 'file', q: 'src/ap', start: 8, end: 15 });
  expect(tokenAt('@a', 2)?.kind).toBe('file');
  expect(tokenAt('mail me@x.io', 12)).toBeNull();
});

test('/model followed by a space is the model card', () => {
  expect(tokenAt('/model ', 7)).toEqual({ kind: 'model', q: '', start: 7, end: 7 });
  expect(tokenAt('/model op', 9)).toEqual({ kind: 'model', q: 'op', start: 7, end: 9 });
  expect(tokenAt('/model', 6)?.kind).toBe('slash');
});

test('a pick replaces the token; a folder keeps the picker open and keeps the @', () => {
  const t = tokenAt('see @sr', 7)!;
  expect(applyPick('see @sr', t, { value: 'src/', label: 'src/', dir: true })).toEqual({ text: 'see @src/', caret: 9 });
  expect(applyPick('see @sr', t, { value: 'src/a.ts', label: 'a.ts' })).toEqual({ text: 'see @src/a.ts ', caret: 14 });
  expect(applyPick('@s', tokenAt('@s', 2)!, { value: 'src', label: 'src', dir: true }).text).toBe('@src/');
  const c = tokenAt('/re', 3)!;
  expect(applyPick('/re', c, { value: '/review', label: '/review' }).text).toBe('/review ');
  const mid = tokenAt('@a more', 2)!;
  expect(applyPick('@a more', mid, { value: 'a.ts', label: 'a.ts' }).text).toBe('@a.ts more');
});

test('the key bar: defaults until chosen, then one flat list in the chosen order', () => {
  const groups = trayGroups({ shell: false, claude: false, profileKeys: [] });
  expect(applyKeyPrefs(groups, null)).toBe(groups);
  let rows = editableCaps(groups, null);
  expect(rows.every((r) => r.on)).toBe(true);
  rows = moveRow(rows, 1, -1);
  rows = rows.map((r, i) => (i === 3 ? { ...r, on: false } : r));
  const prefs = toKeyPrefs(rows);
  const shown = applyKeyPrefs(groups, prefs)[0]!.caps.map((c) => c.label);
  expect(shown[0]).toBe('esc');
  expect(shown).not.toContain(rows[3]!.cap.label);
  expect(editableCaps(groups, prefs).map((r) => r.cap.label)).toEqual(rows.map((r) => r.cap.label));
  expect(moveRow([1, 2], 0, -1)).toEqual([1, 2]);
});

test('a saved choice that is malformed is the defaults', () => {
  expect(parseKeyPrefs(null)).toBeNull();
  expect(parseKeyPrefs('{nope')).toBeNull();
  expect(parseKeyPrefs('{"order":["a",1],"hidden":"x"}')).toEqual({ order: ['a'], hidden: [] });
});
