import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { parseAnsi } from '../shared/ansi.ts';
import type { Explain, HostConfig, InputBody, MouseBody, MoveBody, Mux, NewTabBody, NewTabResult, NewWorkspaceBody, NewWorkspaceResult, PushSubscriptionBody, RenameBody, Screen, ScreenEvent, ScreenMode, Settings, SplitBody, State, StateHost, StatePane, Tree } from '../shared/types.ts';
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

// The chrome an agent Screen ends with, from live Panes (Claude Code and pi, 2026-10-10): the
// prompt box's rules and input line, Claude's mode footer and background-agent panel, pi's
// status bar, and the spinner line above it all.
const isRule = (line: string) => line.includes('───') && /^[\s─━┌┐└┘├┤┬┴┼╭╮╰╯]+$/.test(line);
const PROMPT_LINE = /^❯/; // the input box's line, typed text included
const STATUS_LINE = /^(?:⏵⏵|⏸)\s|^[·✢✳✶✻✽○◯⏺◐]\s/; // ● is a content bullet, never skipped
// Claude right-aligns its notices above the box (`new task? /clear to save …`, `✔ Update
// installed`): a line indented past half its width is chrome, never content.
const isNotice = (line: string) => { const indent = line.length - line.trimStart().length; return indent >= 24 && indent * 2 >= line.trimEnd().length; };

/** The last content line of an agent Screen: everything from the prompt box's rule down is
 *  chrome (the box, Claude's mode footer and background-agent panel, pi's cwd bar and status
 *  line), and so are the spinner and footer lines left above it. `undefined` when every line
 *  is chrome (Home falls back to the cwd, a push to the Pane title).
 *  ponytail: a rule-shaped line inside content (a drawn table's border as the last output,
 *  box scrolled off) reads as the box and drops the table's last rows — classify borders by
 *  neighbours if that ever shows up. */
/**
 * herdr's `live_blocked_form`, read by the Hub: a question or permission footer after the
 * Screen's last full-width rule. herdr can take well over a minute to turn a working Claude
 * blocked (100 s on a question, 2026-10-10), and the Hub re-reads a working Agent's Screen on
 * every poll anyway, so its Status turns blocked at the next read.
 */
export function asksOnScreen(rows: string[]): boolean {
  const tail = rows.slice(rows.map(row => /^\s*─{20,}\s*$/.test(row)).lastIndexOf(true) + 1).join('\n').toLowerCase();
  return tail.includes('esc to cancel')
    && (tail.includes('enter to confirm') || (tail.includes('enter to select') && /(?:arrow keys|arrows|↑\/?↓) to navigate/.test(tail)));
}

export function previewLine(lines: string[]): string | undefined {
  // The last rule is the box's own boundary; with no rule anywhere the Screen's own last
  // lines count, footer chrome aside.
  let start = lines.length - 1;
  while (start >= 0 && !isRule(lines[start]!)) start--;
  if (start < 0) start = lines.length - 1;
  for (let index = start; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (line === '' || isRule(line) || PROMPT_LINE.test(line) || STATUS_LINE.test(line) || isNotice(lines[index]!)) continue;
    return line;
  }
  return undefined;
}

export interface HubListener {
  onState(s: State): void;
  onScreen?(s: ScreenEvent): void;
  /** the Panes this stream watches, each polled on its own backoff (ADR 0006) */
  paneKeys?: string[];
  /** this stream's announced id: when the stream ends, leases it owns release (ADR 0006) */
  stream?: string;
  mode?: ScreenMode;
}

type Entry = { hostId: string; mux: Mux; tree?: Tree; refresh?: Promise<void>; again: boolean; timer?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; unsubscribe: () => void };

