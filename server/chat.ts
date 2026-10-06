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
};

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

export class ChatLens {
  private cache = new Map<string, Cached>();
  private subagents = new Map<string, Subagents>();
  private reads = new Map<string, Promise<Cached | undefined>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly hub: ChatHub, private readonly io: TranscriptIo = remoteIo, private readonly home = homedir()) {}

  async query(paneKey: string, agent?: string): Promise<ChatResponse | undefined> {
    const value = await this.value(paneKey, agent);
    return value && { sessionId: value.sessionId, turns: value.turns, at: value.at, subagents: value.subagents, ...(agent ? { agent } : {}) };
  }

  /** The Pane's subagent tree, `undefined` when the Pane resolves to no session. */
  async subagentList(paneKey: string): Promise<Subagent[] | undefined> {
    const resolved = await resolveSession(this.hub, paneKey);
    if (!resolved) return undefined;
    if (resolved.agent === 'pi') return [];
    const target = this.hub.host(await this.hub.paneHost(paneKey))?.target;
    const cwd = (await this.hub.state()).panes.find(item => item.key === paneKey)?.cwd;
    if (!cwd) return undefined;
    return (await this.list(paneKey, join(transcriptDir(cwd, resolved.sessionId, target ? '$HOME' : this.home), 'subagents'), target, resolved.sessionId))?.list ?? [];
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
    if (cached?.sessionId === session && sameSignature(cached.signature, signature)) return cached;
    let list: Subagent[] = [];
    if (dir) {
      // The tree rides every Claude parse: the turns link Task rows by toolUseId, on both forms.
      list = (await this.list(paneKey, join(dir, 'subagents'), target, session))?.list ?? [];
      if (agent && !list.some(item => item.id === agent)) return; // the route pre-checks; a race only misses the cache
    }
    const jsonl = await this.io.read(path, target);
    const images: TranscriptImage[] = [];
    const previews: string[] = [];
    const subagentIds = new Map<string, string>();
    for (const item of list) if (item.toolUseId) subagentIds.set(item.toolUseId, item.id);
    const opts: ParseOpts = { images, previews, subagentIds, ...(agent ? { sidechain: true } : {}) };
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
