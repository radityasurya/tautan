import { describe, expect, test } from 'bun:test';
import { parseTranscript, TranscriptParser, type ParseOpts, type Queued, type TranscriptImage } from '../shared/chat.ts';

// A resumable parse must equal the one-shot parse of the same bytes: Turns and every side map.

const ts = (n: number) => `2026-10-18T01:${String(n % 60).padStart(2, '0')}:00.000Z`;
const rec = (r: Record<string, unknown>) => JSON.stringify(r);
const user = (uuid: string, content: unknown, n: number) => rec({ uuid, type: 'user', message: { role: 'user', content }, timestamp: ts(n) });
const assistant = (uuid: string, content: unknown, n: number) => rec({ uuid, type: 'assistant', message: { role: 'assistant', content }, timestamp: ts(n) });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const op = (operation: string, n: number, content?: string) =>
  rec({ type: 'queue-operation', operation, timestamp: ts(n), ...(content !== undefined ? { content } : {}) });
const png = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const long = (label: string) => Array.from({ length: 120 }, (_, i) => `${label} ${i}`).join('\n');

const corpus: Record<string, string[]> = {
  'a tool result lands on an earlier row, past a long assistant stretch': [
    user('u1', 'run it', 1),
    assistant('a1', [{ type: 'text', text: 'Running.' }, use('t1', 'Bash', { command: 'ls' }), use('t2', 'Bash', { command: 'seq 1 200' })], 2),
    assistant('a2', [{ type: 'text', text: 'Still going.' }], 3),
    user('u2', [result('t2', long('line'))], 4),
    user('u3', [result('t1', 'a\r\nb', { is_error: true })], 5),
    rec({ type: 'system', subtype: 'turn_duration' }),
    assistant('a3', [{ type: 'text', text: 'Done.' }], 6),
    'not json at all',
    '[1,2]',
    '',
  ],
  'a queue with enqueue, dequeue, remove, popAll and a queued attachment': [
    user('u1', 'start', 1),
    op('enqueue', 2, 'first'),
    op('enqueue', 3, 'second'),
    op('enqueue', 4, '<task-notification>hidden</task-notification>'),
    rec({ type: 'attachment', uuid: 'q1', timestamp: ts(5), attachment: { type: 'queued_command', prompt: 'second', origin: { kind: 'human' } } }),
    op('dequeue', 6),
    op('remove', 7, 'second'),
    user('u2', 'second', 8),
    rec({ type: 'attachment', uuid: 'p1', timestamp: ts(9), attachment: { type: 'queued_command', prompt: 'x', origin: { kind: 'peer', name: 'bob', body: 'hello from bob' } } }),
    op('enqueue', 10, 'last'),
    op('enqueue', 11, 'gone'),
    op('popAll', 12),
    op('enqueue', 13, 'kept'),
  ],
  'images, html previews, an artifact and a long detail': [
    user('u1', [{ type: 'text', text: 'look' }, png('AAAA'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '!!' } }], 1),
    assistant('a1', [
      use('w1', 'Write', { file_path: '/p/a.html', content: '<html><title>Hi</title></html>' }),
      use('w2', 'Write', { file_path: '/p/a.html', content: '<html><title>Hi again</title></html>' }),
      use('e1', 'Edit', { file_path: '/p/b.html', old_string: 'a', new_string: 'b' }),
      use('r1', 'Read', { file_path: '/p/shot.png' }),
      use('g1', 'Bash', { command: long('cmd') }),
      use('x1', 'Artifact', { file_path: '/p/a.html' }),
    ], 2),
    user('u2', [result('r1', [png('BBBB')]), result('x1', 'see https://claude.ai/code/artifact/abc123 ok')], 3),
    user('u3', '<command-name>/clear</command-name>', 4),
    user('u4', '<local-command-stdout>cleared</local-command-stdout>', 5),
    rec({ uuid: 'c1', type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' }, timestamp: ts(6) }),
    assistant('a2', [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'ok' }], 7),
    assistant('a3', [{ type: 'text', text: 'more' }, use('t9', 'Task', { description: 'd' })], 8),
  ],
};

