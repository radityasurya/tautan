import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatLens, type ChatHub } from '../server/chat.ts';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, ScreenMode, State, Tree, Workspace } from '../shared/types.ts';

const id = '33333333-3333-3333-3333-333333333333';
const png = 'iVBORw0KGgo=';
const paneKey = 'local/fake/p1';

// The route runs against a real Hub pane; the transcript comes through an injected ChatLens,
// the same seam as startHttp's discover/discoverRemote.
describe('chat image route', () => {
  let stateHome: string, hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  const get = (key = paneKey, suffix = '0') => handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent(key)}/chat/image/${suffix}`));

  beforeAll(async () => {
    const oldState = process.env.XDG_STATE_HOME;
    stateHome = mkdtempSync(join(tmpdir(), 'tautan-chat-image-'));
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const cwd = '/repo';
      const tree: Tree = {
        workspaces: [{ id: 'w1', label: 'Repo', cwd }],
        tabs: [{ id: 't1', workspaceId: 'w1', label: 'T' }],
        panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'claude', cwd, agentSession: id, status: 'idle' as const, revision: 0 }],
      };
      const mux: Mux = { kind: 'herdr', id: 'fake', tree: async () => tree, read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }), sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); }, rename: async () => {}, closePane: async () => {}, closeWorkspace: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {} };
      hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); await hub.state();
      const jsonl = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.png' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } },
      ].map(entry => JSON.stringify(entry)).join('\n');
      const chatHub: ChatHub = {
        resolvePane: () => ({ paneId: 'p1', entry: { mux: { kind: 'herdr' }, tree: { panes: [{ id: 'p1', agentSession: id }] } } }),
        state: async () => ({ panes: [{ key: paneKey, cwd }] }) as State,
        paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
      };
      const lens = new ChatLens(chatHub, { stat: async () => ({ inode: '1', size: 1, mtime: 'now' }), read: async () => jsonl }, '/home/tama');
      const serve = Bun.serve;
      try { Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve; startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: stateHome, chats: lens }); }
      finally { Bun.serve = serve; }
    } finally { process.env.XDG_STATE_HOME = oldState; }
  });
  afterAll(() => { hub.close(); rmSync(stateHome, { recursive: true, force: true }); });

  test('serves the image bytes with long-lived private caching', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(png);
  });

  test('answers 400, no-image and no-session', async () => {
    for (const bad of ['x', '-1', '1.5']) expect((await get(paneKey, bad)).status).toBe(400);
    const missing = await get(paneKey, '1');
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: 'no-image' });
    const noSession = await get('local/fake/p9');
    expect(noSession.status).toBe(404); expect(await noSession.json()).toEqual({ error: 'no-session' });
  });
});
