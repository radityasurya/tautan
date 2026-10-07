import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostId } from '../server/hosts.ts';
import { Hub } from '../server/mux.ts';
import { startHttp } from '../server/http.ts';
import { TmuxMux } from '../server/tmux.ts';
import type { Mux, StatePane } from '../shared/types.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

const tmuxAvailable = Bun.which('tmux') !== null && process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1';

/** Drive POST /api/panes/:key/zoom on a 2-Pane Tab: zoom one Pane, then unzoom from the other. */
async function zoomStory(mux: Mux, tabId: string, staticDir: string): Promise<void> {
  const hub = new Hub({ refreshMs: 0, suggest: null });
  hub.add(hostId, mux);
  await hub.state();
  const server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir, discover: async () => [] });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const panes = async (): Promise<StatePane[]> =>
      ((await (await fetch(`${base}/api/state`)).json()).panes as StatePane[]).filter(pane => pane.tabId === tabId);
    const zoom = (pane: StatePane, zoomed: boolean) => fetch(`${base}/api/panes/${encodeURIComponent(pane.key)}/zoom`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ zoomed }),
    });
    const [first, second] = await panes();
    expect(second).toBeDefined();
    expect((await panes()).every(pane => typeof pane.x === 'number' && !pane.zoomed)).toBe(true);    // the split places cells

    // The route awaits a tree refresh, so the state read right after already shows the zoom.
    expect((await zoom(first!, true)).status).toBe(204);
    let after = await panes();
    expect(after.find(pane => pane.id === first!.id)?.zoomed).toBe(true);                                 // the zoomed Pane is named
    expect(after.find(pane => pane.id === second!.id)?.zoomed).toBeUndefined();
    expect(after.every(pane => pane.x === undefined && pane.y === undefined)).toBe(true);                // and x/y are gone
    expect((await zoom(first!, true)).status).toBe(204);                                                  // zoom on is idempotent
    expect((await panes()).find(pane => pane.id === first!.id)?.zoomed).toBe(true);

    // Unzoom from the hidden Pane: it names the Tab, not the zoomed Pane.
    expect((await zoom(second!, false)).status).toBe(204);
    after = await panes();
    expect(after.every(pane => typeof pane.x === 'number' && typeof pane.y === 'number' && !pane.zoomed)).toBe(true);
  } finally { server.stop(); hub.close(); }
}

test.skipIf(!herdrAvailable)('herdr: zoom and unzoom a Pane through the Hub', async () => {
  const fixture = await startThrowawayHerdr();
  try {
    const mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'zoom' });
    const root = (await mux.tree()).panes.find(pane => pane.workspaceId === workspace.id)!;
    await herdrRpc(fixture.sock, 'pane.split', { pane_id: root.id, direction: 'right' });
    for (let i = 0; i < 20 && (await mux.tree()).panes.filter(pane => pane.tabId === root.tabId).length < 2; i++) await Bun.sleep(250);
    await zoomStory(mux, root.tabId, fixture.dir);
  } finally { await fixture.stop(); }
}, 60_000);

test.skipIf(!tmuxAvailable)('tmux: zoom and unzoom a Pane through the Hub', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tautan-tmux-zoom-'));
  const sock = join(dir, 't.sock');
  const tmux = (args: string[]) => Bun.spawn(['tmux', '-f', '/dev/null', '-S', sock, ...args], { stdout: 'ignore', stderr: 'ignore' }).exited;
  try {
    expect(await tmux(['new', '-d', '-s', 'z', '-x', '120', '-y', '30', 'exec sh'])).toBe(0);
    expect(await tmux(['split-window', '-h', '-t', 'z', 'exec sh'])).toBe(0);
    const mux = new TmuxMux({ id: 'z', socket: sock, treeIntervalMs: 60_000, screenIntervalMs: 60_000 });
    await zoomStory(mux, (await mux.tree()).panes[0]!.tabId, dir);
  } finally {
    await tmux(['kill-server']);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