interface Parsed { turns: unknown; images: TranscriptImage[]; previews: string[]; previewFiles: [number, string][]; outputs: [string, string][]; details: [string, string][]; queued: Queued[] }
const sides = () => ({ images: [] as TranscriptImage[], previews: [] as string[], previewFiles: new Map<number, string>(), outputs: new Map<string, string>(), details: new Map<string, string>(), queued: [] as Queued[] });
const snap = (turns: unknown, s: ReturnType<typeof sides>): Parsed =>
  ({ turns: structuredClone(turns), images: s.images, previews: s.previews, previewFiles: [...s.previewFiles], outputs: [...s.outputs], details: [...s.details], queued: s.queued });
const opts = (s: ReturnType<typeof sides>): ParseOpts => ({ ...s, subagentIds: new Map([['t9', 'sub-1']]) });

const oneShot = (text: string): Parsed => { const s = sides(); return snap(parseTranscript(text, opts(s)), s); };

/** Feed `text` cut at newlines, holding the partial tail as the lens does. */
function chunked(text: string, cuts: number[]): Parsed {
  const s = sides();
  const parser = new TranscriptParser(opts(s));
  let held = '';
  let at = 0;
  for (const end of [...cuts, text.length]) {
    held += text.slice(at, end);
    at = end;
    const nl = held.lastIndexOf('\n');
    if (nl < 0) continue;
    parser.feed(held.slice(0, nl + 1));
    held = held.slice(nl + 1);
  }
  parser.feed(held);
  s.queued.push(...parser.queued());
  return snap(parser.turns, s);
}

// mulberry32: a seeded PRNG so the cuts reproduce.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('a resumable parse equals the one-shot parse', () => {
  for (const [name, lines] of Object.entries(corpus)) {
    const text = `${lines.join('\n')}\n`;
    const whole = oneShot(text);

    test(`${name}: line by line`, () => {
      const cuts: number[] = [];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') cuts.push(i + 1);
      expect(chunked(text, cuts)).toEqual(whole);
    });

    test(`${name}: random cuts`, () => {
      const rand = prng(42);
      for (let round = 0; round < 25; round++) {
        const cuts = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => Math.floor(rand() * text.length)).sort((a, b) => a - b);
        expect(chunked(text, cuts)).toEqual(whole);
      }
    });
  }

  test('the corpus reaches what it claims to', () => {
    const early = oneShot(`${corpus['a tool result lands on an earlier row, past a long assistant stretch']!.join('\n')}\n`);
    const tools = (early.turns as { tools: { result?: string; resultTruncated?: boolean }[] }[])[1]!.tools;
    expect(tools[0]!.result).toBe('a\nb');
    expect(tools[1]!.resultTruncated).toBe(true);
    expect(early.outputs).toHaveLength(1);
    expect(oneShot(`${corpus['a queue with enqueue, dequeue, remove, popAll and a queued attachment']!.join('\n')}\n`).queued.map(q => q.text)).toEqual(['kept']);
    const media = oneShot(`${corpus['images, html previews, an artifact and a long detail']!.join('\n')}\n`);
    expect(media.images).toHaveLength(2);
    expect(media.previewFiles).toEqual([[1, '/p/b.html']]);
    expect(media.details).toHaveLength(1);
  });

  test('a refused image in a tool result keeps the later image and the sibling result', () => {
    const refused = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' } };
    const text = `${[
      assistant('a1', [use('r1', 'Read', { file_path: '/p/a.png' }), use('r2', 'Bash', { command: 'ls' })], 1),
      user('u1', [result('r1', [refused, png('iVBORw0KGgo=')]), result('r2', 'ok')], 2),
    ].join('\n')}\n`;
    const s = sides();
    const tools = (parseTranscript(text, opts(s)) as { tools: { id: string; result?: string; pending?: boolean; imageId?: number }[] }[])[0]!.tools;
    expect(s.images).toHaveLength(1);
    expect(tools[0]!.imageId).toBe(0);
    expect(tools[1]!.result).toBe('ok');
    expect(tools[1]!.pending).toBeFalsy();
  });

  test('onEntry sees each parsed object once, before any filter', () => {
    const seen: unknown[] = [];
    new TranscriptParser({ onEntry: entry => seen.push(entry) }).feed(`${corpus['a queue with enqueue, dequeue, remove, popAll and a queued attachment']!.join('\n')}\n[1]\nnope\n`);
    expect(seen).toHaveLength(corpus['a queue with enqueue, dequeue, remove, popAll and a queued attachment']!.length);
  });
});
