import { describe, expect, test } from 'bun:test';
import { ChatLens, ParentScan, parentFinished, type ChatHub, type TranscriptIo } from '../server/chat.ts';
import { parseTranscript, TranscriptParser, type ChatEvent, type ParseOpts, type Queued, type TranscriptImage } from '../shared/chat.ts';
import type { State } from '../shared/types.ts';

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

  test('the parent scan fused into the parse equals parentFinished', () => {
    const note = (id: string) => user('n', `<task-notification><task-id>ag-${id}</task-id><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>`, 5);
    const text = [
      assistant('a1', [use('fg', 'Task', { description: 'x' }), use('bg', 'Agent', { run_in_background: 'true' }), use('bg2', 'Agent', { run_in_background: true })], 1),
      user('u1', [result('fg', 'done'), result('bg', 'Async agent launched: id')], 2),
      note('bg'),
      'not json',
    ].join('\n');
    const scan = new ParentScan();
    parseTranscript(text, { onEntry: scan.entry });
    const fused = scan.done(), whole = parentFinished(text);
    expect([...fused.finished].sort()).toEqual(['bg', 'fg']);
    expect(fused).toEqual(whole);
  });
});

// The lens resumes a growing Claude transcript: `range` reads only the new bytes, and the state
// it keeps must equal today's whole-file lens over the complete lines.

const sid = '77777777-7777-7777-7777-777777777777';
const paneKey = 'local/fake/p1';
const encode = (text: string) => new TextEncoder().encode(text);
const lensHub = (): ChatHub => ({
  resolvePane: () => ({ paneId: 'p1', entry: { mux: { kind: 'herdr' }, tree: { panes: [{ id: 'p1', agentSession: sid }] } } }),
  state: async () => ({ panes: [{ key: paneKey, cwd: '/repo' }] }) as State,
  paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
});

/** The main transcript as bytes, re-stat per call, with counters on both reads; `whole` drops
 *  `range`, which is today's lens. */
function growing(text = '', agents: { id: string; meta: string }[] = [], whole = false) {
  const state = { bytes: encode(text), inode: '1', agents };
  const calls = { read: 0, ranges: [] as [number, number][] };
  const io: TranscriptIo = {
    stat: async path => path.endsWith(`${sid}.jsonl`) ? { inode: state.inode, size: state.bytes.length, mtime: Bun.hash(state.bytes).toString(36) } : undefined,
    read: async () => { calls.read++; return new TextDecoder().decode(state.bytes); },
    ...(whole ? {} : { range: async (_path: string, start: number, end: number) => { calls.ranges.push([start, end]); return state.bytes.slice(start, end); } }),
    subagents: async () => ({ mtime: Bun.hash(JSON.stringify(state.agents)).toString(36), agents: state.agents.map(agent => ({ ...agent })) }),
  };
  const events: ChatEvent[] = [];
  const lens = new ChatLens(lensHub(), io, '/home/tama');
  lens.onChat = event => events.push(event);
  const append = (more: string | Uint8Array) => {
    const add = typeof more === 'string' ? encode(more) : more;
    const next = new Uint8Array(state.bytes.length + add.length);
    next.set(state.bytes);
    next.set(add, state.bytes.length);
    state.bytes = next;
  };
  return { state, calls, events, lens, append };
}

/** The lens's whole cached state: Turns, queue and every side map it serves by id. */
async function seen(lens: ChatLens) {
  await lens.query(paneKey);
  const value = (lens as unknown as { cache: Map<string, Record<string, unknown>> }).cache.get(paneKey)!;
  const pairs = (map: unknown) => [...(map as Map<unknown, unknown>)];
  return structuredClone({ turns: value.turns, queued: value.queued, images: value.images, previews: value.previews, previewFiles: pairs(value.previewFiles), outputs: pairs(value.outputs), details: pairs(value.details) });
}

/** Today's lens (a whole read, `parseTranscript`) over the bytes `[0, lastNewline + 1)`. */
async function reference(bytes: Uint8Array, agents: { id: string; meta: string }[] = []) {
  const ref = growing(new TextDecoder().decode(bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1)), [...agents], true);
  const out = await seen(ref.lens);
  ref.lens.close();
  return out;
}

const text = (uuid: string, words: string, n: number) => assistant(uuid, [{ type: 'text', text: words }], n);
const ids = async (lens: ChatLens) => (await lens.query(paneKey))!.turns.map(turn => turn.id);

