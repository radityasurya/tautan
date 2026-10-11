import { expect, test } from 'bun:test';
import { dropMuxOrders, mergeOrder, moveWorkspace, muxOrders, orderWorkspaces, spliceIndex } from '../web/order.ts';
import type { StateWorkspace } from '../shared/types.ts';

const w = (muxKey: string, id: string): StateWorkspace => ({ key: `${muxKey}/${id}`, muxKey, id, label: id });
const ids = (l: StateWorkspace[]) => l.map((x) => `${x.muxKey}:${x.id}`);

test('mergeOrder: stored first, unknown at their snapshot position after, gone dropped', () => {
  expect(mergeOrder(['c', 'a', 'x'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  expect(mergeOrder(undefined, ['a', 'b'])).toEqual(['a', 'b']);
  expect(mergeOrder(['a', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
});

test('orderWorkspaces: orders per Mux and keeps the Mux slots', () => {
  const all = [w('h/1', 'a'), w('h/2', 'x'), w('h/1', 'b'), w('h/2', 'y')];
  const out = orderWorkspaces(all, { 'h/1': ['b', 'a'], 'h/2': ['y'] });
  expect(ids(out)).toEqual(['h/1:b', 'h/2:y', 'h/1:a', 'h/2:x']);
});

test('moveWorkspace: to a slot, edges and its own slot are no-ops, ids that left drop', () => {
  const all = [w('m', 'a'), w('m', 'b'), w('m', 'c')];
  expect(moveWorkspace(all, {}, all[1]!, 0)).toEqual({ m: ['b', 'a', 'c'] });
  expect(moveWorkspace(all, {}, all[0]!, 2)).toEqual({ m: ['b', 'c', 'a'] });
  expect(moveWorkspace(all, {}, all[0]!, -1)).toEqual({});
  expect(moveWorkspace(all, {}, all[2]!, 3)).toEqual({});
  expect(moveWorkspace(all, {}, all[1]!, 1)).toEqual({});
  expect(moveWorkspace(all, { m: ['gone', 'a', 'b', 'c'] }, all[2]!, 0)).toEqual({ m: ['c', 'a', 'b'] });
  expect(moveWorkspace(all, {}, w('other', 'z'), 0)).toEqual({});
});

/** The Hub's splice model (ADR 0009), to check spliceIndex against what herdr does. */
const splice = (ids: string[], from: number, index: number) => {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(index > from ? index - 1 : index, 0, id!);
  return next;
};

test('spliceIndex: Move up is from − 1, Move down from + 2, a drop on the last appends', () => {
  expect(spliceIndex(2, 1)).toBe(1); // Move up
  expect(spliceIndex(2, 3)).toBe(4); // Move down
  expect(spliceIndex(3, 0)).toBe(0); // drop on the first
  expect(spliceIndex(1, 5)).toBe(6); // drop on the last of six: the count
  // Every from → to lands where it should under the Hub's splice model.
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (let from = 0; from < ids.length; from++)
    for (let to = 0; to < ids.length; to++) {
      if (to === from) continue;
      expect(splice(ids, from, spliceIndex(from, to)).indexOf(ids[from]!)).toBe(to);
    }
});

test('muxOrders: a herdr Workspace moves through the Hub, a tmux one stays on this device', () => {
  expect(muxOrders('herdr')).toBe(true);
  expect(muxOrders('tmux')).toBe(false);
  expect(muxOrders(undefined)).toBe(false);
});

test('dropMuxOrders: herdr entries go, tmux and unseen Muxes stay, nothing to drop is the same object', () => {
  const order = { 'h/herdr': ['b', 'a'], 'h/tmux': ['y', 'x'], 'far/herdr': ['q'] };
  const muxes = [{ key: 'h/herdr', kind: 'herdr' as const }, { key: 'h/tmux', kind: 'tmux' as const }];
  const next = dropMuxOrders(order, muxes);
  expect(next).toEqual({ 'h/tmux': ['y', 'x'], 'far/herdr': ['q'] });
  expect(order['h/herdr']).toEqual(['b', 'a']); // the input is left alone
  expect(dropMuxOrders(next, muxes)).toBe(next);
  // With its entry gone, a herdr Mux lists its Workspaces in the snapshot's order.
  const all = [w('h/herdr', 'a'), w('h/herdr', 'b')];
  expect(ids(orderWorkspaces(all, next))).toEqual(['h/herdr:a', 'h/herdr:b']);
});
