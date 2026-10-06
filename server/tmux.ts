import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Explain, Mux, Pane, Screen, ScreenMode, Tree, Workspace } from '../shared/types.ts';

export type TmuxExec = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

const FORMAT = '#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_width}\t#{pane_height}';
const agents = new Set(['claude', 'pi', 'codex', 'gemini', 'opencode', 'cursor', 'amp', 'grok', 'kimi', 'copilot', 'droid']);

export function parseTree(stdout: string): Tree {
  const workspaces = new Map<string, Tree['workspaces'][number]>();
  const tabs = new Map<string, Tree['tabs'][number]>();
  const panes: Pane[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length < 10) continue;
    const [workspaceId, workspaceLabel, tabId, tabLabel, paneId, command, cwd] = fields;
    const width = fields.at(-2)!;
    const height = fields.at(-1)!;
    const rawTitle = fields.slice(7, -2).join('\t');
    const title = !rawTitle || rawTitle === hostname() ? command! : rawTitle;
    if (!workspaces.has(workspaceId!)) workspaces.set(workspaceId!, { id: workspaceId!, label: workspaceLabel!, cwd });
    if (!tabs.has(tabId!)) tabs.set(tabId!, { id: tabId!, workspaceId: workspaceId!, label: tabLabel! });
    panes.push({
      id: paneId!, tabId: tabId!, workspaceId: workspaceId!, title, cwd,
      command, ...(agents.has(command!) ? { agent: command } : {}), status: 'unknown', revision: 1,
      cols: Number(width), rows: Number(height),
    });
  }
  return { workspaces: [...workspaces.values()], tabs: [...tabs.values()], panes };
}

const namedKeys: Record<string, string> = {
  enter: 'Enter', esc: 'Escape', tab: 'Tab', 'shift+tab': 'BTab', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', backspace: 'BSpace', space: 'Space',
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

  constructor(o: { id: string; socket: string; exec?: TmuxExec; treeIntervalMs?: number; screenIntervalMs?: number }) {
    this.id = o.id;
    this.socketPath = o.socket;
    this.treeIntervalMs = o.treeIntervalMs ?? 5_000;
    this.screenIntervalMs = o.screenIntervalMs ?? 1_000;
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
    }
    for (const id of this.revisions.keys()) if (!live.has(id)) { this.revisions.delete(id); this.lastReadAt.delete(id); }
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

  // ponytail: polling; ceiling is ~30 watched panes × 1 capture/s per Host, upgrade path is tmux -C control mode (%output events) which gives push for free.
  private startPolling(): void {
    this.treeTimer = setInterval(() => void this.pollTree(), this.treeIntervalMs);
    this.screenTimer = setInterval(() => void this.pollScreens(), this.screenIntervalMs);
  }

  private stopPolling(): void {
    clearInterval(this.treeTimer); clearInterval(this.screenTimer);
    this.treeTimer = undefined; this.screenTimer = undefined;
  }

  private async pollTree(): Promise<void> {
    if (this.treeTicking) return;
    this.treeTicking = true;
    try {
      const tree = await this.tree();
      const parts = [
        ...tree.panes.map(p => `${p.id}|${p.title}|${p.agent ?? ''}|${p.tabId}|${p.workspaceId}`),
        ...tree.tabs.map(t => `${t.id}|${t.label}`), ...tree.workspaces.map(w => `${w.id}|${w.label}`),
      ].sort();
      const signature = parts.join('\n');
      if (this.signature !== undefined && signature !== this.signature) this.emit('all');
      this.signature = signature;
    } catch {} finally { this.treeTicking = false; }
  }

  private async pollScreens(): Promise<void> {
    if (this.screenTicking) return;
    this.screenTicking = true;
    try {
      const now = Date.now();
      const changed: string[] = [];
      await Promise.all([...this.lastReadAt].filter(([, at]) => now - at <= 30_000).map(async ([id]) => {
        try {
          const text = await this.run(['capture-pane', '-t', id, '-e', '-p', '-J']);
          const before = this.revisions.get(id)?.revision ?? 1;
          if (this.record(id, text) !== before) changed.push(id);
        } catch {}
      }));
      if (changed.length) this.emit(changed);
    } finally { this.screenTicking = false; }
  }

  private emit(ids: string[] | 'all'): void { for (const listener of this.listeners) listener(ids); }
  async newTab(_workspaceId: string, _o: { cwd?: string; label?: string; agent?: string }): Promise<Pane> { throw new Error('unsupported'); }
  async newWorkspace(_o: { cwd?: string; label?: string; branch?: string }): Promise<Workspace> { throw new Error('unsupported'); }
  async rename(_target: { workspaceId: string } | { tabId: string } | { paneId: string }, _label: string): Promise<void> { throw new Error('unsupported'); }
  async closePane(_paneId: string): Promise<void> { throw new Error('unsupported'); }
  async closeWorkspace(_workspaceId: string): Promise<void> { throw new Error('unsupported'); }
  async explain(_paneId: string): Promise<Explain | null> { return null; }
  close(): void {
    this.stopPolling(); this.listeners.clear(); this.revisions.clear(); this.lastReadAt.clear();
    this.signature = undefined;
  }
}
