import { expect, test } from 'bun:test';
import { Hub } from '../server/mux.ts';
import { startHttp } from '../server/http.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

/**
 * One sequential contract (the lease attach dies with the file's process group between
 * tests, so the whole story runs inside a single test — see lease.contract.test.ts):
 * the watched-Pane set on /api/events (ADR 0006) and the lease owned by its stream.
 */
test.skipIf(!herdrAvailable)('watched-Pane set: per-key screens, cap, and a lease owned by its stream', async () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>> | undefined;
  let server: ReturnType<typeof startHttp> | undefined;
  let hub: Hub | undefined;
  const streams: { close(): Promise<void> }[] = [];
  try {
    fixture = await startThrowawayHerdr();
    const mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'watch' });
    const a = (await mux.tree()).panes.find(pane => pane.workspaceId === workspace.id)!.id;
    // A real split through herdr itself: the second Pane of the Tab.
    const split = await herdrRpc(fixture.sock, 'pane.split', { pane_id: a, direction: 'right' });
    const b = (split as { pane: { pane_id: string } }).pane.pane_id;
    hub = new Hub(); hub.add('contract', mux); await hub.state();
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
    const base = `http://127.0.0.1:${server.port}`;
    const keyA = `contract/throwaway/${a}`;
    const keyB = `contract/throwaway/${b}`;

    const openStream = async (keys: string[]) => {
      const query = keys.map(key => `pane=${encodeURIComponent(key)}`).join('&');
      const controller = new AbortController();
      const response = await fetch(`${base}/api/events?${query}`, { signal: controller.signal });
      const close = async () => { controller.abort(); try { await response.body?.cancel(); } catch {} };
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        await close();
        return { status: response.status, body, frames: [] as { event: string; data: any }[], close };
      }
      const frames: { event: string; data: any }[] = [];
      streams.push({ close });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const event = /^event: (.+)$/m.exec(frame)?.[1];
              const data = /^data: (.+)$/m.exec(frame)?.[1];
              if (event && data !== undefined) frames.push({ event, data: JSON.parse(data) });
            }
          }
        } catch { /* closed */ }
      })();
      return { status: response.status, body: null, frames, close };
    };
    const until = async <T>(read: () => T, accepts: (value: T) => boolean, timeout: number) => {
      const deadline = Date.now() + timeout;
      let value = await read();
      while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(25); value = await read(); }
      return value;
    };
    // stty anchored on the wanted value: zsh can take seconds to start on a loaded machine,
    // and a stale `rows cols` line from an earlier stty stays visible on the pane, so poll for
    // the value itself — each attempt types one fresh stty.
    const stty = async (expected: string) => {
      const read = async () => String((await mux.read(a, 'visible')).text).trim().split(/\r|\n/).filter(line => /^\d+ \d+$/.test(line.trim())).at(-1);
      for (let attempt = 0; attempt < 8; attempt++) {
        await mux.sendText(a, 'stty size'); await mux.sendKeys(a, ['enter']);
        for (let reread = 0; reread < 4; reread++) {
          await Bun.sleep(400);
          const match = await read();
          if (match === expected) return match;
        }
      }
      return read();
    };
    // The operator rect as herdr sees it — the rect a lease release restores to. The split's
    // relayout can land on the pty late, so a stty read taken before the lease may be stale.
    const rect = async () => {
      const pane = (await mux.tree()).panes.find(item => item.id === a)!;
      return `${pane.rows} ${pane.cols}`;
    };
    const lease = (body: Record<string, unknown>) =>
      fetch(`${base}/api/panes/${encodeURIComponent(keyA)}/lease`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body),
      });
    const release = () =>
      fetch(`${base}/api/panes/${encodeURIComponent(keyA)}/lease`, { method: 'DELETE', headers: { origin: base } });

    // More than 4 unique keys is a 400.
    const five = await openStream([keyA, keyB, 'contract/throwaway/x1', 'contract/throwaway/x2', 'contract/throwaway/x3']);
    expect(five.status).toBe(400);
    expect(five.body).toEqual({ error: 'too-many-panes' });
    // None resolving is the old 404; unresolved keys drop when at least one resolves.
    expect((await openStream(['contract/throwaway/nope'])).status).toBe(404);
    const mixed = await openStream([keyA, 'contract/throwaway/nope']);
    expect(mixed.status).toBe(200);

    // One stream, two watched Panes: an announced id, then each key's first Screen.
    const s1 = await openStream([keyA, keyB]);
    expect(s1.status).toBe(200);
    const hello = await until(() => s1.frames, fs => fs.length > 0 && fs[0]!.event === 'hello', 5_000);
    expect(hello[0]!.data.stream).toBeString();
    await until(() => s1.frames, fs => fs.some(f => f.event === 'screen' && f.data.key === keyA) && fs.some(f => f.event === 'screen' && f.data.key === keyB), 5_000);
    expect(mixed.frames.some(f => f.event === 'screen' && f.data.key === 'contract/throwaway/nope')).toBe(false);
    await mixed.close();

    // A marker printed in Pane b only: its Screen reaches the stream keyed by b, and no
    // later key=a Screen carries it.
    await mux.sendText(b, "printf 'MARKER-WATCH'");
    await mux.sendKeys(b, ['enter']);
    await until(() => s1.frames, fs => fs.some(f => f.event === 'screen' && f.data.key === keyB && f.data.text.includes('MARKER-WATCH')), 8_000);
    const markerAt = s1.frames.findIndex(f => f.event === 'screen' && f.data.key === keyB && f.data.text.includes('MARKER-WATCH'));
    const laterA = await until(
      () => s1.frames.filter((f, i) => f.event === 'screen' && f.data.key === keyA && i > markerAt),
      fs => fs.length > 0, 4_000,
    );
    expect(laterA.every(f => !f.data.text.includes('MARKER-WATCH'))).toBe(true);

    // The lease owner (ADR 0006): a lease taken with S1's announced id releases when S1's
    // stream ends, while a second stream still watches the same Pane.
    const s2 = await openStream([keyA]);
    expect(s2.status).toBe(200);
    await until(() => s2.frames, fs => fs.some(f => f.event === 'hello'), 5_000);
    expect((await lease({ cols: 50, rows: 20, stream: hello[0]!.data.stream })).status).toBe(204);
    expect(await stty('20 50')).toBe('20 50');
    await s1.close();
    await Bun.sleep(2_000); // release restores the rect and gives herdr its beat
    expect(await stty(await rect())).toBe(await rect());

    // A lease without an id keeps the old rule: a stream's end releases nothing, and any
    // watcher (S3) keeps the 15 s reaper quiet.
    expect((await lease({ cols: 44, rows: 18 })).status).toBe(204);
    expect(await stty('18 44')).toBe('18 44');
    const s3 = await openStream([keyA]);
    await until(() => s3.frames, fs => fs.some(f => f.event === 'hello'), 5_000);
    await s2.close();
    // Past the ~1 s a release would take: still 44 wide proves the stream's end released
    // nothing (and the stale-match poll below cannot pass on the previous stty's line).
    await Bun.sleep(1_500);
    expect(await stty('18 44')).toBe('18 44');
    await s3.close();
    expect((await release()).status).toBe(204);
    expect(await stty(await rect())).toBe(await rect());
  } finally {
    await Promise.allSettled(streams.map(stream => stream.close()));
    server?.stop(); hub?.close(); await fixture?.stop();
  }
}, 90_000);
