import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatLens, localIo, transcriptDir, type ChatHub } from '../server/chat.ts';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, ScreenMode, State, Tree, Workspace } from '../shared/types.ts';

// Shapes sanitised from a real session: the main transcript beside a subagents/ folder of
// agent-<id>.jsonl conversations (every entry isSidechain) and agent-<id>.meta.json descriptors.
const id = '44444444-4444-4444-4444-444444444444';
const paneKey = 'local/fake/p1';
const png = 'iVBORw0KGgo=';
const subPng = 'PHN2Zz4=';
const page = '<html><head><title>Deck</title></head><body><p>main page</p></body></html>';
const subPage = '<html><head><title>Sub deck</title></head><body><p>sub page</p></body></html>';
const artifactUrl = 'https://claude.ai/code/artifact/ee67305a-ece1-4d62-b0b7';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const mainJsonl = [
  { type: 'user', timestamp: '2026-10-06T00:00:00.000Z', message: { content: 'Publish the deck.' } },
  { type: 'assistant', timestamp: '2026-10-06T00:00:01.000Z', message: { content: [
    { type: 'tool_use', id: 'toolu_t1', name: 'Task', input: { prompt: 'Draft the deck.' } },
    { type: 'tool_use', id: 'toolu_w1', name: 'Write', input: { file_path: '/tmp/deck.html', content: page } },
    { type: 'tool_use', id: 'toolu_a1', name: 'Artifact', input: { file_path: '/tmp/deck.html' } },
    { type: 'tool_use', id: 'toolu_r1', name: 'Read', input: { file_path: '/tmp/shot.png' } },
  ] } },
  { type: 'user', timestamp: '2026-10-06T00:00:02.000Z', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_a1', content: `Published /tmp/deck.html at ${artifactUrl}` },
    { type: 'tool_result', tool_use_id: 'toolu_r1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] },
  ] } },
].map(line).join('\n');
const t1Jsonl = [
  { type: 'user', isSidechain: true, timestamp: '2026-10-06T00:00:03.000Z', message: { content: 'Draft the deck.' } },
  { type: 'assistant', isSidechain: true, timestamp: '2026-10-06T00:00:04.000Z', message: { content: [
    { type: 'tool_use', id: 'toolu_t2', name: 'Task', input: { prompt: 'Polish.' } },
    { type: 'tool_use', id: 'toolu_w2', name: 'Write', input: { file_path: '/tmp/sub.html', content: subPage } },
    { type: 'tool_use', id: 'toolu_r2', name: 'Read', input: { file_path: '/tmp/sub.png' } },
  ] } },
  { type: 'user', isSidechain: true, timestamp: '2026-10-06T00:00:05.000Z', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_r2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: subPng } }] },
  ] } },
  { type: 'assistant', isSidechain: true, timestamp: '2026-10-06T00:00:06.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done drafting.' }] } },
].map(line).join('\n');
const t2Jsonl = [{ type: 'user', isSidechain: true, timestamp: '2026-10-06T00:00:04.500Z', message: { content: 'Polish.' } }].map(line).join('\n');
// No timestamp anywhere in t3's file: `at` falls back to the file's mtime.
const t3Jsonl = [{ type: 'user', isSidechain: true, message: { content: 'No timestamp.' } }].map(line).join('\n');

