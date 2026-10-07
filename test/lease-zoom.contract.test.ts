import { afterAll, beforeAll, expect, test } from 'bun:test';
import { hostId } from '../server/hosts.ts';
import { Hub } from '../server/mux.ts';
import { startHttp } from '../server/http.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

/**
 * ADR 0006: a zoomed layout omits x/y for every Pane, and a Mux-side layout change must
 * reach the state without waiting for the Hub's slow poll. herdr fires `layout.updated`
 * for it; the Hub's own poll interval is off here (refreshMs 0), so this contract passes
 * only through the event. Same single-test shape as lease.contract: the runner's
 * between-test reaping must not kill the detached lease attach mid-story.
 */
test.skipIf(!herdrAvailable)('phone-width lease cycle, then zoom: x/y drop without the poll', async () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>> | undefined;
  let server: ReturnType<typeof startHttp> | undefined;
  let hub: Hub | undefined;
  try {
    fixture = await startThrowawayHerdr();
    const mux = herdrMux(fixture.sock);
    const rpc = (method: string, params: Record<string, unknown>) => herdrRpc(fixture!.sock, method, params);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'zoom' });
    await rpc('workspace.focus', { workspace_id: workspace.id });
    const root = (await mux.tree()).panes.find(p => p.workspaceId === workspace.id)!.id;
    await rpc('pane.split', { pane_id: root, direction: 'right' });
    for (let i = 0; i < 20 && (await mux.tree()).panes.filter(p => p.workspaceId === workspace.id).length < 2; i++) await Bun.sleep(250);
    hub = new Hub({ refreshMs: 0 });
    hub.add(hostId, mux);
    await hub.state();
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir, discover: async () => [] });
    const base = `http://127.0.0.1:${server.port}`;
    const key = `${hostId}/${mux.id}/${root}`;
    const origin = { origin: base };
    // The story's Pane rects: [x, y] per Pane of the workspace, straight from /api/state.
    const xy = async (): Promise<(number | undefined)[][]> =>
      (await (await fetch(`${base}/api/state`)).json()).panes
        .filter((p: { workspaceId?: string }) => p.workspaceId === workspace.id)
        .map((p: { x?: number; y?: number }) => [p.x, p.y]);

    expect((await xy()).every(([x, y]) => typeof x === 'number' && typeof y === 'number')).toBe(true); // the split places cells
    expect((await fetch(`${base}/api/panes/${encodeURIComponent(key)}/lease`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...origin }, body: JSON.stringify({ cols: 50, rows: 20 }),
    })).status).toBe(204);                                                                                          // phone takes the width
    await Bun.sleep(1_500);
    expect((await fetch(`${base}/api/panes/${encodeURIComponent(key)}/lease`, { method: 'DELETE', headers: origin })).status).toBe(204);
    await Bun.sleep(500);
    expect((await xy()).every(([x, y]) => typeof x === 'number' && typeof y === 'number')).toBe(true);               // release restores the split

    await rpc('pane.zoom', { pane_id: root });                                                                      // the operator zooms from herdr
    let rects: (number | undefined)[][] = [];
    for (let i = 0; i < 33 && !(rects = await xy()).every(([x, y]) => x === undefined && y === undefined); i++) await Bun.sleep(150);
    expect(rects.every(([x, y]) => x === undefined && y === undefined)).toBe(true);                                 // zoom drops x/y for every Pane
    expect((await fetch(`${base}/api/hosts/${hostId}/retry`, { method: 'POST', headers: origin })).ok).toBe(true);  // retry keeps it that way
    expect((await xy()).every(([x, y]) => x === undefined && y === undefined)).toBe(true);
  } finally {
    server?.stop(); hub?.close(); await fixture?.stop();
  }
}, 60_000);
