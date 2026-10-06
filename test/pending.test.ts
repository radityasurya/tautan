import { expect, test } from 'bun:test';
import { settled, type Pending } from '../web/pending.ts';
import type { Turn } from '../shared/chat.ts';

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