describe('the lens resumes a growing Claude transcript', () => {
  test('an append reads only the 4 KB mark and the new bytes, and never the whole file', async () => {
    const g = growing(`${user('u1', 'x'.repeat(6000), 1)}\n`);
    await g.lens.query(paneKey);
    const before = g.state.bytes.length;
    g.append(`${text('a1', 'ok', 2)}\n`);
    expect(await ids(g.lens)).toEqual(['u1', 'a1']);
    expect(g.calls.ranges).toEqual([[0, before], [before - 4096, g.state.bytes.length]]);
    expect(g.calls.read).toBe(0);
    g.lens.close();
  });

  test('a result landing on an old row upserts that Turn', async () => {
    const g = growing(`${[assistant('a1', [use('t1', 'Bash', { command: 'ls' })], 1), text('a2', 'Waiting.', 2), user('u1', 'status?', 3)].join('\n')}\n`);
    const { cursor } = (await g.lens.delta(paneKey, 'unknown'))!;
    g.append(`${user('u2', [result('t1', 'ok')], 4)}\n`);
    const delta = (await g.lens.delta(paneKey, cursor))!;
    expect(delta.reset).toBe(false);
    expect(delta.upserts.map(turn => turn.id)).toEqual(['a1']);
    expect(delta.upserts[0]!.tools[0]).toMatchObject({ id: 't1', result: 'ok' });
    g.lens.close();
  });

  test('a partial last line is held, and shows once its newline lands', async () => {
    const g = growing(`${user('u1', 'hi', 1)}\n`);
    await g.lens.query(paneKey);
    const next = text('a1', 'Hello there.', 2);
    g.append(next.slice(0, 20));
    expect(await ids(g.lens)).toEqual(['u1']);
    g.append(next.slice(20)); // whole JSON, but no newline yet
    expect(await ids(g.lens)).toEqual(['u1']);
    g.append('\n');
    expect(await ids(g.lens)).toEqual(['u1', 'a1']);
    expect(g.calls.read).toBe(0);
    g.lens.close();
  });

  test('multibyte characters torn across appends decode whole', async () => {
    const g = growing(`${user('u1', 'hi', 1)}\n`);
    await g.lens.query(paneKey);
    const bytes = encode(`${text('a1', 'Café 😀 done', 2)}\n`);
    const e = bytes.indexOf(0xc3), emoji = bytes.indexOf(0xf0);
    g.append(bytes.subarray(0, e + 1)); // inside "é"
    await g.lens.query(paneKey);
    g.append(bytes.subarray(e + 1, emoji + 2)); // inside the emoji
    await g.lens.query(paneKey);
    g.append(bytes.subarray(emoji + 2));
    expect((await g.lens.query(paneKey))!.turns.at(-1)!.text).toBe('Café 😀 done');
    g.lens.close();
  });

  for (const change of ['a truncation', 'a new inode', 'a rewritten prefix on the same inode'] as const) {
    test(`${change} parses fresh`, async () => {
      const g = growing(`${[user('u1', 'x'.repeat(5000), 1), text('a1', 'two', 2), user('u2', 'three', 3)].join('\n')}\n`);
      await g.lens.query(paneKey);
      if (change === 'a truncation') g.state.bytes = encode(`${user('u1', 'x'.repeat(5000), 1)}\n`);
      if (change === 'a new inode') { g.state.inode = '2'; g.append(`${text('a2', 'four', 4)}\n`); }
      if (change === 'a rewritten prefix on the same inode') g.state.bytes = encode(`${[user('u9', 'y'.repeat(5000), 1), text('a9', 'other', 2), user('u8', 'longer than before', 3), text('a8', 'yes', 4)].join('\n')}\n`);
      expect(await seen(g.lens)).toEqual(await reference(g.state.bytes));
      expect(g.calls.ranges.at(-1)).toEqual([0, g.state.bytes.length]); // the fresh read starts at byte 0
      expect(g.calls.read).toBe(0);
      g.lens.close();
    });
  }

  test("a pending tool's whole detail is cut again once its result lands", async () => {
    const command = long('step');
    const g = growing(`${assistant('a1', [use('t1', 'Bash', { command })], 1)}\n`);
    const pending = (await g.lens.query(paneKey))!.turns[0]!.tools[0]!;
    expect(pending.detail).toBe(command);
    expect(pending.detailTruncated).toBeUndefined();
    g.append(`${user('u1', [result('t1', 'ok')], 2)}\n`);
    expect((await g.lens.query(paneKey))!.turns[0]!.tools[0]).toMatchObject({ detailTruncated: true, detailLines: 120, result: 'ok' });
    expect(await g.lens.output(paneKey, 't1', undefined, 'detail')).toEqual({ text: command });
    expect(await seen(g.lens)).toEqual(await reference(g.state.bytes));
    g.lens.close();
  });

  test('queued follows a dequeue after an append', async () => {
    const g = growing(`${[user('u1', 'go', 1), op('enqueue', 2, 'next please')].join('\n')}\n`);
    expect((await g.lens.query(paneKey))!.queued?.map(item => item.text)).toEqual(['next please']);
    g.append(`${op('dequeue', 3)}\n`);
    expect((await g.lens.query(paneKey))!.queued).toBeUndefined();
    g.lens.close();
  });

  test('one onChat per generation', async () => {
    const g = growing(`${user('u1', 'a', 1)}\n`);
    await g.lens.query(paneKey);
    g.append(`${text('a1', 'b', 2)}\n`);
    await g.lens.query(paneKey);
    await g.lens.query(paneKey); // the bytes stood still: no generation
    g.append('{"partial'); // the bytes moved, no Turn did: still a generation
    await g.lens.query(paneKey);
    expect(new Set(g.events.map(event => event.cursor)).size).toBe(3);
    expect(g.events).toHaveLength(3);
    g.lens.close();
  });

  test('a Task row fed before its subagent was listed gains the link', async () => {
    const g = growing(`${[user('u1', 'go', 1), assistant('a1', [use('toolu_t1', 'Task', { prompt: 'x' })], 2)].join('\n')}\n`);
    expect((await g.lens.query(paneKey))!.turns[1]!.tools[0]!.subagentId).toBeUndefined();
    g.state.agents.push({ id: 'sub1', meta: JSON.stringify({ agentType: 'recon', toolUseId: 'toolu_t1' }) });
    g.append(`${text('a2', 'Waiting.', 3)}\n`);
    expect((await g.lens.query(paneKey))!.turns[1]!.tools[0]!.subagentId).toBe('sub1');
    expect(await seen(g.lens)).toEqual(await reference(g.state.bytes, g.state.agents));
    g.lens.close();
  });

  test('after every append in a random sequence, the state equals the whole-file parse of the complete lines', async () => {
    const lines = [
      ...Object.values(corpus).flat(),
      text('m1', 'Café 😀 — naïve', 20),
      assistant('p1', [use('pd', 'Bash', { command: long('pending') })], 21),
      user('p2', [result('pd', 'ok')], 22),
      assistant('p3', [use('pz', 'Bash', { command: long('abandoned') })], 23),
      user('p4', 'never mind', 24), // pz stops pending without a result
      op('enqueue', 25, 'later'),
      op('dequeue', 26),
    ];
    const bytes = encode(`${lines.join('\n')}\n`);
    expect(bytes.length).toBeGreaterThan(4096 * 2); // the mark sits mid-file
    const rand = prng(7);
    for (let round = 0; round < 8; round++) {
      const g = growing();
      const cuts = [...new Set(Array.from({ length: 12 }, () => 1 + Math.floor(rand() * bytes.length)))].sort((a, b) => a - b);
      for (const cut of [...cuts, bytes.length]) {
        g.state.bytes = bytes.slice(0, cut);
        expect(await seen(g.lens)).toEqual(await reference(g.state.bytes));
      }
      expect(g.calls.read).toBe(0);
      // One read per append, each resuming 4 KB before where the last one ended: no fresh parse.
      expect(g.calls.ranges).toHaveLength(cuts.length + 1);
      g.calls.ranges.forEach(([start], i) => expect(start).toBe(i ? Math.max(0, g.calls.ranges[i - 1]![1] - 4096) : 0));
      g.lens.close();
    }
  });
});

