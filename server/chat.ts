import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePiTranscript, parseTranscript, type ChatResponse, type ParseOpts, type Subagent, type TranscriptImage, type Turn } from '../shared/chat.ts';
import type { State, StateHost } from '../shared/types.ts';

export interface TranscriptSignature { inode: string; size: number; mtime: string }
/** One `subagents` directory listing: its mtime signature and every agent's meta text.
 *  `at` is the conversation file's first timestamp when its head parses, else its mtime. */
export interface SubagentDir { mtime: string; agents: { id: string; meta: string; at?: number }[] }
export interface TranscriptIo {
  stat(path: string, target?: string): Promise<TranscriptSignature | undefined>;
  read(path: string, target?: string): Promise<string>;
  /** One round trip: a `subagents` directory's signature and its `agent-<id>.meta.json` files;
   *  `undefined` when the directory does not exist. */
  subagents?(dir: string, target?: string): Promise<SubagentDir | undefined>;
  /** Every `agent-<id>.jsonl` mtime in ms, in one cheap round trip for the running check. */
  mtimes?(dir: string, target?: string): Promise<Map<string, number> | undefined>;
  /** The last `bytes` of a file, for a conversation's ending. */
  tail?(path: string, bytes: number, target?: string): Promise<string>;
}

type Process = { pid?: number; name?: string; argv?: string[] };
type ProcessInfo = { foregroundProcessGroupId?: number; foregroundProcesses: Process[] };
type ResolvedPane = {
  paneId: string;
  entry: { mux: { kind: 'herdr' | 'tmux'; processInfo?: (paneId: string) => Promise<ProcessInfo> }; tree?: { panes: { id: string; agent?: string; agentSession?: string }[] } };
};
export interface SessionHub { resolvePane(paneKey: string): ResolvedPane | undefined }
export interface ChatHub extends SessionHub {
  state(): Promise<State>;
  paneHost(paneKey: string): Promise<string>;
  host(id: string): StateHost | undefined;
  watchedPaneKeys(): Set<string>;
}

const sessionId = /^[0-9a-f-]{36}$/;
const sameSignature = (a: TranscriptSignature, b: TranscriptSignature) => a.inode === b.inode && a.size === b.size && a.mtime === b.mtime;
const quoteShell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The session's own folder, which holds its `subagents/` directory. */
export function transcriptDir(cwd: string, id: string, home = homedir()): string {
  return join(home, '.claude', 'projects', cwd.replace(/[\/._]/g, '-'), id);
}

/** The main transcript, a sibling of the session folder. */
export function transcriptPath(cwd: string, id: string, home = homedir()): string {
  return join(home, '.claude', 'projects', cwd.replace(/[\/._]/g, '-'), `${id}.jsonl`);
}

/** pi names its files `<ISO timestamp>_<session uuid>.jsonl`; herdr hands us the path. */
const piSessionId = (path: string): string => path.split('/').at(-1)!.replace(/\.jsonl$/, '').split('_').at(-1) || path;

function remotePath(path: string): string {
  if (!path.startsWith('$HOME/')) return quoteShell(path);
  return `"$HOME/"${quoteShell(path.slice('$HOME/'.length))}`;
}

async function ssh(target: string, command: string): Promise<{ stdout: string; code: number }> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', target, '--', command], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

// ponytail: `at` reads only the first 256 KB of a subagent transcript; a first entry whose
// timestamp sits further in falls back to the file's mtime.
const HEAD = 262_144;
const firstAt = (head: string, mtimeMs: number | undefined): number | undefined => {
  const parsed = Date.parse(head.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1] ?? '');
  return Number.isFinite(parsed) ? parsed : mtimeMs;
};

/** A conversation file's `at`: its first entry's timestamp, else its mtime in ms. */
async function agentAt(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(HEAD);
      const { bytesRead } = await handle.read(buffer, 0, HEAD, 0);
      return firstAt(buffer.subarray(0, bytesRead).toString('utf8'), Math.round(info.mtimeMs));
    } finally { await handle.close(); }
  } catch { return undefined; }
}

