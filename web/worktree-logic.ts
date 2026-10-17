import type { WorktreeStatus } from '../shared/types.ts';

/**
 * The Remove worktree sheet's headline: whether the branch has landed. `merged` without a
 * base is believed only when GitHub says so; with no base, "ahead 0" measures nothing.
 */
export function verdict(s: WorktreeStatus): { tone: 'ok' | 'warn'; text: string } {
  if (!s.base) return s.pr?.state === 'MERGED' ? { tone: 'ok', text: 'Pull request merged' } : { tone: 'warn', text: 'No base branch to compare with' };
  if (s.merged) return { tone: 'ok', text: `Merged into ${s.base}` };
  return { tone: 'warn', text: `${s.ahead} commit${s.ahead === 1 ? '' : 's'} not in ${s.base}` };
}
