import { expect, test } from 'bun:test';
import { yesNoKeys } from '../shared/blocked.ts';
import type { Explain } from '../shared/types.ts';

const explain = (detection: string, hintKeys: Explain['hintKeys'], ruleId = 'live_blocked_form'): Explain =>
  ({ ruleId, state: 'blocked', detection, hintKeys });

test('a yes/no prompt gives the plain enter/esc pair, never the Always hint key', () => {
  const box = explain('Bash command\n  rm -rf dist\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No', [
    { key: '2', label: "Yes, and don't ask again" },
    { key: '3', label: 'No' },
  ]);
  expect(yesNoKeys(box)).toEqual({ yes: { key: 'enter', label: 'Yes' }, no: { key: 'esc', label: 'No' } });
});

test('a prompt that is not yes/no gives null, even when a hint key is labelled Yes', () => {
  const box = explain('Pick a model\n  1. opus\n  2. sonnet', [
    { key: '1', label: "Yes, and don't ask again" },
    { key: '2', label: 'No' },
  ], 'menu_prompt');
  expect(yesNoKeys(box)).toBeNull();
});
