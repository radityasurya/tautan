import { expect, test } from 'bun:test';
import { verdict } from '../web/worktree-logic.ts';
import type { WorktreeStatus } from '../shared/types.ts';

const status = (o: Partial<WorktreeStatus>): WorktreeStatus => ({
  branch: 'feat/files', path: '/w', base: 'origin/main', fetched: true, ahead: 0, dirty: 0, merged: true, ...o,
});

test('a merged branch names its base', () => {
  expect(verdict(status({}))).toEqual({ tone: 'ok', text: 'Merged into origin/main' });
  // A squash merge: commits ahead, but GitHub says merged.
  expect(verdict(status({ ahead: 4, pr: { number: 12, url: 'u', state: 'MERGED' } }))).toEqual({ tone: 'ok', text: 'Merged into origin/main' });
});

test('an unmerged branch counts what the base lacks', () => {
  expect(verdict(status({ ahead: 1, merged: false })).text).toBe('1 commit not in origin/main');
  expect(verdict(status({ ahead: 3, merged: false }))).toEqual({ tone: 'warn', text: '3 commits not in origin/main' });
});

test('with no base, only a merged pull request counts as merged', () => {
  expect(verdict(status({ base: undefined }))).toEqual({ tone: 'warn', text: 'No base branch to compare with' });
  expect(verdict(status({ base: undefined, pr: { number: 3, url: 'u', state: 'MERGED' } }))).toEqual({ tone: 'ok', text: 'Pull request merged' });
});
