import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { autoDeliver, dropPending, flushHeld, heldOf, pendingSnapshot, settled, trackPending, type Pending } from '../web/pending.ts';
import type { Turn } from '../shared/chat.ts';
import type { Status } from '../shared/types.ts';

const T0 = 1_700_000_000_000;
const user = (text: string, at?: number): Turn => ({ role: 'user', text, tools: [], ...(at !== undefined ? { at } : {}) });
const reply = (text: string): Turn => ({ role: 'assistant', text, tools: [] });
const entry = (id: number, text: string, state: Pending['state'] = 'sent', at = T0): Pending => ({ id, paneKey: 'k', text, state, at });

test('a reply settles on its turn, whitespace aside', () => {
  expect(settled([reply('hi'), user('  run   the\ttests \n', T0 + 900)], [entry(1, 'run the tests')])).toEqual([1]);
});

test('an earlier identical turn does not settle a new reply', () => {
  const turns = [user('yes', T0 - 120_000), reply('done')];
  expect(settled(turns, [entry(1, 'yes')])).toEqual([]);
  expect(settled([...turns, user('yes', T0 + 500)], [entry(1, 'yes')])).toEqual([1]);
});

test('two replies folded into one turn settle both, once each', () => {
  const turns = [user('first\n\nsecond', T0 + 100)];
  expect(settled(turns, [entry(1, 'first'), entry(2, 'second'), entry(3, 'first', 'sent', T0 + 200)])).toEqual([1, 2]);
});

test('a paragraph inside a longer message is not a match', () => {
  expect(settled([user('please do not deploy', T0 + 100)], [entry(1, 'deploy')])).toEqual([]);
});

test('held and failed replies wait; a turn without a time still counts', () => {
  const turns = [user('go')];
  expect(settled(turns, [entry(1, 'go', 'held'), entry(2, 'go', 'failed')])).toEqual([]);
  expect(settled(turns, [entry(3, 'go', 'late')])).toEqual([3]);
});

describe('held replies', () => {
  const posted: string[] = [];
  let up = true;
  const real = globalThis.fetch;
  beforeEach(() => {
    posted.length = 0;
    up = true;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response(null, { status: up ? 204 : 502 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
    dropPending(pendingSnapshot().map((p) => p.id));
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const pane = (status: Status, revision = 1) => [{ key: 'h', status, revision }];

  test('go out in order once the Pane is idle or done, never while it works or is blocked', async () => {
    autoDeliver(pane('working'));
    trackPending('h', 'first', true);
    trackPending('h', 'second', true);
    autoDeliver(pane('blocked', 2));
    await settle();
    expect(posted).toEqual([]);
    autoDeliver(pane('done', 3));
    await settle();
    await settle();
    expect(posted).toEqual(['first', 'second']);
    expect(heldOf(pendingSnapshot(), 'h')).toEqual([]);
  });

  test('a held reply on a Pane that is already idle goes at once', async () => {
    autoDeliver(pane('idle', 4));
    trackPending('h', 'now', true);
    await settle();
    expect(posted).toEqual(['now']);
  });

  test('a failure keeps it held and in order, and waits for the Pane to move', async () => {
    autoDeliver(pane('working', 5));
    trackPending('h', 'a', true);
    trackPending('h', 'b', true);
    up = false;
    autoDeliver(pane('idle', 6));
    await settle();
    await settle();
    expect(posted).toEqual(['a']);
    expect(heldOf(pendingSnapshot(), 'h').map((p) => p.text)).toEqual(['a', 'b']);
    autoDeliver(pane('idle', 6)); // same revision: no retry storm
    await settle();
    expect(posted).toEqual(['a']);
    up = true;
    expect(await flushHeld('h')).toBe(true); // Send now
    expect(posted).toEqual(['a', 'a', 'b']);
  });
});
