import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatLens, localIo, type ChatHub } from '../server/chat.ts';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, ScreenMode, State, Tree, Workspace } from '../shared/types.ts';

// Shapes sanitised from real pi transcripts (pi-agents' `Agent` tool): the parent's toolCalls
// and their toolResults carry `details.id` (agent-N) and `details.cwd`; the child session files
// live under the sessions dir of their cwd's slug, named by their header's ISO timestamp, and
// their first user message repeats the spawn prompt verbatim.
const paneKey = 'local/fake/p1';
const parentUuid = '01a11710-e557-721b-9cd9-e7375923d226';
const uuidA = '01a11714-57f0-721b-9cd9-e738332e3337';
const uuidB = '01a11714-57f2-721b-9cd9-e73aec20fb4e';
const uuidC = '01a11714-57f3-721b-9cd9-e73dce2289bf';
const promptA = 'Think: weigh the two designs and answer in a table.';
const promptB = 'Code: move the mockup into mockup/ and keep it building.';
const promptC = 'An unrelated conversation that happens to run in the same second.';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const message = (id: string, parentId: string | null, at: string, body: Record<string, unknown>) =>
  line({ type: 'message', id, parentId, timestamp: at, message: body });

const parentJsonl = [
  line({ type: 'session', version: 3, id: parentUuid, timestamp: '2026-10-07T15:56:10.100Z', cwd: '/tmp/repo' }),
  message('u1', null, '2026-10-07T15:56:10.200Z', { role: 'user', content: [{ type: 'text', text: 'Run the lanes.' }] }),
  // Parallel spawns share one call timestamp; the prompts tell the children apart.
  message('a1', 'u1', '2026-10-07T15:56:10.394Z', { role: 'assistant', content: [
    { type: 'toolCall', id: 'call_a', name: 'Agent', arguments: { description: 'Think: pick design', prompt: promptA, subagent_type: 'think', run_in_background: true } },
    { type: 'toolCall', id: 'call_b', name: 'Agent', arguments: { description: 'Code: build it', prompt: promptB, subagent_type: 'code', run_in_background: true } },
  ] }),
  message('r1', 'a1', '2026-10-07T15:56:10.900Z', { role: 'toolResult', toolCallId: 'call_a', toolName: 'Agent', content: [{ type: 'text', text: 'Started agent-1.' }], details: { id: 'agent-1', title: 'Think: pick design', cwd: '/tmp/repo' } }),
  message('r2', 'a1', '2026-10-07T15:56:10.900Z', { role: 'toolResult', toolCallId: 'call_b', toolName: 'Agent', content: [{ type: 'text', text: 'Started agent-2.' }], details: { id: 'agent-2', title: 'Code: build it', cwd: '/tmp/repo' } }),
].join('\n');
const agentResult = (id: string) => line({ type: 'custom_message', customType: 'agent-result', timestamp: '2026-10-07T16:10:00.000Z', details: { id, title: 'x', status: 'done' }, content: `agent ${id} finished` });

const childJsonl = (uuid: string, at: string, name: string, prompt: string, ends: 'stop' | 'open') => [
  line({ type: 'session', version: 3, id: uuid, timestamp: at, cwd: '/tmp/repo' }),
  line({ type: 'model_change', id: 'm', parentId: null, timestamp: at, provider: 'zai', modelId: 'glm-5.3' }),
  line({ type: 'session_info', id: 's', parentId: 'm', timestamp: at, name: `agent: ${name}` }),
  message('sys', 's', at, { role: 'system', content: 'system prompt' }),
  message('u1', 'sys', at, { role: 'user', content: [{ type: 'text', text: prompt }] }),
  message('a1', 'u1', at, { role: 'assistant', stopReason: ends === 'stop' ? 'stop' : 'toolUse', content: [
    ...(ends === 'open' ? [{ type: 'toolCall', id: 'call_c', name: 'bash', arguments: { command: 'pnpm test' } }] : []),
    { type: 'text', text: ends === 'stop' ? 'All done.' : 'Working.' },
  ] }),
  ...(ends === 'open' ? [message('t1', 'a1', at, { role: 'toolResult', toolCallId: 'call_c', content: [{ type: 'text', text: 'still running' }] })] : []),
].join('\n');

