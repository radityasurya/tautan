/**
 * The Workspace and Tab order (ADR 0009). herdr keeps its own order: tautan lists its
 * Workspaces and Tabs as the snapshot does and asks the Hub to move them. tmux sessions have
 * no order, so a tmux Workspace keeps this device's own (ADR 0008): one localStorage key holds
 * `{ [muxKey]: [workspaceId, …] }`. Pure helpers first, then the storage, so a test can run the
 * order without a DOM.
 */
import type { StateMux, StateWorkspace } from '../shared/types.ts';
import { store } from './store.tsx';

export type WorkspaceOrder = Record<string, string[]>;
export const ORDER_KEY = 'tautan.workspaceOrder';

/** A Mux that keeps the Workspace order itself, so a move goes to the Hub. Tabs always do. */
export const muxOrders = (kind: StateMux['kind'] | undefined) => kind === 'herdr';

/**
 * The Hub's move `index` for an item at `from` that should end at `to`: the pre-move splice
 * index, which lands at `index` moving up and at `index − 1` moving down past its own slot.
 * So one step up is `from − 1`, one step down `from + 2`, and a drop on the last item the count.
 */
export const spliceIndex = (from: number, to: number) => (to > from ? to + 1 : to);

/** `order` without the herdr Muxes' entries, or `order` itself when it holds none. */
export function dropMuxOrders(order: WorkspaceOrder, muxes: Pick<StateMux, 'key' | 'kind'>[]): WorkspaceOrder {
  const gone = muxes.filter((m) => muxOrders(m.kind) && m.key in order).map((m) => m.key);
  if (!gone.length) return order;
  const next = { ...order };
  for (const key of gone) delete next[key];
  return next;
}

/** Stored ids first, in stored order; ids the state added since keep their snapshot order after them. */
export function mergeOrder(stored: string[] | undefined, ids: string[]): string[] {
  const live = new Set(ids);
  const known = (stored ?? []).filter((id, i, all) => live.has(id) && all.indexOf(id) === i);
  const seen = new Set(known);
  return [...known, ...ids.filter((id) => !seen.has(id))];
}

/** Each Mux's Workspaces in its order. A Mux keeps the list positions it had, so Hosts do not interleave differently. */
export function orderWorkspaces(all: StateWorkspace[], order: WorkspaceOrder): StateWorkspace[] {
  const byMux = new Map<string, StateWorkspace[]>();
  for (const w of all) byMux.set(w.muxKey, [...(byMux.get(w.muxKey) ?? []), w]);
  const next = new Map<string, StateWorkspace[]>();
  for (const [mux, list] of byMux) {
    const rank = mergeOrder(order[mux], list.map((w) => w.id));
    // ponytail: rank.indexOf in the comparator is O(n² log n); fine at Workspace counts, build a Map if lists grow.
    next.set(mux, [...list].sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id)));
  }
  const used = new Map<string, number>();
  return all.map((w) => {
    const i = used.get(w.muxKey) ?? 0;
    used.set(w.muxKey, i + 1);
    return next.get(w.muxKey)![i]!;
  });
}

/** `order` with `w` moved to slot `at` of its Mux's list. Writes the whole live list, so ids that left the state drop out. */
export function moveWorkspace(all: StateWorkspace[], order: WorkspaceOrder, w: StateWorkspace, at: number): WorkspaceOrder {
  const ids = orderWorkspaces(all, order).filter((x) => x.muxKey === w.muxKey).map((x) => x.id);
  const from = ids.indexOf(w.id);
  if (from < 0 || at < 0 || at >= ids.length || at === from) return order;
  ids.splice(from, 1);
  ids.splice(at, 0, w.id);
  return { ...order, [w.muxKey]: ids };
}

export function readOrder(): WorkspaceOrder {
  try {
    const v: unknown = JSON.parse(store.get(ORDER_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((x) => typeof x === 'string')),
    );
  } catch {
    return {};
  }
}
// ponytail: a blocked localStorage keeps the order for this page load only; the caller holds it in state.
export function writeOrder(order: WorkspaceOrder) {
  try { store.set(ORDER_KEY, JSON.stringify(order)); } catch {}
}