describe('chat subagents and previews', () => {
  let stateHome: string, home: string, hub: Hub, lens: ChatLens;
  let handle: (request: Request) => Response | Promise<Response>;
  let oldState: string | undefined;

  beforeAll(() => {
    oldState = process.env.XDG_STATE_HOME;
    stateHome = mkdtempSync(join(tmpdir(), 'tautan-chat-sub-'));
    process.env.XDG_STATE_HOME = stateHome;
    home = mkdtempSync(join(tmpdir(), 'tautan-chat-home-'));
    const sessionDir = transcriptDir('/repo', id, home);
    const subs = join(sessionDir, 'subagents');
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(sessionDir, '..', `${id}.jsonl`), mainJsonl); // the main transcript is a sibling of the session folder
    const meta = (name: string, body: Record<string, unknown>) => writeFileSync(join(subs, `agent-${name}.meta.json`), JSON.stringify(body));
    meta('t1aaaa', { agentType: 'recon', description: 'Draft the deck', toolUseId: 'toolu_t1' });
    writeFileSync(join(subs, 'agent-t1aaaa.jsonl'), t1Jsonl);
    meta('t2bbbb', { agentType: 'worker', description: 'Polish', toolUseId: 'toolu_t2', parentAgentId: 't1aaaa' });
    writeFileSync(join(subs, 'agent-t2bbbb.jsonl'), t2Jsonl);
    meta('t3cccc', { agentType: 'recon', description: 'Orphan parent', parentAgentId: 'zzzz9999' });
    writeFileSync(join(subs, 'agent-t3cccc.jsonl'), t3Jsonl);

    const cwd = '/repo';
    const tree: Tree = {
      workspaces: [{ id: 'w1', label: 'Repo', cwd }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'T' }],
      panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'claude', cwd, agentSession: id, status: 'idle' as const, revision: 0 }],
    };
    const mux: Mux = { kind: 'herdr', id: 'fake', tree: async () => tree, read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }), sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); }, rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {} };
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); void hub.state();
    const chatHub: ChatHub = {
      resolvePane: () => ({ paneId: 'p1', entry: { mux: { kind: 'herdr' }, tree: { panes: [{ id: 'p1', agentSession: id }] } } }),
      state: async () => ({ panes: [{ key: paneKey, cwd }] }) as State,
      paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
    };
    lens = new ChatLens(chatHub, localIo, home);
    const serve = Bun.serve;
    try { Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve; startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: stateHome, chats: lens }); }
    finally { Bun.serve = serve; }
  });
  afterAll(() => { lens.close(); hub.close(); rmSync(stateHome, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); process.env.XDG_STATE_HOME = oldState; });

  test('the main conversation lists the tree and links Task, preview and link rows', async () => {
    const chat = await lens.query(paneKey);
    expect(chat?.sessionId).toBe(id);
    expect(chat?.subagents?.map(item => item.id)).toEqual(['t1aaaa', 't2bbbb', 't3cccc']); // ordered by `at`
    expect(chat?.subagents?.[1]).toEqual({ id: 't2bbbb', type: 'worker', description: 'Polish', toolUseId: 'toolu_t2', parentId: 't1aaaa', at: Date.parse('2026-10-06T00:00:04.500Z'), updatedAt: expect.any(Number), state: 'running' });
    // t1 ended with a final assistant message; the others are fresh and unfinished. t2's Task
    // rows sit in t1's file, not the main transcript, so only the ending and freshness judge it.
    expect(chat?.subagents?.map(item => item.state)).toEqual(['done', 'running', 'running']);
    expect(chat?.subagents?.[2]!.parentId).toBeUndefined(); // a parent id outside the list is dropped
    const [task, write, artifact, read] = chat!.turns[1]!.tools;
    expect(task!.subagentId).toBe('t1aaaa');
    expect(write!.previewId).toBe(0);
    expect(artifact!.previewId).toBe(0);
    expect(artifact!.link).toEqual({ url: artifactUrl, title: 'Deck' });
    expect(read!.imageId).toBe(0);
    expect(JSON.stringify(chat)).not.toContain('<title>'); // previews stay out of the chat JSON
  });

  test('a subagent conversation parses with its sidechain entries and its own numbering', async () => {
    const sub = await lens.query(paneKey, 't1aaaa');
    expect(sub?.agent).toBe('t1aaaa');
    expect(sub?.sessionId).toBe(id);
    expect(sub?.subagents?.map(item => item.id)).toEqual(['t1aaaa', 't2bbbb', 't3cccc']);
    expect(sub!.turns[0]!.text).toBe('Draft the deck.'); // isSidechain entries show in the agent's own file
    const [task, write] = sub!.turns[1]!.tools;
    expect(task!.subagentId).toBe('t2bbbb'); // a nested Task links inside the subagent's file
    expect(write!.previewId).toBe(0); // numbered within the subagent's conversation
    expect((await lens.preview(paneKey, 0))?.html).toBe(page);
    expect((await lens.preview(paneKey, 0, 't1aaaa'))?.html).toBe(subPage);
    expect(await lens.preview(paneKey, 1, 't1aaaa')).toEqual({ html: undefined });
    expect(Buffer.from((await lens.image(paneKey, 0, 't1aaaa'))!.image!.bytes).toString('base64')).toBe(subPng);
    expect(Buffer.from((await lens.image(paneKey, 0))!.image!.bytes).toString('base64')).toBe(png);
  });

  test('the directory listing reads first timestamps and falls back to mtimes', async () => {
    const home2 = mkdtempSync(join(tmpdir(), 'tautan-chat-dir-'));
    try {
      const dir = join(transcriptDir('/repo', id, home2), 'subagents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent-stamped.meta.json'), JSON.stringify({ agentType: 'recon' }));
      writeFileSync(join(dir, 'agent-stamped.jsonl'), line({ type: 'user', isSidechain: true, timestamp: '2026-10-06T00:00:03.000Z', message: { content: 'x' } }));
      writeFileSync(join(dir, 'agent-plain.meta.json'), JSON.stringify({ agentType: 'worker' }));
      writeFileSync(join(dir, 'agent-plain.jsonl'), line({ type: 'user', isSidechain: true, message: { content: 'x' } }));
      const found = await localIo.subagents!(dir);
      expect(found?.agents.map(agent => agent.id)).toEqual(['plain', 'stamped']); // readdir order; `at` orders the tree
      expect(found?.agents.find(agent => agent.id === 'stamped')!.at).toBe(Date.parse('2026-10-06T00:00:03.000Z'));
      expect(typeof found?.agents.find(agent => agent.id === 'plain')!.at).toBe('number');
      expect(await localIo.subagents!(join(home2, 'missing'))).toBeUndefined();
    } finally { rmSync(home2, { recursive: true, force: true }); }
  });

  const get = (path: string) => handle(new Request(`http://tautan.test${path}`));
  const key = encodeURIComponent(paneKey);

  test('GET /chat lists subagents, links and preview ids', async () => {
    const response = await get(`/api/panes/${key}/chat`);
    expect(response.status).toBe(200);
    const chat = await response.json();
    expect(chat.subagents.map((item: { id: string }) => item.id)).toEqual(['t1aaaa', 't2bbbb', 't3cccc']);
    expect(chat.turns[1].tools[0].subagentId).toBe('t1aaaa');
    expect(chat.turns[1].tools[2].link).toEqual({ url: artifactUrl, title: 'Deck' });
    expect(chat.turns[1].tools[1].previewId).toBe(0);
    expect(JSON.stringify(chat)).not.toContain('<title>');
  });

  test('GET /chat answers 304 to a matching If-None-Match until the transcript moves', async () => {
    const first = await get(`/api/panes/${key}/chat`);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-z]+"$/);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const again = await handle(new Request(`http://tautan.test/api/panes/${key}/chat`, { headers: { 'if-none-match': `"other", W/${etag}` } }));
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(await again.text()).toBe('');
    // A subagent's conversation carries its own tag.
    const sub = await get(`/api/panes/${key}/chat?agent=t1aaaa`);
    expect(sub.headers.get('etag')).not.toBe(etag);
    // An appended line moves the signature: a new tag and a full body.
    const file = join(transcriptDir('/repo', id, home), '..', `${id}.jsonl`);
    writeFileSync(file, `${mainJsonl}\n${line({ type: 'assistant', timestamp: '2026-10-06T00:00:09.000Z', message: { content: [{ type: 'text', text: 'More.' }] } })}`);
    const moved = await handle(new Request(`http://tautan.test/api/panes/${key}/chat`, { headers: { 'if-none-match': etag } }));
    expect(moved.status).toBe(200);
    expect(moved.headers.get('etag')).not.toBe(etag);
    expect((await moved.json()).turns.at(-1).text).toBe('More.');
    writeFileSync(file, mainJsonl);
  });

  test('GET /chat?agent= serves the subagent conversation; unknown or malformed ids give no-agent', async () => {
    const ok = await get(`/api/panes/${key}/chat?agent=t1aaaa`);
    expect(ok.status).toBe(200);
    const chat = await ok.json();
    expect(chat.agent).toBe('t1aaaa');
    expect(chat.sessionId).toBe(id);
    expect(chat.turns[0].text).toBe('Draft the deck.');
    expect(chat.subagents).toHaveLength(3);
    for (const bad of ['nope', 'bad id', `${'x'.repeat(65)}`, '']) {
      const response = await get(`/api/panes/${key}/chat?agent=${encodeURIComponent(bad)}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'no-agent' });
    }
  });

  test('GET /chat/preview/:id serves the HTML under the sandbox headers, numbered per conversation', async () => {
    const response = await get(`/api/panes/${key}/chat/preview/0`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(page);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; media-src data: https:");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const sub = await get(`/api/panes/${key}/chat/preview/0?agent=t1aaaa`);
    expect(await sub.text()).toBe(subPage);
  });

  test('GET /chat/preview/:id answers 400, no-preview and no-agent', async () => {
    expect((await get(`/api/panes/${key}/chat/preview/x`)).status).toBe(400);
    const missing = await get(`/api/panes/${key}/chat/preview/1`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'no-preview' });
    const badAgent = await get(`/api/panes/${key}/chat/preview/0?agent=nope`);
    expect(badAgent.status).toBe(404);
    expect(await badAgent.json()).toEqual({ error: 'no-agent' });
  });

  test('a quiet unfinished file reads done, and the state moves the ETag with the transcript still', async () => {
    const file = join(transcriptDir('/repo', id, home), 'subagents', 'agent-t3cccc.jsonl');
    const etag = (await lens.tagged(paneKey))!.etag;
    const stale = Date.now() / 1000 - 200;
    utimesSync(file, stale, stale); // the process died: nothing else will move
    const chat = await lens.query(paneKey);
    expect(chat?.subagents?.find(item => item.id === 't3cccc')!.state).toBe('done');
    expect(chat?.subagents?.find(item => item.id === 't2bbbb')!.state).toBe('running');
    const moved = (await lens.tagged(paneKey))!.etag;
    expect(moved).not.toBe(etag);
    const again = await handle(new Request(`http://tautan.test/api/panes/${key}/chat`, { headers: { 'if-none-match': etag } }));
    expect(again.status).toBe(200); // the digest, not the transcript, moved the tag
    utimesSync(file, Date.now() / 1000, Date.now() / 1000);
  });

  test('a background Task reads done only once its notification lands in the parent', async () => {
    const bgHome = mkdtempSync(join(tmpdir(), 'tautan-chat-bg-'));
    const sid = '55555555-5555-5555-5555-555555555555';
    const bgKey = 'local/fake/p9';
    let bgLens: ChatLens | undefined;
    try {
      const dir = transcriptDir('/repo', sid, bgHome);
      mkdirSync(join(dir, 'subagents'), { recursive: true });
      const main = [
        line({ type: 'user', timestamp: '2026-10-06T00:00:00.000Z', message: { content: 'Go.' } }),
        line({ type: 'assistant', timestamp: '2026-10-06T00:00:01.000Z', message: { content: [
          { type: 'tool_use', id: 'toolu_bg1', name: 'Task', input: { prompt: 'Scan.', run_in_background: true } },
        ] } }),
      ].join('\n');
      writeFileSync(join(dir, '..', `${sid}.jsonl`), main);
      writeFileSync(join(dir, 'subagents', 'agent-bg11111.meta.json'), JSON.stringify({ agentType: 'recon', toolUseId: 'toolu_bg1' }));
      writeFileSync(join(dir, 'subagents', 'agent-bg11111.jsonl'), t2Jsonl); // fresh, ends on a user entry
      const chatHub: ChatHub = {
        resolvePane: () => ({ paneId: 'p9', entry: { mux: { kind: 'herdr' }, tree: { panes: [{ id: 'p9', agentSession: sid }] } } }),
        state: async () => ({ panes: [{ key: bgKey, cwd: '/repo' }] }) as State,
        paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
      };
      bgLens = new ChatLens(chatHub, localIo, bgHome);
      expect((await bgLens.query(bgKey))?.subagents?.[0]!.state).toBe('running'); // the tool_result came back at once
      writeFileSync(join(dir, '..', `${sid}.jsonl`), `${main}\n${line({ type: 'user', timestamp: '2026-10-06T00:00:09.000Z', message: { content: [
        { type: 'text', text: '<task-notification><task-id>bg11111</task-id><tool-use-id>toolu_bg1</tool-use-id><status>completed</status></task-notification>' },
      ] } })}`);
      expect((await bgLens.query(bgKey))?.subagents?.[0]!.state).toBe('done');
      expect((await bgLens.query(bgKey))!.turns.map(turn => turn.role)).toEqual(['user', 'assistant']); // the wrapper line stays out
    } finally { bgLens?.close(); rmSync(bgHome, { recursive: true, force: true }); }
  });
});
