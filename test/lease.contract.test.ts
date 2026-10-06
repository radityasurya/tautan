import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Hub } from '../server/mux.ts';
import { startHttp } from '../server/http.ts';
import { herdrAvailable, herdrMux, startThrowawayHerdr } from './harness.ts';

/**
 * One sequential contract: the runner's between-test reaping kills lease attaches
 * mid-suite (a detached child still dies with the file's process group on herdr
 * 0.9.2), so the whole story runs inside a single test, the way a phone would
 * drive it.
 */
test.skipIf(!herdrAvailable)('phone-width lease: resize, swap, restore, reap', async () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>> | undefined;
  let server: ReturnType<typeof startHttp> | undefined;
  let hub: Hub | undefined;
  try {
    fixture = await startThrowawayHerdr();
    const mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'lease' });
    const paneId = (await mux.tree()).panes.find(p => p.workspaceId === workspace.id)!.id;
    await mux.sendText(paneId, 'stty size');
    await mux.sendKeys(paneId, ['enter']);
    hub = new Hub(); hub.add('contract', mux); await hub.state();
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
    const base = `http://127.0.0.1:${server.port}`;
    const key = `contract/throwaway/${paneId}`;
    const lease = (cols: number, rows: number, takeover = false) =>
      fetch(`${base}/api/panes/${encodeURIComponent(key)}/lease`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ cols, rows, takeover }),
      });
    const release = () =>
      fetch(`${base}/api/panes/${encodeURIComponent(key)}/lease`, { method: 'DELETE', headers: { origin: base } });
    const stty = async () => {
      await mux.sendText(paneId, 'stty size'); await mux.sendKeys(paneId, ['enter']);
      await Bun.sleep(500);
      return String((await mux.read(paneId, 'visible')).text).trim().split(/\r|\n/).filter((line) => /^\d+ \d+$/.test(line.trim())).at(-1);
    };

    expect(await stty()).toContain('119');            // the operator's wide grid
    expect((await lease(50, 20)).status).toBe(204);   // the phone takes the width
    await Bun.sleep(1200);
    expect(await stty()).toBe('20 50');               // the agent draws at 50 columns
    const screen = await fetch(`${base}/api/panes/${encodeURIComponent(key)}/screen`).then((r) => r.json());
    expect(typeof screen.text).toBe('string');        // reads keep flowing under the lease
    expect((await lease(45, 20, true)).status).toBe(204); // a takeover swaps the holder
    await Bun.sleep(1200);
    expect(await stty()).toBe('20 45');
    expect((await release()).status).toBe(204);       // release restores the operator width
    await Bun.sleep(1200);
    expect(await stty()).toContain('120');
    expect((await lease(50, 20)).status).toBe(204);   // an unwatched lease is reaped
    await Bun.sleep(16_500);
    expect(await stty()).toContain('120');
  } finally {
    server?.stop(); hub?.close(); await fixture?.stop();
  }
}, 60_000);
