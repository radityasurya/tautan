import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Integration, Mux, Pane, PluginAction, PluginRun, Screen, State, Tree, Workspace } from '../shared/types.ts';

describe('write routes', () => {
  let dir: string;
  let cwd: string;
  let hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  let tree: Tree;
  let failure: string | undefined;
  let explainResponse: Explain | null = null;
  let visible: { text: string; ansi: boolean } = { text: '', ansi: false };
  let sent: string[] = [];
  let actions: PluginAction[] = [];
  let integrations: Integration[] = [];
  let invoked: { paneId: string; actionId: string; pluginId?: string }[] = [];
  let freshCalls: boolean[] = [];
  let run: PluginRun | undefined;
  let fakeMux: Mux & { version(): Promise<string> };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tautan-write-'));
    cwd = join(dir, 'cwd'); mkdirSync(cwd);
    actions = []; integrations = []; invoked = []; freshCalls = []; run = undefined;
    tree = {
      workspaces: [{ id: 'w1', label: 'Workspace', cwd }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'Tab' }],
      panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'Pane', cwd, status: 'unknown', revision: 0 }],
    };
    const fail = () => { if (failure) throw new Error(failure); };
    const mux = fakeMux = {
      kind: 'herdr', id: 'fake', version: async () => '9.9.9', tree: async () => structuredClone(tree),
      read: async (_id, mode): Promise<Screen> => ({ ...structuredClone(visible), revision: 0, mode }),
      sendText: async (_id, text) => { sent.push(text); }, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, explain: async (): Promise<Explain | null> => explainResponse,
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
      resize: async () => { fail(); }, moveWorkspace: async () => { fail(); }, moveTab: async () => { fail(); },
      pluginActions: async (fresh?: boolean) => { fail(); freshCalls.push(Boolean(fresh)); return actions; },
      invokePluginAction: async (paneId, actionId, pluginId) => { fail(); invoked.push({ paneId, actionId, pluginId }); return run; },
      renameAgent: async (paneId, name) => { fail(); const pane = tree.panes.find(x => x.id === paneId)!; if (name) pane.agentName = name; else delete pane.agentName; },
      integrations: async () => { fail(); return integrations; },
      close: () => {},
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

  test('a read carries an etag; ~ is contained now, so it answers 415 as a non-file', async () => {
    writeFileSync(join(cwd, 'text.txt'), 'hello');
    const path = `/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=`;
    const read = await handle(new Request(`http://tautan.test${path}${encodeURIComponent('text.txt')}`, { headers: { host: 'tautan.test' } }));
    expect(read.status).toBe(200);
    expect(read.headers.get('etag')).toMatch(/^"[A-Za-z0-9-]{1,64}"$/);
    const home = await handle(new Request(`http://tautan.test${path}${encodeURIComponent('~')}`, { headers: { host: 'tautan.test' } }));
    expect(home.status).toBe(415); expect(await home.json()).toEqual({ error: 'not a file' });
  });

  test('saves a file, keeping its mode and leaving no temp file behind', async () => {
    const file = join(cwd, 'editable.txt');
    writeFileSync(file, 'one\n'); chmodSync(file, 0o640);
    const path = `/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=${encodeURIComponent('editable.txt')}`;
    const read = await handle(new Request(`http://tautan.test${path}`, { headers: { host: 'tautan.test' } }));
    const save = await handle(new Request(`http://tautan.test${path}`, { method: 'PUT', headers: { host: 'tautan.test', origin: 'http://tautan.test', 'if-match': read.headers.get('etag')! }, body: 'two\n' }));
    expect(save.status).toBe(204);
    expect(save.headers.get('etag')).toMatch(/^"[A-Za-z0-9-]{1,64}"$/);
    expect(readFileSync(file, 'utf8')).toBe('two\n');
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(cwd).some(name => name.startsWith('.tautan-'))).toBe(false);
    // the save's etag is the file's new version: saving again with it works
    const again = await handle(new Request(`http://tautan.test${path}`, { method: 'PUT', headers: { host: 'tautan.test', origin: 'http://tautan.test', 'if-match': save.headers.get('etag')! }, body: 'three\n' }));
    expect(again.status).toBe(204);
    expect(readFileSync(file, 'utf8')).toBe('three\n');
  });

  test('a PUT to a target larger than the cap answers 413 and leaves it unchanged', async () => {
    const file = join(cwd, 'huge.txt');
    writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1, 0x78));
    const response = await handle(new Request(`http://tautan.test/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=${encodeURIComponent('huge.txt')}`, { method: 'PUT', headers: { host: 'tautan.test', origin: 'http://tautan.test', 'if-match': '"anything"' }, body: 'new' }));
    expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: 'too large' });
    expect(statSync(file).size).toBe(5 * 1024 * 1024 + 1);
    expect(readdirSync(cwd).some(name => name.startsWith('.tautan-'))).toBe(false);
  });

  test('a same-size change on disk answers 412 and keeps the other edit', async () => {
    const file = join(cwd, 'clash.txt');
    writeFileSync(file, 'aaaa\n');
    const path = `/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=${encodeURIComponent('clash.txt')}`;
    const etag = (await handle(new Request(`http://tautan.test${path}`, { headers: { host: 'tautan.test' } }))).headers.get('etag')!;
    writeFileSync(file, 'bbbb\n'); // same size, different bytes
    const save = await handle(new Request(`http://tautan.test${path}`, { method: 'PUT', headers: { host: 'tautan.test', origin: 'http://tautan.test', 'if-match': etag }, body: 'cccc\n' }));
    expect(save.status).toBe(412); expect(await save.json()).toEqual({ error: 'changed' });
    expect(readFileSync(file, 'utf8')).toBe('bbbb\n');
    expect(readdirSync(cwd).some(name => name.startsWith('.tautan-'))).toBe(false);
  });

  test('refuses every save the contract lists', async () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'outside');
    mkdirSync(join(cwd, 'folder'));
    writeFileSync(join(cwd, 'strict.txt'), 'x');
    symlinkSync(outside, join(cwd, 'outside-link'));
    chmodSync(join(cwd, 'strict.txt'), 0o444);
    const url = (p: string) => `http://tautan.test/api/panes/${encodeURIComponent('local/fake/p1')}/file?path=${encodeURIComponent(p)}`;
    const put = (p: string, body: BodyInit, headers: Record<string, string> = {}, origin = true) =>
      handle(new Request(url(p), { method: 'PUT', headers: { host: 'tautan.test', ...(origin ? { origin: 'http://tautan.test' } : {}), ...headers }, body }));
    const check = async (response: Response, status: number, error: string) => {
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    };
    await check(await put('strict.txt', 'y'), 428, 'version');          // no If-Match
    await check(await put('folder', 'y', { 'if-match': '"anything"' }), 415, 'not a file');
    await check(await put('../outside.txt', 'y', { 'if-match': '"anything"' }), 403, 'escape');
    await check(await put('outside-link', 'y', { 'if-match': '"anything"' }), 403, 'escape');
    await check(await put('strict.txt', new Uint8Array([0xff]), { 'if-match': '"anything"' }), 415, 'not text');
    const ro = (await handle(new Request(url('strict.txt'), { headers: { host: 'tautan.test' } }))).headers.get('etag')!;
    await check(await put('strict.txt', 'y', { 'if-match': ro }), 403, 'read-only'); // 0444
    await check(await put('missing.txt', 'y', { 'if-match': '"anything"' }), 404, 'not found');
    expect(readdirSync(cwd)).not.toContain('missing.txt');              // never creates
    expect(readdirSync(cwd).some(name => name.startsWith('.tautan-'))).toBe(false);
    await check(await put('strict.txt', 'y', { 'if-match': '"anything"' }, false), 403, 'origin'); // no Origin
    chmodSync(join(cwd, 'strict.txt'), 0o644); // let afterEach clean up
    const previous = process.env.TAUTAN_MAX_FILE_MB;
    try {
      process.env.TAUTAN_MAX_FILE_MB = '0.000001';
      await check(await put('strict.txt', 'yy', { 'if-match': '"anything"' }), 413, 'too large');
    } finally {
      if (previous === undefined) delete process.env.TAUTAN_MAX_FILE_MB;
      else process.env.TAUTAN_MAX_FILE_MB = previous;
    }
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

  test('a held reply to a Claude Pane waits for an empty box and arrives stripped', async () => {
    const fixtures = join(import.meta.dir, 'fixtures/claude-2.1.296');
    const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');
    const emoji = '\u{1F468}‍\u{1F469}';
    tree.panes[0]!.agent = 'claude'; await hub.refreshHost('local');
    const path = `/api/panes/${encodeURIComponent('local/fake/p1')}/input`;
    // The box holds a draft: the reply must not type over it.
    visible = { text: fixture('inputbox-draft-oneline.ansi.txt'), ansi: true };
    const refused = await request(path, { text: 'reply', keys: ['enter'], held: true });
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: 'draft' });
    expect(sent).toEqual([]);
    // The dim placeholder reads as empty, so the reply goes through — stripped of what Claude holds.
    visible = { text: fixture('inputbox-empty.ansi.txt'), ansi: true };
    expect((await request(path, { text: `a​b${emoji}`, keys: ['enter'], held: true })).status).toBe(204);
    expect(sent).toEqual([`ab${emoji}`]);
    // Without `held` the reply types over a bash-mode box regardless, still stripped; `held` must be true or absent.
    visible = { text: fixture('inputbox-bash-mode.ansi.txt'), ansi: true };
    expect((await request(path, { text: 'x​y' })).status).toBe(204);
    expect(sent).toEqual([`ab${emoji}`, 'xy']);
    expect((await request(path, { held: false })).status).toBe(400);
    // A non-Claude Pane keeps today's behaviour: no refusal, no strip.
    tree.panes[0]!.agent = undefined; await hub.refreshHost('local');
    expect((await request(path, { text: 'x​y', held: true })).status).toBe(204);
    expect(sent.at(-1)).toBe('x​y');
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
    failure = undefined;
  });

  test('lists, invokes, and maps errors for plugin actions', async () => {
    const key = 'local%2Ffake%2Fp1';
    actions = [{ pluginId: 'tautan.test', plugin: 'Tautan Test', actionId: 'mark', title: 'Mark', contexts: ['pane'] }];
    const list = async (query = '') => handle(new Request(`http://tautan.test/api/panes/${key}/actions${query}`, { headers: { host: 'tautan.test' } }));
    const plain = await list();
    expect(plain.status).toBe(200); expect(await plain.json()).toEqual({ actions });
    expect((await handle(new Request('http://tautan.test/api/panes/local%2Ffake%2Fmissing/actions', { headers: { host: 'tautan.test' } }))).status).toBe(404);
    // 21.4.2: only `?fresh=1` reaches past the cache; every other value is not the flag.
    expect((await list('?fresh=1')).status).toBe(200);
    expect((await list('?fresh=0')).status).toBe(200);
    expect(freshCalls).toEqual([false, true, false]);
    // The invoke body is `{pluginId?}` only; the action id rides the path.
    expect((await request(`/api/panes/${key}/actions/mark`, null)).status).toBe(400);
    expect((await request(`/api/panes/${key}/actions/mark`, { pluginId: 5 })).status).toBe(400);
    expect((await request(`/api/panes/${key}/actions/mark`, { pluginId: '' })).status).toBe(400);
    // A double's void cannot say how the run ended (21.4.1): the body says `unknown`.
    const unknown = await request(`/api/panes/${key}/actions/mark`, {});
    expect(unknown.status).toBe(200); expect(await unknown.json()).toEqual({ status: 'unknown' });
    run = { status: 'failed', exitCode: 3, message: 'the scratch script is missing' };
    const failed = await request(`/api/panes/${key}/actions/mark`, { pluginId: 'tautan.test' });
    expect(failed.status).toBe(200); expect(await failed.json()).toEqual(run);
    run = undefined;
    expect(invoked).toEqual([{ paneId: 'p1', actionId: 'mark', pluginId: undefined }, { paneId: 'p1', actionId: 'mark', pluginId: 'tautan.test' }]);
    expect((await request('/api/panes/local%2Ffake%2Fmissing/actions/mark', {})).status).toBe(404);
    failure = 'unsupported';
    expect((await request(`/api/panes/${key}/actions/mark`, {})).status).toBe(501);
    failure = 'plugin_not_found: no plugin offers mark';
    const herdrError = await request(`/api/panes/${key}/actions/mark`, {});
    // Unlike other routes, the invoke answers herdr's own message, not just its code.
    expect(herdrError.status).toBe(502);
    expect(await herdrError.json()).toEqual({ error: 'plugin_not_found: no plugin offers mark' });
    failure = undefined;
  });

  test('history route: validates q and before, 404s an unknown pane, 501s a Mux without history', async () => {
    const key = 'local%2Ffake%2Fp1';
    const get = (query: string) => handle(new Request(`http://tautan.test/api/panes/${key}/history${query}`, { headers: { host: 'tautan.test' } }));
    const missingQ = await get('');
    expect(missingQ.status).toBe(400); expect(await missingQ.json()).toEqual({ error: 'q' });
    const longQ = await get(`?q=${'x'.repeat(201)}`);
    expect(longQ.status).toBe(400); expect(await longQ.json()).toEqual({ error: 'q' });
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const response = await get(`?q=alpha&before=${bad}`);
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'before' });
    }
    const unknownPane = await handle(new Request('http://tautan.test/api/panes/local%2Ffake%2Fmissing/history?q=alpha', { headers: { host: 'tautan.test' } }));
    expect(unknownPane.status).toBe(404); expect(await unknownPane.json()).toEqual({ error: 'pane not found' });
    const noMethod = await get('?q=alpha'); // this fake Mux carries no `history`
    expect(noMethod.status).toBe(501); expect(await noMethod.json()).toEqual({ error: 'unsupported' });
    fakeMux.history = async () => ['alpha one', 'filler', 'Alpha two'];
    const ok = await get('?q=ALPHA&before=3');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ lines: 3, total: 2, matches: [{ line: 1, text: 'alpha one', before: [], after: ['filler', 'Alpha two'] }] });
  });

  test('renames an Agent through /api/rename and reflects it in state', async () => {
    tree.panes[0]!.agent = 'claude'; await hub.refreshHost('local');
    const agentPane = async () => ((await (await handle(new Request('http://tautan.test/api/state'))).json()) as { panes: Pane[] }).panes[0]!;
    // `agent` must be exactly true, alone with paneId; the label may be empty (that clears).
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: 'x', agent: 'yes' })).status).toBe(400);
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: 'x', agent: true, workspaceId: 'w1' })).status).toBe(400);
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: 'x', agent: true, tabId: 't1' })).status).toBe(400);
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', agent: true })).status).toBe(400); // no label
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'missing', label: 'x', agent: true })).status).toBe(404);
    failure = 'unsupported';
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: 'x', agent: true })).status).toBe(501);
    failure = undefined;
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: ' reviewer ', agent: true })).status).toBe(204);
    const renamed = await agentPane();
    expect(renamed.agentName).toBe('reviewer'); // the user's Agent name lands in its own field
    expect(renamed.agent).toBe('claude');       // the Agent TYPE is untouched
    expect((await request('/api/rename', { muxKey: 'local/fake', paneId: 'p1', label: '  ', agent: true })).status).toBe(204);
    expect((await agentPane()).agentName).toBeUndefined();
  });

  test('Settings carries each herdr Host integrations, or the error in their place', async () => {
    integrations = [{ target: 'claude', label: 'claude', command: 'claude', available: true, state: 'current' }];
    const settings = await (await handle(new Request('http://tautan.test/api/settings', { headers: { host: 'tautan.test' } }))).json() as { integrations: { muxKey: string; label: string; integrations?: Integration[]; error?: string }[] };
    expect(settings.integrations).toEqual([{ muxKey: 'local/fake', label: 'fake', integrations }]);
    failure = 'integration_unavailable: socket down';
    const degraded = await (await handle(new Request('http://tautan.test/api/settings', { headers: { host: 'tautan.test' } }))).json() as typeof settings;
    expect(degraded.integrations).toEqual([{ muxKey: 'local/fake', label: 'fake', error: 'integration_unavailable' }]);
    failure = undefined;
  });
});
