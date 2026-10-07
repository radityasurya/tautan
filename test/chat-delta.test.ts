import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatLens, type ChatHub, type TranscriptIo } from '../server/chat.ts';
import type { ChatEvent } from '../shared/chat.ts';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, ScreenMode, State, Tree, Workspace } from '../shared/types.ts';

const id = '66666666-6666-6666-6666-666666666666';
const paneKey = 'local/fake/p1';
const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

/** A herdr-style Hub reporting one Claude pane; the transcript never touches the filesystem. */
const chatHub = (): ChatHub => ({
  resolvePane: () => ({ paneId: 'p1', entry: { mux: { kind: 'herdr' }, tree: { panes: [{ id: 'p1', agentSession: id }] } } }),
  state: async () => ({ panes: [{ key: paneKey, cwd: '/repo' }] }) as State,
  paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
});

/** One mutable conversation: main and subagent texts plus the subagents tree, re-stat per call. */
function fixture(main = '', sub: string | undefined = undefined, agents: { id: string; meta: string }[] = []) {
  const state = { main, sub, agents };
  const text = (path: string) => path.includes('/subagents/') ? state.sub : state.main;
  const io: TranscriptIo = {
    stat: async path => { const value = text(path); return value === undefined ? undefined : { inode: '1', size: value.length, mtime: Bun.hash(value).toString(36) }; },
    read: async path => text(path)!,
    subagents: async () => ({ mtime: Bun.hash(JSON.stringify(state.agents)).toString(36), agents: state.agents.map(agent => ({ ...agent })) }),
  };
  const events: ChatEvent[] = [];
  const lens = new ChatLens(chatHub(), io, '/home/tama');
  lens.onChat = event => events.push(event);
  return { state, io, events, lens };
}