// Opt-in: TAUTAN_TRANSCRIPT=<a real Claude .jsonl> checks the resumable parse against a whole file.
describe('a real transcript', () => {
  test.skipIf(!process.env.TAUTAN_TRANSCRIPT)('the incremental parse equals the one-shot parse at every cut', async () => {
    const bytes = new Uint8Array(await Bun.file(process.env.TAUTAN_TRANSCRIPT!).arrayBuffer());
    const decoder = new TextDecoder();
    const whole = oneShot(decoder.decode(bytes));

    // Line by line.
    const s = sides();
    const parser = new TranscriptParser(opts(s));
    const all = decoder.decode(bytes);
    for (let at = 0; at < all.length;) {
      const nl = all.indexOf('\n', at);
      const end = nl < 0 ? all.length : nl + 1;
      parser.feed(all.slice(at, end));
      at = end;
    }
    s.queued.push(...parser.queued());
    expect(snap(parser.turns, s)).toEqual(whole);

    // 50 seeded byte cuts; the partial line waits as bytes, as the lens holds it.
    const rand = prng(2026);
    const cuts = Array.from({ length: 50 }, () => 1 + Math.floor(rand() * bytes.length)).sort((a, b) => a - b);
    const t = sides();
    const inc = new TranscriptParser(opts(t));
    let held = new Uint8Array(0), at = 0;
    for (const cut of cuts) {
      const joined = new Uint8Array(held.length + cut - at);
      joined.set(held);
      joined.set(bytes.subarray(at, cut), held.length);
      at = cut;
      const end = joined.lastIndexOf(0x0a) + 1;
      if (end) inc.feed(decoder.decode(joined.subarray(0, end)));
      held = joined.slice(end);
      const complete = bytes.subarray(0, at - held.length);
      const reference = oneShot(decoder.decode(complete));
      const u = { ...t, queued: inc.queued() };
      expect(snap(inc.turns, u)).toEqual(reference);
    }
  }, 600_000);
});
