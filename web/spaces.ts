/**
 * The herdr-style Pane list: Spaces over Agents, the way herdr's own sidebar draws them
 * (`[ui.sidebar.spaces]` and `[ui.sidebar.agents]`, `agent_panel_sort = "priority"`).
 * Pure helpers and the one preference, so a test can run them without a DOM.
 */
import { useSyncExternalStore } from 'react';
import { store } from './store.tsx';
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
const get = store.get;
const set = (key: string, value: string) => {
  store.set(key, value);
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

/** The Spaces section's order: this device's drag order, or the Agents sorts by Space. */
export type SpaceSort = 'manual' | AgentSort;
const SPACE_SORT = 'tautan.spaceSort';
const SPACE_AGENTS = 'tautan.spaceAgentsOnly';
export const getSpaceSort = (): SpaceSort => {
  const v = get(SPACE_SORT);
  return v === 'urgency' || v === 'recent' || v === 'name' ? v : 'manual';
};
export const setSpaceSort = (v: SpaceSort) => set(SPACE_SORT, v);
/** Hide Spaces where no Agent runs (only shells, or empty). */
export const getSpaceAgentsOnly = () => get(SPACE_AGENTS) === 'on';
export const setSpaceAgentsOnly = (on: boolean) => set(SPACE_AGENTS, on ? 'on' : 'off');

/**
 * Does a blur leave a view menu? Only when focus lands outside it. Safari, on the Mac and on
 * iOS, never focuses a clicked button, so a click on a choice blurs to `null`: closing then
 * unmounted the menu on mousedown and the click never landed. A tap outside closes it through
 * `pointerdown`, and Tab out of it still lands somewhere.
 */
export const leavesMenu = (menu: { contains(node: Node | null): boolean }, next: EventTarget | null) =>
  !!next && !menu.contains(next as Node);

/** `/home/ada/x`, `/Users/ada/x` and `/root/x` → `~/x`: a Workspace path the way its owner says it. */
// ponytail: State carries no Host home, so the usual homes are matched by shape and one
// elsewhere stays absolute. Send each Host's home in State if that ever reads wrong.
export const tildePath = (path: string) => path.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/, '~');

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

/**
 * Spaces in the Spaces section's order. `manual` keeps the given (drag) order; `urgency` puts
 * the Space whose most urgent Agent needs you first; `recent` the Space with the newest
 * Status change first; `name` by label. Ties keep the given order (sort is stable).
 */
export function sortSpaces<T extends { w: { label: string }; all: StatePane[] }>(
  spaces: T[],
  o: { sort: SpaceSort; unseen: (p: StatePane) => boolean },
): T[] {
  if (o.sort === 'manual') return spaces;
  const newest = (t: T) => Math.max(0, ...t.all.map((p) => p.statusChangedAt ?? 0));
  const rank = (t: T) => Math.min(5, ...t.all.map((p) => urgency(p, o.unseen)));
  const by =
    o.sort === 'name' ? (a: T, b: T) => a.w.label.localeCompare(b.w.label, undefined, { numeric: true, sensitivity: 'base' })
    : o.sort === 'recent' ? (a: T, b: T) => newest(b) - newest(a)
    : (a: T, b: T) => rank(a) - rank(b) || newest(b) - newest(a);
  return [...spaces].sort(by);
}
