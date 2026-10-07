import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HerdrMux } from '../server/herdr.ts';

// A fake herdr 0.8 (no 0.8 binary ships on this machine; installed is 0.9.2): one response
// per connection for RPC, `layout.updated` refused with an error reply and a closed socket,
// and the accepted events.subscribe connection kept open for pushed events.
const socketPath = join(tmpdir(), `tautan-herdr08-${process.pid}.sock`);
const subscribes: string[][] = [];
let server: Server;
let events: Socket | undefined;

// Mutable snapshot: the test moves it forward the way the real server would.
const snapshot = {
  snapshot: {
    version: '0.8.0',
    workspaces: [{ workspace_id: 'w1', label: 'w1' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }],
    layouts: [{ zoomed: false, panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 80, height: 50 } }] }],
    panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', revision: 7, agent_status: 'idle' }],
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
      if (request.method === 'events.subscribe') {
        subscribes.push(request.params.subscriptions.map((s: any) => s.type));
        if (request.params.subscriptions.some((s: any) => s.type === 'layout.updated')) {
          // 0.8 refuses the unknown variant and closes the socket.
          socket.end(`${JSON.stringify({ id: request.id, error: { code: -32602, message: 'unknown variant `layout.updated`' } })}\n`);
        } else {
          events = socket;
          socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
        }
        return;
      }
      socket.end(`${JSON.stringify({ id: request.id, result: request.method === 'session.snapshot' ? snapshot : {} })}\n`);
    });
    socket.on('close', () => { if (events === socket) events = undefined; });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
});
afterAll(() => { server?.close(); try { unlinkSync(socketPath); } catch {} });

const push = (message: unknown) => events?.write(`${JSON.stringify(message)}\n`);
const until = async (ok: () => boolean) => { while (!ok()) await new Promise(resolve => setTimeout(resolve, 25)); };

describe.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('HerdrMux against herdr 0.8', () => {
  test('resubscribes without layout.updated, still receives events, and the tree still updates', async () => {
    const mux = new HerdrMux('test', socketPath);
    const calls: (string[] | 'all')[] = [];
    mux.onChange(ids => calls.push(ids));

    // The first subscribe asks for layout.updated and is refused; the retry comes after a 1 s backoff.
    await until(() => subscribes.length >= 2);
    expect(subscribes[0]).toContain('layout.updated');
    expect(subscribes[1]).not.toContain('layout.updated');
    await until(() => Boolean(events));

    // pane.updated still arrives and is debounced into a targeted emit. The retry's
    // subscription_started may already have emitted 'all' (backoff > 1 s), so match by content.
    snapshot.snapshot.panes[0].revision = 8;
    push({ event: 'pane_updated', data: { pane: { pane_id: 'w1:p1', revision: 8 } } });
    await until(() => calls.some(ids => ids !== 'all' && (ids as string[]).includes('w1:p1')));
    expect(calls.find(ids => ids !== 'all')).toEqual(['w1:p1']);

    // Other events still arrive: a structural change emits 'all'.
    snapshot.snapshot.tabs.push({ tab_id: 'w1:t2', workspace_id: 'w1' });
    snapshot.snapshot.layouts[0].panes[0].rect.width = 100;
    snapshot.snapshot.layouts[0].panes.push({ pane_id: 'w1:p2', rect: { x: 80, y: 0, width: 40, height: 50 } });
    snapshot.snapshot.panes.push({ pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', revision: 1, agent_status: 'idle' });
    push({ event: 'tab_created', data: { tab: { tab_id: 'w1:t2' } } });
    await until(() => calls.at(-1) === 'all');

    // The refresh the Hub runs on a change reads the snapshot again: without any layout event,
    // the new Tab, its Pane geometry and the moved revision all arrive through tree().
    const tree = await mux.tree();
    expect(tree.tabs.map(tab => tab.id)).toEqual(['w1:t1', 'w1:t2']);
    expect(tree.panes.find(pane => pane.id === 'w1:p1')).toMatchObject({ revision: 8, cols: 100, rows: 50 });
    expect(tree.panes.find(pane => pane.id === 'w1:p2')).toMatchObject({ x: 80, cols: 40, rows: 50 });
    mux.close();
  }, 15_000);
});
