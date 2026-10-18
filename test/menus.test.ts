import { expect, test } from 'bun:test';
import { duplicateLabel, paneMenuItems, tabMenuItems, type PaneMenuActions, type TabMenuActions } from '../web/menus.ts';
import type { StatePane } from '../shared/types.ts';

const pane = (key: string, more: Partial<StatePane> = {}): StatePane => ({
  key, muxKey: 'h/m', workspaceId: 'w1', tabId: 't1', id: key, title: key, status: 'idle', revision: 1, seenRevision: 1, ...more,
});
const calls: string[] = [];
const tabAct: TabMenuActions = {
  openPane: (k) => calls.push(`open ${k}`), newTab: () => calls.push('new'), duplicate: () => calls.push('duplicate'),
  rename: () => calls.push('rename'), move: (by) => calls.push(`move ${by}`), close: () => calls.push('close'), closeOthers: () => calls.push('others'),
};
const paneAct: PaneMenuActions = {
  split: (d) => calls.push(`split ${d}`), duplicate: () => calls.push('duplicate'), zoom: (on) => calls.push(`zoom ${on}`),
  rename: () => calls.push('rename'), renameAgent: () => calls.push('agent'), copyPath: () => calls.push('copy'), close: () => calls.push('close'),
};
const labels = (items: { label: string }[]) => items.map((i) => i.label);

test('Tab menu, herdr: every action, the closes last; a split Tab lists its Panes first', () => {
  const one = tabMenuItems({ panes: [pane('a')], index: 1, count: 3 }, { write: true, busy: false, newTabHint: '⌘T' }, tabAct);
  expect(labels(one)).toEqual(['New Tab', 'Duplicate Tab', 'Rename Tab…', 'Move left', 'Move right', 'Close Tab', 'Close other Tabs']);
  expect(one[0]!.hint).toBe('⌘T');
  expect(one.filter((i) => i.danger).map((i) => i.label)).toEqual(['Close Tab', 'Close other Tabs']);
  const split = tabMenuItems({ panes: [pane('a'), pane('b', { agent: 'claude', status: 'working' })], index: 0, count: 1 }, { write: true, busy: false }, tabAct);
  expect(labels(split)).toEqual(['a', 'b', 'New Tab', 'Duplicate Tab', 'Rename Tab…', 'Close Tab']); // one Tab: no Move, no Close other Tabs
  expect(split[1]).toMatchObject({ group: 'Panes', sub: 'claude · working' });
  calls.length = 0;
  split[1]!.onClick!();
  one.find((i) => i.label === 'Move right')!.onClick!();
  expect(calls).toEqual(['open b', 'move 1']);
});

test('Tab menu, tmux: only the moves; the ends and a write in flight disable them', () => {
  expect(labels(tabMenuItems({ panes: [pane('a')], index: 0, count: 1 }, { write: false, busy: false }, tabAct))).toEqual([]);
  const first = tabMenuItems({ panes: [pane('a')], index: 0, count: 2 }, { write: false, busy: false }, tabAct);
  expect(first.map((i) => [i.label, !!i.disabled])).toEqual([['Move left', true], ['Move right', false]]);
  const busy = tabMenuItems({ panes: [pane('a')], index: 1, count: 3 }, { write: true, busy: true }, tabAct);
  expect(busy.filter((i) => i.disabled).map((i) => i.label)).toEqual(['Duplicate Tab', 'Move left', 'Move right']);
});

test('Pane menu: layout, duplicate, zoom, renames, copy, close; a zoomed Tab offers Unzoom and no edits', () => {
  const agent = pane('a', { agent: 'claude', agentName: 'Ada', cwd: '/r' });
  expect(labels(paneMenuItems(agent, { write: true, busy: false, split: true, zoomed: false }, paneAct))).toEqual([
    'Split right', 'Split down', 'Duplicate Pane', 'Zoom Pane', 'Rename Pane…', 'Rename Agent…', 'Copy path', 'Close Pane',
  ]);
  const zoomed = paneMenuItems(agent, { write: true, busy: false, split: true, zoomed: true }, paneAct);
  expect(labels(zoomed)).toEqual(['Unzoom', 'Rename Pane…', 'Rename Agent…', 'Copy path', 'Close Pane']);
  calls.length = 0;
  zoomed[0]!.onClick!();
  expect(calls).toEqual(['zoom false']);
  // A lone shell with no cwd yet: no Zoom, no Rename Agent, no Copy path.
  expect(labels(paneMenuItems(pane('s'), { write: true, busy: true, split: false, zoomed: false }, paneAct))).toEqual([
    'Split right', 'Split down', 'Duplicate Pane', 'Rename Pane…', 'Close Pane',
  ]);
});

test('Pane menu, tmux: layout and zoom only, and a tmux Agent Pane has no duplicate', () => {
  const can = { write: false, busy: false, split: true, zoomed: false };
  expect(labels(paneMenuItems(pane('s', { cwd: '/r' }), can, paneAct))).toEqual(['Split right', 'Split down', 'Duplicate Pane', 'Zoom Pane', 'Copy path']);
  expect(labels(paneMenuItems(pane('c', { agent: 'claude' }), can, paneAct))).toEqual(['Split right', 'Split down', 'Zoom Pane']);
});

test('duplicateLabel keeps a name the user gave, not herdr\'s number or the Tab id', () => {
  expect(duplicateLabel({ id: 'w1:t2', label: 'api' })).toBe('api');
  expect(duplicateLabel({ id: 'w1:t2', label: '2' })).toBeUndefined();
  expect(duplicateLabel({ id: 'w1:t2', label: 'w1:t2' })).toBeUndefined();
});
