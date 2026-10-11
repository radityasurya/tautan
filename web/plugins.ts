/**
 * herdr's plugin actions and Agent integrations, as the ⋯ menus and Settings › About list
 * them (Wave 21). Pure helpers, so a test runs them without a DOM.
 */
import type { Integration, PluginAction, StatePane } from '../shared/types.ts';

/** The Pane ⋯ menu lists `pane` and `tab` actions; the Workspace ⋯ menu lists `workspace` ones. */
export const actionsFor = (actions: PluginAction[], menu: 'pane' | 'workspace') =>
  actions.filter((a) => a.contexts.some((c) => (menu === 'pane' ? c === 'pane' || c === 'tab' : c === 'workspace')));

/** One group per plugin, headed by its display name; plugins and rows keep the Hub's order. */
export function byPlugin(actions: PluginAction[]): { pluginId: string; plugin: string; actions: PluginAction[] }[] {
  const groups = new Map<string, { pluginId: string; plugin: string; actions: PluginAction[] }>();
  for (const a of actions) {
    const group = groups.get(a.pluginId) ?? { pluginId: a.pluginId, plugin: a.plugin, actions: [] };
    group.actions.push(a);
    groups.set(a.pluginId, group);
  }
  return [...groups.values()];
}

/** What installs or updates one integration. herdr's own `command` field is the Agent's
 *  executable (`pi`, `claude`: what `available` looks for on PATH, probed on 0.9.3), so the
 *  line to copy is herdr's CLI with the target. */
export const installCommand = (i: Pick<Integration, 'target'>) => `herdr integration install ${i.target}`;

/** The Agents found on the Host first, then the rest; each half keeps the Hub's order. */
export const integrationOrder = (list: Integration[]) => [...list.filter((i) => i.available), ...list.filter((i) => !i.available)];

/** How long after an action's 204 a new Pane in its Workspace still opens. */
export const NEW_PANE_MS = 5_000;

/** The Pane keys a Workspace held when an action started, and when the watch ends. */
export interface PaneWatch { muxKey: string; workspaceId: string; before: string[]; until: number }

export const keysIn = (panes: StatePane[], muxKey: string, workspaceId: string) =>
  panes.filter((p) => p.muxKey === muxKey && p.workspaceId === workspaceId).map((p) => p.key);

/** The Pane that appeared in the watched Workspace, while the watch lasts. */
export function appeared(watch: PaneWatch, panes: StatePane[], now: number): string | undefined {
  if (now > watch.until) return undefined;
  return panes.find((p) => p.muxKey === watch.muxKey && p.workspaceId === watch.workspaceId && !watch.before.includes(p.key))?.key;
}
