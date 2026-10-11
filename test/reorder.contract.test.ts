import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hostId } from '../server/hosts.ts';
import { Hub } from '../server/mux.ts';
import { startHttp } from '../server/http.ts';
import { HerdrMux } from '../server/herdr.ts';
import { TmuxMux } from '../server/tmux.ts';
import type { Mux, State } from '../shared/types.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

const tmuxAvailable = Bun.which('tmux') !== null && process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1';

/** A Hub plus its HTTP routes on a throwaway port, driven with plain fetch. */
async function serve(mux: Mux, staticDir: string, refreshMs = 0) {
  const hub = new Hub({ refreshMs, suggest: null });
  hub.add(hostId, mux);
  await hub.state();
  const server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir, discover: async () => [] });
  const base = `http://127.0.0.1:${server.port}`;
  const muxKey = `${hostId}/${mux.id}`;
  return {
    base, muxKey, stop: () => { server.stop(); hub.close(); },
    state: async (): Promise<State> => await (await fetch(`${base}/api/state`)).json(),
    move: (kind: 'workspaces' | 'tabs', key: string, body: unknown) =>
      fetch(`${base}/api/${kind}/${encodeURIComponent(key)}/move`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body),
      }),
  };
}

describe.skipIf(!herdrAvailable)('herdr: order writes through the Hub (ADR 0009)', () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>>;
  let api: Awaited<ReturnType<typeof serve>>;

  beforeAll(async () => {
    fixture = await startThrowawayHerdr();
    const mux = herdrMux(fixture.sock); // setup only; a Hub must own its own mux
    const setup = herdrMux(fixture.sock);
    const a = await setup.newWorkspace({ cwd: fixture.dir, label: 'order-a' });
    const b = await setup.newWorkspace({ cwd: fixture.dir, label: 'order-b' });
    await setup.newTab(a.id, { cwd: fixture.dir, label: 'a2' });
    await setup.newTab(a.id, { cwd: fixture.dir, label: 'a3' });
    setup.close();
    api = await serve(mux, fixture.dir);
  }, 20_000);

  afterAll(async () => { api?.stop(); await fixture.stop(); });

  test('a Workspace move up and a down-to-append are in state when the 204 arrives', async () => {
    const first = async () => {
      const workspaces = (await api.state()).workspaces.filter(w => w.muxKey === api.muxKey);
      return workspaces.map(w => w.id);
    };
    const initial = await first();
    expect(initial).toHaveLength(2);
    const a = initial[0]!; const b = initial[1]!;
    // Move the last Workspace to the head: final position is `index` when moving up.
    expect((await api.move('workspaces', `${api.muxKey}/${b}`, { index: 0 })).status).toBe(204);
    expect(await first()).toEqual([b, a]);
    // Move it back down to the end: index == count appends.
    expect((await api.move('workspaces', `${api.muxKey}/${b}`, { index: 2 })).status).toBe(204);
    expect(await first()).toEqual(initial);
  });

  test('a Tab move up, a move down, an append, and an own-index no-op', async () => {
    const order = async () => {
      const state = await api.state();
      const ws = state.workspaces.find(w => w.muxKey === api.muxKey && w.label === 'order-a')!.id;
      return state.tabs.filter(t => t.muxKey === api.muxKey && t.workspaceId === ws).map(t => t.id);
    };
    const initial = await order();
    expect(initial).toHaveLength(3);
    // Up: the last Tab to the head (index 0 lands at 0).
    expect((await api.move('tabs', `${api.muxKey}/${initial[2]}`, { index: 0 })).status).toBe(204);
    expect(await order()).toEqual([initial[2], initial[0], initial[1]]);
    // Down past its own slot: index 2 on the head lands at 1 (splice model).
    expect((await api.move('tabs', `${api.muxKey}/${initial[2]}`, { index: 2 })).status).toBe(204);
    expect(await order()).toEqual([initial[0], initial[2], initial[1]]);
    // Append: index == count.
    expect((await api.move('tabs', `${api.muxKey}/${initial[2]}`, { index: 3 })).status).toBe(204);
    expect(await order()).toEqual([initial[0], initial[1], initial[2]]);
    // Its own index: 204, order unchanged, and herdr fires nothing.
    expect((await api.move('tabs', `${api.muxKey}/${initial[2]}`, { index: 2 })).status).toBe(204);
    expect(await order()).toEqual([initial[0], initial[1], initial[2]]);
  });

  test('an out-of-range index surfaces herdr\'s error code as 502, a bad body as 400', async () => {
    const tab = (await api.state()).tabs.find(t => t.muxKey === api.muxKey)!;
    const out = await api.move('tabs', `${api.muxKey}/${tab.id}`, { index: 99 });
    expect(out.status).toBe(502);
    expect(await out.json()).toEqual({ error: 'tab_move_failed' });
    for (const body of [{ index: -1 }, { index: 1.5 }, { index: '0' }, {}, null]) {
      const response = await api.move('tabs', `${api.muxKey}/${tab.id}`, body);
      expect(response.status).toBe(400);
    }
    expect((await api.move('tabs', `${api.muxKey}/w9:t9`, { index: 0 })).status).toBe(404);
    expect((await api.move('workspaces', `${api.muxKey}/w9`, { index: 0 })).status).toBe(404);
  });
});

