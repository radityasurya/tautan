import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, Tree, Workspace } from '../shared/types.ts';

describe('write routes', () => {
  let dir: string;
  let hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  let tree: Tree;
  let failure: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tautan-write-'));
    tree = {
      workspaces: [{ id: 'w1', label: 'Workspace', cwd: dir }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'Tab' }],
      panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'Pane', status: 'unknown', revision: 0 }],
    };
    const fail = () => { if (failure) throw new Error(failure); };
    const mux: Mux = {
      kind: 'herdr', id: 'fake', tree: async () => structuredClone(tree),
      read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, explain: async (): Promise<Explain | null> => null,
      newTab: async (workspaceId, body): Promise<Pane> => { fail(); const pane = { id: 'p2', tabId: 't2', workspaceId, title: body.label!, cwd: body.cwd, status: 'unknown' as const, revision: 0 }; tree.tabs.push({ id: 't2', workspaceId, label: body.label! }); tree.panes.push(pane); return pane; },
      newWorkspace: async (body): Promise<Workspace> => { fail(); const workspace = { id: 'w2', label: body.label!, cwd: body.cwd }; tree.workspaces.push(workspace); return workspace; },
      rename: async (target, label) => { fail(); if ('workspaceId' in target) tree.workspaces.find(x => x.id === target.workspaceId)!.label = label; else if ('tabId' in target) tree.tabs.find(x => x.id === target.tabId)!.label = label; else tree.panes.find(x => x.id === target.paneId)!.title = label; },
      closePane: async id => { fail(); tree.panes = tree.panes.filter(x => x.id !== id); },
      closeWorkspace: async id => { fail(); tree.workspaces = tree.workspaces.filter(x => x.id !== id); tree.tabs = tree.tabs.filter(x => x.workspaceId !== id); tree.panes = tree.panes.filter(x => x.workspaceId !== id); }, close: () => {},
    };
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); await hub.state();
    const serve = Bun.serve;
    try {
      Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve;
      startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir });
    } finally { Bun.serve = serve; }
  });

  afterEach(() => { hub?.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path: string, body?: unknown, origin = true) => {
    const base = 'http://tautan.test';
    return handle(new Request(`${base}${path}`, { method: 'POST', headers: { host: 'tautan.test', ...(origin ? { origin: base } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  };

  test('creates tabs and workspaces and refreshes state', async () => {
    const tab = await request('/api/muxes/local%2Ffake/tabs', { workspaceId: 'w1', cwd: dir, label: 'New tab' });
    expect(tab.status).toBe(201); expect(await tab.json()).toEqual({ paneKey: 'local/fake/p2' });
    const workspace = await request('/api/muxes/local%2Ffake/workspaces', { cwd: dir, label: 'New workspace' });
    expect(workspace.status).toBe(201); expect(await workspace.json()).toEqual({ workspaceKey: 'local/fake/w2' });
    const state = await (await handle(new Request('http://tautan.test/api/state'))).json() as { panes: Pane[] };
    expect(state.panes.some(pane => pane.id === 'p2')).toBe(true);
  });

  test('renames and closes', async () => {
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: 'Renamed' })).status).toBe(204);
    expect((await request('/api/panes/local%2Ffake%2Fp1/close')).status).toBe(204);
  });

  test('closes a workspace and refreshes state', async () => {
    expect((await request('/api/workspaces/local%2Ffake%2Fw1/close')).status).toBe(204);
    const state = await (await handle(new Request('http://tautan.test/api/state'))).json() as { panes: Pane[]; workspaces: Tree['workspaces'] };
    expect(state.workspaces.length).toBe(0);
    expect(state.panes.length).toBe(0);
    const missing = await request('/api/workspaces/local%2Ffake%2Fmissing/close');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'unknown-workspace' });
  });

  test('trims the label before forwarding it', async () => {
    const label = `${'x'.repeat(80)}  `;
    const tab = await request('/api/muxes/local%2Ffake/tabs', { workspaceId: 'w1', label });
    expect(tab.status).toBe(201);
    const state = await (await handle(new Request('http://tautan.test/api/state'))).json() as { panes: Pane[] };
    expect(state.panes.find(pane => pane.id === 'p2')?.title).toBe('x'.repeat(80));
  });

  test('validates body, label, cwd, and origin', async () => {
    expect((await request('/api/muxes/local%2Ffake/tabs', { workspaceId: 'w1', label: ' ' })).status).toBe(400);
    expect((await request('/api/muxes/local%2Ffake/workspaces', { cwd: 'relative', label: 'Okay' })).status).toBe(400);
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', tabId: 't1', label: 'x' })).status).toBe(400);
    expect((await request('/api/rename', null)).status).toBe(400);
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: 'x' }, false)).status).toBe(403);
  });

  test('maps unknown and adapter errors', async () => {
    expect(await (await request('/api/muxes/missing%2Ffake/tabs', { workspaceId: 'w1' })).json()).toEqual({ error: 'mux not found' });
    expect(await (await request('/api/panes/local%2Ffake%2Fmissing/close')).json()).toEqual({ error: 'pane not found' });
    const badWorkspace = await request('/api/muxes/local%2Ffake/tabs', { workspaceId: 'missing' });
    expect(badWorkspace.status).toBe(404); expect(await badWorkspace.json()).toEqual({ error: 'workspace not found' });
    const badRename = await request('/api/rename', { muxKey: 'local/fake', paneId: 'missing', label: 'x' });
    expect(badRename.status).toBe(404); expect(await badRename.json()).toEqual({ error: 'pane not found' });
    failure = 'unsupported';
    const unsupported = await request('/api/muxes/local%2Ffake/tabs', { workspaceId: 'w1' });
    expect(unsupported.status).toBe(501); expect(await unsupported.json()).toEqual({ error: 'unsupported' });
    failure = 'agent_not_ready: x';
    const herdr = await request('/api/muxes/local%2Ffake/tabs', { workspaceId: 'w1' });
    expect(herdr.status).toBe(502); expect(await herdr.json()).toEqual({ error: 'agent_not_ready' });
  });
});
