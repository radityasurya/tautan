import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HerdrMux } from '../server/herdr.ts';
import { hostId } from '../server/hosts.ts';
import { Hub } from '../server/mux.ts';
import { startHttp } from '../server/http.ts';

// A fake herdr: one request per connection, records every params object it saw.
const socketPath = join(tmpdir(), `tautan-herdr-test-${process.pid}.sock`);
const seen: Record<string, any>[] = [];
const seenMethods: string[] = [];
// 21.4.1: what plugin.log.list answers, and what an invoke appends to it (mirrors herdr:
// the invoke reply already carries a `running` log; here it lands settled for speed).
// `refusePluginLog` answers the 0.8-style `unknown variant` an older server gives.
let pluginLogs: Record<string, any>[] = [];
let invokeOutcome: Record<string, any> | null = null;
let refusePluginLog = false;
// A poll that hangs: plugin.log.list requests after an invoke never answer, so the client's
// per-poll budget — not the rpc default — is the only thing that can end them.
let hangPollsAfterInvoke = false;
let sawInvoke = false;
let server: Server;

const snapshot = {
  snapshot: {
    workspaces: [
      { workspace_id: 'w1', label: 'w1' },
      // herdr 0.9.2 links a Workspace to a git worktree; 0.9.0 omits the field entirely.
      { workspace_id: 'w2', label: 'w2', worktree: { checkout_path: '/wt/checkout', repo_root: '/wt/repo', is_linked_worktree: true, repo_key: 'k', repo_name: 'r' } },
      { workspace_id: 'w3', label: 'w3' },
    ],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }, { tab_id: 'w1:t2', workspace_id: 'w1' }, { tab_id: 'w2:t1', workspace_id: 'w2' }],
    layouts: [
      { zoomed: false, panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 80, height: 50 } }, { pane_id: 'w1:p2', rect: { x: 80, y: 0, width: 40, height: 50 } }] },
      { zoomed: true, focused_pane_id: 'w1:p3', panes: [{ pane_id: 'w1:p3', rect: { x: 0, y: 0, width: 120, height: 50 } }] },
    ],
    panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd: '/run/w1', revision: 7, agent_status: 'idle' },
      { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', revision: 1, agent_status: 'idle' },
      { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1', revision: 1, agent_status: 'idle' },
      { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2', cwd: '/run/w2', revision: 1, agent_status: 'idle' },
    ],
  },
};

// herdr 0.9.3's PluginPlatform is linux | macos | windows. One action per platform name,
// plus the two undeclared shapes: platforms absent, and platforms an empty list — herdr
// itself refuses an empty array at link time, so that row only pins the filter's contract.
const platformActions = [
  { plugin_id: 'p', action_id: 'plat-linux', title: 'linux', contexts: ['pane'], platforms: ['linux'] },
  { plugin_id: 'p', action_id: 'plat-macos', title: 'macos', contexts: ['pane'], platforms: ['macos'] },
  { plugin_id: 'p', action_id: 'plat-windows', title: 'windows', contexts: ['pane'], platforms: ['windows'] },
  { plugin_id: 'p', action_id: 'plat-absent', title: 'absent', contexts: ['pane'] },
  { plugin_id: 'p', action_id: 'plat-empty', title: 'empty', contexts: ['pane'], platforms: [] },
];

