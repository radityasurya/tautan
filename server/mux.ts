import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { parseAnsi } from '../shared/ansi.ts';
import type { Explain, HostConfig, InputBody, MouseBody, Mux, NewTabBody, NewTabResult, NewWorkspaceBody, NewWorkspaceResult, PushSubscriptionBody, RenameBody, Screen, ScreenEvent, ScreenMode, Settings, State, StateHost, StatePane, Tree } from '../shared/types.ts';
import { sendPush, type VapidKeys } from './push.ts';
import { configureSuggest, type SuggestAdapter } from './suggest.ts';
import { hostId as localHostId, hostsConfigPath } from './hosts.ts';

export function mouseBytes(body: MouseBody): string {
  const report = (button: number, release = true) => `\x1b[<${button};${body.col};${body.row}M${release ? `\x1b[<${button};${body.col};${body.row}m` : ''}`;
  if (body.kind === 'right') return report(2);
  if (body.kind === 'double') return report(0) + report(0);
  if (body.kind === 'wheelUp') return report(64, false);
  if (body.kind === 'wheelDown') return report(65, false);
  return report(0);
}

export interface HubListener {
  onState(s: State): void;
  onScreen?(s: ScreenEvent): void;
  paneKey?: string;
  mode?: ScreenMode;
}

type Entry = { hostId: string; mux: Mux; tree?: Tree; refresh?: Promise<void>; again: boolean; timer?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; unsubscribe: () => void };

interface StoredState { seen: Record<string, number>; vapid?: VapidKeys; subscriptions?: PushSubscriptionBody[]; suggestEnabled?: boolean; trustedUser?: string }

export class Hub {
  private entries = new Map<string, Entry>();
  private hosts = new Map<string, StateHost>();
  private closeCallbacks = new Set<() => void>();
  private listeners = new Set<HubListener>();
  // herdr 0.8 fires `pane.updated` on title, cwd and Status, never on raw output: a shell
  // printing for ten seconds emits nothing (probed 2026-09-14), and `pane.output_matched`
  // only fires on a pattern. So a watched Pane is polled, fast after a change and backing
  // off while quiet. ponytail: drop this if herdr gains a surface stream.
  private static readonly WATCH_FAST = 250;
  private static readonly WATCH_SLOW = 2_000;
  private watchers = new Map<HubListener, { timer?: ReturnType<typeof setTimeout>; delay: number; last?: string }>();
  private cached?: State;
  private statuses = new Map<string, { status: string; at: number }>();
  private lastLines = new Map<string, { revision: number; line?: string; excerpt?: string; command?: string }>();
  private suggestions = new Map<string, { revision: number; values: string[] }>();
  private suggestionTriggers = new Set<string>();
  private suggestionRequests = new Set<string>();
  private lastLineReads = 0;
  private lastLineWaiters: (() => void)[] = [];
  private seen: Record<string, number> = {};
  private stateTimer?: ReturnType<typeof setTimeout>;
  private seenTimer?: ReturnType<typeof setTimeout>;
  private lastStateAt = 0;
  private readonly statePath: string;
  private vapid: VapidKeys;
  private subscriptions: PushSubscriptionBody[];
  private suggestEnabled: boolean;
  trustedUser?: string;
  private readonly suggestAdapter: SuggestAdapter | null;
  private readonly refreshMs: number;

  constructor(opts: { refreshMs?: number; suggest?: SuggestAdapter | null } = {}) {
    this.refreshMs = opts.refreshMs ?? 15_000;
    const root = process.env.XDG_STATE_HOME || join(os.homedir(), '.local/state');
    this.statePath = join(root, 'tautan/state.json');
    let stored: StoredState = { seen: {} };
    try { stored = JSON.parse(readFileSync(this.statePath, 'utf8')); } catch {}
    this.seen = stored.seen ?? {};
    this.subscriptions = stored.subscriptions ?? [];
    this.suggestEnabled = stored.suggestEnabled ?? false;
    this.trustedUser = stored.trustedUser;
    this.suggestAdapter = opts.suggest === undefined ? configureSuggest() : opts.suggest;
    if (stored.vapid) this.vapid = stored.vapid;
    else {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const publicJwk = pair.publicKey.export({ format: 'jwk' });
      const privateJwk = pair.privateKey.export({ format: 'jwk' });
      this.vapid = { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, 'base64url'), Buffer.from(publicJwk.y!, 'base64url')]).toString('base64url'), privateKey: privateJwk.d! };
      this.save();
    }
  }

  add(hostId: string, mux: Mux): void {
    const key = `${hostId}/${mux.id}`;
    const entry: Entry = { hostId, mux, again: false, unsubscribe: () => {} };
    entry.unsubscribe = mux.onChange(ids => this.changed(key, ids));
    if (this.refreshMs > 0) entry.interval = setInterval(() => void this.refresh(key).catch(() => {}), this.refreshMs);
    this.entries.set(key, entry);
    if (!this.hosts.has(hostId)) this.setHost({ id: hostId, label: hostId, online: hostId === localHostId, source: hostId === localHostId ? 'local' : undefined });
    this.cached = undefined;
  }

  setHost(host: StateHost): void { this.hosts.set(host.id, host); this.cached = undefined; this.recompute(); this.emitState(); }
  removeHost(id: string): void {
    for (const [key, entry] of this.entries) if (entry.hostId === id) { entry.unsubscribe(); entry.mux.close(); clearTimeout(entry.timer); clearInterval(entry.interval); this.entries.delete(key); }
    this.hosts.delete(id); this.cached = undefined; this.recompute(); this.emitState();
  }
  host(id: string): StateHost | undefined { return this.hosts.get(id); }
  onClose(callback: () => void): () => void { this.closeCallbacks.add(callback); return () => this.closeCallbacks.delete(callback); }

  hasMux(hostId: string, muxId: string): boolean { return this.entries.has(`${hostId}/${muxId}`); }
  removeMux(hostId: string, muxId: string): void {
    const key = `${hostId}/${muxId}`; const entry = this.entries.get(key); if (!entry) return;
    entry.unsubscribe(); entry.mux.close(); clearTimeout(entry.timer); clearInterval(entry.interval); this.entries.delete(key); this.cached = undefined;
  }

  async refreshHost(hostId: string): Promise<void> {
    await Promise.all([...this.entries].filter(([, entry]) => entry.hostId === hostId).map(([key]) => this.refresh(key)));
    this.recompute();
    this.emitState();
  }

  private changed(muxKey: string, ids: string[] | 'all'): void {
    const entry = this.entries.get(muxKey); if (!entry) return;
    clearTimeout(entry.timer);
    // Nobody awaits this one, so a Mux that dies mid-refresh must not raise an unhandled
    // rejection: the routes that do await refresh still see the error and answer 502.
    entry.timer = setTimeout(() => void this.refresh(muxKey).catch(() => {}), 200);
    for (const listener of this.listeners) {
      if (!listener.paneKey || !listener.onScreen) continue;
      const parsed = this.resolve(listener.paneKey);
      if (!parsed || parsed.muxKey !== muxKey || ids !== 'all' && !ids.includes(parsed.paneId)) continue;
      this.scheduleWatch(listener, 150);
    }
  }

  private async refresh(muxKey: string): Promise<void> {
    const entry = this.entries.get(muxKey); if (!entry) return;
    if (entry.refresh) { entry.again = true; return entry.refresh; }
    entry.refresh = (async () => {
      do {
        entry.again = false;
        entry.tree = await entry.mux.tree();
        this.recompute();
        this.emitState();
        await this.fillLastLines(muxKey, entry);
        this.recompute();
        this.emitState();
      } while (entry.again);
    })().finally(() => { entry.refresh = undefined; });
    return entry.refresh;
  }

  private async fillLastLines(muxKey: string, entry: Entry): Promise<void> {
    const pending = (entry.tree?.panes ?? []).filter(pane => this.lastLines.get(`${muxKey}/${pane.id}`)?.revision !== pane.revision);
    await Promise.all(pending.map(async pane => {
      const key = `${muxKey}/${pane.id}`;
      await this.acquireLastLineRead();
      try {
        const commandLookup = (entry.mux as Mux & { foregroundCommand?: (id: string) => Promise<string | undefined> }).foregroundCommand;
        const command = pane.agent || !commandLookup ? pane.command : await commandLookup.call(entry.mux, pane.id);
        if (command) pane.command = command;
        if (pane.agent) {
          const screen = await entry.mux.read(pane.id, 'visible');
          const lines = parseAnsi(screen.text).map(spans => spans.map(span => span.text).join('').trim()).filter(Boolean);
          const line = lines.at(-1)?.slice(0, 200);
          this.lastLines.set(key, { revision: pane.revision, line, excerpt: lines.slice(-40).join('\n'), command });
        } else this.lastLines.set(key, { revision: pane.revision, command });
      } catch {
        this.lastLines.set(key, { revision: pane.revision });
      } finally {
        this.releaseLastLineRead();
      }
    }));
  }

  private async acquireLastLineRead(): Promise<void> {
    if (this.lastLineReads >= 4) await new Promise<void>(resolve => this.lastLineWaiters.push(resolve));
    this.lastLineReads++;
  }

  private releaseLastLineRead(): void {
    this.lastLineReads--;
    this.lastLineWaiters.shift()?.();
  }

  private recompute(): State {
    const registered = [...this.hosts.values()];
    const state: State = {
      hosts: registered.map(host => ({ ...host, online: host.id === localHostId ? true : host.online })), muxes: [], workspaces: [], tabs: [], panes: [],
    };
    for (const [muxKey, entry] of this.entries) {
      state.muxes.push({ key: muxKey, hostId: entry.hostId, kind: entry.mux.kind, label: entry.mux.id, online: true });
      if (!entry.tree) continue;
      for (const workspace of entry.tree.workspaces) state.workspaces.push({ key: `${muxKey}/${workspace.id}`, muxKey, ...workspace });
      for (const tab of entry.tree.tabs) state.tabs.push({ key: `${muxKey}/${tab.id}`, muxKey, ...tab });
      for (const pane of entry.tree.panes) {
        const key = `${muxKey}/${pane.id}`;
        const previous = this.statuses.get(key);
        const requestKey = `${key}:${pane.revision}`;
        if (previous?.status !== pane.status && this.suggestEnabled && this.suggestAdapter && pane.agent && (pane.status === 'blocked' || pane.status === 'done'))
          this.suggestionTriggers.add(requestKey);
        if (pane.status === 'blocked' && previous?.status !== 'blocked') {
          console.log(`tautan: ${key} → blocked`);
          const workspace = entry.tree.workspaces.find(item => item.id === pane.workspaceId);
          const payload = JSON.stringify({
            title: `${pane.agent?.trim() || 'Agent'} needs you`,
            body: `${workspace?.label ?? pane.workspaceId} · ${this.lastLines.get(key)?.line || pane.title}`,
            url: `#/pane/${key}`, tag: key,
          });
          // ponytail: independent sends are enough until subscription counts become large.
          for (const subscription of [...this.subscriptions]) void sendPush(subscription, payload, this.vapid).then(response => {
            if (response.status === 404 || response.status === 410) this.removeSubscription(subscription.endpoint);
            else if (!response.ok) console.warn(`tautan: push ${response.status} ${subscription.endpoint}`);
          }).catch(error => console.warn(`tautan: push failed ${subscription.endpoint}`, error));
        }
        const status = previous?.status === pane.status ? previous : { status: pane.status, at: Date.now() };
        this.statuses.set(key, status);
        if (pane.status === 'working' || pane.status === 'idle') this.suggestions.delete(key);
        const cachedSuggestion = this.suggestions.get(key);
        state.panes.push({ key, muxKey, ...pane, command: pane.command ?? this.lastLines.get(key)?.command, seenRevision: this.seen[key] ?? 0, lastLine: pane.agent ? this.lastLines.get(key)?.line : undefined, statusChangedAt: status.at,
          suggestions: cachedSuggestion?.revision === pane.revision ? cachedSuggestion.values : undefined });
        const screen = this.lastLines.get(key);
        if (this.suggestEnabled && this.suggestAdapter && pane.agent && (pane.status === 'blocked' || pane.status === 'done') &&
          screen?.revision === pane.revision && cachedSuggestion?.revision !== pane.revision && this.suggestionTriggers.has(requestKey) && !this.suggestionRequests.has(requestKey)) {
          this.suggestionTriggers.delete(requestKey);
          this.suggestionRequests.add(requestKey);
          const revision = pane.revision;
          void this.suggestAdapter.suggest(screen.excerpt ?? '').then(values => {
            this.suggestions.set(key, { revision, values });
            this.recompute(); this.emitState();
          });
        }
      }
    }
    this.cached = state;
    return state;
  }

  async state(): Promise<State> {
    await Promise.all([...this.entries.keys()].map(key => this.entries.get(key)!.tree ? undefined : this.refresh(key)));
    return this.cached ?? this.recompute();
  }

  async newTab(muxKey: string, body: NewTabBody): Promise<NewTabResult> {
    const entry = this.entries.get(muxKey);
    if (!entry) throw new Error('mux not found');
    if (!entry.tree?.workspaces.some(w => w.id === body.workspaceId)) throw new Error('workspace not found');
    const pane = await entry.mux.newTab(body.workspaceId, body);
    await this.refreshAfterWrite(muxKey);
    return { paneKey: `${muxKey}/${pane.id}` };
  }

  async newWorkspace(muxKey: string, body: NewWorkspaceBody): Promise<NewWorkspaceResult> {
    const entry = this.entries.get(muxKey);
    if (!entry) throw new Error('mux not found');
    const workspace = await entry.mux.newWorkspace(body);
    await this.refreshAfterWrite(muxKey);
    return { workspaceKey: `${muxKey}/${workspace.id}` };
  }

  async rename(body: RenameBody): Promise<void> {
    const entry = this.entries.get(body.muxKey);
    if (!entry) throw new Error('mux not found');
    const target = 'workspaceId' in body ? { workspaceId: body.workspaceId }
      : 'tabId' in body ? { tabId: body.tabId } : { paneId: body.paneId };
    if ('workspaceId' in target && !entry.tree?.workspaces.some(w => w.id === target.workspaceId)) throw new Error('workspace not found');
    if ('tabId' in target && !entry.tree?.tabs.some(t => t.id === target.tabId)) throw new Error('tab not found');
    if ('paneId' in target && !entry.tree?.panes.some(p => p.id === target.paneId)) throw new Error('pane not found');
    await entry.mux.rename(target, body.label);
    await this.refreshAfterWrite(body.muxKey);
  }

  async closePane(paneKey: string): Promise<void> {
    await this.state();
    const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    await found.entry.mux.closePane(found.paneId);
    await this.refreshAfterWrite(found.muxKey);
  }

  // ponytail: the write already happened; a failed receipt must not trigger a duplicate Retry.
  private async refreshAfterWrite(muxKey: string): Promise<void> {
    try { await this.refresh(muxKey); } catch (error) { console.warn(`tautan: refresh after write failed for ${muxKey}`, error); }
  }

  private resolve(paneKey: string): { muxKey: string; paneId: string; entry: Entry } | undefined {
    const first = paneKey.indexOf('/'); const second = paneKey.indexOf('/', first + 1);
    if (first < 0 || second < 0) return;
    const muxKey = paneKey.slice(0, second); const entry = this.entries.get(muxKey);
    if (!entry || !entry.tree?.panes.some(p => p.id === paneKey.slice(second + 1))) return;
    return { muxKey, paneId: paneKey.slice(second + 1), entry };
  }

  async read(paneKey: string, mode: ScreenMode): Promise<Screen> {
    await this.state(); const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    return found.entry.mux.read(found.paneId, mode);
  }
  async input(paneKey: string, body: InputBody): Promise<void> {
    await this.state(); const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    if (body.text !== undefined) await found.entry.mux.sendText(found.paneId, body.text);
    if (body.keys?.length) await found.entry.mux.sendKeys(found.paneId, body.keys);
    if (body.raw !== undefined) await found.entry.mux.sendRaw(found.paneId, body.raw);
  }
  async explain(paneKey: string): Promise<Explain | null> {
    await this.state(); const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    return found.entry.mux.explain(found.paneId);
  }
  async hasPane(paneKey: string): Promise<boolean> { await this.state(); return Boolean(this.resolve(paneKey)); }
  async paneHost(paneKey: string): Promise<string> {
    await this.state(); const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    return found.entry.hostId;
  }

  markSeen(paneKey: string, revision: number): void {
    this.seen[paneKey] = revision; this.recompute(); this.emitState(); clearTimeout(this.seenTimer);
    this.seenTimer = setTimeout(() => this.save(), 100);
  }
  settings(): Settings {
    let hosts: HostConfig[] = [];
    try { const value = JSON.parse(readFileSync(hostsConfigPath(), 'utf8')); if (Array.isArray(value)) hosts = value; } catch {}
    return {
      hosts, trustedUser: this.trustedUser,
      suggest: { provider: this.suggestAdapter?.provider, model: this.suggestAdapter?.model, enabled: this.suggestEnabled },
    };
  }
  setSuggestEnabled(value: boolean): void { this.suggestEnabled = value; this.save(); this.recompute(); this.emitState(); }
  setTrustedUser(value: string | undefined): void { this.trustedUser = value || undefined; this.save(); }
  async forceSuggest(paneKey: string): Promise<StatePane> {
    const state = await this.state();
    const current = state.panes.find(item => item.key === paneKey);
    if (!current) throw new Error('pane not found');
    if (!this.suggestEnabled || !this.suggestAdapter) return current;
    const requestKey = `${paneKey}:${current.revision}`;
    // ponytail: same-revision force is a no-op once a request is in flight or done; a real
    // re-ask needs a `force` query flag to bypass this later.
    if (this.suggestionRequests.has(requestKey)) return current;
    this.suggestionRequests.add(requestKey);
    const found = this.resolve(paneKey)!;
    const pane = found.entry.tree!.panes.find(item => item.id === found.paneId)!;
    const screen = await found.entry.mux.read(found.paneId, 'visible');
    const lines = parseAnsi(screen.text).map(spans => spans.map(span => span.text).join('').trim()).filter(Boolean);
    const values = await this.suggestAdapter.suggest(lines.slice(-40).join('\n'));
    this.suggestions.set(paneKey, { revision: pane.revision, values });
    const next = this.recompute(); this.emitState();
    return next.panes.find(item => item.key === paneKey)!;
  }
  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify({ seen: this.seen, vapid: this.vapid, subscriptions: this.subscriptions, suggestEnabled: this.suggestEnabled, trustedUser: this.trustedUser }, null, 2)}\n`);
  }
  vapidPublicKey(): string { return this.vapid.publicKey; }
  addSubscription(subscription: PushSubscriptionBody): void {
    const index = this.subscriptions.findIndex(item => item.endpoint === subscription.endpoint);
    if (index < 0) this.subscriptions.push(subscription); else this.subscriptions[index] = subscription;
    this.save();
  }
  removeSubscription(endpoint: string): void {
    const next = this.subscriptions.filter(item => item.endpoint !== endpoint);
    if (next.length === this.subscriptions.length) return;
    this.subscriptions = next; this.save();
  }

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    if (listener.paneKey && listener.onScreen) {
      this.watchers.set(listener, { delay: Hub.WATCH_FAST });
      queueMicrotask(() => void this.sendScreen(listener));
    }
    return () => {
      this.listeners.delete(listener);
      clearTimeout(this.watchers.get(listener)?.timer);
      this.watchers.delete(listener);
    };
  }

  /** Poll the watched Pane again in `ms`, or sooner than already planned. */
  private scheduleWatch(listener: HubListener, ms: number): void {
    const watch = this.watchers.get(listener); if (!watch) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => void this.sendScreen(listener), ms);
  }

  private async sendScreen(listener: HubListener): Promise<void> {
    const watch = this.watchers.get(listener);
    if (!watch || !this.listeners.has(listener) || !listener.paneKey || !listener.onScreen) return;
    try {
      const screen = await this.read(listener.paneKey, listener.mode ?? 'visible');
      if (screen.text !== watch.last) {
        watch.last = screen.text;
        watch.delay = Hub.WATCH_FAST;
        listener.onScreen({ key: listener.paneKey, ...screen });
      } else {
        watch.delay = Math.min(Hub.WATCH_SLOW, Math.round(watch.delay * 1.5));
      }
    } catch { watch.delay = Hub.WATCH_SLOW; }
    if (this.watchers.has(listener)) this.scheduleWatch(listener, watch.delay);
  }
  private emitState(): void {
    const wait = Math.max(0, 500 - (Date.now() - this.lastStateAt));
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.lastStateAt = Date.now(); const state = this.cached ?? this.recompute();
      for (const listener of this.listeners) listener.onState(state);
    }, wait);
  }
  close(): void {
    for (const callback of this.closeCallbacks) callback();
    for (const entry of this.entries.values()) { entry.unsubscribe(); entry.mux.close(); clearTimeout(entry.timer); clearInterval(entry.interval); }
    clearTimeout(this.stateTimer); clearTimeout(this.seenTimer);
    for (const watch of this.watchers.values()) clearTimeout(watch.timer);
    this.watchers.clear();
  }
}