interface StoredState { seen: Record<string, number>; statuses?: Record<string, { status: string; at: number }>; vapid?: VapidKeys; subscriptions?: PushSubscriptionBody[]; suggestEnabled?: boolean; trustedUser?: string }

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
  // How long a blank Screen stays fast before it backs off like a quiet one.
  private static readonly WATCH_BLANK_GRACE = 2_000;
  // One watch per (listener, key), so each watched Pane backs off on its own (ADR 0006).
  private watchers = new Map<HubListener, Map<string, { timer?: ReturnType<typeof setTimeout>; delay: number; last?: string; blankSince?: number }>>();
  private streamEndCallbacks = new Set<(stream: string) => void>();
  private cached?: State;
  private statuses = new Map<string, { status: string; at: number }>();
  private statusesDirty = false;
  private lastLines = new Map<string, { revision: number; line?: string; excerpt?: string; command?: string; readAt?: number; asks?: boolean }>();
  private suggestions = new Map<string, { revision: number; values: string[] }>();
  private suggestionTriggers = new Set<string>();
  private suggestionRequests = new Set<string>();
  /** Pushes queued by a transition, sent once the Screens they quote are fresh (flushPushes). */
  private pushes: { key: string; agent?: string; label: string; title: string }[] = [];
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
    // When each Status last changed, kept across restarts: the Agents list sorts on it, and a
    // fresh start used to stamp every Pane with the start time.
    this.statuses = new Map(Object.entries(stored.statuses ?? {}));
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

  // A host that comes back online drops any retryAt it carried in from a stale state read.
  setHost(host: StateHost): void { this.hosts.set(host.id, host.online ? { ...host, retryAt: undefined } : host); this.cached = undefined; this.recompute(); this.emitState(); }
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
      for (const paneKey of this.watchers.get(listener)?.keys() ?? []) {
        const parsed = this.resolve(paneKey);
        if (!parsed || parsed.muxKey !== muxKey || ids !== 'all' && !ids.includes(parsed.paneId)) continue;
        this.scheduleWatch(listener, paneKey, 150);
      }
    }
  }

  /** Re-read one Mux now and emit the result. Public for the events route's stale-key path. */
  async refresh(muxKey: string): Promise<void> {
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
        this.flushPushes();
      } while (entry.again);
    })().finally(() => { entry.refresh = undefined; });
    return entry.refresh;
  }

  private async fillLastLines(muxKey: string, entry: Entry): Promise<void> {
    // herdr's revision does not move on raw output, so a working Pane is re-read on each poll
    // (bounded by the refresh interval, not by every event); other Panes re-read only when the
    // revision moves.
    const pending = (entry.tree?.panes ?? []).filter(pane => {
      const cached = this.lastLines.get(`${muxKey}/${pane.id}`);
      if (cached?.revision !== pane.revision) return true;
      return Boolean(pane.agent && pane.status === 'working' && Date.now() - (cached.readAt ?? 0) >= Math.max(1, this.refreshMs - 1_000));
    });
    await Promise.all(pending.map(async pane => {
      const key = `${muxKey}/${pane.id}`;
      await this.acquireLastLineRead();
      try {
        const commandLookup = (entry.mux as Mux & { foregroundCommand?: (id: string) => Promise<string | undefined> }).foregroundCommand;
        const command = pane.agent || !commandLookup ? pane.command : await commandLookup.call(entry.mux, pane.id);
        if (command) pane.command = command;
        if (pane.agent) {
          const screen = await entry.mux.read(pane.id, 'visible');
          const rows = parseAnsi(screen.text).map(spans => spans.map(span => span.text).join('').trimEnd());
          const lines = rows.map(row => row.trim()).filter(Boolean);
          const line = previewLine(rows)?.slice(0, 200); // untrimmed: a notice reads by its indent
          this.lastLines.set(key, { revision: pane.revision, line, excerpt: lines.slice(-40).join('\n'), command, readAt: Date.now(), asks: asksOnScreen(rows) });
        } else this.lastLines.set(key, { revision: pane.revision, command });
      } catch {
        this.lastLines.set(key, { revision: pane.revision });
      } finally {
        this.releaseLastLineRead();
      }
    }));
  }

  /** Send the pushes a transition queued, after fillLastLines made the lines they quote fresh. */
  private flushPushes(): void {
    for (const item of this.pushes.splice(0)) {
      const payload = JSON.stringify({
        title: `${item.agent?.trim() || 'Agent'} needs you`,
        body: `${item.label} · ${this.lastLines.get(item.key)?.line || item.title}`,
        url: `#/pane/${item.key}`, tag: item.key,
      });
      // ponytail: independent sends are enough until subscription counts become large.
      for (const subscription of [...this.subscriptions]) void sendPush(subscription, payload, this.vapid).then(response => {
        if (response.status === 404 || response.status === 410) this.removeSubscription(subscription.endpoint);
        else if (!response.ok) console.warn(`tautan: push ${response.status} ${subscription.endpoint}`);
      }).catch(error => console.warn(`tautan: push failed ${subscription.endpoint}`, error));
    }
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
      const version = entry.mux.cachedVersion?.();
      state.muxes.push({ key: muxKey, hostId: entry.hostId, kind: entry.mux.kind, label: entry.mux.id, online: true,
        ...(entry.mux.socketPath ? { socket: entry.mux.socketPath } : {}), ...(version ? { version } : {}) });
      if (!entry.tree) continue;
      for (const workspace of entry.tree.workspaces) state.workspaces.push({ key: `${muxKey}/${workspace.id}`, muxKey, ...workspace });
      for (const tab of entry.tree.tabs) state.tabs.push({ key: `${muxKey}/${tab.id}`, muxKey, ...tab });
      for (const pane of entry.tree.panes) {
        const key = `${muxKey}/${pane.id}`;
        const { agentSession: _agentSession, ...publicPane } = pane;
        // A working Agent whose last read shows a question box is blocked now, not when herdr
        // catches up; the next read without the box hands the Status back to herdr.
        const live = pane.status === 'working' && pane.agent && this.lastLines.get(key)?.asks ? 'blocked' : pane.status;
        const previous = this.statuses.get(key);
        const requestKey = `${key}:${pane.revision}`;
        if (previous?.status !== live && this.suggestEnabled && this.suggestAdapter && pane.agent && (live === 'blocked' || live === 'done'))
          this.suggestionTriggers.add(requestKey);
        if (live === 'blocked' && previous?.status !== 'blocked') {
          console.log(`tautan: ${key} → blocked`);
          const workspace = entry.tree.workspaces.find(item => item.id === pane.workspaceId);
          // Queued, not sent: fillLastLines re-reads this Pane's Screen after recompute, and
          // the push must quote the fresh line, not the one before the transition.
          this.pushes.push({ key, agent: pane.agent, label: workspace?.label ?? pane.workspaceId, title: pane.title });
        }
        const status = previous?.status === live ? previous : { status: live, at: Date.now() };
        if (status !== previous) this.statusesDirty = true;
        this.statuses.set(key, status);
        if (live === 'working' || live === 'idle') this.suggestions.delete(key);
        const cachedSuggestion = this.suggestions.get(key);
        state.panes.push({ key, muxKey, ...publicPane, status: live, command: pane.command ?? this.lastLines.get(key)?.command, seenRevision: this.seen[key] ?? 0, lastLine: pane.agent ? this.lastLines.get(key)?.line : undefined, statusChangedAt: status.at,
          suggestions: cachedSuggestion?.revision === pane.revision ? cachedSuggestion.values : undefined });
        const screen = this.lastLines.get(key);
        if (this.suggestEnabled && this.suggestAdapter && pane.agent && (live === 'blocked' || live === 'done') &&
          screen?.revision === pane.revision && cachedSuggestion?.revision !== pane.revision && this.suggestionTriggers.has(requestKey) && !this.suggestionRequests.has(requestKey)) {
          this.suggestionRequests.add(requestKey);
          const revision = pane.revision;
          void this.suggestAdapter.suggest(screen.excerpt ?? '').then(values => {
            // A failed call (null) caches nothing and keeps its trigger: the next refresh asks
            // again, so one provider blip no longer starves this revision's drafts. The
            // in-flight key clears on a timer, or this failure's own recompute would refire it.
            if (values !== null) {
              this.suggestions.set(key, { revision, values });
              this.suggestionTriggers.delete(requestKey);
              this.suggestionRequests.delete(requestKey);
            } else setTimeout(() => this.suggestionRequests.delete(requestKey), Math.max(1_000, this.refreshMs));
            this.recompute(); this.emitState();
          });
        }
      }
    }
    this.cached = state;
    if (this.statusesDirty) {
      this.statusesDirty = false;
      // Closed Panes drop on the next change; a Mux that is offline now keeps its entries.
      const live = new Set(state.panes.map(p => p.key));
      const muxes = new Set(state.panes.map(p => p.muxKey));
      for (const key of this.statuses.keys()) if (!live.has(key) && [...muxes].some(m => key.startsWith(`${m}/`))) this.statuses.delete(key);
      clearTimeout(this.seenTimer);
      this.seenTimer = setTimeout(() => this.save(), 1000);
    }
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

  async zoomPane(paneKey: string, zoomed: boolean): Promise<void> {
    await this.state();
    const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    await found.entry.mux.zoom(found.paneId, zoomed);
    await this.refreshAfterWrite(found.muxKey);
  }

  async splitPane(paneKey: string, body: SplitBody): Promise<NewTabResult> {
    await this.state();
    const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    const paneId = await found.entry.mux.split(found.paneId, body);
    await this.refreshAfterWrite(found.muxKey);
    return { paneKey: `${found.muxKey}/${paneId}` };
  }

  async swapPanes(paneKey: string, targetPaneKey: string): Promise<void> {
    await this.state();
    const found = this.resolve(paneKey); const target = this.resolve(targetPaneKey);
    if (!found || !target) throw new Error('pane not found');
    if (found.muxKey !== target.muxKey) throw new Error('pane not found'); // a swap lives on one Mux
    await found.entry.mux.swap(found.paneId, target.paneId);
    await this.refreshAfterWrite(found.muxKey);
  }

  async movePane(paneKey: string, body: MoveBody): Promise<NewTabResult> {
    await this.state();
    const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    const destination = body.tab !== undefined
      ? { tabId: this.tabIdOf(found, body.tab), split: body.split!, ...(body.ratio !== undefined ? { ratio: body.ratio } : {}) }
      : body.newTab ? { newTab: true as const } : { newWorkspace: true as const, ...(body.label !== undefined ? { label: body.label } : {}) };
    const paneId = await found.entry.mux.move(found.paneId, destination);
    await this.refreshAfterWrite(found.muxKey);
    return { paneKey: `${found.muxKey}/${paneId}` };
  }

  async resizePane(paneKey: string, direction: 'left' | 'right' | 'up' | 'down', amount: number): Promise<void> {
    await this.state();
    const found = this.resolve(paneKey);
    if (!found) throw new Error('pane not found');
    await found.entry.mux.resize(found.paneId, direction, amount);
    await this.refreshAfterWrite(found.muxKey);
  }

  /** The pane id a Tab key names on `found`'s Mux; both keys must share the Mux. */
  private tabIdOf(found: { muxKey: string; entry: Entry }, tabKey: string): string {
    const first = tabKey.indexOf('/'); const second = tabKey.indexOf('/', first + 1);
    if (first < 0 || second < 0 || tabKey.slice(0, second) !== found.muxKey) throw new Error('tab not found');
    const tabId = tabKey.slice(second + 1);
    if (!found.entry.tree?.tabs.some(t => t.id === tabId)) throw new Error('tab not found');
    return tabId;
  }

  async closeWorkspace(muxKey: string, workspaceId: string): Promise<void> {
    const entry = this.entries.get(muxKey);
    if (!entry) throw new Error('mux not found');
    if (!entry.tree?.workspaces.some(w => w.id === workspaceId)) throw new Error('workspace not found');
    await entry.mux.closeWorkspace(workspaceId);
    await this.refreshAfterWrite(muxKey);
  }

  // ponytail: the write already happened; a failed receipt must not trigger a duplicate Retry.
  private async refreshAfterWrite(muxKey: string): Promise<void> {
    try { await this.refresh(muxKey); } catch (error) { console.warn(`tautan: refresh after write failed for ${muxKey}`, error); }
  }

  /** The pane a paneKey names, for the Hub's own machinery (the geometry lease). */
  resolvePane(paneKey: string): { muxKey: string; paneId: string; entry: Entry } | undefined { return this.resolve(paneKey); }

  /** The pane keys some SSE client currently watches — a lease reaper's keep-alive set. */
  watchedPaneKeys(): Set<string> {
    const keys = new Set<string>();
    for (const listener of this.listeners) for (const key of listener.paneKeys ?? []) keys.add(key);
    return keys;
  }

  /** ADR 0006: is the SSE stream that announced this id still subscribed? A lease-reaper backstop. */
  streamActive(stream: string): boolean {
    return [...this.listeners].some(listener => listener.stream === stream);
  }

  /** ADR 0006: be told when an SSE stream (by its announced id) ends. */
  onStreamEnd(callback: (stream: string) => void): () => void {
    this.streamEndCallbacks.add(callback);
    return () => this.streamEndCallbacks.delete(callback);
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
  async herdrVersions(): Promise<{ muxKey: string; label: string; version: string }[]> {
    return Promise.all([...this.entries].filter(([, entry]) => entry.mux.kind === 'herdr').map(async ([muxKey, entry]) => {
      const readVersion = (entry.mux as Mux & { version?: () => Promise<string> }).version;
      const version = readVersion ? await readVersion.call(entry.mux).catch(() => 'unknown') : 'unknown';
      return { muxKey, label: entry.mux.id, version };
    }));
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
    // ponytail: same-revision force is a no-op once a request is in flight or its answers are
    // cached (request keys now clear when a call settles, so the cache carries the no-op); a
    // real re-ask needs a `force` query flag to bypass this later.
    if (this.suggestionRequests.has(requestKey) || this.suggestions.get(paneKey)?.revision === current.revision) return current;
    this.suggestionRequests.add(requestKey);
    const found = this.resolve(paneKey)!;
    const pane = found.entry.tree!.panes.find(item => item.id === found.paneId)!;
    try {
      const screen = await found.entry.mux.read(found.paneId, 'visible');
      const lines = parseAnsi(screen.text).map(spans => spans.map(span => span.text).join('').trim()).filter(Boolean);
      const values = await this.suggestAdapter.suggest(lines.slice(-40).join('\n'));
      // A failed call caches nothing: the pane keeps whatever it had, and a later ask retries.
      if (values !== null) this.suggestions.set(paneKey, { revision: pane.revision, values });
    } finally {
      this.suggestionRequests.delete(requestKey);
    }
    const next = this.recompute(); this.emitState();
    return next.panes.find(item => item.key === paneKey)!;
  }
  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify({ seen: this.seen, statuses: Object.fromEntries(this.statuses), vapid: this.vapid, subscriptions: this.subscriptions, suggestEnabled: this.suggestEnabled, trustedUser: this.trustedUser }, null, 2)}\n`);
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
    if (listener.paneKeys?.length && listener.onScreen) {
      this.watchers.set(listener, new Map(listener.paneKeys.map(key => [key, { delay: Hub.WATCH_FAST }])));
      // One microtask per key: a slow read of one Pane cannot delay another Pane's first Screen.
      for (const key of listener.paneKeys) queueMicrotask(() => void this.sendScreen(listener, key));
    }
    return () => {
      this.listeners.delete(listener);
      const watches = this.watchers.get(listener);
      if (watches) { for (const watch of watches.values()) clearTimeout(watch.timer); this.watchers.delete(listener); }
      // ADR 0006: leases owned by this stream release now, whoever else still watches the Pane.
      if (listener.stream) for (const callback of this.streamEndCallbacks) callback(listener.stream);
    };
  }

  /** Poll a watched Pane again in `ms`, or sooner than already planned. */
  private scheduleWatch(listener: HubListener, paneKey: string, ms: number): void {
    const watch = this.watchers.get(listener)?.get(paneKey); if (!watch) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => void this.sendScreen(listener, paneKey), ms);
  }

  private async sendScreen(listener: HubListener, paneKey: string): Promise<void> {
    const watch = this.watchers.get(listener)?.get(paneKey);
    if (!watch || !this.listeners.has(listener) || !listener.onScreen) return;
    try {
      const screen = await this.read(paneKey, listener.mode ?? 'visible');
      const blank = !screen.text.trim();
      if (blank) watch.blankSince ??= Date.now(); else watch.blankSince = undefined;
      const blankSince = watch.blankSince ?? 0;
      const blankPastGrace = blank && Date.now() - blankSince > Hub.WATCH_BLANK_GRACE;
      if (screen.text !== watch.last) {
        watch.last = screen.text;
        watch.delay = Hub.WATCH_FAST;
        listener.onScreen({ key: paneKey, ...screen });
      } else if (!blank || blankPastGrace) {
        watch.delay = Math.min(Hub.WATCH_SLOW, Math.round(watch.delay * 1.5));
      }
      // A blank Screen keeps the fast cadence for the grace window only: a program that has
      // not drawn yet (a fresh htop reads empty until it paints) still shows its first frame
      // on the next read. Past the grace it backs off like a quiet one, and a `pane.updated`
      // re-reads at once (`changed`), so a Pane that later draws is never missed.
    } catch { watch.delay = Hub.WATCH_SLOW; }
    if (this.watchers.get(listener)?.has(paneKey)) this.scheduleWatch(listener, paneKey, watch.delay);
  }
  private emitState(): void {
    const wait = Math.max(0, 500 - (Date.now() - this.lastStateAt));
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.lastStateAt = Date.now(); const state = this.cached ?? this.recompute();
      // One dead subscriber must not starve the rest: a send to a closed connection
      // throws inside this loop and, unguarded, silenced every listener after it.
      for (const listener of this.listeners) {
        try { listener.onState(state); } catch { /* the stream's own catch unsubscribed it */ }
      }
    }, wait);
  }
  close(): void {
    for (const callback of this.closeCallbacks) callback();
    for (const entry of this.entries.values()) { entry.unsubscribe(); entry.mux.close(); clearTimeout(entry.timer); clearInterval(entry.interval); }
    clearTimeout(this.stateTimer); clearTimeout(this.seenTimer);
    for (const watches of this.watchers.values()) for (const watch of watches.values()) clearTimeout(watch.timer);
    this.watchers.clear();
  }
}
