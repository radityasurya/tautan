/**
 * The herdr-style Pane list: Spaces over Agents, the way herdr's own sidebar draws them
 * (`[ui.sidebar.spaces]` and `[ui.sidebar.agents]`, `agent_panel_sort = "priority"`).
 * Pure helpers and the one preference, so a test can run them without a DOM.
 */
import type { StatePane, Status } from '../shared/types.ts';

// ---- preference ----

export type PaneList = 'tautan' | 'herdr';
const PANE_LIST = 'tautan.paneList';
const SHELLS = 'tautan.showShells';

const get = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const set = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch {}
};

/** Settings › Appearance › Pane list. tautan is the default. */
export const getPaneList = (): PaneList => (get(PANE_LIST) === 'herdr' ? 'herdr' : 'tautan');
export const setPaneList = (v: PaneList) => set(PANE_LIST, v);
export const getShowShells = () => get(SHELLS) === 'on';
export const setShowShells = (on: boolean) => set(SHELLS, on ? 'on' : 'off');

// ---- order ----

/** herdr's priority order: blocked, then done the user has not seen, working, the rest. */
export function urgency(p: StatePane, unseen: (p: StatePane) => boolean): number {
  if (p.status === 'blocked') return 0;
  if (p.status === 'done' && unseen(p)) return 1;
  if (p.status === 'working') return 2;
  return p.agent ? 3 : 4;
}

/** The Agents section: agent Panes (shells too when asked), most urgent first, newest change first within a rank. */
export function agentRows(panes: StatePane[], o: { shells: boolean; unseen: (p: StatePane) => boolean }): StatePane[] {
  return panes
    .filter((p) => o.shells || p.agent)
    .sort((a, b) => urgency(a, o.unseen) - urgency(b, o.unseen) || (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0));
}

/** A Space's rolled-up state: its most urgent Agent, or null when only shells run there. */
export function rollup(panes: StatePane[], unseen: (p: StatePane) => boolean): { status: Status; seen: boolean } | null {
  const top = agentRows(panes, { shells: false, unseen })[0];
  return top ? { status: top.status, seen: !unseen(top) } : null;
}
