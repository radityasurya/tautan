import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_KEYS, SHELL_KEYS } from '../web/keys.ts';
import { parseAnsi } from '../shared/ansi.ts';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import { herdrAvailable, herdrMux, startThrowawayHerdr } from './harness.ts';

const eventually = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(50); value = await read(); }
  return value;
};

describe.skipIf(!herdrAvailable)('HerdrMux contract', () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>>;
  let mux: ReturnType<typeof herdrMux>;
  let workspaceId: string;
  let paneId: string;

  beforeAll(async () => {
    fixture = await startThrowawayHerdr();
    mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'tautan-contract' });
    workspaceId = workspace.id;
    paneId = (await mux.tree()).panes.find(pane => pane.workspaceId === workspaceId)!.id;
  }, 15_000);

  afterAll(async () => { mux?.close(); await fixture?.stop(); });

  test('tree returns a pane', async () => {
    expect((await mux.tree()).panes.length).toBeGreaterThanOrEqual(1);
  });

  test('sendText and sendKeys reach the visible screen', async () => {
    await mux.sendText(paneId, 'echo tautan-ok');
    await mux.sendKeys(paneId, ['enter']);
    const screen = await eventually(() => mux.read(paneId, 'visible'), value => value.text.includes('tautan-ok'), 5_000);
    expect(screen.text).toContain('tautan-ok');
  });

  test('sendRaw reaches the visible screen', async () => {
    await mux.sendRaw(paneId, 'echo raw-ok\n');
    const screen = await eventually(() => mux.read(paneId, 'visible'), value => value.text.includes('raw-ok'), 5_000);
    expect(screen.text).toContain('raw-ok');
  });

  test('records extended Herdr key-name acceptance', async () => {
    const pane = await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'extended-keys' });
    const results = new Map<string, 'resolved' | 'rejected'>();
    for (const name of ['f1', 'f5', 'f10', 'shift+f', 'ctrl+d', 'shift+tab']) {
      try { await mux.sendKeys(pane.id, [name]); results.set(name, 'resolved'); }
      catch { results.set(name, 'rejected'); }
    }
    console.log('Herdr key-name contract', Object.fromEntries(results));
    expect([...results.values()].every(value => value === 'resolved' || value === 'rejected')).toBe(true);
    try { await mux.closePane(pane.id); } catch {}
  });

  test('forwarded htop click moves its highlighted process row', async () => {
    if (!Bun.which('htop')) return;
    const pane = await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'htop-mouse' });
    // htop paints its column-header row (`PID USER ...`) with a partial, mixed-colour
    // background for the sorted column, and the selected process row with a single,
    // uniform background colour across the whole line. Skip the header explicitly and
    // require a uniform bg colour so meter/tab bars (row 8, mixed green/blue) and the
    // header (mixed green/cyan) don't win over the real selection (solid cyan).
    const highlightedRow = (text: string) => parseAnsi(text).findIndex((line, row) => {
      if (row <= 1) return false;
      const rowText = line.map(span => span.text).join('');
      if (rowText.includes('PID') && rowText.includes('USER')) return false;
      const withBg = line.filter(span => span.bg !== undefined && span.text.trim() !== '');
      return withBg.length > 0 && withBg.every(span => span.bg === withBg[0]!.bg);
    });
    // Hub.close() closes every Mux it was given, so it must not be handed the shared
    // `mux` fixture: that would kill the shared event stream for every later test.
    const hubMux = herdrMux(fixture.sock);
    const hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('contract', hubMux);
    const server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
    try {
      await mux.sendText(pane.id, 'htop\n');
      const ready = await eventually(() => mux.read(pane.id, 'visible'), value => value.text.includes('F10Quit') && highlightedRow(value.text) >= 0, 5_000);
      const current = highlightedRow(ready.text); const target = current + 3;
      const origin = `http://127.0.0.1:${server.port}`;
      const key = `contract/throwaway/${pane.id}`;
      const response = await fetch(`${origin}/api/panes/${encodeURIComponent(key)}/mouse`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'click', col: 5, row: target + 1, allow: true }) });
      expect(response.status).toBe(204);
      const moved = await eventually(() => mux.read(pane.id, 'visible'), value => highlightedRow(value.text) === target, 5_000);
      expect(highlightedRow(moved.text)).toBe(target);
      await mux.sendText(pane.id, 'q');
    } finally { server.stop(); hub.close(); try { await mux.closePane(pane.id); } catch {} }
  }, 15_000);

  test('mouse-off rejects before a plain shell receives bytes', async () => {
    const pane = await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'mouse-off' });
    // See the note in the htop-click test above: never hand the shared `mux` to a Hub.
    const hubMux = herdrMux(fixture.sock);
    const hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('contract', hubMux);
    const server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
    try {
      const before = (await mux.read(pane.id, 'visible')).text;
      const origin = `http://127.0.0.1:${server.port}`; const key = `contract/throwaway/${pane.id}`;
      const response = await fetch(`${origin}/api/panes/${encodeURIComponent(key)}/mouse`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'click', col: 5, row: 5, allow: false }) });
      expect(response.status).toBe(409);
      expect((await mux.read(pane.id, 'visible')).text).toBe(before);
    } finally { server.stop(); hub.close(); try { await mux.closePane(pane.id); } catch {} }
  });

  test('onChange fires after a send', async () => {
    // herdr replays a backlog of `*_created` events on subscribe, so wait for that
    // backlog to settle first, or the assertion passes on stale events instead of the send.
    let lastEventAt = Date.now();
    const settleOff = mux.onChange(ids => {
      if (ids === 'all' || ids.includes(paneId)) lastEventAt = Date.now();
    });
    while (Date.now() - lastEventAt < 300) await Bun.sleep(50);
    settleOff();

    const marker = Date.now();
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { off(); reject(new Error('onChange timed out')); }, 2_000);
      const off = mux.onChange(ids => {
        if ((ids === 'all' || ids.includes(paneId)) && Date.now() >= marker) { clearTimeout(timeout); off(); resolve(); }
      });
    });
    // A plain `echo` never touches PaneInfo, so herdr never emits `pane.updated` for it.
    // Set the terminal title instead: that's a real send through the same pty, and it's
    // the same OSC mechanism agent CLIs use to report status, which is what onChange exists for.
    await mux.sendText(paneId, "printf '\\033]0;tautan-change\\007'");
    await mux.sendKeys(paneId, ['enter']);
    await changed;
  });

  test('all Pane key-bar names are accepted', async () => {
    const pane = await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'key-test' });
    const names = [...new Set([...AGENT_KEYS, ...SHELL_KEYS].map(([name]) => name))].filter(name => name !== 'ctrl');
    names.sort(name => name === 'ctrl+d' ? 1 : -1);
    await mux.sendKeys(pane.id, names);
    try { await mux.closePane(pane.id); } catch {}
  });

  test('newTab, rename, and closePane update the tree', async () => {
    const pane = await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'new-tab' });
    expect((await mux.tree()).panes.some(item => item.id === pane.id)).toBe(true);
    await mux.rename({ paneId: pane.id }, 'renamed-pane');
    expect((await mux.tree()).panes.find(item => item.id === pane.id)?.title).toBe('renamed-pane');
    await mux.closePane(pane.id);
    const tree = await eventually(() => mux.tree(), value => !value.panes.some(item => item.id === pane.id), 2_000);
    expect(tree.panes.some(item => item.id === pane.id)).toBe(false);
  });

  test('newTab can start a named agent', async () => {
    if (!Bun.which('claude')) {
      try { await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'Agent Tab', agent: 'claude' }); }
      catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(/^[^:]+:/); return; }
      throw new Error('agent.start unexpectedly succeeded without claude on PATH');
    }
    const pane = await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'Agent Tab', agent: 'claude' });
    try {
      const tree = await eventually(() => mux.tree(), value => value.panes.find(item => item.id === pane.id)?.agent === 'claude', 30_000);
      expect(tree.panes.find(item => item.id === pane.id)?.agent).toBe('claude');
    } finally { try { await mux.closePane(pane.id); } catch {} }
  }, 40_000);

  test('newWorkspace creates plain and worktree workspaces', async () => {
    const plain = await mux.newWorkspace({ cwd: fixture.dir, label: 'plain-workspace' });
    const plainTree = await mux.tree();
    expect(plainTree.workspaces.find(item => item.id === plain.id)).toMatchObject({ label: 'plain-workspace', cwd: fixture.dir });

    const repo = join(fixture.dir, 'repo');
    await mkdir(repo);
    for (const args of [['git', 'init'], ['git', 'config', 'user.email', 'tautan@example.test'], ['git', 'config', 'user.name', 'Tautan'], ['git', 'commit', '--allow-empty', '-m', 'init']]) {
      const child = Bun.spawn(args, { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(0);
    }
    const worktree = await mux.newWorkspace({ cwd: repo, branch: 'tautan-wt', label: 'worktree-workspace' });
    expect((await mux.tree()).workspaces.find(item => item.id === worktree.id)?.label).toBe('worktree-workspace');
    expect(worktree.cwd).toBeTruthy();
    expect((await stat(worktree.cwd!)).isDirectory()).toBe(true);
    const listed = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: repo });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString()).toContain(`worktree ${worktree.cwd}`);
  });

  test('rename updates workspace, tab, and pane labels', async () => {
    const pane = await mux.newTab(workspaceId, { cwd: fixture.dir, label: 'rename-all' });
    try {
      await mux.rename({ workspaceId }, 'renamed-workspace');
      await mux.rename({ tabId: pane.tabId }, 'renamed-tab');
      await mux.rename({ paneId: pane.id }, 'renamed-pane-all');
      const tree = await mux.tree();
      expect(tree.workspaces.find(item => item.id === workspaceId)?.label).toBe('renamed-workspace');
      expect(tree.tabs.find(item => item.id === pane.tabId)?.label).toBe('renamed-tab');
      expect(tree.panes.find(item => item.id === pane.id)?.title).toBe('renamed-pane-all');
    } finally { try { await mux.closePane(pane.id); } catch {} }
  });

  test('explain returns null for a shell', async () => {
    expect(await mux.explain(paneId)).toBeNull();
  });
});