describe.skipIf(!herdrAvailable)('herdr: a herdr-side move reaches the Hub through the event', () => {
  test('the state follows well inside the slow-poll interval', async () => {
    const fixture = await startThrowawayHerdr();
    try {
      const setup = herdrMux(fixture.sock);
      const a = await setup.newWorkspace({ cwd: fixture.dir, label: 'ev-a' });
      const b = await setup.newWorkspace({ cwd: fixture.dir, label: 'ev-b' });
      setup.close();
      // No tree poll for a minute: only the ADR 0009 events can carry the reorder.
      const api = await serve(herdrMux(fixture.sock), fixture.dir, 60_000);
      try {
        expect((await api.state()).workspaces.filter(w => w.muxKey === api.muxKey).map(w => w.id)).toEqual([a.id, b.id]);
        // A reorder made straight on the throwaway socket, the way herdr's own window makes one.
        await herdrRpc(fixture.sock, 'workspace.move', { workspace_id: b.id, insert_index: 0 });
        const deadline = Date.now() + 10_000;
        let ids: string[] = [];
        while (Date.now() < deadline) {
          ids = (await api.state()).workspaces.filter(w => w.muxKey === api.muxKey).map(w => w.id);
          if (ids[0] === b.id) break;
          await Bun.sleep(100);
        }
        expect(ids).toEqual([b.id, a.id]);
      } finally { api.stop(); }
    } finally { await fixture.stop(); }
  }, 30_000);
});

