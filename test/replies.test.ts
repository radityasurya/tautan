import { describe, expect, test } from 'bun:test';
import { isNumberedList, pillLabel, quickReplies } from '../web/replies.ts';
import type { Explain } from '../shared/types.ts';

const BOX: Explain = {
  ruleId: 'claude.permission.bash',
  state: 'blocked',
  detection: [
    '\x1b[33m│\x1b[0m Do you want to proceed?',
    '\x1b[33m│\x1b[0m ❯ 1. Yes',
    '\x1b[33m│\x1b[0m   2. Yes, and don’t ask again',
    '\x1b[33m│\x1b[0m   3. No, and tell Claude what to do differently',
    '  esc to cancel · enter to confirm',
  ].join('\n'),
  hintKeys: [{ key: 'esc', label: 'No' }, { key: 'ctrl+c', label: 'Quit' }],
};

const labels = (agent?: string, o: Partial<Parameters<typeof quickReplies>[0]> = {}) =>
  quickReplies({ agent, smart: false, ...o }).map((p) => p.label);

describe('isNumberedList', () => {
  test('reads through the box frame and the ANSI', () => {
    expect(isNumberedList(BOX.detection)).toBe(true);
  });
  test('one option is not a list', () => {
    expect(isNumberedList('Press enter to continue\n1. Yes')).toBe(false);
  });
});

describe('pillLabel', () => {
  test('a mode keeps its name, not its state or the hint beside it', () => {
    expect(pillLabel('auto mode on')).toBe('auto mode');
    expect(pillLabel('accept edits on (shift+tab to cycle)')).toBe('accept edits');
  });
  test('a long label is cut to fit the row', () => {
    expect(pillLabel('Yes, and don’t ask again')).toBe('Yes, and don…');
    expect(pillLabel('cancel')).toBe('cancel');
  });
});

describe('quickReplies', () => {
  test('key pills first, then the static set for the Agent', () => {
    expect(labels('claude', { explain: BOX })).toEqual([
      'Yes', 'No', 'Quit',
      'Continue', 'Run the tests', 'Commit and push', 'Explain the diff', 'Stop here',
    ]);
  });
  test('key pills send, text pills do not', () => {
    const pills = quickReplies({ agent: 'claude', explain: BOX, smart: false });
    expect(pills[0]).toMatchObject({ kind: 'key', keys: ['enter'], glyph: '↵' });
    expect(pills.find((p) => p.label === 'Continue')?.keys).toBeUndefined();
  });
  test('an unknown Agent offers Continue, and no keys without an Explain', () => {
    expect(labels('codex')).toEqual(['Continue']);
    expect(labels('pi')).toEqual(['Continue', 'Run the tests', 'Show me the plan']);
  });
  test('suggestions need the smart flag, come before the static set, and cap at three', () => {
    const suggestions = ['Yes, but skip the e2e tests', 'Run it in a worktree', 'Show the command', 'Fourth'];
    expect(labels('pi', { suggestions })).toEqual(['Continue', 'Run the tests', 'Show me the plan']);
    expect(labels('pi', { suggestions, smart: true })).toEqual([
      'Yes, but skip the e2e tests', 'Run it in a worktree', 'Show the command',
      'Continue', 'Run the tests', 'Show me the plan',
    ]);
  });
  test('a blocked Pane drops the static set and keeps the drafts', () => {
    expect(labels('claude', { explain: BOX, blocked: true })).toEqual(['Yes', 'No', 'Quit']);
    expect(labels('pi', { suggestions: ['Allow it once'], smart: true, blocked: true })).toEqual(['Allow it once']);
  });
  test('a preset says it sends; a draft says it fills the reply box', () => {
    const pills = quickReplies({ agent: 'pi', suggestions: ['Run it in a worktree'], smart: true });
    expect(pills.find((p) => p.label === 'Continue')?.aria).toBe('Continue, sends');
    expect(pills[0]).toMatchObject({ generated: true, aria: 'Run it in a worktree, fills the reply box' });
  });
  test('a drafted reply that repeats a static one is listed once, as the draft', () => {
    const pills = quickReplies({ agent: 'pi', suggestions: ['Continue'], smart: true });
    expect(pills.filter((p) => p.label === 'Continue')).toEqual([
      { kind: 'text', label: 'Continue', aria: 'Continue, fills the reply box', generated: true },
    ]);
  });
});