describe('ChatLens deltas (ADR 0007)', () => {
  test('a delta after one appended turn carries only the new turn', async () => {
    const { state, events, lens } = fixture(line({ uuid: 'run1', type: 'user', message: { content: 'Check the logs.' } }));
    const first = await lens.delta(paneKey, 'unknown');
    // Bun's toMatchObject replaces a received property with an expect.any matcher, so the
    // cursor is read before any matcher touches it.
    const cursor = first!.cursor;
    expect(first).toMatchObject({ sessionId: id, reset: true });
    expect(typeof cursor).toBe('string');
    expect(first!.upserts.map(turn => [turn.id, turn.text])).toEqual([['run1', 'Check the logs.']]);
    expect(first!.subagents).toEqual([]); // a reset always carries the whole tree

    state.main += '\n' + line({ uuid: 'run2', type: 'assistant', message: { content: [{ type: 'text', text: 'All clear.' }] } });
    const delta = await lens.delta(paneKey, cursor);
    expect(delta).toMatchObject({ sessionId: id, reset: false });
    expect(delta!.cursor).not.toBe(cursor);
    expect(delta!.upserts).toEqual([{ id: 'run2', role: 'assistant', text: 'All clear.', tools: [] }]);
    expect(delta!.subagents).toBeUndefined(); // the tree did not change
    expect((await lens.delta(paneKey, delta!.cursor))!.upserts).toEqual([]); // nothing since its own cursor
    expect((await lens.delta(paneKey, cursor))!.upserts.map(turn => turn.id)).toEqual(['run2']); // the old cursor still diffs
    expect(events).toEqual([{ pane: paneKey, cursor }, { pane: paneKey, cursor: delta!.cursor }]);
    lens.close();
  });

  test('a result arriving on an old tool row re-sends that turn as changed', async () => {
    const { state, lens } = fixture([
      line({ uuid: 'run1', type: 'user', message: { content: 'Run the suite.' } }),
      line({ uuid: 'run2', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'bun test' } }] } }),
    ].join('\n'));
    const { cursor } = (await lens.delta(paneKey, 'unknown'))!;
    state.main += '\n' + line({ uuid: 'run3', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: 'ok' }] } });
    const delta = await lens.delta(paneKey, cursor);
    expect(delta!.reset).toBe(false);
    expect(delta!.upserts).toHaveLength(1); // run1 unchanged, run3 makes no turn of its own
    expect(delta!.upserts[0]).toMatchObject({ id: 'run2' });
    expect(delta!.upserts[0]!.tools[0]).toMatchObject({ id: 'toolu_b1', result: 'ok', resultLines: 1 });
    expect(delta!.upserts[0]!.tools[0]!.resultTruncated).toBeUndefined();
    lens.close();
  });

  test('a cursor from before a restart answers a full reset', async () => {
    const { state, io, lens } = fixture(line({ uuid: 'run1', type: 'user', message: { content: 'hi' } }));
    const { cursor } = (await lens.delta(paneKey, 'unknown'))!;
    lens.close();
    state.main += '\n' + line({ uuid: 'run2', type: 'assistant', message: { content: 'again' } }); // a user entry would merge into run1's turn
    const fresh = new ChatLens(chatHub(), io, '/home/tama');
    const again = await fresh.delta(paneKey, cursor);
    expect(again?.reset).toBe(true);
    expect(again?.upserts).toHaveLength(2);
    fresh.close();
  });

  test('a transcript without native ids answers reset every time', async () => {
    const { state, lens } = fixture(line({ type: 'user', message: { content: 'no uuids here' } }));
    const first = await lens.delta(paneKey, 'unknown');
    expect(first?.reset).toBe(true);
    state.main += '\n' + line({ type: 'assistant', message: { content: 'reply' } });
    const second = await lens.delta(paneKey, first!.cursor);
    expect(second?.reset).toBe(true); // no fingerprints are kept, so a moved cursor still resets
    expect(second?.upserts).toHaveLength(2);
    lens.close();
  });

  test('a transcript without native ids answers a quiet delta for the cursor it holds', async () => {
    const { lens } = fixture(line({ type: 'user', message: { content: 'no uuids here' } }));
    const first = await lens.delta(paneKey, 'unknown');
    const cursor = first!.cursor;
    expect(first?.reset).toBe(true);
    const again = await lens.delta(paneKey, cursor);
    expect(again).toMatchObject({ sessionId: id, reset: false, upserts: [] });
    expect(again!.cursor).toBe(cursor);
    expect(again!.subagents).toBeUndefined(); // the quiet answer re-renders nothing
    lens.close();
  });

  test('a result past 40 lines keeps its tail inline and serves the whole text by tool id', async () => {
    const lines = Array.from({ length: 60 }, (_, n) => `line ${n + 1}`);
    const { lens } = fixture([
      line({ uuid: 'run1', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'heavy' } }] } }),
      line({ uuid: 'run2', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: lines.join('\n') }] } }),
    ].join('\n'));
    const chat = await lens.query(paneKey);
    const tool = chat!.turns[0]!.tools[0]!;
    expect(tool.resultLines).toBe(60);
    expect(tool.resultTruncated).toBe(true);
    expect(tool.result).toBe(`…\n${lines.slice(20).join('\n')}`);
    expect(await lens.output(paneKey, 'toolu_big')).toEqual({ text: lines.join('\n') });
    expect(await lens.output(paneKey, 'toolu_none')).toEqual({ text: undefined });
    expect(await lens.output('local/fake/p9', 'toolu_big')).toBeUndefined();
    lens.close();
  });

  test('a transient stat miss keeps the remembered generations', async () => {
    const { state, io, lens } = fixture(line({ uuid: 'run1', type: 'user', message: { content: 'hi' } }));
    const old = (await lens.delta(paneKey, 'unknown'))!.cursor;
    state.main += '\n' + line({ uuid: 'run2', type: 'assistant', message: { content: 'again' } });
    await lens.delta(paneKey, old); // two generations remembered
    const realStat = io.stat;
    let missed = false;
    io.stat = async (path, target) => { if (!missed) { missed = true; return undefined; } return realStat(path, target); };
    expect(await lens.query(paneKey)).toBeUndefined(); // the blip
    const after = await lens.delta(paneKey, old);
    expect(after?.reset).toBe(false); // the older baseline survived it
    expect(after!.upserts.map(turn => turn.id)).toEqual(['run2']);
    lens.close();
  });

  test('a pasted image rides out of band under the shared image numbering', async () => {
    const png = 'iVBORw0KGgo=';
    const { lens } = fixture(line({ uuid: 'run1', type: 'user', message: { content: [
      { type: 'text', text: 'See this:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ] } }));
    const chat = await lens.query(paneKey);
    expect(chat!.turns[0]!.images).toEqual([{ imageId: 0 }]);
    expect(JSON.stringify(chat)).not.toContain('data:image');
    const image = (await lens.image(paneKey, 0))?.image;
    expect(Buffer.from(image!.bytes).toString('base64')).toBe(png);
    lens.close();
  });

  test('a subagent view keeps its own cursor, and its tree rides only when it changed', async () => {
    const { state, events, lens } = fixture(
      [
        line({ uuid: 'run1', type: 'user', message: { content: 'Draft it.' } }),
        line({ uuid: 'run2', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_t1', name: 'Task', input: { prompt: 'x' } }] } }),
      ].join('\n'),
      line({ uuid: 's1', type: 'user', isSidechain: true, message: { content: 'Drafting.' } }),
      [{ id: 'sub1', meta: JSON.stringify({ agentType: 'recon', toolUseId: 'toolu_t1' }) }],
    );
    const first = await lens.delta(paneKey, 'unknown', 'sub1');
    expect(first).toMatchObject({ reset: true, agent: 'sub1' });
    expect(first!.upserts.map(turn => [turn.id, turn.text])).toEqual([['s1', 'Drafting.']]);
    expect(first!.subagents?.map(item => item.id)).toEqual(['sub1']);
    const cursor = first!.cursor;
    expect((await lens.delta(paneKey, 'unknown'))!.cursor).not.toBe(cursor); // its own cursor, not the main view's

    state.sub += '\n' + line({ uuid: 's2', type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Done.' }] } });
    const delta = await lens.delta(paneKey, cursor, 'sub1');
    expect(delta!.reset).toBe(false);
    expect(delta!.upserts.map(turn => [turn.id, turn.text])).toEqual([['s2', 'Done.']]);
    expect(delta!.subagents).toBeUndefined(); // the tree did not change
    expect(events.at(-1)).toEqual({ pane: paneKey, cursor: delta!.cursor, agent: 'sub1' });

    state.agents.push({ id: 'sub2', meta: JSON.stringify({ agentType: 'worker' }) });
    const grown = await lens.delta(paneKey, cursor, 'sub1');
    expect(grown!.reset).toBe(false);
    expect(grown!.upserts.map(turn => turn.id)).toEqual(['s2']);
    expect(grown!.subagents?.map(item => item.id)).toEqual(['sub1', 'sub2']); // the tree changed
    lens.close();
  });
});

// The routes run against a real Hub pane; the transcript comes through an injected ChatLens,
// the same seam as chat-image.test.ts.
describe('chat delta routes', () => {
  let stateHome: string, hub: Hub, lens: ChatLens;
  let handle: (request: Request) => Response | Promise<Response>;
  const lines = Array.from({ length: 60 }, (_, n) => `line ${n + 1}`);
  const png = 'iVBORw0KGgo=';
  const state = { main: '' };
  const chat = (suffix = '', headers?: HeadersInit) =>
    handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent(paneKey)}/chat${suffix}`, { headers }));

  beforeAll(async () => {
    const oldState = process.env.XDG_STATE_HOME;
    stateHome = mkdtempSync(join(tmpdir(), 'tautan-chat-delta-'));
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const cwd = '/repo';
      const tree: Tree = {
        workspaces: [{ id: 'w1', label: 'Repo', cwd }],
        tabs: [{ id: 't1', workspaceId: 'w1', label: 'T' }],
        panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'claude', cwd, agentSession: id, status: 'idle' as const, revision: 0 }],
      };
      const mux: Mux = { kind: 'herdr', id: 'fake', tree: async () => tree, read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }), sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); }, rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {} };
      hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); await hub.state();
      state.main = [
        line({ uuid: 'run1', type: 'user', message: { content: [
          { type: 'text', text: 'Check this.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ] } }),
        line({ uuid: 'run2', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'seq 60' } }] } }),
        line({ uuid: 'run3', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: lines.join('\n') }] } }),
      ].join('\n');
      const io: TranscriptIo = {
        stat: async () => state.main ? { inode: '1', size: state.main.length, mtime: Bun.hash(state.main).toString(36) } : undefined,
        read: async () => state.main,
      };
      lens = new ChatLens(chatHub(), io, '/home/tama');
      const serve = Bun.serve;
      try { Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve; startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: stateHome, chats: lens }); }
      finally { Bun.serve = serve; }
    } finally { process.env.XDG_STATE_HOME = oldState; }
  });
  afterAll(() => { lens.close(); hub.close(); rmSync(stateHome, { recursive: true, force: true }); });

  test('a plain GET keeps its ETag and 304; a ?since= GET always answers 200', async () => {
    const plain = await chat();
    expect(plain.status).toBe(200);
    const etag = plain.headers.get('etag')!;
    expect(etag).toMatch(/^"\w+"$/);
    expect((await chat('', { 'if-none-match': etag })).status).toBe(304);
    const start = await (await chat('?since=nope', { 'if-none-match': etag })).json();
    expect(start.reset).toBe(true); // unknown cursor: the whole conversation
    expect(start.upserts.map((turn: { id?: string }) => turn.id)).toEqual(['run1', 'run2']);
    const same = await chat(`?since=${encodeURIComponent(start.cursor)}`, { 'if-none-match': etag });
    expect(same.status).toBe(200); // a since GET ignores If-None-Match
    expect(await same.json()).toMatchObject({ reset: false, upserts: [] });
  });

  test('an appended turn answers a delta over HTTP', async () => {
    const start = await (await chat('?since=nope')).json();
    state.main += '\n' + line({ uuid: 'run4', type: 'user', message: { content: 'Again.' } });
    const delta = await (await chat(`?since=${encodeURIComponent(start.cursor)}`)).json();
    expect(delta).toMatchObject({ reset: false });
    expect(delta.upserts.map((turn: { id?: string; text: string }) => [turn.id, turn.text])).toEqual([['run4', 'Again.']]);
  });

  test('/chat/output/:toolId serves the whole sliced text; a malformed or unknown id answers 400 and 404', async () => {
    const response = await handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent(paneKey)}/chat/output/toolu_b1`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await response.text();
    expect(text.split('\n')).toHaveLength(60);
    expect(text.startsWith('line 1\n')).toBe(true); // the whole text, not the inline slice
    expect((await handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent(paneKey)}/chat/output/bad%20id`))).status).toBe(400);
    const unknown = await handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent(paneKey)}/chat/output/toolu_none`));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'no-output' });
    expect((await handle(new Request('http://tautan.test/api/panes/local%2Ffake%2Fp9/chat/output/toolu_b1'))).status).toBe(404); // no session
  });

  test('a pasted image serves from /chat/image/:id and no data URL rides the turns', async () => {
    const body = await (await chat()).json();
    expect(JSON.stringify(body)).not.toContain('data:image');
    expect(body.turns[0].images).toEqual([{ imageId: 0 }]);
    const image = await handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent(paneKey)}/chat/image/0`));
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer()).toString('base64')).toBe(png);
  });

  test('the events stream carries the chat wake-up for a watched Pane', async () => {
    const response = await handle(new Request(`http://tautan.test/api/events?pane=${encodeURIComponent(paneKey)}`));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const until = async (marker: string) => {
      while (!seen.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${marker}`);
        seen += decoder.decode(value);
      }
    };
    try {
      await until('event: state'); // the watcher registers in the same block that enqueues it
      state.main += '\n' + line({ uuid: 'run5', type: 'user', message: { content: 'Once more.' } });
      const fresh = await (await chat('?since=nope')).json(); // the GET that produces the generation
      await until('event: chat');
      expect(seen).toContain(`data: ${JSON.stringify({ pane: paneKey, cursor: fresh.cursor })}\n`);
    } finally { await reader.cancel(); }
  });
});
