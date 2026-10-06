// Subagents of a Chat: the switcher's chips, the remembered choice per Pane, and which
// subagent the Chat view shows right now (the Composer reads it for its placeholder).
// ponytail: a module store with one listener set, like pending.ts; no state library.
import type { Subagent } from '../shared/chat.ts';

export interface Chip {
  id: string;
  /** `type · description`, with the parent's type in front when nested: `Explore › Plan · …`. */
  label: string;
}

const kind = (agent: Subagent) => agent.type?.trim() || 'Subagent';

/** `type · description` for one subagent, or the type alone. */
export function subagentName(agent: Subagent): string {
  const description = agent.description?.trim();
  return description ? `${kind(agent)} · ${description}` : kind(agent);
}

/**
 * One chip per subagent, oldest first and newest last. A nested one names its parent's type
 * in front, so the strip stays one flat row; a parent missing from the list is left out.
 * An unknown start time sorts last, in the order the Hub listed it.
 */
export function subagentChips(list: Subagent[]): Chip[] {
  const byId = new Map(list.map((agent) => [agent.id, agent]));
  return list
    .map((agent, n) => ({ agent, n }))
    .sort((a, b) => (a.agent.at ?? Infinity) - (b.agent.at ?? Infinity) || a.n - b.n)
    .map(({ agent }) => {
      const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
      return { id: agent.id, label: parent ? `${kind(parent)} › ${subagentName(agent)}` : subagentName(agent) };
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