export const localIo: TranscriptIo = {
  async stat(path) {
    try {
      const info = await stat(path);
      return info.isFile() ? { inode: String(info.ino), size: info.size, mtime: String(info.mtimeMs) } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  read: path => readFile(path, 'utf8'),
  async mtimes(dir) {
    try {
      const out = new Map<string, number>();
      for (const name of await readdir(dir)) {
        const id = name.match(/^agent-(.+)\.jsonl$/)?.[1];
        if (!id) continue;
        const info = await stat(join(dir, name)).catch(() => undefined);
        if (info?.isFile()) out.set(id, Math.round(info.mtimeMs));
      }
      return out;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  async tail(path, bytes) {
    const info = await stat(path);
    const handle = await open(path, 'r');
    try {
      const start = Math.max(0, info.size - bytes);
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally { await handle.close(); }
  },
  async subagents(dir) {
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) return undefined;
      const agents: SubagentDir['agents'] = [];
      for (const name of (await readdir(dir)).sort()) {
        const id = name.match(/^agent-(.+)\.meta\.json$/)?.[1];
        if (!id) continue;
        const meta = await readFile(join(dir, name), 'utf8').catch(() => undefined);
        if (meta === undefined) continue; // deleted mid-listing: the agent is gone
        agents.push({ id, meta, at: await agentAt(join(dir, `agent-${id}.jsonl`)) });
      }
      return { mtime: String(info.mtimeMs), agents };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
};

const remoteIo: TranscriptIo = {
  async stat(path, target) {
    if (!target) return localIo.stat(path);
    const file = remotePath(path);
    const result = await ssh(target, `[ -f ${file} ] || exit 3; LC_ALL=C stat -c '%i\t%s\t%y' -- ${file} 2>/dev/null || stat -f '%i\t%z\t%Sm' -- ${file}`);
    if (result.code === 3) return undefined;
    if (result.code) throw new Error('remote transcript stat failed');
    const [inode, size, ...mtime] = result.stdout.trimEnd().split('\t');
    if (!inode || !size || !mtime.length || !/^\d+$/.test(size)) throw new Error('remote transcript stat failed');
    return { inode, size: Number(size), mtime: mtime.join('\t') };
  },
  async read(path, target) {
    if (!target) return localIo.read(path);
    const result = await ssh(target, `cat -- ${remotePath(path)}`);
    if (result.code) throw new Error('remote transcript read failed');
    return result.stdout;
  },
  subagents: (dir, target) => target ? remoteSubagents(dir, target) : localIo.subagents!(dir),
  mtimes: (dir, target) => target ? remoteMtimes(dir, target) : localIo.mtimes!(dir),
  tail: async (path, bytes, target) => {
    if (!target) return localIo.tail!(path, bytes);
    const result = await ssh(target, `tail -c ${bytes} -- ${remotePath(path)}`);
    if (result.code) throw new Error('remote transcript tail failed');
    return result.stdout;
  },
};

/** One ssh round trip for every agent file's mtime, in seconds since the epoch. */
async function remoteMtimes(dir: string, target: string): Promise<Map<string, number> | undefined> {
  const script = `d=${remotePath(dir)}
[ -d "$d" ] || exit 3
for f in "$d"/agent-*.jsonl; do
  [ -f "$f" ] || continue
  i=\${f##*/agent-}; i=\${i%.jsonl}
  e=$(LC_ALL=C stat -c '%Y' -- "$f" 2>/dev/null || stat -f '%m' -- "$f" 2>/dev/null || echo 0)
  printf '%s %s\\n' "$i" "$e"
done`;
  const result = await ssh(target, script);
  if (result.code === 3) return undefined;
  if (result.code) throw new Error('remote subagents mtimes failed');
  const out = new Map<string, number>();
  for (const line of result.stdout.split('\n')) {
    const found = line.match(/^(\S+) (\d+)$/);
    if (found) out.set(found[1]!, Number(found[2]!) * 1000);
  }
  return out;
}

/** One ssh round trip for the whole `subagents` directory: its mtime, then per agent its
 *  conversation file's mtime and head, and the meta file's text, between `@@` marker lines. */
async function remoteSubagents(dir: string, target: string): Promise<SubagentDir | undefined> {
  const script = `d=${remotePath(dir)}
[ -d "$d" ] || exit 3
LC_ALL=C stat -c '%y' -- "$d" 2>/dev/null || stat -f '%Sm' -- "$d"
for f in "$d"/agent-*.meta.json; do
  [ -f "$f" ] || continue
  i=\${f##*/agent-}; i=\${i%.meta.json}
  j="$d/agent-$i.jsonl"
  e=0; [ -f "$j" ] && e=$(LC_ALL=C stat -c '%Y' -- "$j" 2>/dev/null || stat -f '%m' -- "$j" 2>/dev/null || echo 0)
  printf '@@%s %s\\n' "$i" "$e"
  if [ -f "$j" ]; then printf '@@head\\n'; head -c ${HEAD} "$j" 2>/dev/null; printf '\\n@@meta\\n'; else printf '@@meta\\n'; fi
  cat -- "$f"
  printf '\\n@@end\\n'
done`;
  const result = await ssh(target, script);
  if (result.code === 3) return undefined;
  if (result.code) throw new Error('remote subagents list failed');
  const [first = '', ...rest] = result.stdout.split('\n');
  const mtime = first.trim();
  if (!mtime) throw new Error('remote subagents list failed');
  const agents: SubagentDir['agents'] = [];
  let id: string | undefined, epoch = 0, section: 'head' | 'meta' | undefined, head = '', meta = '';
  const push = () => { if (id !== undefined) agents.push({ id, meta: meta.trim(), at: firstAt(head, epoch > 0 ? epoch * 1000 : undefined) }); };
  for (const line of rest) {
    if (line === '@@head') { section = 'head'; continue; }
    if (line === '@@meta') { section = 'meta'; continue; }
    if (line === '@@end') { push(); id = undefined; epoch = 0; section = undefined; head = ''; meta = ''; continue; }
    const start = id === undefined ? line.match(/^@@(\S+) (\d+)$/) : undefined;
    if (start) { id = start[1]!; epoch = Number(start[2]); section = undefined; continue; }
    if (section === 'head') head += line + '\n';
    else if (section === 'meta') meta += line + '\n';
  }
  push(); // a stream cut past the last marker still yields its record
  return { mtime, agents };
}

/** A resolved session: Claude's rollout id, or pi's session file path (herdr reports pi as
 *  `kind: "path"`). Both come only from herdr's `agent_session` or the process's own argv. */
export type ResolvedSession = { agent: 'claude'; sessionId: string } | { agent: 'pi'; path: string };

const piFile = /^\/\S+\.jsonl$/;
// ponytail: `pi --session <uuid>` (a bare or partial id) is left unresolved — mapping an id to a
// file means scanning the cwd-encoded sessions directory, and herdr's path already covers it.
async function piSession(known: string | undefined, info: Promise<ProcessInfo | undefined> | undefined): Promise<ResolvedSession | undefined> {
  if (typeof known === 'string' && piFile.test(known)) return { agent: 'pi', path: known };
  const value = await info;
  if (!value) return undefined;
  const processes = [...value.foregroundProcesses].sort((a, b) => Number(b.pid === value.foregroundProcessGroupId) - Number(a.pid === value.foregroundProcessGroupId));
  for (const process of processes) {
    const argv = process.argv ?? [];
    if (process.name?.toLowerCase() !== 'pi' && !argv.some(arg => /(?:^|\/)pi$/.test(arg))) continue;
    for (let index = 0; index < argv.length - 1; index++) if (['--session', '--session-id'].includes(argv[index]!) && piFile.test(argv[index + 1]!)) return { agent: 'pi', path: argv[index + 1]! };
  }
}

export async function resolveSession(hub: SessionHub, paneKey: string): Promise<ResolvedSession | undefined> {
  const found = hub.resolvePane(paneKey);
  if (!found || found.entry.mux.kind !== 'herdr') return undefined;
  const pane = found.entry.tree?.panes.find(pane => pane.id === found.paneId);
  const known = pane?.agentSession;
  if (pane?.agent === 'pi') return piSession(known, found.entry.mux.processInfo?.(found.paneId));
  if (known && sessionId.test(known)) return { agent: 'claude', sessionId: known };
  const info = await found.entry.mux.processInfo?.(found.paneId);
  if (!info) return undefined;
  const processes = [...info.foregroundProcesses].sort((a, b) => Number(b.pid === info.foregroundProcessGroupId) - Number(a.pid === info.foregroundProcessGroupId));
  for (const process of processes) {
    const argv = process.argv ?? [];
    if (process.name?.toLowerCase() !== 'claude' && !argv.some(arg => /(?:^|\/)claude$/i.test(arg))) continue;
    for (let index = 0; index < argv.length - 1; index++) if (['-r', '--resume', '--session-id'].includes(argv[index]!) && sessionId.test(argv[index + 1]!)) return { agent: 'claude', sessionId: argv[index + 1]! };
  }
}

type Cached = { sessionId: string; signature: TranscriptSignature; turns: Turn[]; images: TranscriptImage[]; previews: string[]; subagents: Subagent[]; at: number };
/** A Pane's subagent tree, re-listed only when the `subagents` directory's mtime moves. */
type Subagents = { sessionId: string; signature: string; list: Subagent[] };

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;

function subagentsOf(agents: SubagentDir['agents']): Subagent[] {
  const ids = new Set(agents.map(agent => agent.id));
  const list: Subagent[] = [];
  for (const { id, meta, at } of agents) {
    let record: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(meta);
      if (value && typeof value === 'object' && !Array.isArray(value)) record = value as Record<string, unknown>;
    } catch {}
    const type = text(record.agentType), description = text(record.description), toolUseId = text(record.toolUseId), parent = text(record.parentAgentId);
    list.push({
      id,
      ...(type ? { type } : {}),
      ...(description ? { description } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      ...(parent && ids.has(parent) ? { parentId: parent } : {}),
      ...(at !== undefined ? { at } : {}),
    });
  }
  return list.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));
}

/** What the parent transcript records about its subagents: the Task tool_use ids that
 *  finished, and every id a background task's `<task-notification>` named. A foreground
 *  Task's result arrives when it ends; a background Task's arrives at once, so only its
 *  later notification — which carries the tool-use id, and the agent id as its task id —
 *  says it ended. The notification rides any entry kind, so this scans the raw lines. */
export interface ParentDone { finished: Set<string>; notified: Set<string> }

export function parentFinished(jsonl: string): ParentDone {
  const calls = new Map<string, boolean>(); // Task tool_use id → started with run_in_background
  const results = new Set<string>();
  const notified = new Set<string>();
  const notification = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value.includes('<task-notification>') && value.includes('<tool-use-id>') ? value : undefined;
    if (!value || typeof value !== 'object') return undefined;
    for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
      const found = notification(item);
      if (found) return found;
    }
  };
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('<task-notification>')) continue;
    let entry: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      entry = value as Record<string, unknown>;
    } catch { continue; }
    const note = notification(entry);
    if (note) {
      const toolUseId = note.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1];
      const taskId = note.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
      if (toolUseId) notified.add(toolUseId);
      if (taskId) notified.add(taskId); // a background subagent's task id is its agent id
      continue;
    }
    const content = (entry.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const block = item as Record<string, unknown>;
      if (block.type === 'tool_use' && (block.name === 'Task' || block.name === 'Agent') && typeof block.id === 'string')
        calls.set(block.id, (block.input as Record<string, unknown> | undefined)?.run_in_background === true);
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') results.add(block.tool_use_id);
    }
  }
  const finished = new Set<string>();
  for (const [id, background] of calls) if (background ? notified.has(id) : results.has(id)) finished.add(id);
  return { finished, notified };
}