beforeAll(async () => {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') return;
  server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      seen.push(request.params);
      seenMethods.push(request.method);
      if (request.method === 'events.subscribe') {
        // Reject any subscribe that still asks for `layout.updated`, worded unlike real 0.8
        // so the test proves the fallback does not match on the error text.
        if (request.params.subscriptions.some((s: any) => s.type === 'layout.updated'))
          socket.end(`${JSON.stringify({ id: request.id, error: { code: -32602, message: 'nope' } })}\n`);
        else socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
        return;
      }
      if (request.method === 'pane.get') {
        socket.end(`${JSON.stringify({ id: request.id, result: { pane: { scroll: { max_offset_from_bottom: 5, viewport_rows: 24 } } } })}\n`);
        return;
      }
      if (request.method === 'pane.selection.read') {
        // A herdr older than the method answers serde's unknown variant with JSON-RPC -32602.
        socket.end(`${JSON.stringify({ id: request.id, error: { code: -32602, message: 'unknown variant `pane.selection.read`' } })}\n`);
        return;
      }
      if (request.method === 'plugin.log.list' && refusePluginLog) {
        socket.end(`${JSON.stringify({ id: request.id, error: { code: 'unknown variant', message: 'plugin_log_list' } })}\n`);
        return;
      }
      if (request.method === 'plugin.log.list' && hangPollsAfterInvoke && sawInvoke) return; // hang: no reply
      const result = request.method === 'session.snapshot' ? snapshot
        : request.method === 'plugin.action.list' ? { actions: platformActions }
        : request.method === 'plugin.list' ? { plugins: [{ plugin_id: 'p', name: 'P' }] }
        : request.method === 'plugin.log.list' ? { logs: pluginLogs }
        : request.method === 'plugin.action.invoke' ? (
          sawInvoke = true,
          invokeOutcome && pluginLogs.push({ log_id: `log-${pluginLogs.length + 1}`, plugin_id: request.params.plugin_id, action_id: request.params.action_id, ...invokeOutcome }),
          { type: 'plugin_action_invoked' }
        )
        : { read: { text: 'hi\r\n', revision: 9, truncated: false } };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
});
afterAll(() => { server?.close(); try { unlinkSync(socketPath); } catch {} });

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux.read', () => {
  test('asks for less recent text than the pane is tall', async () => {
    // herdr 0.8.0 turns pathologically slow (~30 ms/line) once `lines` reaches the pane
    // height, so a 50-row pane must be asked for at most 48.
    const mux = new HerdrMux('test', socketPath);
    await mux.tree();
    await mux.read('w1:p1', 'recent');
    expect(seen.at(-1)).toMatchObject({ pane_id: 'w1:p1', source: 'recent', lines: 48 });
    mux.close();
  });

  test('falls back to a safe line count for an unknown pane', async () => {
    const mux = new HerdrMux('test', socketPath);
    await mux.read('w9:p9', 'recent');
    expect(seen.at(-1)!.lines).toBeLessThanOrEqual(48);
    mux.close();
  });

  test('visible reads ask for the ansi grid and no line count', async () => {
    const mux = new HerdrMux('test', socketPath);
    await mux.read('w1:p1', 'visible');
    expect(seen.at(-1)).toEqual({ pane_id: 'w1:p1', source: 'visible', format: 'ansi', strip_ansi: false });
    mux.close();
  });
});

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux events fallback', () => {
  test('drops layout.updated after any error reply and reconnects without it', async () => {
    // `seen` also holds earlier tests' calls: count only this mux's subscribes, and wait for
    // the reconnect that dropped layout.updated, not for any second subscribe.
    const from = seen.length;
    const mux = new HerdrMux('test', socketPath);
    mux.onChange(() => {});
    const types = () => seen.slice(from).filter(params => params?.subscriptions).map(params => params.subscriptions.map((s: any) => s.type));
    while (types().length < 2) await new Promise(resolve => setTimeout(resolve, 50));
    expect(types()[0]).toContain('layout.updated');
    expect(types().at(-1)).not.toContain('layout.updated');
    mux.close();
  }, 10_000);
});

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux.tree workspace cwd', () => {
  test('prefers the worktree checkout path, then the root pane, then none', async () => {
    const mux = new HerdrMux('test', socketPath);
    const workspaces = (await mux.tree()).workspaces;
    // A linked worktree's checkout_path wins over the pane cwd.
    expect(workspaces.find(w => w.id === 'w2')!.cwd).toBe('/wt/checkout');
    // No worktree (herdr 0.9.0 or an unlinked Workspace): derived from the first Pane.
    expect(workspaces.find(w => w.id === 'w1')!.cwd).toBe('/run/w1');
    // No worktree and no Pane: no cwd at all.
    expect(workspaces.find(w => w.id === 'w3')!.cwd).toBeUndefined();
    mux.close();
  });
});

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux.tree geometry', () => {
  test('copies rect x/y and omits both for every Pane of a zoomed layout', async () => {
    const mux = new HerdrMux('test', socketPath);
    const panes = (await mux.tree()).panes;
    expect(panes.find(pane => pane.id === 'w1:p1')).toMatchObject({ x: 0, y: 0, cols: 80, rows: 50 });
    expect(panes.find(pane => pane.id === 'w1:p2')).toMatchObject({ x: 80, y: 0, cols: 40, rows: 50 });
    // ADR 0006: a zoomed layout's rects are bookkeeping, so both x and y stay absent.
    const zoomed = panes.find(pane => pane.id === 'w1:p3')!;
    expect(zoomed).toMatchObject({ cols: 120, rows: 50 });
    expect(zoomed.x).toBeUndefined();
    expect(zoomed.y).toBeUndefined();
    // The layout's focused Pane is the zoomed one; a split Pane carries no flag.
    expect(zoomed.zoomed).toBe(true);
    expect(panes.find(pane => pane.id === 'w1:p1')!.zoomed).toBeUndefined();
    mux.close();
  });
});

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux.history', () => {
  test("maps an old server's unknown variant to unsupported, and the route answers 501", async () => {
    const mux = new HerdrMux('test', socketPath);
    // rpc() prefixes herdr's frame (`-32602: unknown variant …`), so the check must read
    // inside the message, not at its start — otherwise this rejects with '-32602: …'.
    await expect(mux.history('w1:p1')).rejects.toThrow('unsupported');

    const hub = new Hub({ refreshMs: 0, suggest: null });
    hub.add(hostId, mux);
    await hub.state();
    const dir = mkdtempSync(join(tmpdir(), 'tautan-history-route-'));
    const server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir, discover: async () => [] });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/panes/${encodeURIComponent(`${hostId}/test/w1:p1`)}/history?q=word`);
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: 'unsupported' });
    } finally { server.stop(); hub.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux.pluginActions platform filter', () => {
  test('shows an action only when its platforms cover the mapped process.platform', async () => {
    // The filter maps process.platform onto herdr's PluginPlatform names and hides a
    // declared action that does not cover it; platforms absent or empty means every
    // platform. A platform the map does not cover matches nothing declared — the
    // remote-Host hazard the Hub's own-platform filter carries (21.4.7).
    const cases: [string, string[]][] = [
      ['linux', ['plat-linux', 'plat-absent', 'plat-empty']],
      ['darwin', ['plat-macos', 'plat-absent', 'plat-empty']],
      ['win32', ['plat-windows', 'plat-absent', 'plat-empty']],
      ['freebsd', ['plat-absent', 'plat-empty']],
    ];
    const real = process.platform;
    for (const [platform, expected] of cases) {
      // A fresh mux per platform: pluginActions caches its answer for 30 s.
      const mux = new HerdrMux('test', socketPath);
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        const actions = await mux.pluginActions();
        expect(actions.map(action => action.actionId)).toEqual(expected);
      } finally {
        Object.defineProperty(process, 'platform', { value: real });
        mux.close();
      }
    }
  });
});

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux.pluginActions fresh (21.4.2)', () => {
  test('fresh re-reads plugin.action.list past the 30 s cache and refreshes it', async () => {
    const mux = new HerdrMux('test', socketPath);
    const count = () => seenMethods.filter(method => method === 'plugin.action.list').length;
    const before = count();
    await mux.pluginActions();        // reads and caches
    await mux.pluginActions();        // inside the TTL: the cache answers
    expect(count()).toBe(before + 1);
    await mux.pluginActions(true);    // 21.4.2: the menu opened — read herdr again
    expect(count()).toBe(before + 2);
    await mux.pluginActions();        // the fresh read refreshed the cache
    expect(count()).toBe(before + 2);
    mux.close();
  });
});

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux.invokePluginAction outcome (21.4.1)', () => {
  test('a failed run reports the exit code and the last stderr line', async () => {
    pluginLogs = [{ log_id: 'log-old', plugin_id: 'p', action_id: 'mark', status: 'succeeded', exit_code: 0, stderr: '' }];
    invokeOutcome = { status: 'failed', exit_code: 3, stdout: '', stderr: 'noise\nthe scratch script is missing\n' };
    const mux = new HerdrMux('test', socketPath);
    await mux.tree(); // paneContexts, as the Hub holds them before an invoke
    const run = await mux.invokePluginAction('w1:p1', 'mark', 'p');
    expect(run).toEqual({ status: 'failed', exitCode: 3, message: 'the scratch script is missing' });
    mux.close();
  });

  test('a succeeded run reports its exit code; a log the server refuses reads as unknown', async () => {
    pluginLogs = [];
    invokeOutcome = { status: 'succeeded', exit_code: 0, stdout: '', stderr: '' };
    const mux = new HerdrMux('test', socketPath);
    await mux.tree();
    expect(await mux.invokePluginAction('w1:p1', 'mark', 'p')).toEqual({ status: 'succeeded', exitCode: 0 });
    refusePluginLog = true; // a server older than plugin.log.list
    expect(await mux.invokePluginAction('w1:p1', 'mark', 'p')).toEqual({ status: 'unknown' });
    refusePluginLog = false;
    mux.close();
  });

  test('a settled status herdr may add later reads as unknown, not succeeded', async () => {
    // 21.4.1 review: `cancelled` is neither of the two statuses PluginRun names, so it maps
    // to unknown — and its exit code does not leak into the answer.
    pluginLogs = [{ log_id: 'log-old', plugin_id: 'p', action_id: 'mark', status: 'succeeded', exit_code: 0, stderr: '' }];
    invokeOutcome = { status: 'cancelled', exit_code: 9, error: 'aborted by user' };
    const mux = new HerdrMux('test', socketPath);
    await mux.tree();
    expect(await mux.invokePluginAction('w1:p1', 'mark', 'p')).toEqual({ status: 'unknown' });
    mux.close();
  });

  test('a poll RPC that hangs is cut at the deadline, not at the rpc default', async () => {
    // The window is the test seam's 1.2 s; a hung poll must end inside it. With the old
    // fixed 10 s rpc timeout the route held for 10 s more and this elapsed check failed.
    pluginLogs = [{ log_id: 'log-old', plugin_id: 'p', action_id: 'mark', status: 'succeeded', exit_code: 0, stderr: '' }];
    invokeOutcome = null; // no log lands, so only the window can end the polls
    hangPollsAfterInvoke = true; sawInvoke = false;
    const mux = new HerdrMux('test', socketPath);
    (mux as any).pluginPollMs = 1_200;
    await mux.tree();
    const start = Date.now();
    try {
      expect(await mux.invokePluginAction('w1:p1', 'mark', 'p')).toEqual({ status: 'unknown' });
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally { hangPollsAfterInvoke = false; mux.close(); }
  }, 10_000);
});