describe.skipIf(!tmuxAvailable)('tmux: Tab moves through the Hub (ADR 0009)', () => {
  let dir: string;
  let sock: string;
  let api: Awaited<ReturnType<typeof serve>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tautan-tmux-order-'));
    sock = join(dir, 't.sock');
    const tmux = (args: string[]) => Bun.spawn(['tmux', '-f', '/dev/null', '-S', sock, ...args], { stdout: 'ignore', stderr: 'ignore' }).exited;
    expect(await tmux(['new', '-d', '-s', 't', '-x', '80', '-y', '24', 'exec sh'])).toBe(0);
    for (let i = 0; i < 3; i++) expect(await tmux(['new-window', '-d', '-t', 't:', 'exec sh'])).toBe(0);
    api = await serve(new TmuxMux({ id: 't', socket: sock, treeIntervalMs: 60_000, screenIntervalMs: 60_000 }), dir);
  }, 15_000);

  afterAll(async () => {
    api?.stop();
    if (sock) await Bun.spawn(['tmux', '-S', sock, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const order = async () => (await api.state()).tabs.filter(t => t.muxKey === api.muxKey).map(t => t.id);

  test('a Tab move up, down, and append land on herdr\'s splice positions', async () => {
    const initial = await order();
    expect(initial).toHaveLength(4);
    // Up: index 0 on the second Tab lands at 0.
    expect((await api.move('tabs', `${api.muxKey}/${initial[1]}`, { index: 0 })).status).toBe(204);
    expect(await order()).toEqual([initial[1], initial[0], initial[2], initial[3]]);
    // Down past its own slot: index 3 on the head lands at 2.
    expect((await api.move('tabs', `${api.muxKey}/${initial[1]}`, { index: 3 })).status).toBe(204);
    expect(await order()).toEqual([initial[0], initial[2], initial[1], initial[3]]);
    // Append: index == count.
    expect((await api.move('tabs', `${api.muxKey}/${initial[1]}`, { index: 4 })).status).toBe(204);
    expect(await order()).toEqual([initial[0], initial[2], initial[3], initial[1]]);
    // Its own index: 204 and no write.
    expect((await api.move('tabs', `${api.muxKey}/${initial[1]}`, { index: 3 })).status).toBe(204);
    expect(await order()).toEqual([initial[0], initial[2], initial[3], initial[1]]);
  });

  test('a Workspace move answers 501 and a bad index 400', async () => {
    const workspace = (await api.state()).workspaces.find(w => w.muxKey === api.muxKey)!;
    expect((await api.move('workspaces', workspace.key, { index: 0 })).status).toBe(501);
    const tab = (await api.state()).tabs.find(t => t.muxKey === api.muxKey)!;
    expect((await api.move('tabs', tab.key, { index: -1 })).status).toBe(400);
    expect((await api.move('tabs', tab.key, { index: 9 })).status).toBe(502); // past the count, herdr parity
  });
});

// A fake herdr 0.7.5: older than the ADR 0009 gate, and without `workspace.reordered`
// (0.8.0) or `layout.updated` (0.9) — the subscription fallback must drop both, newest
// first, and still subscribe to the 0.7 move events.
describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('a Mux older than the 0.8 gate', () => {
  const socketPath = join(tmpdir(), `tautan-herdr075-${process.pid}.sock`);
  const subscribes: string[][] = [];
  let server: Server | undefined;
  const snapshot = { snapshot: { version: '0.7.5', workspaces: [{ workspace_id: 'w1', label: 'w1' }], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }], panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', revision: 1, agent_status: 'idle' }] } };

  beforeAll(async () => {
    const srv = createServer(socket => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        if (request.method === 'events.subscribe') {
          subscribes.push(request.params.subscriptions.map((s: any) => s.type));
          const tooNew = request.params.subscriptions.some((s: any) => s.type === 'layout.updated' || s.type === 'workspace.reordered');
          if (tooNew) socket.end(`${JSON.stringify({ id: request.id, error: { code: -32602, message: 'unknown variant' } })}\n`);
          else socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ id: request.id, result: request.method === 'session.snapshot' ? snapshot : {} })}\n`);
      });
    });
    server = srv;
    await new Promise<void>(resolve => srv.listen(socketPath, resolve));
  });
  afterAll(() => { server?.close(); try { unlinkSync(socketPath); } catch {} });

  test('the move routes answer 501 and the subscription falls back to the 0.7 events', async () => {
    const mux = new HerdrMux('old', socketPath);
    const hub = new Hub({ refreshMs: 0, suggest: null });
    hub.add(hostId, mux);
    await hub.state();
    const dir = await mkdtemp(join(tmpdir(), 'tautan-075-routes-'));
    const http = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir, discover: async () => [] });
    const base = `http://127.0.0.1:${http.port}`;
    try {
      const post = (path: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"index":0}' });
      expect((await post(`/api/workspaces/${encodeURIComponent(`${hostId}/old/w1`)}/move`)).status).toBe(501);
      expect((await post(`/api/tabs/${encodeURIComponent(`${hostId}/old/w1:t1`)}/move`)).status).toBe(501);
      // The reconnect backoff (1 s, then 2 s) needs a moment to drop both new variants —
      // and it must settle while the Hub still lives; close() would cancel the retry.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !subscribes.some(types => !types.includes('layout.updated') && !types.includes('workspace.reordered'))) await Bun.sleep(100);
    } finally { http.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); }

    // The gate refused before any RPC: the only writes the fake saw were subscriptions.
    expect(subscribes[0]).toContain('layout.updated');
    expect(subscribes[0]).toContain('workspace.reordered');
    const settled = subscribes.find(types => !types.includes('layout.updated') && !types.includes('workspace.reordered'));
    expect(settled).toContain('workspace.moved');
    expect(settled).toContain('tab.moved');
    expect(settled).toContain('pane.moved');
  }, 20_000);
});
