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
    // Each call prints a fresh tag after the size, and waits for THAT tag: earlier
    // assertions leave their own `rows cols` lines on screen, and without the tag a
    // read that lands before this call's output renders returns the previous size.
    let call = 0;
    const stty = async () => {
      const tag = `SZ${++call}`;
      // The quotes keep the tag out of the echoed command line (its `S"Z"1` form does not
      // contain `SZ1`), so matching the tag means the command's OUTPUT rendered, not its echo.
      await mux.sendText(paneId, `stty size; echo S"Z"${call}`); await mux.sendKeys(paneId, ['enter']);
      const read = async (): Promise<string | undefined> => {
        const lines = String((await mux.read(paneId, 'visible')).text).trim().split(/\r|\n/);
        const at = lines.findIndex((line) => line.includes(tag));
        if (at < 1) return undefined;
        for (let i = at - 1; i >= 0; i--) if (/^\d+ \d+$/.test(lines[i]!.trim())) return lines[i]!.trim();
        return undefined;
      };
      // zsh can take seconds to start on a loaded machine, so re-read the same output
      // until it appears — never re-type, which would stack commands on the pane.
      for (let attempt = 0; attempt < 10 && !(await read()); attempt++) await Bun.sleep(500);
      return read();
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
