import { expect, test } from 'bun:test';
import { paneDrop } from '../web/pane-drag.ts';
import type { StatePane, StateTab, StateWorkspace } from '../shared/types.ts';

const pane = (id: string, more: Partial<StatePane> = {}): StatePane => ({
  key: `h/m/${id}`, muxKey: 'h/m', workspaceId: 'w1', tabId: 'w1:t1', id, title: id, status: 'idle', revision: 1, seenRevision: 1, ...more,
});
const tab = (id: string, workspaceId = 'w1', muxKey = 'h/m'): StateTab => ({ key: `${muxKey}/${id}`, muxKey, workspaceId, id, label: id });
const space = (id: string, muxKey = 'h/m'): StateWorkspace => ({ key: `${muxKey}/${id}`, muxKey, id, label: id });

// w1: t1 split into a and b, t2 holding c; w2: t1 holding d; another Mux holds e.
const a = pane('w1:p1');
const b = pane('w1:p2');
const c = pane('w1:p3', { tabId: 'w1:t2' });
const d = pane('w2:p1', { workspaceId: 'w2', tabId: 'w2:t1' });
const e = pane('w1:p1', { key: 'h/other/w1:p1', muxKey: 'h/other' });
const panes = [a, b, c, d, e];
const t1 = tab('w1:t1');
const t2 = tab('w1:t2');

test('a cell: two cells of one Tab swap; a Pane from another Tab joins the cell\'s Tab; itself and another Mux refuse', () => {
  expect(paneDrop(a, { kind: 'cell', pane: b, tab: t1 }, panes)).toEqual({ verb: 'Swap', label: 'Swap', target: b.key });
  expect(paneDrop(c, { kind: 'cell', pane: b, tab: t1 }, panes)).toEqual({ verb: 'Move', label: 'Move here', to: { tab: t1.key, split: 'right' } });
  expect(paneDrop(d, { kind: 'cell', pane: b, tab: t1 }, panes)?.verb).toBe('Move'); // across Workspaces too
  expect(paneDrop(a, { kind: 'cell', pane: a, tab: t1 }, panes)).toBeNull();
  expect(paneDrop(e, { kind: 'cell', pane: b, tab: t1 }, panes)).toBeNull();
  expect(paneDrop(c, { kind: 'cell', pane: b }, panes)).toBeNull(); // no Tab record to move into
});

test('a Tab: any other Tab on the Mux takes the Pane, split right; its own Tab and another Mux\'s refuse', () => {
  expect(paneDrop(a, { kind: 'tab', tab: t2 }, panes)).toEqual({ verb: 'Move', label: 'Move here', to: { tab: t2.key, split: 'right' } });
  expect(paneDrop(d, { kind: 'tab', tab: t2 }, panes)?.label).toBe('Move here');
  expect(paneDrop(a, { kind: 'tab', tab: t1 }, panes)).toBeNull();
  expect(paneDrop(c, { kind: 'tab', tab: t2 }, panes)).toBeNull();
  expect(paneDrop(a, { kind: 'tab', tab: tab('w1:t2', 'w1', 'h/other') }, panes)).toBeNull();
});

test('the +: a Pane of this Workspace that shares its Tab moves to a new Tab; a lone Pane or another Workspace refuses', () => {
  const plus = { kind: 'newTab' as const, muxKey: 'h/m', workspaceId: 'w1' };
  expect(paneDrop(a, plus, panes)).toEqual({ verb: 'Move', label: 'New Tab', to: { newTab: true } });
  expect(paneDrop(c, plus, panes)).toBeNull(); // alone in t2: it is a Tab of its own already
  expect(paneDrop(d, plus, panes)).toBeNull(); // the Mux would open the Tab in w2, not here
  expect(paneDrop(e, plus, panes)).toBeNull();
});

test('a Space: another Space on the Mux takes the Pane into its first Tab; its own Space, a Space without Tabs and another Mux refuse', () => {
  const w2t1 = tab('w2:t1', 'w2');
  expect(paneDrop(a, { kind: 'space', space: space('w2'), tab: w2t1 }, panes)).toEqual({ verb: 'Move', label: 'Move here', to: { tab: w2t1.key, split: 'right' } });
  expect(paneDrop(c, { kind: 'space', space: space('w1'), tab: t1 }, panes)).toBeNull(); // already in w1, even from another Tab
  expect(paneDrop(a, { kind: 'space', space: space('w2') }, panes)).toBeNull();
  expect(paneDrop(e, { kind: 'space', space: space('w2'), tab: w2t1 }, panes)).toBeNull();
});
