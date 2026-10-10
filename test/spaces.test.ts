import { expect, test } from 'bun:test';
import {
  agentRows, bySpace, sortSpaces, getAgentSort, getPaneList, leavesMenu, rollup, setAgentSort, setPaneList, subscribePrefs, tildePath,
} from '../web/spaces.ts';
import type { StatePane, Status } from '../shared/types.ts';

const pane = (key: string, status: Status, o: Partial<StatePane> = {}): StatePane => ({
  key, muxKey: 'm', workspaceId: 'w', tabId: 't', id: key, title: key, status, revision: 1, seenRevision: 0, agent: 'claude', ...o,
});
const fresh = new Set(['done-new']);
const unseen = (p: StatePane) => fresh.has(p.key);

test('Agents sort blocked, unseen done, working, then the rest; shells hidden', () => {
  const panes = [
    pane('idle', 'idle'),
    pane('done-old', 'done'),
    pane('working', 'working'),
    pane('shell', 'unknown', { agent: undefined }),
    pane('done-new', 'done'),
    pane('blocked', 'blocked'),
  ];
  expect(agentRows(panes, { shells: false, unseen }).map((p) => p.key)).toEqual(['blocked', 'done-new', 'working', 'idle', 'done-old']);
  expect(agentRows(panes, { shells: true, unseen }).at(-1)?.key).toBe('shell');
});

test('newest change first within a rank', () => {
  const rows = agentRows([pane('a', 'working', { statusChangedAt: 1 }), pane('b', 'working', { statusChangedAt: 2 })], { shells: false, unseen });
  expect(rows.map((p) => p.key)).toEqual(['b', 'a']);
});

test('a Space rolls up to its most urgent Agent, or null with only shells', () => {
  expect(rollup([pane('working', 'working'), pane('done-new', 'done')], unseen)).toEqual({ status: 'done', seen: false });
  expect(rollup([pane('shell', 'idle', { agent: undefined })], unseen)).toBeNull();
});

test('sort by the last Status change or by title', () => {
  const panes = [
    pane('b', 'blocked', { title: 'zeta', statusChangedAt: 1 }),
    pane('w', 'working', { title: 'Alpha 10', statusChangedAt: 3 }),
    pane('i', 'idle', { title: 'alpha 9', statusChangedAt: 2 }),
  ];
  expect(agentRows(panes, { shells: false, unseen, sort: 'recent' }).map((p) => p.key)).toEqual(['w', 'i', 'b']);
  expect(agentRows(panes, { shells: false, unseen, sort: 'name' }).map((p) => p.key)).toEqual(['i', 'w', 'b']);
  expect(agentRows(panes, { shells: false, unseen }).map((p) => p.key)).toEqual(['b', 'w', 'i']);
});

test('group by Space in Spaces order, keep row order, drop empty Spaces', () => {
  const rows = [pane('x1', 'blocked', { workspaceId: 'x' }), pane('y1', 'working', { workspaceId: 'y' }), pane('x2', 'idle', { workspaceId: 'x' })];
  const spaces = [{ muxKey: 'm', id: 'y' }, { muxKey: 'm', id: 'empty' }, { muxKey: 'm', id: 'x' }];
  expect(bySpace(rows, spaces).map((g) => [g.space.id, g.rows.map((p) => p.key)])).toEqual([['y', ['y1']], ['x', ['x1', 'x2']]]);
});

test('preferences default, survive a bad value, and tell subscribers', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  expect(getPaneList()).toBe('tautan');
  store.set('tautan.agentSort', 'bogus');
  expect(getAgentSort()).toBe('urgency');
  setAgentSort('name');
  expect(getAgentSort()).toBe('name');
  let told = 0;
  const off = subscribePrefs(() => told++);
  setPaneList('herdr');
  expect(getPaneList()).toBe('herdr');
  off();
  setPaneList('tautan');
  expect(told).toBe(1);
});

test('a blocked localStorage keeps choices in memory and flags it once', async () => {
  const blocked = () => { throw new Error('SecurityError'); };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: blocked, setItem: blocked, removeItem: blocked };
  const { isStorageBlocked, resetStore, store } = await import('../web/store.tsx');
  expect(getAgentSort()).toBe('urgency');
  setAgentSort('name');
  expect(getAgentSort()).toBe('name');
  store.set('k', 'v');
  expect(store.get('k')).toBe('v');
  store.remove('k');
  expect(store.get('k')).toBeNull();
  expect(isStorageBlocked()).toBe(true);
  resetStore();
  expect(isStorageBlocked()).toBe(false);
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('Spaces sort: manual keeps the drag order; urgency, recent and name reorder', () => {
  const space = (label: string, all: StatePane[]) => ({ w: { label }, all });
  const list = [
    space('b-idle', [pane('i', 'idle', { statusChangedAt: 5 })]),
    space('a-blocked', [pane('x', 'blocked', { statusChangedAt: 1 })]),
    space('c-new', [pane('n', 'working', { statusChangedAt: 9 })]),
  ];
  const order = (sort: Parameters<typeof sortSpaces>[1]['sort']) => sortSpaces(list, { sort, unseen }).map((s) => s.w.label);
  expect(order('manual')).toEqual(['b-idle', 'a-blocked', 'c-new']);
  expect(order('urgency')).toEqual(['a-blocked', 'c-new', 'b-idle']);
  expect(order('recent')).toEqual(['c-new', 'b-idle', 'a-blocked']);
  expect(order('name')).toEqual(['a-blocked', 'b-idle', 'c-new']);
});

test('a view menu stays open when a click on a choice blurs to nothing, as Safari does', () => {
  const choice = {} as Node;
  const menu = { contains: (node: Node | null) => node === choice };
  // Safari never focuses a clicked button: the old `!contains(relatedTarget)` closed the menu
  // here, on mousedown, so the sort the click was for never ran.
  expect(leavesMenu(menu, null)).toBe(false);
  expect(leavesMenu(menu, choice)).toBe(false);
  expect(leavesMenu(menu, {} as Node)).toBe(true); // Tab moved focus past the menu
});

test('a Workspace path shortens its home to ~', () => {
  expect(tildePath('/home/ada/projects/tautan')).toBe('~/projects/tautan');
  expect(tildePath('/Users/ada')).toBe('~');
  expect(tildePath('/root/.config')).toBe('~/.config');
  expect(tildePath('/rootfs/x')).toBe('/rootfs/x');
  expect(tildePath('/mnt/user')).toBe('/mnt/user');
  expect(tildePath('~/srv/blog')).toBe('~/srv/blog');
});
