import { basename } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { offeredKeys } from '../shared/blocked.ts';
import type { Explain, Mux, Pane, Screen, ScreenMode, Status, Tree, Workspace } from '../shared/types.ts';

type Json = Record<string, any>;
export interface HerdrProcessInfo {
  foregroundProcessGroupId?: number;
  foregroundProcesses: { pid?: number; name?: string; argv?: string[] }[];
}
const sessionValue = (value: unknown): string | undefined => typeof value === 'string'
  ? value : value && typeof value === 'object' && typeof (value as Json).value === 'string' ? (value as Json).value : undefined;
const statuses = new Set<Status>(['idle', 'working', 'blocked', 'done', 'unknown']);
const VERSION_TTL = 24 * 60 * 60 * 1_000;

export class HerdrMux implements Mux {
  readonly kind = 'herdr' as const;
  private revisions = new Map<string, number>();
  private rows = new Map<string, number>();
  private listeners = new Set<(paneIds: string[] | 'all') => void>();
  private stream?: Socket;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private paneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private serverVersion?: { value: string; at: number };
  private versionRequest?: Promise<string>;

  constructor(readonly id: string, readonly socketPath: string) {}

  private rpc(method: string, params: Json): Promise<Json> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let data = '';
      const timeout = setTimeout(() => socket.destroy(new Error('Herdr RPC timed out')), 10_000);
      const finish = (error?: Error, value?: Json) => {
        clearTimeout(timeout); socket.destroy();
        error ? reject(error) : resolve(value!);
      };
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({ id: crypto.randomUUID(), method, params })}\n`));
      socket.on('data', chunk => {
        data += chunk;
        const end = data.indexOf('\n');
        if (end < 0) return;
        try {
          const message = JSON.parse(data.slice(0, end));
          if (message.error) finish(new Error(`${message.error.code}: ${message.error.message}`));
          else finish(undefined, message.result);
        } catch (error) { finish(error as Error); }
      });
      socket.on('error', error => finish(error));
      socket.on('end', () => { if (!data.includes('\n')) finish(new Error('Herdr RPC closed without a response')); });
    });
  }

  async tree(): Promise<Tree> {
    const result = await this.rpc('session.snapshot', {});
    const snap = result.snapshot;
    if (typeof snap.version === 'string') this.serverVersion = { value: snap.version, at: Date.now() };
    const sizes = new Map<string, { cols?: number; rows?: number }>();
    for (const layout of snap.layouts ?? []) for (const item of layout.panes ?? []) {
      sizes.set(item.pane_id, { cols: item.rect?.width, rows: item.rect?.height });
    }
    const rawPanes: Json[] = snap.panes ?? [];
    const sessions = new Map(await Promise.all(rawPanes.map(async pane => {
      if (Object.hasOwn(pane, 'agent_session')) return [pane.pane_id, sessionValue(pane.agent_session)] as const;
      try {
        const result = await this.rpc('pane.get', { pane_id: pane.pane_id });
        return [pane.pane_id, sessionValue(result.pane?.agent_session ?? result.agent_session)] as const;
      } catch { return [pane.pane_id, undefined] as const; }
    })));
    const panes: Pane[] = rawPanes.map((pane: Json) => {
      this.revisions.set(pane.pane_id, pane.revision ?? 0);
      const rows = sizes.get(pane.pane_id)?.rows;
      if (rows) this.rows.set(pane.pane_id, rows);
      const agent = pane.display_agent ?? pane.agent;
      const agentSession = sessions.get(pane.pane_id);
      return {
        id: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id,
        title: pane.terminal_title_stripped || pane.label || pane.terminal_title || (pane.cwd && basename(pane.cwd)) || pane.pane_id,
        ...(pane.cwd ? { cwd: pane.cwd } : {}), ...(agent ? { agent } : {}), ...(agentSession ? { agentSession } : {}),
        status: statuses.has(pane.agent_status) ? pane.agent_status : 'unknown',
        revision: pane.revision ?? 0, ...sizes.get(pane.pane_id),
      };
    });
    // ponytail: herdr workspace snapshots carry no cwd, so it is derived from the root pane
    return {
      workspaces: (snap.workspaces ?? []).map((w: Json) => {
        const cwd = panes.find(p => p.workspaceId === w.workspace_id)?.cwd;
        return { id: w.workspace_id, label: w.label || w.workspace_id, ...(cwd ? { cwd } : {}) };
      }),
      tabs: (snap.tabs ?? []).map((t: Json) => ({ id: t.tab_id, workspaceId: t.workspace_id, label: t.label || t.tab_id })),
      panes,
    };
  }

  async read(paneId: string, mode: ScreenMode): Promise<Screen> {
    const params = mode === 'visible'
      ? { pane_id: paneId, source: 'visible', format: 'ansi', strip_ansi: false }
      // ponytail: herdr 0.8.0 costs ~30 ms per requested line once `lines` reaches the pane
      // height, on panes running Claude Code — 500 lines is ~16 s, past our own 10 s timeout,
      // and the orphaned job then blocks the next read of that pane. Stay under the cliff:
      // `rows - 2` is the most herdr returns cheaply, and matches Screen/recent in CONTEXT.md
      // ("recent output as reflowed text"). Raise it when herdr fixes the scrollback path.
      : { pane_id: paneId, source: 'recent', format: 'text', strip_ansi: true, lines: Math.max(2, (this.rows.get(paneId) ?? 50) - 2) };
    const result = (await this.rpc('pane.read', params)).read;
    return { text: result.text, ansi: mode === 'visible', revision: this.revisions.get(paneId) ?? result.revision, mode };
  }

  async version(): Promise<string> {
    if (this.serverVersion && Date.now() - this.serverVersion.at < VERSION_TTL) return this.serverVersion.value;
    if (!this.versionRequest) this.versionRequest = this.rpc('session.snapshot', {})
      .then(result => typeof result.snapshot?.version === 'string' ? result.snapshot.version : 'unknown')
      .catch(() => 'unknown')
      .then(value => (this.serverVersion = { value, at: Date.now() }).value)
      .finally(() => { this.versionRequest = undefined; });
    return this.versionRequest;
  }

  /** The last snapshot's version, for the sync state stream; `version()` refreshes it. */
  cachedVersion(): string | undefined { return this.serverVersion?.value; }

  async sendText(paneId: string, text: string): Promise<void> { await this.rpc('pane.send_text', { pane_id: paneId, text }); }

  /** The geometry lease's target (ADR 0004): the pane's terminal id and its operator rect. */
  async leaseInfo(paneId: string): Promise<{ terminalId: string; rect: { cols: number; rows: number } | null }> {
    const result = await this.rpc('session.snapshot', {});
    const snap = result.snapshot;
    const pane = (snap.panes ?? []).find((item: Json) => item.pane_id === paneId);
    if (!pane?.terminal_id) throw new Error('no terminal');
    const entry = (snap.layouts ?? [])
      .flatMap((layout: Json) => layout.panes ?? [])
      .find((item: Json) => item.pane_id === paneId);
    const rect = entry?.rect;
    return {
      terminalId: String(pane.terminal_id),
      rect: rect?.width ? { cols: Number(rect.width), rows: Number(rect.height) } : null,
    };
  }
  async sendKeys(paneId: string, keys: string[]): Promise<void> { await this.rpc('pane.send_keys', { pane_id: paneId, keys }); }
  async sendRaw(paneId: string, raw: string): Promise<void> { if (raw) await this.rpc('pane.send_input', { pane_id: paneId, text: raw }); }

  async processInfo(paneId: string): Promise<HerdrProcessInfo> {
    const result = await this.rpc('pane.process_info', { pane_id: paneId });
    const info = result.process_info ?? result;
    const processes: Json[] = info.foreground_processes ?? [];
    return {
      ...(typeof info.foreground_process_group_id === 'number' ? { foregroundProcessGroupId: info.foreground_process_group_id } : {}),
      foregroundProcesses: processes.map(process => ({
        ...(typeof process.pid === 'number' ? { pid: process.pid } : {}),
        ...(typeof process.name === 'string' ? { name: process.name } : {}),
        ...(Array.isArray(process.argv) ? { argv: process.argv.filter((arg: unknown): arg is string => typeof arg === 'string') } : {}),
      })),
    };
  }

  async foregroundCommand(paneId: string): Promise<string | undefined> {
    const info = await this.processInfo(paneId);
    const known = new Set(['claude', 'pi', 'codex', 'k9s', 'htop', 'btop', 'lazygit', 'nvim', 'vim', 'less']);
    const process = info.foregroundProcesses.find(item => item.pid === info.foregroundProcessGroupId)
      ?? info.foregroundProcesses.find(item => known.has(String(item.name).toLowerCase())) ?? info.foregroundProcesses[0];
    return process?.name;
  }

  async explain(paneId: string): Promise<Explain | null> {
    try {
      const [explained, detected] = await Promise.all([
        this.rpc('agent.explain', { target: paneId }),
        this.rpc('pane.read', { pane_id: paneId, source: 'detection', format: 'text', strip_ansi: true }),
      ]);
      const value = explained.explain;
      const detection = detected.read.text as string;
      const hintKeys: Explain['hintKeys'] = [];
      for (const line of detection.split(/\r?\n/).slice(-3)) {
        for (const match of line.matchAll(/\b(enter|esc|tab|space|[a-z]|[1-9]|↑|↓)\s+to\s+([a-z][a-z ]+)/gi)) {
          hintKeys.push({ key: match[1]!.toLowerCase(), label: match[2]!.trim() });
        }
      }
      const explain: Explain = { ruleId: value.matched_rule?.id ?? '', state: statuses.has(value.state) ? value.state : 'unknown', detection, hintKeys };
      return { ...explain, hintKeys: offeredKeys(explain) };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('agent_not_found:')) return null;
      throw error;
    }
  }

  async newTab(workspaceId: string, o: { cwd?: string; label?: string; agent?: string }): Promise<Pane> {
    const result = await this.rpc('tab.create', { workspace_id: workspaceId, cwd: o.cwd, label: o.label, focus: false });
    const pane = result.root_pane;
    if (o.agent) {
      // ponytail: herdr agent names are unique per session and label-free; the Tab carries the label.
      const name = `${o.agent}-${pane.pane_id}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
      const params = { name, kind: o.agent, pane_id: pane.pane_id, timeout_ms: 30_000 };
      try { await this.rpc('agent.start', params); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('agent_not_ready:')) throw error;
        await Bun.sleep(1_000);
        // ponytail: leave the Tab on agent failure; the user sees it and can close it. Retry from the sheet makes a new Tab.
        await this.rpc('agent.start', params);
      }
    }
    return this.paneRecord(pane);
  }

  async newWorkspace(o: { cwd?: string; label?: string; branch?: string }): Promise<Workspace> {
    const method = o.branch ? 'worktree.create' : 'workspace.create';
    const result = await this.rpc(method, { ...(o.branch ? { branch: o.branch } : {}), cwd: o.cwd, label: o.label, focus: false });
    const workspace = result.workspace ?? result;
    const cwd = workspace.cwd ?? result.root_pane?.cwd ?? o.cwd;
    return { id: workspace.workspace_id, label: workspace.label || o.label || workspace.workspace_id, ...(cwd ? { cwd } : {}) };
  }

  async rename(target: { workspaceId: string } | { tabId: string } | { paneId: string }, label: string): Promise<void> {
    if ('workspaceId' in target) await this.rpc('workspace.rename', { workspace_id: target.workspaceId, label });
    else if ('tabId' in target) await this.rpc('tab.rename', { tab_id: target.tabId, label });
    else await this.rpc('pane.rename', { pane_id: target.paneId, label });
  }
  async closePane(paneId: string): Promise<void> { await this.rpc('pane.close', { pane_id: paneId }); }
  async closeWorkspace(workspaceId: string): Promise<void> { await this.rpc('workspace.close', { workspace_id: workspaceId }); }

  private paneRecord(pane: Json): Pane {
    const agent = pane.display_agent ?? pane.agent;
    return { id: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id,
      title: pane.terminal_title_stripped || pane.label || pane.terminal_title || (pane.cwd && basename(pane.cwd)) || pane.pane_id,
      ...(pane.cwd ? { cwd: pane.cwd } : {}), ...(agent ? { agent } : {}), ...(sessionValue(pane.agent_session) ? { agentSession: sessionValue(pane.agent_session) } : {}),
      status: statuses.has(pane.agent_status) ? pane.agent_status : 'unknown', revision: pane.revision ?? 0 };
  }

  onChange(cb: (paneIds: string[] | 'all') => void): () => void {
    this.listeners.add(cb);
    if (!this.stream && !this.retry) this.connectEvents();
    return () => this.listeners.delete(cb);
  }

  private connectEvents(backoff = 1_000): void {
    if (this.stopped || !this.listeners.size) return;
    const socket = this.stream = createConnection(this.socketPath);
    let data = '';
    let started = false;
    const fail = () => {
      if (this.stream !== socket) return;
      this.stream = undefined; socket.destroy();
      if (this.stopped) return;
      this.retry = setTimeout(() => { this.retry = undefined; this.connectEvents(Math.min(backoff * 2, 10_000)); }, backoff);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: crypto.randomUUID(), method: 'events.subscribe', params: { subscriptions: [
      'pane.updated', 'pane.created', 'pane.closed', 'pane.exited', 'pane.agent_detected', 'workspace.created', 'workspace.updated',
      'workspace.renamed', 'workspace.closed', 'tab.created', 'tab.closed', 'tab.renamed',
    ].map(type => ({ type })) } })}\n`));
    socket.on('data', chunk => {
      data += chunk;
      while (data.includes('\n')) {
        const end = data.indexOf('\n'); const line = data.slice(0, end); data = data.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.result?.type === 'subscription_started') { started = true; if (backoff > 1_000) this.emit('all'); continue; }
          if (message.event === 'pane_updated') {
            const pane = message.data?.pane; if (!pane?.pane_id) continue;
            if (pane.revision !== undefined) this.revisions.set(pane.pane_id, pane.revision);
            clearTimeout(this.paneTimers.get(pane.pane_id));
            this.paneTimers.set(pane.pane_id, setTimeout(() => { this.paneTimers.delete(pane.pane_id); this.emit([pane.pane_id]); }, 150));
          } else if (message.event) this.emit('all');
        } catch { fail(); }
      }
    });
    socket.on('error', fail); socket.on('close', fail);
    setTimeout(() => { if (!started && this.stream === socket) fail(); }, 10_000);
  }

  private emit(ids: string[] | 'all'): void { for (const listener of this.listeners) listener(ids); }
  close(): void {
    this.stopped = true; this.stream?.destroy(); clearTimeout(this.retry);
    for (const timer of this.paneTimers.values()) clearTimeout(timer);
    this.paneTimers.clear(); this.listeners.clear();
  }
}
