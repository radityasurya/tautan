import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, State, Tree, Workspace } from '../shared/types.ts';

describe('write routes', () => {
  let dir: string;
  let cwd: string;
  let hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  let tree: Tree;
  let failure: string | undefined;
  let explainResponse: Explain | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tautan-write-'));
    cwd = join(dir, 'cwd'); mkdirSync(cwd);
    tree = {
      workspaces: [{ id: 'w1', label: 'Workspace', cwd }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'Tab' }],
      panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'Pane', cwd, status: 'unknown', revision: 0 }],
    };
    const fail = () => { if (failure) throw new Error(failure); };
    const mux: Mux & { version(): Promise<string> } = {
      kind: 'herdr', id: 'fake', version: async () => '9.9.9', tree: async () => structuredClone(tree),
      read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, explain: async (): Promise<Explain | null> => explainResponse,
      newTab: async (workspaceId, body): Promise<Pane> => { fail(); const pane = { id: 'p2', tabId: 't2', workspaceId, title: body.label!, cwd: body.cwd, status: 'unknown' as const, revision: 0 }; tree.tabs.push({ id: 't2', workspaceId, label: body.label! }); tree.panes.push(pane); return pane; },
      newWorkspace: async (body): Promise<Workspace> => { fail(); const workspace = { id: 'w2', label: body.label!, cwd: body.cwd }; tree.workspaces.push(workspace); return workspace; },
      rename: async (target, label) => { fail(); if ('workspaceId' in target) tree.workspaces.find(x => x.id === target.workspaceId)!.label = label; else if ('tabId' in target) tree.tabs.find(x => x.id === target.tabId)!.label = label; else tree.panes.find(x => x.id === target.paneId)!.title = label; },
      closePane: async id => { fail(); tree.panes = tree.panes.filter(x => x.id !== id); },
      zoom: async (id, zoomed) => { fail(); const pane = tree.panes.find(x => x.id === id)!; if (zoomed) pane.zoomed = true; else delete pane.zoomed; },
      closeWorkspace: async id => { fail(); tree.workspaces = tree.workspaces.filter(x => x.id !== id); tree.tabs = tree.tabs.filter(x => x.workspaceId !== id); tree.panes = tree.panes.filter(x => x.workspaceId !== id); },
      split: async (id, body): Promise<string> => { fail(); const pane = tree.panes.find(x => x.id === id)!; const fresh = { id: `p${tree.panes.length + 1}`, tabId: pane.tabId, workspaceId: pane.workspaceId, title: 'Split', ...(body.cwd ? { cwd: body.cwd } : {}), status: 'unknown' as const, revision: 0 }; tree.panes.push(fresh); return fresh.id; },
      swap: async () => { fail(); },
      move: async (id, destination): Promise<string> => {
        fail(); const pane = tree.panes.find(x => x.id === id)!;
        if ('tabId' in destination) { pane.tabId = destination.tabId; return id; }
        const tab = { id: `t${tree.tabs.length + 1}`, workspaceId: pane.workspaceId, label: 'Tab' };
        if ('newTab' in destination) { tree.tabs.push(tab); pane.tabId = tab.id; return id; }
        const workspace = { id: `w${tree.workspaces.length + 1}`, label: destination.label ?? 'Workspace' };
        tab.workspaceId = workspace.id; tree.workspaces.push(workspace); tree.tabs.push(tab);
        pane.workspaceId = workspace.id; pane.tabId = tab.id; pane.id = `moved-${id}`; return pane.id; // ids change across Workspaces (herdr)
      },
      resize: async () => { fail(); }, close: () => {},
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

  test('serves Pane files only from the resolved cwd', async () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'outside');
    writeFileSync(join(cwd, 'image.png'), 'png');
    writeFileSync(join(cwd, 'image.svg'), '<svg/>');
    mkdirSync(join(cwd, 'folder'));
    writeFileSync(join(cwd, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1));
    symlinkSync(outside, join(cwd, 'outside-link'));
    const path = `/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=`;
    const file = (value: string) => handle(new Request(`http://tautan.test${path}${encodeURIComponent(value)}`, { headers: { host: 'tautan.test' } }));

    for (const value of ['../outside.txt', outside, 'outside-link']) {
      const response = await file(value);
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'escape' });
    }
    const legal = await file('image.png');
    expect(legal.status).toBe(200); expect(legal.headers.get('content-type')).toBe('image/png'); expect(legal.headers.get('x-content-type-options')).toBe('nosniff'); expect(legal.headers.get('cache-control')).toBe('no-store'); expect(await legal.text()).toBe('png');
    const svg = await file('image.svg');
    expect(svg.status).toBe(200); expect(svg.headers.get('content-type')).toBe('text/plain; charset=utf-8'); expect(svg.headers.get('x-content-type-options')).toBe('nosniff'); expect(svg.headers.get('cache-control')).toBe('no-store'); expect(await svg.text()).toBe('<svg/>');
    const directory = await file('folder');
    expect(directory.status).toBe(415); expect(await directory.json()).toEqual({ error: 'not a file' });
    const large = await file('large.txt');
    expect(large.status).toBe(413); expect(await large.json()).toEqual({ error: 'too large' });
    const missing = await file('missing.txt');
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: 'not found' });
  });

  test('caps file reads using the request-time limit', async () => {
    const previous = process.env.TAUTAN_MAX_FILE_MB;
    try {
      process.env.TAUTAN_MAX_FILE_MB = '0.000001';
      writeFileSync(join(cwd, 'tiny-limit.txt'), 'xx');
      const response = await handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=tiny-limit.txt`, { headers: { host: 'tautan.test' } }));
      expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: 'too large' });
    } finally {
      if (previous === undefined) delete process.env.TAUTAN_MAX_FILE_MB;
      else process.env.TAUTAN_MAX_FILE_MB = previous;
    }
  });

  test('serves files from a root cwd', async () => {
    tree.panes[0]!.cwd = '/'; await hub.refreshHost('local');
    const response = await handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=etc%2Fhostname`, { headers: { host: 'tautan.test' } }));
    expect(response.status).toBe(200);
  });

  test('reports tautan and herdr versions in Settings', async () => {
    const response = await handle(new Request('http://tautan.test/api/settings', { headers: { host: 'tautan.test' } }));
    const settings = await response.json() as { version: { tautan: string; herdr: { muxKey: string; label: string; version: string }[] } };
    expect(settings.version.tautan).toMatch(/^\d+\.\d+\.\d+/);
    expect(settings.version.herdr).toEqual([{ muxKey: 'local/fake', label: 'fake', version: '9.9.9' }]);
  });

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

  test('zooms and unzooms a Pane, refreshing state before the reply', async () => {
    const path = '/api/panes/local%2Ffake%2Fp1/zoom';
    const zoomedState = async () => ((await (await handle(new Request('http://tautan.test/api/state'))).json()) as { panes: Pane[] }).panes[0]!.zoomed;
    expect((await request(path, { zoomed: true })).status).toBe(204);
    expect(await zoomedState()).toBe(true);
    expect((await request(path, { zoomed: false })).status).toBe(204);
    expect(await zoomedState()).toBeUndefined();
    expect((await request(path, { zoomed: 'yes' })).status).toBe(400);
    expect((await request('/api/panes/local%2Ffake%2Fmissing/zoom', { zoomed: true })).status).toBe(404);
    failure = 'pane_not_found: gone';
    const herdrError = await request(path, { zoomed: true });
    expect(herdrError.status).toBe(502); expect(await herdrError.json()).toEqual({ error: 'pane_not_found' });
    failure = undefined;
  });

  test('splits, swaps, moves, and resizes Panes, refreshing state before the reply', async () => {
    const state = async (): Promise<State> =>
      (await (await handle(new Request('http://tautan.test/api/state'))).json());
    const split = await request('/api/panes/local%2Ffake%2Fp1/split', { direction: 'right', ratio: 0.5, cwd: dir });
    expect(split.status).toBe(201); expect(await split.json()).toEqual({ paneKey: 'local/fake/p2' });
    expect((await state()).panes.some(pane => pane.id === 'p2')).toBe(true);
    expect((await request('/api/panes/local%2Ffake%2Fp2/swap', { target: 'local/fake/p1' })).status).toBe(204);
    expect((await request('/api/panes/local%2Ffake%2Fp1/resize', { direction: 'left', amount: 5 })).status).toBe(204);
    const newTab = await request('/api/panes/local%2Ffake%2Fp1/move', { newTab: true });
    expect(newTab.status).toBe(201); expect(await newTab.json()).toEqual({ paneKey: 'local/fake/p1' });
    const newWorkspace = await request('/api/panes/local%2Ffake%2Fp1/move', { newWorkspace: true, label: 'Moved' });
    expect(newWorkspace.status).toBe(201);
    const moved = await newWorkspace.json() as { paneKey: string };
    expect(moved.paneKey).not.toBe('local/fake/p1'); // a cross-Workspace move renames the Pane
    const after = await state();
    expect(after.panes.some(pane => pane.key === moved.paneKey)).toBe(true);
    expect(after.workspaces.some(workspace => workspace.label === 'Moved')).toBe(true);
  });

  test('moves a Pane to an existing Tab and 404s an unknown Tab', async () => {
    const split = await (await request('/api/panes/local%2Ffake%2Fp1/split', { direction: 'down' })).json() as { paneKey: string };
    const path = `/api/panes/${encodeURIComponent(split.paneKey)}/move`;
    const move = await request(path, { tab: 'local/fake/t1', split: 'right', ratio: 0.4 });
    expect(move.status).toBe(201); expect(await move.json()).toEqual({ paneKey: split.paneKey });
    const missing = await request(path, { tab: 'local/fake/missing', split: 'right' });
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: 'tab not found' });
  });

  test('validates layout bodies and maps adapter errors', async () => {
    const split = '/api/panes/local%2Ffake%2Fp1/split';
    expect((await request(split, { direction: 'up' })).status).toBe(400);
    expect((await request(split, { direction: 'right', ratio: 1 })).status).toBe(400);
    expect((await request(split, { direction: 'right', cwd: 'relative' })).status).toBe(400);
    expect((await request('/api/panes/local%2Ffake%2Fp1/swap', { target: 'local/other/p1' })).status).toBe(404);
    const move = '/api/panes/local%2Ffake%2Fp1/move';
    expect((await request(move, {})).status).toBe(400);                     // no target
    expect((await request(move, { newTab: true, newWorkspace: true })).status).toBe(400); // two targets
    expect((await request(move, { newTab: 'yes' })).status).toBe(400);      // target must be true
    expect((await request(move, { newTab: true, label: 'x' })).status).toBe(400); // label belongs to newWorkspace
    expect((await request(move, { tab: 'local/fake/t1' })).status).toBe(400); // split required with tab
    expect((await request(move, { tab: 'local/fake/t1', split: 'sideways' })).status).toBe(400);
    expect((await request(move, { tab: 'local/fake/t1', split: 'right', ratio: 0 })).status).toBe(400);
    const resize = '/api/panes/local%2Ffake%2Fp1/resize';
    expect((await request(resize, { direction: 'left' })).status).toBe(400);
    expect((await request(resize, { direction: 'left', amount: 0 })).status).toBe(400);
    expect((await request(resize, { direction: 'left', amount: 501 })).status).toBe(400);
    expect((await request(resize, { direction: 'left', amount: 2.5 })).status).toBe(400);
    expect((await request('/api/panes/local%2Ffake%2Fmissing/split', { direction: 'right' })).status).toBe(404);
    failure = 'unsupported';
    expect((await request(split, { direction: 'right' })).status).toBe(501);
    failure = 'pane_not_found: gone';
    const herdr = await request(split, { direction: 'right' });
    expect(herdr.status).toBe(502); expect(await herdr.json()).toEqual({ error: 'pane_not_found' });
    failure = undefined;
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

  test('refuses a Tailscale Funnel request before the Origin check', async () => {
    const res = await handle(new Request('http://tautan.test/api/state', { headers: { host: 'tautan.test', 'Tailscale-Funnel-Request': '1' } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'funnel' });
  });

  test('input refuses a stale prompt id and passes a fresh one', async () => {
    const path = `/api/panes/${encodeURIComponent('local/fake/p1')}/input`;
    explainResponse = { ruleId: 'live_blocked_form', state: 'blocked', detection: 'Do you want to proceed?\n❯ 1. Yes', hintKeys: [] };
    const explain = await (await handle(new Request('http://tautan.test/api/panes/local%2Ffake%2Fp1/explain', { headers: { host: 'tautan.test' } })))
      .json() as { promptId?: string };
    expect(explain.promptId).toMatch(/^[0-9a-f]{12}$/);
    // Fresh id: the answer goes through.
    expect((await request(path, { keys: ['enter'], promptId: explain.promptId })).status).toBe(204);
    // No id: the key bar and quick replies, unchanged behaviour.
    expect((await request(path, { keys: ['enter'] })).status).toBe(204);
    // Stale id: the prompt moved on, so the answer must not land.
    const stale = await request(path, { keys: ['enter'], promptId: '000000000000' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'prompt_changed' });
    // Box gone: every id is stale.
    explainResponse = null;
    expect((await request(path, { keys: ['enter'], promptId: explain.promptId })).status).toBe(409);
    explainResponse = null;
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
