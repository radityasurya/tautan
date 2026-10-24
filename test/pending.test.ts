import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { autoDeliver, DRAFT_RETRY_MS, deliver, dropPending, flushHeld, heldOf, pendingSnapshot, runsOutside, settled, trackPending, type Pending } from '../web/pending.ts';
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
  let refuse: { status: number; error: string } | undefined;
  const bodies: { held?: true }[] = [];
  const real = globalThis.fetch;
  beforeEach(() => {
    posted.length = 0;
    up = true;
    refuse = undefined;
    bodies.length = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string; held?: true };
      posted.push(body.text);
      bodies.push(body);
      if (refuse) return Response.json({ error: refuse.error }, { status: refuse.status });
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

  test('409 draft keeps the reply held with the reason, retries on the timer, and clears on success', async () => {
    refuse = { status: 409, error: 'draft' };
    autoDeliver(pane('idle', 10));
    trackPending('h', 'late', true);
    await settle();
    await settle();
    expect(posted).toEqual(['late']);
    expect(bodies[0]?.held).toBe(true);
    expect(pendingSnapshot().map((p) => [p.state, p.reason])).toEqual([['held', 'draft']]);
    autoDeliver(pane('idle', 10)); // inside the throttle: no retry
    await settle();
    expect(posted).toEqual(['late']);
    refuse = undefined;
    await new Promise((r) => setTimeout(r, DRAFT_RETRY_MS + 300)); // the box cleared; the timer retries

    expect(posted).toEqual(['late', 'late']);
    expect(pendingSnapshot().map((p) => [p.state, p.reason])).toEqual([['sent', undefined]]);
  });

  test('a draft-held reply retries on time at an unchanged revision; a non-draft hold still waits', async () => {
    refuse = { status: 409, error: 'draft' };
    autoDeliver(pane('idle', 40));
    trackPending('h', 'box', true);
    await settle();
    await settle();
    expect(posted).toEqual(['box']);
    refuse = undefined;
    await new Promise((r) => setTimeout(r, DRAFT_RETRY_MS + 300));
    expect(posted).toEqual(['box', 'box']);
    expect(pendingSnapshot()[0]).toMatchObject({ state: 'sent' });
    dropPending(pendingSnapshot().map((p) => p.id));
    // held for another reason: the revision gate stays
    up = false;
    trackPending('h', 'x', true);
    await settle();
    await settle();
    autoDeliver(pane('idle', 40));
    await settle();
    expect(posted).toEqual(['box', 'box', 'x']);
    up = true;
    await new Promise((r) => setTimeout(r, DRAFT_RETRY_MS + 300));
    expect(posted).toEqual(['box', 'box', 'x']);
  }, 10_000);

  test('a first delivery refused for a draft becomes held, not failed', async () => {
    autoDeliver(pane('working', 20));
    const id = trackPending('h', 'now');
    refuse = { status: 409, error: 'draft' };
    expect(await deliver(id)).toBe(false);
    expect(pendingSnapshot()[0]).toMatchObject({ state: 'held', reason: 'draft' });
  });

  test('409 panel holds the reply until the box is back; Send anyway posts it unheld', async () => {
    // A panel (/config) or a prompt has taken the box's place: its Enter would pick a row.
    refuse = { status: 409, error: 'panel' };
    autoDeliver(pane('idle', 50));
    trackPending('h', 'wait', true);
    await settle();
    await settle();
    expect(pendingSnapshot().map((p) => [p.state, p.reason])).toEqual([['held', 'panel']]);
    refuse = undefined;
    await new Promise((r) => setTimeout(r, DRAFT_RETRY_MS + 300)); // the panel closed; the timer retries
    expect(posted).toEqual(['wait', 'wait']);
    expect(pendingSnapshot()[0]).toMatchObject({ state: 'sent' });
    dropPending(pendingSnapshot().map((p) => p.id));
    // Send anyway: the user saw why it waits, so it goes without `held` and the Hub types it.
    refuse = { status: 409, error: 'panel' };
    trackPending('h', 'anyway', true);
    await settle();
    await settle();
    refuse = undefined;
    expect(await flushHeld('h', true)).toBe(true);
    expect(bodies.at(-1)?.held).toBeUndefined();
    expect(posted.at(-1)).toBe('anyway');
  }, 10_000);

  test('another 409 fails the reply as before', async () => {
    autoDeliver(pane('working', 30));
    const id = trackPending('h', 'x');
    refuse = { status: 409, error: 'prompt_changed' };
    expect(await deliver(id)).toBe(false);
    expect(pendingSnapshot()[0]).toMatchObject({ state: 'failed' });
    expect(pendingSnapshot()[0]?.reason).toBeUndefined();
  });
});

test("a command pi runs itself never waits for a turn; Claude's and pi's /skill do", () => {
  expect(runsOutside('pi', '/hotkeys')).toBe(true);
  expect(runsOutside('pi', '/compact keep the plan')).toBe(true);
  expect(runsOutside('codex', '/status')).toBe(true);
  expect(runsOutside('pi', '/skill:lead ship it')).toBe(false);
  expect(runsOutside('claude', '/compact')).toBe(false);
  expect(runsOutside('pi', '/home/dev/notes.md is wrong')).toBe(false);
  expect(runsOutside('pi', 'run /hotkeys')).toBe(false);
});
