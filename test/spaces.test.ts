import { expect, test } from 'bun:test';
import { agentRows, rollup } from '../web/spaces.ts';
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