/** Whether a conversation's tail ends with a final assistant message, Claude Code's own
 *  end-of-run record. Most finished subagents miss it — the answer goes to the parent as the
 *  Task result — so this is one signal beside the parent's records and the file's freshness. */
function endsDone(tail: string): boolean {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      entry = value as Record<string, unknown>;
    } catch { continue; } // a line the tail window cut
    if (entry.type !== 'assistant' && entry.type !== 'user') continue; // reminders and attachments ride last
    const message = entry.message;
    return entry.type === 'assistant' && !!message && typeof message === 'object' && !Array.isArray(message)
      && (message as Record<string, unknown>).stop_reason === 'end_turn';
  }
  return false;
}

// A file this quiet reads done: its process most likely died. A tool silent longer than this
// (a slow build) reads done until its next write or the parent's record corrects it.
const STALE_MS = 90_000;
const TAIL_BYTES = 16_384;

export class ChatLens {
  private cache = new Map<string, Cached>();
  private subagents = new Map<string, Subagents>();
  /** The main transcript's completion records per Pane, re-derived only on a fresh parse. */
  private parents = new Map<string, { sessionId: string; parent: ParentDone }>();
  /** Each subagent file's judged ending per Pane; the cached mtime says when to read again. */
  private tails = new Map<string, { sessionId: string; tails: Map<string, { mtime: number; done: boolean }> }>();
  private reads = new Map<string, Promise<Cached | undefined>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly hub: ChatHub, private readonly io: TranscriptIo = remoteIo, private readonly home = homedir()) {}

  async query(paneKey: string, agent?: string): Promise<ChatResponse | undefined> {
    return (await this.tagged(paneKey, agent))?.chat;
  }

  /** The chat with a strong ETag. One tag per parse: the parse is cached on the transcript's
   *  signature, so the tag holds exactly as long as the JSON it names. */
  async tagged(paneKey: string, agent?: string): Promise<{ chat: ChatResponse; etag: string } | undefined> {
    const value = await this.value(paneKey, agent);
    if (!value) return undefined;
    const { inode, size, mtime } = value.signature;
    // The subagents' states and mtimes ride the tag: they move while the transcript stands still.
    const digest = value.subagents.map((item) => `${item.id}\u0001${item.state ?? ''}\u0001${item.updatedAt ?? ''}`).join('\u0002');
    return {
      chat: { sessionId: value.sessionId, turns: value.turns, at: value.at, subagents: value.subagents, ...(agent ? { agent } : {}) },
      etag: `"${Bun.hash([value.sessionId, agent ?? '', inode, size, mtime, value.at, digest].join('\u0000')).toString(36)}"`,
    };
  }

  /** The Pane's subagent tree, `undefined` when the Pane resolves to no session. */
  async subagentList(paneKey: string): Promise<Subagent[] | undefined> {
    const resolved = await resolveSession(this.hub, paneKey);
    if (!resolved) return undefined;
    if (resolved.agent === 'pi') return [];
    const target = this.hub.host(await this.hub.paneHost(paneKey))?.target;
    const cwd = (await this.hub.state()).panes.find(item => item.key === paneKey)?.cwd;
    if (!cwd) return undefined;
    const dir = join(transcriptDir(cwd, resolved.sessionId, target ? '$HOME' : this.home), 'subagents');
    const found = await this.list(paneKey, dir, target, resolved.sessionId);
    return found ? await this.states(paneKey, dir, target, resolved.sessionId, found.list) : [];
  }

  /** Image `id` from the cached parse of the main or a subagent conversation: `undefined`
   *  when the Pane has no session, `image: undefined` when the id is out of range. */
  async image(paneKey: string, id: number, agent?: string): Promise<{ image?: { bytes: Uint8Array<ArrayBuffer>; mediaType: string } } | undefined> {
    const value = await this.value(paneKey, agent);
    const found = value?.images[id];
    // A fresh Uint8Array so the bytes carry their own ArrayBuffer, which BodyInit demands.
    return value ? { image: found && { bytes: new Uint8Array(Buffer.from(found.data, 'base64')), mediaType: found.mediaType } } : undefined;
  }

  /** Preview `id` (HTML the Agent wrote) from the same cached parse, under the same contract as `image`. */
  async preview(paneKey: string, id: number, agent?: string): Promise<{ html?: string } | undefined> {
    const value = await this.value(paneKey, agent);
    return value ? { html: value.previews[id] } : undefined;
  }

  private async value(paneKey: string, agent?: string): Promise<Cached | undefined> {
    const cacheKey = agent ? `${paneKey}\u0000${agent}` : paneKey;
    let request = this.reads.get(cacheKey);
    if (!request) {
      request = this.refresh(paneKey, agent);
      this.reads.set(cacheKey, request);
      void request.finally(() => this.reads.delete(cacheKey));
    }
    try {
      return await request;
    } finally { this.schedule(paneKey, agent); }
  }

  close(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  private async refresh(paneKey: string, agent?: string): Promise<Cached | undefined> {
    const cacheKey = agent ? `${paneKey}\u0000${agent}` : paneKey;
    const resolved = await resolveSession(this.hub, paneKey);
    if (!resolved) { this.cache.delete(cacheKey); return; }
    const target = this.hub.host(await this.hub.paneHost(paneKey))?.target;
    const session = resolved.agent === 'pi' ? piSessionId(resolved.path) : resolved.sessionId;
    let path: string | undefined;
    let dir: string | undefined;
    if (resolved.agent === 'pi') {
      if (agent) return;
      path = resolved.path;
    } else {
      const cwd = (await this.hub.state()).panes.find(item => item.key === paneKey)?.cwd;
      if (!cwd) return;
      const home = target ? '$HOME' : this.home;
      dir = transcriptDir(cwd, resolved.sessionId, home);
      path = agent ? join(dir, 'subagents', `agent-${agent}.jsonl`) : transcriptPath(cwd, resolved.sessionId, home);
    }
    const signature = await this.io.stat(path, target);
    if (!signature) { this.cache.delete(cacheKey); return; }
    const cached = this.cache.get(cacheKey);
    if (cached?.sessionId === session && sameSignature(cached.signature, signature)) {
      // The transcript stands still while a subagent runs; its own file keeps moving.
      if (dir) cached.subagents = await this.states(paneKey, join(dir, 'subagents'), target, session, (await this.list(paneKey, join(dir, 'subagents'), target, session))?.list ?? cached.subagents);
      return cached;
    }
    let list: Subagent[] = [];
    let subagentDir: string | undefined;
    if (dir) {
      subagentDir = join(dir, 'subagents');
      // The tree rides every Claude parse: the turns link Task rows by toolUseId, on both forms.
      list = (await this.list(paneKey, subagentDir, target, session))?.list ?? [];
      if (agent && !list.some(item => item.id === agent)) return; // the route pre-checks; a race only misses the cache
    }
    const jsonl = await this.io.read(path, target);
    // Only the main transcript holds the first-level Task rows; a nested subagent's Task rows
    // sit in another subagent's file, which this scan does not read — those fall back to the
    // ending and freshness rules.
    if (subagentDir && !agent) this.parents.set(paneKey, { sessionId: session, parent: parentFinished(jsonl) });
    const images: TranscriptImage[] = [];
    const previews: string[] = [];
    const subagentIds = new Map<string, string>();
    for (const item of list) if (item.toolUseId) subagentIds.set(item.toolUseId, item.id);
    const opts: ParseOpts = { images, previews, subagentIds, ...(agent ? { sidechain: true } : {}) };
    if (subagentDir) list = await this.states(paneKey, subagentDir, target, session, list);
    const value: Cached = { sessionId: session, signature, turns: (resolved.agent === 'pi' ? parsePiTranscript : parseTranscript)(jsonl, opts), images, previews, subagents: list, at: Date.now() };
    this.cache.set(cacheKey, value);
    return value;
  }

  /** The `subagents` directory listing, cached on the directory's mtime so polling stays a stat. */
  private async list(paneKey: string, dir: string, target: string | undefined, sessionId: string): Promise<Subagents | undefined> {
    const read = this.io.subagents;
    if (!read) return undefined;
    let found: SubagentDir | undefined;
    try { found = await read(dir, target); } catch { return undefined; } // a failing listing must not take the chat down
    const signature = found?.mtime ?? '';
    const cached = this.subagents.get(paneKey);
    if (cached?.sessionId === sessionId && cached.signature === signature) return cached;
    const value: Subagents = { sessionId, signature, list: found ? subagentsOf(found.agents) : [] };
    this.subagents.set(paneKey, value);
    return value;
  }

  /** The tree with each subagent judged `running` or `done`: done when the parent's records
   *  name it, or its own file ends with a final assistant message; else done once its file
   *  has been quiet past STALE_MS, running until then. One mtime round trip per refresh; a
   *  tail is re-read only when its file moved. */
  private async states(paneKey: string, dir: string, target: string | undefined, sessionId: string, list: Subagent[]): Promise<Subagent[]> {
    const readMtimes = this.io.mtimes, readTail = this.io.tail;
    if (!readMtimes || !list.length) return list;
    let mtimes: Map<string, number> | undefined;
    try { mtimes = await readMtimes(dir, target); } catch { return list; } // a failing check must not take the chat down
    if (!mtimes) return list;
    let cache = this.tails.get(paneKey);
    if (!cache || cache.sessionId !== sessionId) {
      cache = { sessionId, tails: new Map() };
      this.tails.set(paneKey, cache);
    }
    const parent = this.parents.get(paneKey);
    const records = parent && parent.sessionId === sessionId ? parent.parent : undefined;
    const out: Subagent[] = [];
    for (const agent of list) {
      const mtime = mtimes.get(agent.id);
      if (mtime === undefined) { out.push(agent); continue; } // the file is gone; the listing catches up when the directory moves
      const recorded = records && agent.toolUseId !== undefined && (records.finished.has(agent.toolUseId) || records.notified.has(agent.id));
      let done = Boolean(recorded);
      if (!done) {
        let tail = cache.tails.get(agent.id);
        if (tail?.mtime !== mtime) {
          let ending = false;
          if (readTail) {
            try { ending = endsDone(await readTail(join(dir, `agent-${agent.id}.jsonl`), TAIL_BYTES, target)); }
            catch { /* a failing read leaves the judgement to freshness */ }
          }
          tail = { mtime, done: ending };
          cache.tails.set(agent.id, tail);
        }
        done = tail.done || Date.now() - mtime > STALE_MS;
      }
      out.push({ ...agent, updatedAt: mtime, state: done ? 'done' : 'running' });
    }
    return out;
  }

  private schedule(paneKey: string, agent?: string): void {
    const key = agent ? `${paneKey}\u0000${agent}` : paneKey;
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    if (!this.hub.watchedPaneKeys().has(paneKey)) return;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.hub.watchedPaneKeys().has(paneKey)) void this.query(paneKey, agent);
    }, 4_000));
  }
}
