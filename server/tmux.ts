import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Explain, Mux, Pane, Screen, ScreenMode, Tree, Workspace } from '../shared/types.ts';

export type TmuxExec = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

/** a `tmux -C` control client, injectable for tests */
export interface TmuxControl {
  stdin: { write(text: string): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
export type TmuxControlSpawn = (args: string[]) => TmuxControl;

const FORMAT = '#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{window_zoomed_flag}\t#{pane_active}';
const agents = new Set(['claude', 'pi', 'codex', 'gemini', 'opencode', 'cursor', 'amp', 'grok', 'kimi', 'copilot', 'droid']);

export function parseTree(stdout: string): Tree {
  const workspaces = new Map<string, Tree['workspaces'][number]>();
  const tabs = new Map<string, Tree['tabs'][number]>();
  const panes: Pane[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length < 14) continue;
    const [workspaceId, workspaceLabel, tabId, tabLabel, paneId, command, cwd] = fields;
    const [width, height, left, top, zoomed, active] = fields.slice(-6);
    const rawTitle = fields.slice(7, -6).join('\t');
    const title = !rawTitle || rawTitle === hostname() ? command! : rawTitle;
    if (!workspaces.has(workspaceId!)) workspaces.set(workspaceId!, { id: workspaceId!, label: workspaceLabel!, cwd });
    if (!tabs.has(tabId!)) tabs.set(tabId!, { id: tabId!, workspaceId: workspaceId!, label: tabLabel! });
    panes.push({
      id: paneId!, tabId: tabId!, workspaceId: workspaceId!, title, cwd,
      command, ...(agents.has(command!) ? { agent: command } : {}), status: 'unknown', revision: 1,
      cols: Number(width), rows: Number(height),
      // A zoomed window shows one Pane full-size and hides the others, so its rects must not
      // place cells (ADR 0006): x/y are omitted for every Pane of a zoomed window.
      // The zoomed Pane is the window's active one.
      ...(zoomed !== '1' ? { x: Number(left), y: Number(top) } : active === '1' ? { zoomed: true as const } : {}),
    });
  }
  return { workspaces: [...workspaces.values()], tabs: [...tabs.values()], panes };
}

const namedKeys: Record<string, string> = {
  enter: 'Enter', esc: 'Escape', tab: 'Tab', 'shift+tab': 'BTab', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', backspace: 'BSpace', space: 'Space',
  // The function keys herdr takes as f1–f12; htop and less offer them in the Keys tray.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

export function tmuxKey(name: string): string {
  const key = name.toLowerCase();
  if (namedKeys[key]) return namedKeys[key];
  const modified = key.match(/^(ctrl|alt)\+(.)$/);
  if (modified) return `${modified[1] === 'ctrl' ? 'C' : 'M'}-${modified[2]!.toLowerCase()}`;
  if ([...name].length === 1 && /[^\p{C}]/u.test(name)) return name;
  throw new Error('invalid_key');
}

export class TmuxMux implements Mux {
  readonly kind = 'tmux' as const;
  readonly id: string;
  /** the socket this Mux serves on its Host: local path here, remote path over ssh */
  readonly socketPath: string;
  private readonly exec: TmuxExec;
  private readonly controlSpawn: TmuxControlSpawn | null;
  private readonly treeIntervalMs: number;
  private readonly screenIntervalMs: number;
  private revisions = new Map<string, { revision: number; hash?: string }>();
  private lastReadAt = new Map<string, number>();
  private listeners = new Set<(paneIds: string[] | 'all') => void>();
  private treeTimer?: ReturnType<typeof setInterval>;
  private screenTimer?: ReturnType<typeof setInterval>;
  private treeTicking = false;
  private screenTicking = false;
  private signature?: string;
  private versionValue?: string;
  private versionProbed = false;
  private paneSessions = new Map<string, string>();
  private controls = new Map<string, { proc: TmuxControl; startedAt: number }>();
  private restarts = new Map<string, ReturnType<typeof setTimeout>>();
  private restartMs = new Map<string, number>();
  private dirty = new Set<string>();
  private sweepTimer?: ReturnType<typeof setTimeout>;

  constructor(o: { id: string; socket: string; exec?: TmuxExec; controlSpawn?: TmuxControlSpawn | null; treeIntervalMs?: number; screenIntervalMs?: number }) {
    this.id = o.id;
    this.socketPath = o.socket;
    this.treeIntervalMs = o.treeIntervalMs ?? 5_000;
    this.screenIntervalMs = o.screenIntervalMs ?? 1_000;
    // null keeps the Mux on pure polling (remote Hosts: the ssh exec has no control spawn yet).
    this.controlSpawn = o.controlSpawn === undefined
      ? args => Bun.spawn(['tmux', '-S', o.socket, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      : o.controlSpawn;
    this.exec = o.exec ?? (async args => {
      const proc = Bun.spawn(['tmux', '-S', o.socket, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      return { stdout, stderr, code };
    });
  }

  private async run(args: string[]): Promise<string> {
    const result = await this.exec(args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'tmux failed');
    return result.stdout;
  }

  async tree(): Promise<Tree> {
    // `tmux -V` answers without touching the socket; once per Mux, at first sight, for the state stream.
    if (!this.versionProbed) {
      this.versionProbed = true;
      // The answer is new state but not a tree change: poke the Hub's change path (refresh →
      // recompute → emitState) once, or a tree that never changes never ships the version.
      void this.exec(['-V']).then(result => {
        const version = result.code === 0 ? result.stdout.trim().replace(/^tmux\s+/, '') || undefined : undefined;
        if (version !== undefined) { this.versionValue = version; this.emit('all'); }
      }).catch(() => {});
    }
    const tree = parseTree(await this.run(['list-panes', '-a', '-F', FORMAT]));
    const live = new Set(tree.panes.map(pane => pane.id));
    for (const pane of tree.panes) {
      const tracked = this.revisions.get(pane.id) ?? { revision: 1 };
      this.revisions.set(pane.id, tracked);
      pane.revision = tracked.revision;
      this.paneSessions.set(pane.id, pane.workspaceId);
    }
    for (const id of this.revisions.keys()) if (!live.has(id)) { this.revisions.delete(id); this.lastReadAt.delete(id); this.paneSessions.delete(id); }
    this.reconcileControls();
    return tree;
  }

  /** The one-shot `tmux -V` answer, for the state stream. */
  cachedVersion(): string | undefined { return this.versionValue; }

  private record(paneId: string, text: string): number {
    const hash = createHash('sha1').update(text).digest('hex');
    const tracked = this.revisions.get(paneId) ?? { revision: 1 };
    if (tracked.hash !== undefined && tracked.hash !== hash) tracked.revision++;
    tracked.hash = hash;
    this.revisions.set(paneId, tracked);
    return tracked.revision;
  }

  async read(paneId: string, mode: ScreenMode): Promise<Screen> {
    const args = mode === 'visible'
      ? ['capture-pane', '-t', paneId, '-e', '-p', '-J']
      : ['capture-pane', '-t', paneId, '-p', '-J', '-S', '-500'];
    const text = await this.run(args);
    this.lastReadAt.set(paneId, Date.now());
    this.reconcileControls();
    return { text, ansi: mode === 'visible', revision: this.record(paneId, text), mode };
  }

  async sendText(paneId: string, text: string): Promise<void> {
    if (!text) return;
    await this.run(['send-keys', '-t', paneId, '-l', '--', text]);
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    const translated = keys.map(tmuxKey);
    if (!translated.length) return;
    await this.run(['send-keys', '-t', paneId, '--', ...translated]);
  }

  async sendRaw(paneId: string, raw: string): Promise<void> {
    if (!raw) return;
    await this.run(['send-keys', '-t', paneId, '-H', ...Buffer.from(raw).toString('hex').match(/../g)!]);
  }

  onChange(cb: (paneIds: string[] | 'all') => void): () => void {
    this.listeners.add(cb);
    if (this.listeners.size === 1) this.startPolling();
    return () => { this.listeners.delete(cb); if (!this.listeners.size) this.stopPolling(); };
  }

  // A watched Pane is re-captured only when it produced output: one read-only `tmux -C attach`
  // client per Workspace streams %output notifications, which mark the Pane dirty; a capture
  // one screenIntervalMs later turns that into a revision (capture-pane stays the Screen
  // source — the %output bytes are discarded). The client is per Workspace because tmux only
  // delivers %output for windows linked to the attached session (control.c, 3.4–3.5a): a
  // server-wide client sees nothing. A slow fallback poll (5 × screenIntervalMs) covers Panes
  // whose client died, and probes `list-clients` for the server's ground truth on who is
  // alive — Bun does not flush a dead child's pipes, so `exited` alone can lag by a restart
  // cycle. A client that keeps dying fast restarts at 1 s doubling to 30 s. `hub.close()` →
  // `close()` kills every client. Never write to the client's stdin and never
  // `refresh-client -A :off` — the first changes nothing, the second can stall user Panes.
  // ponytail: remote-Host tmux (hosts.ts ssh exec) passes controlSpawn: null and stays on the
  // old poll; wire its spawn over ssh when the remote ceiling (~30 Panes × 1 capture/s) matters.
  private startPolling(): void {
    this.treeTimer = setInterval(() => void this.pollTree(), this.treeIntervalMs);
    this.screenTimer = setInterval(() => void this.pollScreens(), this.screenIntervalMs * (this.controlSpawn ? 5 : 1));
    this.reconcileControls();
  }

  private stopPolling(): void {
    clearInterval(this.treeTimer); clearInterval(this.screenTimer);
    this.treeTimer = undefined; this.screenTimer = undefined;
    for (const sessionId of [...this.controls.keys()]) this.killControl(sessionId);
    // a client that died between polls left a pending restart this loop cannot see
    for (const timer of this.restarts.values()) clearTimeout(timer);
    this.restarts.clear();
    this.dirty.clear();
    clearTimeout(this.sweepTimer); this.sweepTimer = undefined;
  }

  /** start or stop control clients so exactly the Workspaces with a watched Pane have one */
  private reconcileControls(): void {
    if (!this.listeners.size || !this.controlSpawn) return;
    const now = Date.now();
    const wanted = new Set<string>();
    for (const [id, at] of this.lastReadAt) {
      if (now - at > 30_000) continue;
      const session = this.paneSessions.get(id);
      if (session) wanted.add(session);
    }
    for (const sessionId of [...this.controls.keys()]) if (!wanted.has(sessionId)) this.killControl(sessionId);
    for (const sessionId of wanted) if (!this.controls.has(sessionId)) this.startControl(sessionId);
  }

  private startControl(sessionId: string): void {
    let proc: TmuxControl;
    try { proc = this.controlSpawn!(['-C', 'attach', '-E', '-r', '-t', sessionId]); } catch { this.scheduleRestart(sessionId, 30_000); return; }
    const client = { proc, startedAt: Date.now() };
    this.controls.set(sessionId, client);
    void (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const paneId = /^%(?:extended-)?output (%\d+)/.exec(buffer.slice(0, end))?.[1];
          buffer = buffer.slice(end + 1);
          if (!paneId || !this.lastReadAt.has(paneId)) continue; // only Panes someone watches
          this.dirty.add(paneId);
          this.sweepTimer ??= setTimeout(() => void this.sweep(), this.screenIntervalMs);
        }
      }
      this.clientDied(sessionId, client); // stdout closed: the client is gone
    })().catch(() => {});
    void proc.exited.then(() => this.clientDied(sessionId, client)).catch(() => {});
  }

  private clientDied(sessionId: string, client: { proc: TmuxControl; startedAt: number }): void {
    if (this.controls.get(sessionId) !== client) return; // replaced or torn down: no restart
    this.controls.delete(sessionId);
    // A client that lived a while earned a healthy life, so the next death restarts at 1 s.
    const wait = Date.now() - client.startedAt > 30_000 ? 1_000 : Math.min((this.restartMs.get(sessionId) ?? 500) * 2, 30_000);
    this.restartMs.set(sessionId, wait);
    this.scheduleRestart(sessionId, wait);
  }

  /** the server's own view of which control clients are alive; probes only clients old enough to have attached */
  private async verifyControls(): Promise<void> {
    const probeMs = this.screenIntervalMs * (this.controlSpawn ? 5 : 1);
    const probe = [...this.controls].filter(([, client]) => Date.now() - client.startedAt > probeMs);
    if (!probe.length) return;
    let stdout: string;
    try { stdout = await this.run(['list-clients', '-F', '#{session_id}|#{client_flags}']); } catch { return; } // server unreachable: the tree poll reports it
    const alive = new Set(stdout.split(/\r?\n/).filter(line => line.includes('|') && line.split('|')[1]!.includes('control-mode')).map(line => line.split('|')[0]!));
    for (const [sessionId, client] of probe) if (!alive.has(sessionId)) this.clientDied(sessionId, client);
  }

  private scheduleRestart(sessionId: string, wait: number): void {
    clearTimeout(this.restarts.get(sessionId));
    this.restarts.set(sessionId, setTimeout(() => { this.restarts.delete(sessionId); this.reconcileControls(); }, wait));
  }

  private killControl(sessionId: string): void {
    const client = this.controls.get(sessionId);
    if (!client) return;
    this.controls.delete(sessionId);
    client.proc.kill();
    clearTimeout(this.restarts.get(sessionId));
    this.restarts.delete(sessionId);
  }

  private async pollTree(): Promise<void> {
    if (this.treeTicking) return;
    this.treeTicking = true;
    try {
      const tree = await this.tree();
      const parts = [
        // x/y/zoomed in the signature: a zoom made in tmux reaches tautan on the next tree poll.
        ...tree.panes.map(p => `${p.id}|${p.title}|${p.agent ?? ''}|${p.tabId}|${p.workspaceId}|${p.x ?? ''}|${p.y ?? ''}|${p.zoomed ?? ''}`),
        ...tree.tabs.map(t => `${t.id}|${t.label}`), ...tree.workspaces.map(w => `${w.id}|${w.label}`),
      ].sort();
      const signature = parts.join('\n');
      if (this.signature !== undefined && signature !== this.signature) this.emit('all');
      this.signature = signature;
    } catch {} finally { this.treeTicking = false; }
  }

  /** the fallback: capture every recently read Pane a live control client does not cover */
  private async pollScreens(): Promise<void> {
    if (this.screenTicking) return;
    this.screenTicking = true;
    try {
      if (this.controls.size) await this.verifyControls();
      const now = Date.now();
      const ids = [...this.lastReadAt].filter(([id, at]) => now - at <= 30_000 && !this.paneCovered(id)).map(([id]) => id);
      await this.capture(ids);
    } finally { this.screenTicking = false; }
  }

  /** the %output debounce: capture the Panes that produced output since the last sweep */
  private async sweep(): Promise<void> {
    this.sweepTimer = undefined;
    const now = Date.now();
    const ids = [...this.dirty].filter(id => now - (this.lastReadAt.get(id) ?? 0) <= 30_000);
    this.dirty.clear();
    await this.capture(ids);
  }

  private paneCovered(paneId: string): boolean {
    const session = this.paneSessions.get(paneId);
    return session !== undefined && this.controls.has(session);
  }

  private async capture(ids: string[]): Promise<void> {
    const changed: string[] = [];
    await Promise.all(ids.map(async id => {
      try {
        const text = await this.run(['capture-pane', '-t', id, '-e', '-p', '-J']);
        const before = this.revisions.get(id)?.revision ?? 1;
        if (this.record(id, text) !== before) changed.push(id);
      } catch {}
    }));
    if (changed.length) this.emit(changed);
  }

  private emit(ids: string[] | 'all'): void { for (const listener of this.listeners) listener(ids); }
  async newTab(_workspaceId: string, _o: { cwd?: string; label?: string; agent?: string }): Promise<Pane> { throw new Error('unsupported'); }
  async newWorkspace(_o: { cwd?: string; label?: string; branch?: string }): Promise<Workspace> { throw new Error('unsupported'); }
  async rename(_target: { workspaceId: string } | { tabId: string } | { paneId: string }, _label: string): Promise<void> { throw new Error('unsupported'); }
  async closePane(_paneId: string): Promise<void> { throw new Error('unsupported'); }
  async zoom(paneId: string, zoomed: boolean): Promise<void> {
    // `resize-pane -Z` toggles, so read the window's flag first and toggle only on a mismatch.
    const flag = (await this.run(['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}'])).trim() === '1';
    if (flag === zoomed) return;
    // Unzoom targets the window: whichever Pane is zoomed, `-Z` on any Pane of it restores the layout.
    await this.run(['resize-pane', '-Z', '-t', paneId]);
  }
  async closeWorkspace(_workspaceId: string): Promise<void> { throw new Error('unsupported'); }
  async split(paneId: string, o: { direction: 'right' | 'down'; ratio?: number; cwd?: string }): Promise<string> {
    // `-l` is the NEW Pane's share — the API ratio, no complement (unlike herdr).
    return (await this.run(['split-window', '-d', o.direction === 'right' ? '-h' : '-v', '-t', paneId,
      ...(o.ratio !== undefined ? ['-l', `${Math.round(o.ratio * 100)}%`] : []), ...(o.cwd ? ['-c', o.cwd] : []),
      '-P', '-F', '#{pane_id}'])).trim();
  }
  async swap(paneId: string, targetPaneId: string): Promise<void> { await this.run(['swap-pane', '-d', '-s', paneId, '-t', targetPaneId]); }
  async move(paneId: string, destination: { tabId: string; split: 'right' | 'down'; ratio?: number } | { newTab: true } | { newWorkspace: true; label?: string }): Promise<string> {
    if ('tabId' in destination) {
      await this.run(['join-pane', '-d', destination.split === 'right' ? '-h' : '-v',
        ...(destination.ratio !== undefined ? ['-l', `${Math.round(destination.ratio * 100)}%`] : []), '-t', destination.tabId, '-s', paneId]);
      return paneId; // tmux pane ids are stable across moves
    }
    if ('newTab' in destination) { await this.run(['break-pane', '-d', '-s', paneId]); return paneId; }
    // ponytail: three commands, not atomic — a failure between them leaves a seed Workspace the
    // user sees and can close; the write-route refresh reconciles either way. One `move-pane -t` once tmux grows one.
    const cwd = (await this.run(['display-message', '-p', '-t', paneId, '#{pane_current_path}'])).trim();
    const name = destination.label?.replace(/[.:]/g, '-'); // tmux session names reject `.` and `:`
    const session = (await this.run(['new-session', '-d', ...(name ? ['-s', name] : []), ...(cwd ? ['-c', cwd] : []), '-P', '-F', '#{session_name}'])).trim();
    await this.run(['join-pane', '-d', '-s', paneId, '-t', `${session}:`]);
    await this.run(['kill-pane', '-a', '-t', paneId]); // the seed Pane; last, or the fresh Workspace dies with it
    return paneId;
  }
  async resize(paneId: string, direction: 'left' | 'right' | 'up' | 'down', cells: number): Promise<void> {
    await this.run(['resize-pane', '-t', paneId, { left: '-L', right: '-R', up: '-U', down: '-D' }[direction]!, String(cells)]);
  }
  async explain(_paneId: string): Promise<Explain | null> { return null; }
  close(): void {
    this.stopPolling(); this.listeners.clear(); this.revisions.clear(); this.lastReadAt.clear();
    this.signature = undefined;
  }
}
