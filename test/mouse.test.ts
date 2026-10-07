import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { startHttp } from '../server/http.ts';
import { Hub, mouseBytes } from '../server/mux.ts';
import type { Explain, MouseBody, Mux, Pane, Screen, Tree, Workspace } from '../shared/types.ts';

test('mouseBytes emits exact SGR reports', () => {
  const body = (kind: MouseBody['kind']): MouseBody => ({ kind, col: 5, row: 7, allow: true });
  expect(mouseBytes(body('click'))).toBe('\x1b[<0;5;7M\x1b[<0;5;7m');
  expect(mouseBytes(body('right'))).toBe('\x1b[<2;5;7M\x1b[<2;5;7m');
  expect(mouseBytes(body('double'))).toBe('\x1b[<0;5;7M\x1b[<0;5;7m\x1b[<0;5;7M\x1b[<0;5;7m');
  expect(mouseBytes(body('wheelUp'))).toBe('\x1b[<64;5;7M');
  expect(mouseBytes(body('wheelDown'))).toBe('\x1b[<65;5;7M');
});

describe('mouse route', () => {
  let hub: Hub, handle: (request: Request) => Response | Promise<Response>;
  const sent: string[] = [];
  const request = (body: unknown, origin = true) => handle(new Request('http://tautan.test/api/panes/local%2Ffake%2Fp/mouse', {
    method: 'POST', headers: { host: 'tautan.test', ...(origin ? { origin: 'http://tautan.test' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

  beforeEach(async () => {
    sent.length = 0;
    const tree: Tree = { workspaces: [{ id: 'w', label: 'W' }], tabs: [{ id: 't', workspaceId: 'w', label: 'T' }], panes: [{ id: 'p', tabId: 't', workspaceId: 'w', title: 'P', status: 'unknown', revision: 1 }] };
    const mux: Mux = { kind: 'tmux', id: 'fake', tree: async () => tree, read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 1, mode }), sendText: async () => {}, sendKeys: async () => {}, sendRaw: async (_id, raw) => { sent.push(raw); }, onChange: () => () => {}, newTab: async (): Promise<Pane> => tree.panes[0]!, newWorkspace: async (): Promise<Workspace> => tree.workspaces[0]!, rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {} };
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); await hub.state();
    const serve = Bun.serve;
    try { Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve; startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: import.meta.dir }); }
    finally { Bun.serve = serve; }
  });
  afterEach(() => hub.close());

  test('validates bodies before the allow gate', async () => {
    for (const body of [{ col: 1, row: 1 }, { kind: 'click', col: 0, row: 1 }, { kind: 'click', col: 1.5, row: 1 }, { kind: 'click', col: 1, row: '1' }])
      expect((await request(body)).status).toBe(400);
  });
  test('requires explicit allow without writing bytes', async () => {
    expect((await request({ kind: 'click', col: 1, row: 1, allow: false })).status).toBe(409);
    expect((await request({ kind: 'click', col: 1, row: 1 })).status).toBe(409);
    expect(sent).toEqual([]);
  });
  test('forwards allowed bytes and enforces Origin', async () => {
    expect((await request({ kind: 'click', col: 5, row: 7, allow: true })).status).toBe(204);
    expect(sent).toEqual(['\x1b[<0;5;7M\x1b[<0;5;7m']);
    expect((await request({ kind: 'click', col: 1, row: 1, allow: true }, false)).status).toBe(403);
  });
});
