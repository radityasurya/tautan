/**
 * The Phone-width geometry lease (ADR 0004). The Hub holds a `herdr terminal attach` in a
 * Bun.Terminal pty purely as a geometry lever: the attach's size drives the pane's pty, so
 * the agent draws at the phone's columns. The Hub never renders from the lease stream —
 * snapshots stay the only render source; the attach's output is read and discarded.
 */
import type { Hub } from './mux.ts';
import type { HerdrMux } from './herdr.ts';

export class LeaseError extends Error {
  constructor(readonly code: 'slot-held' | 'not-herdr' | 'not-found' | 'lease-failed') { super(code); }
}

type Lease = {
  terminal: Bun.Terminal;
  child: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
  /** The operator's rect as it was before the lease: restored on release. */
  restore: { cols: number; rows: number };
  /** The SSE stream that asked for the lease (ADR 0006): when that stream ends, the lease
   *  releases, whoever else still watches the Pane. Absent → the old rule: any watcher keeps it. */
  owner?: string;
};

const ATTACH_REFUSED = /already has an attached client|retry with --takeover/;

/** A pty whose size the lease controls. Read-and-discard keeps the pipe from filling. */
const hostPty = (): Bun.Terminal =>
  new Bun.Terminal({ cols: 80, rows: 24, data() { /* never rendered; ADR 0004 */ } });

export class LeaseHolder {
  private leases = new Map<string, Lease>();

  constructor(private hub: Hub) {
    // A lease never outlives the watchers: reaped every 15 s. A pane that closed, or that no
    // SSE client watches any more, releases — the desktop gets its width back.
    setInterval(() => void this.reap(), 15_000).unref();
    // ADR 0006: an owned lease follows its owner stream, not the watch set — a desktop split
    // watching the same Pane must not keep a phone's lease alive after the phone leaves.
    this.hub.onStreamEnd?.(stream => {
      for (const [key, lease] of [...this.leases]) if (lease.owner === stream) void this.release(key);
    });
  }

  has(paneKey: string): boolean { return this.leases.has(paneKey); }

  async acquire(paneKey: string, opts: { cols: number; rows: number; takeover?: boolean; owner?: string }): Promise<void> {
    await this.hub.state();
    const found = this.hub.resolvePane(paneKey);
    if (!found) throw new LeaseError('not-found');
    if (found.entry.mux.kind !== 'herdr') throw new LeaseError('not-herdr');
    const mux = found.entry.mux as HerdrMux;
    if (this.leases.has(paneKey)) await this.release(paneKey);

    const { terminalId, rect } = await mux.leaseInfo(found.paneId);
    const restore = { cols: rect?.cols ?? 80, rows: rect?.rows ?? 24 };
    const terminal = hostPty();
    let refusedText = '';
    const child = Bun.spawn(
      ['herdr', 'terminal', 'attach', terminalId, ...(opts.takeover ? ['--takeover'] : [])],
      {
        terminal,
        cwd: process.env.HOME,
        env: { ...process.env, HERDR_SOCKET_PATH: mux.socketPath, TERM: 'xterm-256color' },
        stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
        // Detached: the attach outlives whichever request created it — the Hub owns it, not
        // the request, and a test runner must not reap it mid-lease.
        detached: true,
      },
    );
    // Drain stderr forever, or a refused attach's message fills the pipe and wedges it.
    const stderrText = new Response(child.stderr).text();
    stderrText.then((text) => { refusedText = text; }).catch(() => {});
    this.leases.set(paneKey, { terminal, child, restore, owner: opts.owner });
    try {
      // The initial size does not re-assert on a takeover (probed): resize explicitly once
      // the attach has had a beat to connect, then again to be safe against its own startup.
      await Bun.sleep(700);
      terminal.resize(opts.cols, opts.rows);
      await Bun.sleep(400);
      terminal.resize(opts.cols, opts.rows);
      if (child.exitCode !== null) throw new LeaseError('lease-failed');
      if (ATTACH_REFUSED.test(refusedText)) throw new LeaseError('slot-held');
    } catch (error) {
      await this.release(paneKey);
      if (error instanceof LeaseError) throw error;
      throw new LeaseError('lease-failed');
    }
  }

  async release(paneKey: string): Promise<void> {
    const lease = this.leases.get(paneKey);
    if (!lease) return;
    this.leases.delete(paneKey);
    try { lease.terminal.resize(lease.restore.cols, lease.restore.rows); } catch {}
    // herdr applies a resize it has seen: give the attach a beat before it dies, or the
    // restore dies with it (probed — a resize immediately followed by close never lands).
    await Bun.sleep(500);
    try { lease.terminal.close(); } catch {}
    try { lease.child.kill(); } catch {}
    // Give herdr the pane-update beat, so the operator's width is back before anyone reads.
    await this.hub.refreshHost((await this.hub.state()).panes.find(p => p.key === paneKey)?.muxKey.split('/')[0] ?? '').catch(() => {});
  }

  async releaseAll(): Promise<void> { for (const key of [...this.leases.keys()]) await this.release(key); }

  private async reap(): Promise<void> {
    const watched = this.hub.watchedPaneKeys();
    for (const key of [...this.leases.keys()]) {
      if (!await this.hub.hasPane(key)) { await this.release(key); continue; }
      const lease = this.leases.get(key)!;
      // An owned lease lives and dies with its stream; an anonymous one with the watch set.
      if (lease.owner ? this.hub.streamActive?.(lease.owner) === false : !watched.has(key)) await this.release(key);
    }
  }
}
