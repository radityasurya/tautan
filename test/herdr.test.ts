import { createServer, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HerdrMux } from '../server/herdr.ts';

// A fake herdr: one request per connection, records every params object it saw.
const socketPath = join(tmpdir(), `tautan-herdr-test-${process.pid}.sock`);
const seen: Record<string, any>[] = [];
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
      if (request.method === 'events.subscribe') {
        // Reject any subscribe that still asks for `layout.updated`, worded unlike real 0.8
        // so the test proves the fallback does not match on the error text.
        if (request.params.subscriptions.some((s: any) => s.type === 'layout.updated'))
          socket.end(`${JSON.stringify({ id: request.id, error: { code: -32602, message: 'nope' } })}\n`);
        else socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
        return;
      }
      const result = request.method === 'session.snapshot' ? snapshot : { read: { text: 'hi\r\n', revision: 9, truncated: false } };
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
