/**
 * The herdr-style Pane list: Spaces over Agents, the way herdr's own sidebar draws them
 * (`[ui.sidebar.spaces]` and `[ui.sidebar.agents]`, `agent_panel_sort = "priority"`).
 * Pure helpers and the one preference, so a test can run them without a DOM.
 */
import { useSyncExternalStore } from 'react';
import type { StatePane, Status } from '../shared/types.ts';

// ---- preferences ----

export type PaneList = 'tautan' | 'herdr';
/** herdr's `agent_panel_sort`: one flat attention queue, or one group per Space. */
export type AgentGroup = 'priority' | 'spaces';
/** The order inside a group: herdr's urgency, the last Status change, or the title. */
export type AgentSort = 'urgency' | 'recent' | 'name';
const PANE_LIST = 'tautan.paneList';
const SHELLS = 'tautan.showShells';
const GROUP = 'tautan.agentGroup';
const SORT = 'tautan.agentSort';

// Every write here tells every reader, so the Home TopBar switch and Settings stay in step
// without a reload. `usePref(getX)` re-renders on any of them; the reads are cheap strings.
const bus = new EventTarget();
export const subscribePrefs = (fn: () => void) => {
  bus.addEventListener('change', fn);
  return () => bus.removeEventListener('change', fn);
};
const get = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
// ponytail: a blocked localStorage drops the choice silently; keep an in-memory copy if that bites.
const set = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch {}
  bus.dispatchEvent(new Event('change'));
};
/** A preference below, live: `usePref(getPaneList)`. */
export const usePref = <T,>(read: () => T): T => useSyncExternalStore(subscribePrefs, read);

/** Settings › Appearance › Pane list, and the switch in Home's TopBar. tautan is the default. */
export const getPaneList = (): PaneList => (get(PANE_LIST) === 'herdr' ? 'herdr' : 'tautan');
export const setPaneList = (v: PaneList) => set(PANE_LIST, v);
export const getShowShells = () => get(SHELLS) === 'on';
export const setShowShells = (on: boolean) => set(SHELLS, on ? 'on' : 'off');
export const getAgentGroup = (): AgentGroup => (get(GROUP) === 'spaces' ? 'spaces' : 'priority');
export const setAgentGroup = (v: AgentGroup) => set(GROUP, v);
export const getAgentSort = (): AgentSort => {
  const v = get(SORT);
  return v === 'recent' || v === 'name' ? v : 'urgency';
};
export const setAgentSort = (v: AgentSort) => set(SORT, v);

// ---- order ----

/** herdr's priority order: blocked, then done the user has not seen, working, the rest. */
export function urgency(p: StatePane, unseen: (p: StatePane) => boolean): number {
  if (p.status === 'blocked') return 0;
  if (p.status === 'done' && unseen(p)) return 1;
  if (p.status === 'working') return 2;
  return p.agent ? 3 : 4;
}

const recent = (a: StatePane, b: StatePane) => (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0);
const named = (a: StatePane, b: StatePane) =>
  a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || a.key.localeCompare(b.key);

/**
 * The Agents section: agent Panes (shells too when asked). `urgency`, the default, is most
 * urgent first and newest change first within a rank; `recent` is the newest change first;
 * `name` is by title.
 */
export function agentRows(
  panes: StatePane[],
  o: { shells: boolean; unseen: (p: StatePane) => boolean; sort?: AgentSort },
): StatePane[] {
  const by =
    o.sort === 'name' ? named
    : o.sort === 'recent' ? recent
    : (a: StatePane, b: StatePane) => urgency(a, o.unseen) - urgency(b, o.unseen) || recent(a, b);
  return panes.filter((p) => o.shells || p.agent).sort(by);
}

/**
 * Sorted rows cut into one group per Space, in the order of `spaces` (the Spaces section's
 * order), keeping each group's row order. Spaces without rows are left out; a row whose
 * Space is not listed is dropped, because the Spaces section does not show it either.
 */
export function bySpace<S extends { muxKey: string; id: string }>(rows: StatePane[], spaces: S[]): { space: S; rows: StatePane[] }[] {
  return spaces
    .map((space) => ({ space, rows: rows.filter((p) => p.muxKey === space.muxKey && p.workspaceId === space.id) }))
    .filter((g) => g.rows.length > 0);
}

/** A Space's rolled-up state: its most urgent Agent, or null when only shells run there. */
export function rollup(panes: StatePane[], unseen: (p: StatePane) => boolean): { status: Status; seen: boolean } | null {
  const top = agentRows(panes, { shells: false, unseen })[0];
  return top ? { status: top.status, seen: !unseen(top) } : null;
}
