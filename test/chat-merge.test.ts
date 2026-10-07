import { expect, test } from 'bun:test';
import { mergeTurns } from '../shared/chat-merge.ts';
import type { Turn } from '../shared/chat.ts';

const turn = (id: string, text: string): Turn => ({ id, role: 'assistant', text, tools: [] });

test('appends new ids in order', () => {
  const out = mergeTurns([turn('a', '1')], { reset: false, upserts: [turn('b', '2'), turn('c', '3')] });
  expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c']);
});

test('replaces a changed turn in place', () => {
  const out = mergeTurns([turn('a', '1'), turn('b', '2')], { reset: false, upserts: [turn('a', 'one'), turn('c', '3')] });
  expect(out.map((t) => `${t.id}:${t.text}`)).toEqual(['a:one', 'b:2', 'c:3']);
});

test('an empty delta keeps the same array', () => {
  const turns = [turn('a', '1')];
  expect(mergeTurns(turns, { reset: false, upserts: [] })).toBe(turns);
});

test('reset replaces the list', () => {
  const out = mergeTurns([turn('a', '1'), turn('b', '2')], { reset: true, upserts: [turn('x', '9')] });
  expect(out.map((t) => t.id)).toEqual(['x']);
});
