import { expect, test } from 'bun:test';
import { mergeOrder, moveWorkspace, orderWorkspaces } from '../web/order.ts';
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

test('moveWorkspace: one step, before a target, edges are no-ops, ids that left drop', () => {
  const all = [w('m', 'a'), w('m', 'b'), w('m', 'c')];
  expect(moveWorkspace(all, {}, all[1]!, { delta: -1 })).toEqual({ m: ['b', 'a', 'c'] });
  expect(moveWorkspace(all, {}, all[0]!, { delta: -1 })).toEqual({});
  expect(moveWorkspace(all, {}, all[2]!, { delta: 1 })).toEqual({});
  expect(moveWorkspace(all, { m: ['gone', 'a', 'b', 'c'] }, all[2]!, { before: 'a' })).toEqual({ m: ['c', 'a', 'b'] });
  expect(moveWorkspace(all, {}, w('other', 'z'), { delta: 1 })).toEqual({});
});
