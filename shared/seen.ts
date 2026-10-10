import type { StatePane } from './types.ts';

/** Blocked is actionable even after it was Seen. Others are Seen when the current revision
 *  equals the device's own or the Hub's recorded revision: herdr restarts reset revisions,
 *  so a plain "greater than" would lock a Pane Seen forever and hide a later `done`. */
export const isUnseen = (pane: StatePane, revisions: Record<string, number>) => {
  if (pane.status === 'blocked') return true;
  if (pane.status === 'idle' || pane.status === 'unknown') return false;
  const seen = revisions[pane.key];
  if (seen !== undefined && seen > 1_000_000_000_000) return seen < (pane.statusChangedAt ?? 0); // legacy timestamps
  return pane.revision !== seen && pane.revision !== pane.seenRevision;
};
