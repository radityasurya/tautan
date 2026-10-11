import { expect, test } from 'bun:test';
import { actionsFor, appeared, byPlugin, installCommand, integrationOrder, keysIn, NEW_PANE_MS, type PaneWatch } from '../web/plugins.ts';
import type { Integration, PluginAction, StatePane } from '../shared/types.ts';

const action = (pluginId: string, actionId: string, contexts: PluginAction['contexts']): PluginAction =>
  ({ pluginId, plugin: pluginId.toUpperCase(), actionId, title: actionId, contexts });
const ACTIONS = [
  action('a', 'mark', ['pane']),
  action('a', 'layout', ['tab']),
  action('b', 'greet', ['workspace']),
  action('a', 'both', ['pane', 'workspace']),
];

test('actionsFor: the Pane menu takes pane and tab actions, the Workspace menu workspace ones', () => {
  expect(actionsFor(ACTIONS, 'pane').map((a) => a.actionId)).toEqual(['mark', 'layout', 'both']);
  expect(actionsFor(ACTIONS, 'workspace').map((a) => a.actionId)).toEqual(['greet', 'both']);
  expect(actionsFor([], 'pane')).toEqual([]);
});

test('byPlugin: one group per plugin id under its name, in the order the Hub listed them', () => {
  const groups = byPlugin([...ACTIONS, action('c', 'x', ['pane']), { ...action('c', 'y', ['pane']), plugin: 'C' }]);
  expect(groups.map((g) => [g.pluginId, g.plugin, g.actions.map((a) => a.actionId)])).toEqual([
    ['a', 'A', ['mark', 'layout', 'both']],
    ['b', 'B', ['greet']],
    ['c', 'C', ['x', 'y']],
  ]);
});

test('integrationOrder: Agents found on the Host first, each half in the Hub order; installCommand', () => {
  const i = (target: string, available: boolean): Integration => ({ target, label: target, command: `install ${target}`, available, state: 'current' });
  const list = [i('crush', false), i('claude', true), i('pi', false), i('codex', true)];
  expect(integrationOrder(list).map((x) => x.target)).toEqual(['claude', 'codex', 'crush', 'pi']);
  expect(list[0]!.target).toBe('crush'); // the input is left as it was
  // herdr's `command` is the Agent's executable; the line to copy is herdr's own installer.
  expect(installCommand(i('codex', true))).toBe('herdr integration install codex');
});

test('appeared: a Pane new to the watched Workspace opens within NEW_PANE_MS, nothing else does', () => {
  const pane = (key: string, workspaceId = 'w1', muxKey = 'h/m'): StatePane =>
    ({ key, muxKey, workspaceId, tabId: 't', id: key, title: key, status: 'idle', revision: 0, seenRevision: 0 });
  const start = [pane('h/m/p1'), pane('h/m/p2'), pane('h/m/p9', 'w2')];
  const watch: PaneWatch = { muxKey: 'h/m', workspaceId: 'w1', before: keysIn(start, 'h/m', 'w1'), until: 1_000 + NEW_PANE_MS };
  expect(watch.before).toEqual(['h/m/p1', 'h/m/p2']);
  expect(appeared(watch, start, 1_000)).toBeUndefined();
  // A Pane in another Workspace, or on another Mux with the same Workspace id, is not ours.
  expect(appeared(watch, [...start, pane('h/m/p3', 'w2'), pane('x/m/p4', 'w1', 'x/m')], 2_000)).toBeUndefined();
  const grown = [...start, pane('h/m/p5')];
  expect(appeared(watch, grown, 1_000 + NEW_PANE_MS)).toBe('h/m/p5');
  expect(appeared(watch, grown, 1_001 + NEW_PANE_MS)).toBeUndefined(); // too late
});