describe('pi subagents', () => {
  let home: string, dir: string, parentFile: string, childA: string, childB: string;
  let hub: Hub, lens: ChatLens;
  let handle: (request: Request) => Response | Promise<Response>;
  let oldState: string | undefined;

  const chatHub = (path: string): ChatHub => ({
    resolvePane: () => ({ paneId: 'p1', entry: { mux: { kind: 'herdr' }, tree: { panes: [{ id: 'p1', agent: 'pi', agentSession: path }] } } }),
    state: async () => ({ panes: [{ key: paneKey, cwd: '/tmp/repo' }] }) as State,
    paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
  });

  beforeAll(() => {
    oldState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'tautan-pi-sub-state-'));
    home = mkdtempSync(join(tmpdir(), 'tautan-pi-sub-home-'));
    dir = join(home, '.pi', 'agent', 'sessions', '--tmp-repo--');
    mkdirSync(dir, { recursive: true });
    parentFile = join(dir, `2026-10-07T15-56-10-394Z_${parentUuid}.jsonl`);
    writeFileSync(parentFile, `${parentJsonl}\n`); // appends in later tests must land on fresh lines
    childA = join(dir, `2026-10-07T15-56-11-632Z_${uuidA}.jsonl`);
    childB = join(dir, `2026-10-07T15-56-11-635Z_${uuidB}.jsonl`);
    writeFileSync(childA, childJsonl(uuidA, '2026-10-07T15:56:11.632Z', 'Think: pick design', promptA, 'stop'));
    writeFileSync(childB, childJsonl(uuidB, '2026-10-07T15:56:11.635Z', 'Code: build it', promptB, 'open'));
    // A same-second file that is no call's child, and one from an earlier hour.
    writeFileSync(join(dir, `2026-10-07T15-56-11-640Z_${uuidC}.jsonl`), childJsonl(uuidC, '2026-10-07T15:56:11.640Z', 'Other', promptC, 'stop'));
    writeFileSync(join(dir, `2026-10-07T14-00-00-000Z_01a11700-0000-721b-9cd9-e7375923d226.jsonl`), childJsonl('01a11700-0000-721b-9cd9-e7375923d226', '2026-10-07T14:00:00.000Z', 'Old', 'Old hour.', 'stop'));

    const cwd = '/tmp/repo';
    const tree: Tree = {
      workspaces: [{ id: 'w1', label: 'Repo', cwd }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'T' }],
      panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'pi', cwd, agent: 'pi', agentSession: parentFile, status: 'idle' as const, revision: 0 }],
    };
    const mux: Mux = { kind: 'herdr', id: 'fake', tree: async () => tree, read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }), sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); }, rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {} };
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); void hub.state();
    lens = new ChatLens(chatHub(parentFile), localIo, home);
    const serve = Bun.serve;
    try { Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve; startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: process.env.XDG_STATE_HOME!, chats: lens }); }
    finally { Bun.serve = serve; }
  });
  afterAll(() => { lens.close(); hub.close(); rmSync(home, { recursive: true, force: true }); rmSync(process.env.XDG_STATE_HOME!, { recursive: true, force: true }); process.env.XDG_STATE_HOME = oldState; });

  test('parallel spawns link by prompt, and the rows carry subagentId', async () => {
    const chat = await lens.query(paneKey);
    expect(chat?.agentKind).toBe('pi');
    expect(chat?.sessionId).toBe(parentUuid);
    expect(chat?.subagents).toEqual([
      { id: 'agent-1', type: 'think', description: 'Think: pick design', toolUseId: 'call_a', at: Date.parse('2026-10-07T15:56:10.394Z'), updatedAt: expect.any(Number), state: 'done' },
      { id: 'agent-2', type: 'code', description: 'Code: build it', toolUseId: 'call_b', at: Date.parse('2026-10-07T15:56:10.394Z'), updatedAt: expect.any(Number), state: 'running' },
    ]);
    // agent-1 is done by its own ending (no agent-result in the parent yet); agent-2 runs.
    const [a, b] = chat!.turns[1]!.tools;
    expect(a!.subagentId).toBe('agent-1');
    expect(b!.subagentId).toBe('agent-2');
  });

  test('?agent= serves the mapped child conversation; an unknown id has none', async () => {
    const sub = await lens.query(paneKey, 'agent-2');
    expect(sub?.agent).toBe('agent-2');
    expect(sub?.agentKind).toBe('pi');
    expect(sub?.turns.map(turn => turn.role)).toEqual(['user', 'assistant']);
    expect(sub?.turns[0]!.text).toBe(promptB); // the child matched by prompt, not its sibling's
    expect(sub?.subagents?.map(item => item.id)).toEqual(['agent-1', 'agent-2']);
    expect(await lens.query(paneKey, 'agent-9')).toBeUndefined();
  });

  test('an agent-result marks done, and the ETag moves with a child while the parent stands still', async () => {
    appendFileSync(parentFile, `${agentResult('agent-1')}\n`); // the parent moved: a fresh parse
    expect((await lens.query(paneKey))?.subagents?.find(item => item.id === 'agent-1')!.state).toBe('done');
    const etag = (await lens.tagged(paneKey))!.etag;
    // The parent is idle now; the child's own movement and quietness still move the tag.
    appendFileSync(childB, `${message('t2', 't1', '2026-10-07T15:57:00.000Z', { role: 'toolResult', toolCallId: 'call_c', content: [{ type: 'text', text: 'more output' }] })}\n`);
    const grew = (await lens.tagged(paneKey))!.etag;
    expect(grew).not.toBe(etag); // updatedAt moved with the child's mtime
    const before = (await lens.tagged(paneKey))!.etag;
    const stale = Date.now() / 1000 - 200;
    utimesSync(childB, stale, stale); // the process died: nothing else will move
    const chat = await lens.query(paneKey);
    expect(chat?.subagents?.find(item => item.id === 'agent-2')!.state).toBe('done');
    expect((await lens.tagged(paneKey))!.etag).not.toBe(before);
  });

  test('a resume reuses the mapped child and relinks its row, matched by id not prompt', async () => {
    appendFileSync(parentFile, [
      message('a2', 'r2', '2026-10-07T17:00:00.000Z', { role: 'assistant', content: [
        { type: 'toolCall', id: 'call_r', name: 'Agent', arguments: { description: 'Code: build it', prompt: 'A different resume prompt.', resume: 'agent-2' } },
      ] }),
      message('r3', 'a2', '2026-10-07T17:00:00.500Z', { role: 'toolResult', toolCallId: 'call_r', toolName: 'Agent', content: [{ type: 'text', text: 'Resumed agent-2.' }], details: { id: 'agent-2', title: 'Code: build it', cwd: '/tmp/repo' } }),
    ].join('\n'));
    const chat = await lens.query(paneKey);
    expect(chat?.subagents?.map(item => [item.id, item.toolUseId])).toEqual([['agent-1', 'call_a'], ['agent-2', 'call_r']]);
    expect(chat?.subagents?.[1]!.at).toBe(Date.parse('2026-10-07T15:56:10.394Z')); // the first call still stamps it
    const rows = chat!.turns.at(-1)!.tools;
    expect(rows[0]!.subagentId).toBe('agent-2'); // the resume row links too
    expect((await lens.query(paneKey, 'agent-2'))?.turns[0]!.text).toBe(promptB); // same child file
  });

  const get = (path: string) => handle(new Request(`http://tautan.test${path}`));
  const key = encodeURIComponent(paneKey);

  test('GET /chat lists the pi tree and serves ?agent= through the route pre-check', async () => {
    const main = await get(`/api/panes/${key}/chat`);
    expect(main.status).toBe(200);
    const chat = await main.json();
    expect(chat.subagents.map((item: { id: string }) => item.id)).toEqual(['agent-1', 'agent-2']);
    expect(chat.turns[1].tools[0].subagentId).toBe('agent-1');
    const sub = await get(`/api/panes/${key}/chat?agent=agent-2`);
    expect(sub.status).toBe(200);
    expect((await sub.json()).agent).toBe('agent-2');
    const missing = await get(`/api/panes/${key}/chat?agent=agent-9`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'no-agent' });
  });
});
