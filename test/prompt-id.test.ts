import { beforeEach, describe, expect, test } from 'bun:test';
import { offeredKeys, promptId, rotatePromptSalt } from '../shared/blocked.ts';
import type { Explain, Screen } from '../shared/types.ts';

const explain: Explain = { ruleId: 'live_blocked_form', state: 'blocked', detection: 'Do you want to proceed?\n❯ 1. Yes', hintKeys: [] };
const screen = (text: string): Screen => ({ text, ansi: false, revision: 1, mode: 'visible' });
const box = ['Bash command', 'echo hi', '❯ 1. Yes', '────────────────────────────────', 'esc to cancel · enter to confirm'].join('\n');

describe('promptId', () => {
  beforeEach(rotatePromptSalt);

  test('same prompt and screen give the same id', async () => {
    const id = await promptId(explain, screen(box));
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await promptId(explain, screen(box))).toBe(id);
  });

  test('a changed detection changes the id', async () => {
    const other = { ...explain, detection: 'Allow this edit?\n❯ 1. Yes' };
    expect(await promptId(other, screen(box))).not.toBe(await promptId(explain, screen(box)));
  });

  test('a changed screen changes the id', async () => {
    expect(await promptId(explain, screen(`${box}\nnew line`))).not.toBe(await promptId(explain, screen(box)));
  });

  test('a ticking working line still matches', async () => {
    const a = screen(`✢ Tempering… (1m 55s · ↓ 10.0k tokens · esc to interrupt)\n${box}`);
    const b = screen(`✢ Tempering… (1m 59s · ↓ 10.4k tokens · esc to interrupt)\n${box}`);
    expect(await promptId(explain, a)).toBe(await promptId(explain, b));
  });

  test('a Hub restart must not match', async () => {
    const id = await promptId(explain, screen(box));
    rotatePromptSalt();
    expect(await promptId(explain, screen(box))).not.toBe(id);
  });

  test('two working-line shapes normalise neither', async () => {
    const twin = (time: string) => screen([
      `✢ Tempering… (${time} · ↓ 10.0k tokens · esc to interrupt)`,
      '✢ Pondering… (2m 00s · ↓ 9.9k tokens · esc to interrupt)',
      box,
    ].join('\n'));
    expect(await promptId(explain, twin('1m 55s'))).not.toBe(await promptId(explain, twin('1m 59s')));
  });

  test('offeredKeys still leads with the preset on a yes/no box', () => {
    expect(offeredKeys(explain).map((k) => k.key)).toEqual(['enter', 'esc']);
  });
});
