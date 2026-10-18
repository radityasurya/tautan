import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAnsi } from '../shared/ansi.ts';
import { findAffordances } from '../shared/affordances.ts';
import { enterAction, keyGlyph } from '../web/keys.ts';
import { PROFILES } from '../web/profiles.ts';
import type { Pending } from '../web/pending.ts';
import { queueShown, screenQueue } from '../web/queued.ts';

// Real Screens from Claude Code 2.1.302 on a throwaway herdr (2026-10-18), ANSI kept.
const screen = (name: string) => parseAnsi(readFileSync(join(import.meta.dir, 'fixtures', `${name}.txt`), 'utf8'));

describe("Claude's queue on the Screen", () => {
  test('rows above the hint, a wrapped row and a two-line row each one message', () => {
    expect(screenQueue(screen('claude-queue'))).toEqual([
      `reply OK only. ${Array.from({ length: 30 }, (_, n) => `padding${String(n).padStart(2, '0')}`).join(' ')}`,
      'first line of two second line, reply OK',
    ]);
  });

  test("the echo of the prompt Claude works on is not queued: its words are brighter than its marker", () => {
    expect(screenQueue(screen('claude-queue-echo'))).toEqual(['queued GAMMA, reply GAMMA only']);
  });

  test('no hint, no queue', () => {
    expect(screenQueue(parseAnsi('❯ sent earlier\n\n● Done.\n────────\n❯ \n────────'))).toEqual([]);
  });

  test("Claude's hint is a tap that sends Ctrl+Enter, not Enter", () => {
    const hint = findAffordances(screen('claude-queue-echo'), PROFILES.claude!).find((a) => a.label === 'send now');
    expect(hint?.action).toEqual({ keys: ['ctrl+enter'] });
    expect(keyGlyph('ctrl+enter')).toBe('^↵');
    expect(keyGlyph('ctrl+d')).toBe('^d');
  });
});

describe('the queue the Chat view shows', () => {
  const T0 = 1_760_000_000_000;
  const entry = (id: number, text: string, state: Pending['state'] = 'sent'): Pending => ({ id, paneKey: 'k', text, state, at: T0 + id });

  test('a Screen row the transcript lacks joins it; one it has does not repeat', () => {
    const { items } = queueShown([{ text: 'also tell me the word count', at: T0 }], ['also tell me the word count', '/i-have-adhd'], [], true);
    expect(items).toEqual([{ text: 'also tell me the word count', at: T0 }, { text: '/i-have-adhd' }]);
  });

  test("a reply sent from tautan shows once, as Queued, whether or not Claude's queue shows it yet", () => {
    const shown = queueShown([{ text: 'run  the tests', at: T0 }], [], [entry(1, 'run the tests'), entry(2, 'then deploy')], true);
    expect(shown.items.map((item) => item.text)).toEqual(['run  the tests', 'then deploy']);
    expect(shown.covered).toEqual([1, 2]);
  });

  test('a reply sent with Ctrl+Enter marks its queued item as on its way', () => {
    const now = { ...entry(1, 'stop and fix the test'), now: true as const };
    expect(queueShown([{ text: 'stop and fix the test' }], [], [now], true).items).toEqual([{ text: 'stop and fix the test', now: true }]);
    expect(queueShown([], [], [now], true).items[0]!.now).toBe(true);
  });

  test('while Claude does not work, a reply not in the queue stays a pending turn', () => {
    const shown = queueShown([], [], [entry(1, 'hello'), entry(2, 'held', 'held'), entry(3, 'failed', 'failed')], false);
    expect(shown).toEqual({ items: [], covered: [] });
  });

  test('a message queued twice shows twice; a Screen row cut short still matches', () => {
    const { items } = queueShown([{ text: 'yes' }, { text: 'a long message that goes on' }], ['yes', 'yes', 'a long message th…'], [], true);
    expect(items.map((item) => item.text)).toEqual(['yes', 'a long message that goes on', 'yes']);
  });
});

describe('Enter in the Composer', () => {
  const key = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, ...o });

  test('Ctrl+Enter or Cmd+Enter sends now while Claude works, and is a plain send otherwise', () => {
    expect(enterAction(key({ ctrlKey: true }), { working: true, returnBreaks: false })).toBe('now');
    expect(enterAction(key({ metaKey: true }), { working: true, returnBreaks: true })).toBe('now');
    expect(enterAction(key({ ctrlKey: true }), { working: false, returnBreaks: false })).toBe('send');
  });

  test('Enter sends, Shift+Enter breaks the line, and a touch screen Return breaks it too', () => {
    expect(enterAction(key(), { working: true, returnBreaks: false })).toBe('send');
    expect(enterAction(key({ shiftKey: true }), { working: true, returnBreaks: false })).toBeNull();
    expect(enterAction(key(), { working: false, returnBreaks: true })).toBeNull();
    expect(enterAction({ ...key(), key: 'a' }, { working: true, returnBreaks: false })).toBeNull();
  });
});
