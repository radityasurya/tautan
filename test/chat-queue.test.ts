import { describe, expect, test } from 'bun:test';
import { ChatLens, type ChatHub, type TranscriptIo } from '../server/chat.ts';
import { parseTranscript, type Queued } from '../shared/chat.ts';
import type { State } from '../shared/types.ts';

// Record shapes as Claude Code 2.1.302 writes them (probed on a throwaway herdr, 2026-10-18).
const session = '20fee745-1c95-440b-a1a7-ee7243c8894b';
const op = (operation: string, at: string, content?: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'queue-operation', operation, timestamp: `2026-10-18T01:${at}Z`, sessionId: session, ...(content !== undefined ? { content } : {}), ...extra });
const user = (uuid: string, content: string) => JSON.stringify({ uuid, type: 'user', message: { role: 'user', content }, timestamp: '2026-10-18T01:15:24.932Z' });

const queueOf = (jsonl: string) => {
  const queued: Queued[] = [];
  parseTranscript(jsonl, { queued });
  return queued;
};

describe('the queue in the transcript', () => {
  test('enqueue appends; dequeue takes the head; Ctrl+Enter dequeues every one at once', () => {
    const lines = [
      user('u1', 'Write a 2000-word story about a beekeeper. No tools.'),
      op('enqueue', '16:53.491', 'reply with only the word ALPHA'),
      op('enqueue', '16:55.938', 'and then the word BETA'),
    ];
    expect(queueOf(lines.join('\n'))).toEqual([
      { text: 'reply with only the word ALPHA', at: Date.parse('2026-10-18T01:16:53.491Z') },
      { text: 'and then the word BETA', at: Date.parse('2026-10-18T01:16:55.938Z') },
    ]);
    expect(queueOf([...lines, op('dequeue', '17:20.776')].join('\n')).map(q => q.text)).toEqual(['and then the word BETA']);
    expect(queueOf([...lines, op('dequeue', '17:20.776'), op('dequeue', '17:20.776')].join('\n'))).toEqual([]);
  });

  test('a message absorbed mid-turn leaves by content, not by place', () => {
    const jsonl = [
      op('enqueue', '48:51.961', 'first'),
      op('enqueue', '48:52.100', 'i think i have catchall no?'),
      op('remove', '49:06.768', 'i think i have catchall no?', { reason: 'absorbed_mid_turn', commandUuid: 'c', deliveryId: 'd' }),
    ].join('\n');
    expect(queueOf(jsonl).map(q => q.text)).toEqual(['first']);
  });

  test('a bare enqueue (a `!` line) holds its place for the dequeue, and is never shown', () => {
    const jsonl = [op('enqueue', '48:03.292'), op('enqueue', '48:04.000', 'after the shell line'), op('dequeue', '48:51.195')].join('\n');
    expect(queueOf(jsonl).map(q => q.text)).toEqual(['after the shell line']);
    expect(queueOf([op('enqueue', '48:03.292'), op('enqueue', '48:04.000', 'shown')].join('\n')).map(q => q.text)).toEqual(['shown']);
  });

  test('popAll (the queue pulled back into the box) empties it', () => {
    expect(queueOf([op('enqueue', '14:18.000', 'a'), op('enqueue', '14:18.500', 'b'), op('popAll', '14:18.857', 'a\nb')].join('\n'))).toEqual([]);
  });

  test("a slash command queues like text; a task notification is not the user's", () => {
    const jsonl = [
      op('enqueue', '15:43.277', '/i-have-adhd'),
      op('enqueue', '15:44.000', '<task-notification>\n<task-id>b1</task-id>\n</task-notification>'),
    ].join('\n');
    expect(queueOf(jsonl).map(q => q.text)).toEqual(['/i-have-adhd']);
  });

  test('queue records change no turn', () => {
    const plain = [user('u1', 'hello')].join('\n');
    expect(parseTranscript([plain, op('enqueue', '15:36.247', 'later')].join('\n'))).toEqual(parseTranscript(plain));
  });
});

describe('the queue reaches the client (ADR 0007)', () => {
  const id = '66666666-6666-6666-6666-666666666666';
  const paneKey = 'local/fake/p1';
  const hub: ChatHub = {
    resolvePane: () => ({ paneId: 'p1', entry: { mux: { kind: 'herdr' }, tree: { panes: [{ id: 'p1', agentSession: id }] } } }),
    state: async () => ({ panes: [{ key: paneKey, cwd: '/repo' }] }) as State,
    paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
  };

  test('an enqueue moves the cursor and rides the delta; the dequeue clears it beside its turn', async () => {
    const state = { main: user('u1', 'Write a story.') };
    const io: TranscriptIo = {
      stat: async () => ({ inode: '1', size: state.main.length, mtime: Bun.hash(state.main).toString(36) }),
      read: async () => state.main,
      subagents: async () => undefined,
    };
    const lens = new ChatLens(hub, io, '/home/tama');
    const first = await lens.delta(paneKey, '');
    const cursor = first!.cursor;
    expect(first!.queued).toBeUndefined();

    state.main += `\n${op('enqueue', '15:36.247', 'also tell me the word count')}`;
    const queued = await lens.delta(paneKey, cursor);
    expect(queued!.cursor).not.toBe(cursor);
    expect(queued).toMatchObject({ reset: false, upserts: [], queued: [{ text: 'also tell me the word count' }] });
    // The quiet answer still says what is queued: absent would read as empty.
    expect((await lens.delta(paneKey, queued!.cursor))!.queued).toEqual(queued!.queued!);
    expect((await lens.query(paneKey))!.queued).toEqual(queued!.queued!);

    const reply = JSON.stringify({ uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'Once upon a time.' }] } });
    const ended = JSON.stringify({ type: 'system', subtype: 'turn_duration' });
    state.main += `\n${reply}\n${ended}\n${op('dequeue', '16:03.126')}\n${user('u2', 'also tell me the word count')}`;
    const sent = await lens.delta(paneKey, queued!.cursor);
    expect(sent!.queued).toBeUndefined();
    expect(sent!.upserts.map(turn => [turn.id, turn.text])).toEqual([['a1', 'Once upon a time.'], ['u2', 'also tell me the word count']]);
    lens.close();
  });
});
