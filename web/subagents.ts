// The subagents of a Chat: the switcher's chips and rows, whether each still runs, the
// remembered choice per Pane, and which subagent the Chat view shows right now (the Composer
// reads it for its placeholder).
// ponytail: a module store with one listener set, like pending.ts; no state library.
import type { Subagent, Turn } from '../shared/chat.ts';

export interface Chip {
  id: string;
  /** `type · description`, with the parent's type in front when nested: `Explore › Plan · …`. */
  label: string;
  depth: number;
  running: boolean;
}

const kind = (agent: Subagent) => agent.type?.trim() || 'Subagent';

/** `type · description` for one subagent, or the type alone. */
export function subagentName(agent: Subagent): string {
  const description = agent.description?.trim();
  return description ? `${kind(agent)} · ${description}` : kind(agent);
}

/** Subagents whose Task row in these turns already carries its result: they have finished. */
export function finishedIn(turns: Turn[]): string[] {
  return turns.flatMap((turn) => turn.tools.filter((tool) => tool.subagentId && (tool.result !== undefined || tool.isError)).map((tool) => tool.subagentId!));
}

/**
 * Whether a subagent still runs. The Hub's `state` says it outright; without one (an older
 * Hub), the browser guesses: the Pane's Agent is live (working or blocked), and neither it
 * nor any parent has a finished Task row in a transcript seen so far.
 */
export function subagentRunning(agent: Subagent, list: Subagent[], finished: ReadonlySet<string>, live: boolean): boolean {
  if (agent.state) return agent.state === 'running';
  if (!live) return false;
  const byId = new Map(list.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (let at: Subagent | undefined = agent; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (finished.has(at.id)) return false;
    seen.add(at.id);
  }
  return true;
}

/**
 * The tree as rows: each subagent under its parent, one level deeper; among siblings the
 * running ones first, then newest first, an unknown start time last. A parent missing from
 * the list makes its child a root.
 */
export function subagentRows(list: Subagent[], running: (agent: Subagent) => boolean = () => false): { agent: Subagent; depth: number; running: boolean }[] {
  const ids = new Set(list.map((agent) => agent.id));
  const children = new Map<string, Subagent[]>();
  const live = new Map(list.map((agent) => [agent.id, running(agent)]));
  const sorted = list
    .map((agent, n) => ({ agent, n }))
    .sort((a, b) => Number(live.get(b.agent.id)) - Number(live.get(a.agent.id)) || (b.agent.at ?? -Infinity) - (a.agent.at ?? -Infinity) || a.n - b.n);
  for (const { agent } of sorted) {
    const parent = agent.parentId && ids.has(agent.parentId) ? agent.parentId : '';
    children.set(parent, [...(children.get(parent) ?? []), agent]);
  }
  const rows: { agent: Subagent; depth: number; running: boolean }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const agent of children.get(parent) ?? []) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      rows.push({ agent, depth, running: live.get(agent.id)! });
      walk(agent.id, depth + 1);
    }
  };
  walk('', 0);
  // A parent cycle never reaches a root; its members still get a row.
  for (const { agent } of sorted) if (!seen.has(agent.id)) { seen.add(agent.id); rows.push({ agent, depth: 0, running: live.get(agent.id)! }); walk(agent.id, 1); }
  return rows;
}

/** The strip's chips, in the rows' order. A nested one names its parent's type in front, so the strip stays one flat row. */
export function subagentChips(list: Subagent[], running?: (agent: Subagent) => boolean): Chip[] {
  const byId = new Map(list.map((agent) => [agent.id, agent]));
  return subagentRows(list, running).map(({ agent, depth, running }) => {
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    return { id: agent.id, label: parent ? `${kind(parent)} › ${subagentName(agent)}` : subagentName(agent), depth, running };
  });
}

// ---- the choice per Pane, kept for the tab's life like the lens ----

const storageKey = (paneKey: string) => `tautan.subagent.${paneKey}`;

export function readSubagent(paneKey: string): string | undefined {
  try { return sessionStorage.getItem(storageKey(paneKey)) ?? undefined; } catch { return undefined; }
}

export function writeSubagent(paneKey: string, id: string | undefined) {
  try {
    if (id) sessionStorage.setItem(storageKey(paneKey), id);
    else sessionStorage.removeItem(storageKey(paneKey));
  } catch {}
}

// ---- the subagent on screen, while the Chat view is mounted ----

const showing = new Map<string, string>();
const listeners = new Set<() => void>();

export function subscribeShowing(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const showingSubagent = (paneKey: string) => showing.get(paneKey);

export function setShowing(paneKey: string, id: string | undefined) {
  if (showing.get(paneKey) === id) return;
  if (id) showing.set(paneKey, id); else showing.delete(paneKey);
  for (const fn of listeners) fn();
}
