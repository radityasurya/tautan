import { open, readFile, readdir, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHAT_PAGE_TURNS, parseCodexRollout, parsePiTranscript, parseTranscript, pendingTools, type ChatDelta, type ChatEvent, type ChatResponse, type ParseOpts, type Subagent, type TranscriptImage, type Turn } from '../shared/chat.ts';
import { codexHome, resolveCodexPath } from './codex-chat.ts';
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
  /** Every file matching a `*` wildcard pattern under a directory, recursively; `undefined`
   *  when the directory does not exist. For Codex's exact-id rollout search. */
  find?(root: string, pattern: string, target?: string): Promise<string[] | undefined>;
  /** A file's first complete line (the head window grows to its cap), for Codex's
   *  `session_meta` id check. */
  head?(path: string, target?: string): Promise<string | undefined>;
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
/** A `*` wildcard pattern as a whole-name test: every other character literal. */
const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

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

// ponytail: the head window doubles until the first line is complete, capped at 8 MB — a first
// entry past that falls back to the file's mtime (or fails Codex's header check); stream the
// file if one ever appears.
const HEAD = 262_144;
const HEAD_CAP = 8 * 1024 * 1024;
const firstAt = (head: string, mtimeMs: number | undefined): number | undefined => {
  const parsed = Date.parse(head.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1] ?? '');
  return Number.isFinite(parsed) ? parsed : mtimeMs;
};

/** A file's head, grown until its first line is complete: one long first entry can hold the
 *  timestamp (or Codex's `session_meta` id) deep inside it. */
async function readHead(handle: FileHandle): Promise<string> {
  let window = HEAD;
  for (;;) {
    const buffer = Buffer.alloc(window);
    const { bytesRead } = await handle.read(buffer, 0, window, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (bytesRead < window || text.includes('\n') || window >= HEAD_CAP) return text;
    window = Math.min(window * 2, HEAD_CAP);
  }
}

/** A conversation file's `at`: its first entry's timestamp, else its mtime in ms. */
async function agentAt(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    const handle = await open(path, 'r');
    try { return firstAt(await readHead(handle), Math.round(info.mtimeMs)); } finally { await handle.close(); }
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
  async find(root, pattern) {
    const match = glob(pattern);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && match.test(entry.name)) out.push(path);
      }
    };
    await walk(root);
    return out;
  },
  async head(path) {
    const handle = await open(path, 'r');
    try { return (await readHead(handle)).split('\n', 1)[0] ?? ''; } finally { await handle.close(); }
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
  find: async (root, pattern, target) => {
    if (!target) return localIo.find!(root, pattern);
    const file = remotePath(root);
    const result = await ssh(target, `[ -d ${file} ] || exit 3; find ${file} -type f -name ${quoteShell(pattern)}`);
    if (result.code === 3) return undefined;
    if (result.code) throw new Error('remote codex rollout find failed');
    return result.stdout.split('\n').filter(Boolean);
  },
  head: async (path, target) => {
    if (!target) return localIo.head!(path);
    // The pipeline's exit status is `head -n 1`'s: an unreadable file prints nothing and still
    // exits 0, so it reads as a header miss, not as a failed head.
    const result = await ssh(target, `head -c ${HEAD_CAP} -- ${remotePath(path)} | head -n 1`);
    if (result.code) throw new Error('remote transcript head failed');
    return result.stdout.split('\n', 1)[0] ?? '';
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
  if [ -f "$j" ]; then printf '@@head\\n'; head -c ${HEAD_CAP} "$j" 2>/dev/null | head -n 1; printf '\\n@@meta\\n'; else printf '@@meta\\n'; fi
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

/** A resolved session: Claude's rollout id; pi's or omp's session file path (herdr reports
 *  both as `kind: "path"`; omp trusts the path report only, Wave 12.3); or Codex's thread id,
 *  which maps to its one rollout file under the Codex home (Wave 12.2). All come only from
 *  herdr's `agent_session` or the process's own argv. */
export type ResolvedSession = { agent: 'claude'; sessionId: string } | { agent: 'pi' | 'omp'; path: string } | { agent: 'codex'; sessionId: string };

const piFile = /^\/\S+\.jsonl$/;
const piId = /^[0-9a-f-]+$/i;

/** One remembered pi session-file resolution per ssh target + id: the path (re-checked by
 *  stat on every use, like `rollouts`), or a miss held briefly so an unresolvable id does not
 *  walk the sessions root on every poll. */
type PiFiles = Map<string, { path?: string; at: number }>;
const PI_MISS_MS = 30_000;

/** pi's own `--session <path|id>` rule (its help: "partial UUID"): a bare or partial id maps
 *  to the one sessions file whose name carries it — the header's id always equals the name's.
 *  ponytail: a resolved id (or a 30 s miss) is cached per target+id, stat-checked like
 *  `rollouts`; a cold or invalidated walk still scans the whole sessions root, not the
 *  Pane's project dir — scope it by cwd if that walk ever shows up. */
async function piSessionFile(io: TranscriptIo | undefined, id: string, home: string, target?: string, piFiles?: PiFiles): Promise<string | undefined> {
  if (!io?.find) return undefined;
  const lower = id.toLowerCase(); // pi writes lowercase uuid file names; `piId` takes any case
  const key = `${target ?? ''}\u0000${lower}`;
  const remembered = piFiles?.get(key);
  if (remembered) {
    if (remembered.path) {
      if (await io.stat(remembered.path, target)) return remembered.path;
    } else if (Date.now() - remembered.at < PI_MISS_MS) return undefined;
    piFiles?.delete(key); // the file vanished, or the miss went stale: resolve again
  }
  const root = target ? '$HOME/.pi/agent/sessions' : join(home, '.pi', 'agent', 'sessions');
  try {
    const found = await io.find(root, `*_${lower}*.jsonl`, target) ?? [];
    const path = found.length === 1 ? found[0] : undefined; // zero matches or an ambiguous prefix
    piFiles?.set(key, path ? { path, at: Date.now() } : { at: Date.now() });
    return path;
  } catch { return undefined; } // a failed walk (ssh) is transient: remember nothing
}

async function piSession(known: string | undefined, info: Promise<ProcessInfo | undefined> | undefined, io?: TranscriptIo, home = homedir(), target?: string, piFiles?: PiFiles): Promise<ResolvedSession | undefined> {
  if (typeof known === 'string' && piFile.test(known)) return { agent: 'pi', path: known };
  const value = await info;
  const processes = value ? [...value.foregroundProcesses].sort((a, b) => Number(b.pid === value.foregroundProcessGroupId) - Number(a.pid === value.foregroundProcessGroupId)) : [];
  for (const process of processes) {
    const argv = process.argv ?? [];
    if (process.name?.toLowerCase() !== 'pi' && !argv.some(arg => /(?:^|\/)pi$/.test(arg))) continue;
    for (let index = 0; index < argv.length - 1; index++) {
      if (!['--session', '--session-id'].includes(argv[index]!)) continue;
      const arg = argv[index + 1]!;
      if (piFile.test(arg)) return { agent: 'pi', path: arg };
      if (piId.test(arg)) {
        const path = await piSessionFile(io, arg, home, target, piFiles);
        if (path) return { agent: 'pi', path };
      }
    }
  }
  if (typeof known === 'string' && piId.test(known)) {
    const path = await piSessionFile(io, known, home, target, piFiles); // a remembered miss serves the argv id's re-check
    if (path) return { agent: 'pi', path };
  }
}

export async function resolveSession(hub: SessionHub, paneKey: string, io?: TranscriptIo, home = homedir(), target?: string, piFiles?: PiFiles): Promise<ResolvedSession | undefined> {
  const found = hub.resolvePane(paneKey);
  if (!found || found.entry.mux.kind !== 'herdr') return undefined;
  const pane = found.entry.tree?.panes.find(pane => pane.id === found.paneId);
  const known = pane?.agentSession;
  if (pane?.agent === 'pi') return piSession(known, found.entry.mux.processInfo?.(found.paneId), io, home, target, piFiles);
  // omp (Wave 12.3): the Herdr path report only — an id-only report would need the cwd/profile
  // root scans ADR 0005 forbids, so it stays unresolved.
  if (pane?.agent === 'omp') return typeof known === 'string' && piFile.test(known) ? { agent: 'omp', path: known } : undefined;
  if (pane?.agent === 'codex' && known && sessionId.test(known)) return { agent: 'codex', sessionId: known };
  if (known && sessionId.test(known)) return { agent: 'claude', sessionId: known };
  const info = await found.entry.mux.processInfo?.(found.paneId);
  if (!info) return undefined;
  const processes = [...info.foregroundProcesses].sort((a, b) => Number(b.pid === info.foregroundProcessGroupId) - Number(a.pid === info.foregroundProcessGroupId));
  for (const process of processes) {
    const argv = process.argv ?? [];
    if (process.name?.toLowerCase() !== 'claude' && !argv.some(arg => /(?:^|\/)claude$/i.test(arg))) continue;
    for (let index = 0; index < argv.length - 1; index++) if (['-r', '--resume', '--session-id'].includes(argv[index]!) && sessionId.test(argv[index + 1]!)) return { agent: 'claude', sessionId: argv[index + 1]! };
  }
  // The Pane's own `codex resume <thread-id>` descriptor carries the same id the hook reports.
  for (const process of processes) {
    const argv = process.argv ?? [];
    if (process.name?.toLowerCase() !== 'codex' && !argv.some(arg => /(?:^|\/)codex$/.test(arg))) continue;
    for (let index = 0; index < argv.length - 1; index++) if (argv[index] === 'resume' && sessionId.test(argv[index + 1]!)) return { agent: 'codex', sessionId: argv[index + 1]! };
  }
}

type AgentKind = NonNullable<ChatResponse['agentKind']>;
type Cached = { sessionId: string; agentKind: AgentKind; signature: TranscriptSignature; cursor: string; turns: Turn[]; images: TranscriptImage[]; previews: string[]; outputs: Map<string, string>; details: Map<string, string>; subagents: Subagent[]; at: number };
/** One remembered generation (ADR 0007): the cursor that names it, every Turn's fingerprint
 *  (none for an id-less transcript, which keeps its digest only), and the subagents digest
 *  at parse time. The lens keeps the newest eight per conversation. */
type Generation = { cursor: string; prints: Map<string, string>; subs: string };
/** ADR 0007: how many generations back a `?since=` cursor can name. */
const GENERATIONS = 8;

/** ADR 0007's cursor: the strong ETag's ingredients minus its volatile parts (`at`, the
 *  subagents digest), so it names exactly the parse its Turns came from. Never decoded. */
const cursorOf = (sessionId: string, agent: string | undefined, signature: TranscriptSignature) =>
  Bun.hash([sessionId, agent ?? '', signature.inode, signature.size, signature.mtime].join('\u0000')).toString(36);

/** A Turn's fingerprint (ADR 0007): a short hash of its whole content. */
const print = (turn: Turn) => Bun.hash(JSON.stringify(turn)).toString(36);

/** The subagents' states and mtimes, which ride the ETag: they move while the transcript
 *  stands still. */
const subagentsDigest = (list: Subagent[]) => list.map((item) => `${item.id}\u0001${item.state ?? ''}\u0001${item.updatedAt ?? ''}`).join('\u0002');
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
  /** ADR 0007: called once per new generation of any conversation (its cursor moved) —
   *  the `chat` wake-up on the event stream. */
  onChat?: (event: ChatEvent) => void;
  private cache = new Map<string, Cached>();
  private generations = new Map<string, Generation[]>();
  /** The session each conversation's generations belong to; a change is the one thing that retires them. */
  private sessions = new Map<string, string>();
  /** Remembered pi session files per ssh target + id, stat-checked like `rollouts` on every use. */
  private piFiles: PiFiles = new Map();
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
    return {
      chat: { sessionId: value.sessionId, turns: value.turns, at: value.at, subagents: value.subagents, agentKind: value.agentKind, ...(agent ? { agent } : {}) },
      etag: `"${Bun.hash([value.sessionId, agent ?? '', value.signature.inode, value.signature.size, value.signature.mtime, value.at, subagentsDigest(value.subagents)].join('\u0000')).toString(36)}"`,
    };
  }

  /** ADR 0007: the conversation's change since a cursor it handed out. A `since` equal to
   *  the current cursor answers nothing new; one naming an older remembered generation
   *  answers its diff; anything else — unknown, older than eight generations, from before
   *  a restart, or another transcript — answers a full `reset`. The amendment adds the
   *  windowed form: `limit` caps a reset's upserts to the newest turns and reports
   *  `total`, and `after` names the oldest Turn the client holds, so a diff considers only
   *  turns from it on — the client never receives an upsert it cannot place, and a Turn it
   *  holds outside the window never goes stale. A parse whose Turns lack ids is never
   *  windowed: it keeps the whole-list answer and reports no `total`. */
  async delta(paneKey: string, since: string, agent?: string, opts?: { limit?: number; after?: string }): Promise<ChatDelta | undefined> {
    const value = await this.value(paneKey, agent);
    if (!value) return undefined;
    const gen = this.generations.get(agent ? `${paneKey}\u0000${agent}` : paneKey)?.find(item => item.cursor === since);
    // One id set for the shrink rule and the window rule: a reset whose Turns lack ids is
    // never windowed — `Load earlier` names the oldest held Turn, and an id-less one cannot
    // be named, so the older Turns would go silently missing. Such a parse keeps today's
    // whole-list answer, `total` and all.
    const ids = new Set(value.turns.map(turn => turn.id));
    const cap = opts?.limit !== undefined && !ids.has(undefined) ? opts.limit : undefined;
    const total = cap !== undefined ? value.turns.length : undefined;
    const window = cap !== undefined ? value.turns.slice(-cap) : value.turns;
    // An `after` that names no Turn of this parse (a truncation, a switched branch) cannot
    // be diffed against — not even quietly: the reset below replaces the client's list.
    const from = opts?.after === undefined ? undefined : value.turns.findIndex(turn => turn.id === opts.after);
    // The quiet answer (ADR 0007): the cursor names exactly this parse, so it holds for a
    // digest-only generation (an id-less transcript) as surely as for a fingerprinted one.
    // Only the tree may still ride, when its digest moved past what the client last saw.
    if (gen && since === value.cursor && from !== -1) {
      return {
        sessionId: value.sessionId,
        cursor: value.cursor,
        reset: false,
        upserts: [],
        agentKind: value.agentKind,
        ...(total !== undefined ? { total } : {}),
        ...(gen.subs !== subagentsDigest(value.subagents) ? { subagents: value.subagents } : {}),
        ...(agent ? { agent } : {}),
      };
    }
    // One uniform shrink rule: a remembered id that ceased to exist (a pi branch switch, a
    // truncation) cannot be expressed as upserts. So can a Turn without a native id.
    const reset = !gen || from === -1 || ids.has(undefined) || [...gen.prints.keys()].some(id => !ids.has(id));
    return {
      sessionId: value.sessionId,
      cursor: value.cursor,
      reset,
      upserts: !gen || reset ? window : (from !== undefined && from > 0 ? value.turns.slice(from) : value.turns).filter(turn => gen.prints.get(turn.id!) !== print(turn)),
      agentKind: value.agentKind,
      ...(total !== undefined ? { total } : {}),
      ...(!gen || reset || gen.subs !== subagentsDigest(value.subagents) ? { subagents: value.subagents } : {}),
      ...(agent ? { agent } : {}),
    };
  }

  /** The amendment's earlier page: the turns before `before` — the client's oldest held
   *  Turn id — one page of `limit`, shaped as a delta whose upserts the client prepends.
   *  `before` gone from the parse answers a reset, so the client replaces its list. */
  async earlier(paneKey: string, before: string, agent?: string, limit = CHAT_PAGE_TURNS): Promise<ChatDelta | undefined> {
    const value = await this.value(paneKey, agent);
    if (!value) return undefined;
    const index = value.turns.findIndex(turn => turn.id === before);
    const page = index >= 0 ? value.turns.slice(Math.max(0, index - limit), index) : undefined;
    // The same rule as `delta`: a reset whose Turns lack ids is never windowed — the whole
    // list rides, so no Turn goes missing behind an unnameable oldest one.
    const whole = value.turns.some(turn => turn.id === undefined);
    return {
      sessionId: value.sessionId,
      cursor: value.cursor,
      reset: page === undefined,
      upserts: page ?? (whole ? value.turns : value.turns.slice(-limit)),
      agentKind: value.agentKind,
      total: value.turns.length,
      ...(page === undefined ? { subagents: value.subagents } : {}),
      ...(agent ? { agent } : {}),
    };
  }

  /** The Pane's subagent tree, `undefined` when the Pane resolves to no session. */
  async subagentList(paneKey: string): Promise<Subagent[] | undefined> {
    const target = await this.target(paneKey);
    const resolved = await resolveSession(this.hub, paneKey, this.io, this.home, target, this.piFiles);
    if (!resolved) return undefined;
    if (resolved.agent !== 'claude') return []; // only Claude Code writes a subagents directory
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

  /** A tool's whole text from the cached parse, under the same contract as `image`: its
   *  result (ADR 0007: kept only past the inline slice) or, since the amendment, its detail
   *  (kept only past the inline head). */
  async output(paneKey: string, toolId: string, agent?: string, part: 'result' | 'detail' = 'result'): Promise<{ text?: string } | undefined> {
    const value = await this.value(paneKey, agent);
    return value ? { text: (part === 'detail' ? value.details : value.outputs).get(toolId) } : undefined;
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

  /** The Pane's Host ssh target: `undefined` for a local Host, or for a Pane already gone. */
  private async target(paneKey: string): Promise<string | undefined> {
    return await this.hub.paneHost(paneKey).then(hostId => this.hub.host(hostId)?.target, () => undefined);
  }

  private async refresh(paneKey: string, agent?: string): Promise<Cached | undefined> {
    const cacheKey = agent ? `${paneKey}\u0000${agent}` : paneKey;
    const target = await this.target(paneKey);
    const resolved = await resolveSession(this.hub, paneKey, this.io, this.home, target, this.piFiles);
    if (!resolved) { this.cache.delete(cacheKey); return; }
    let session: string;
    if (resolved.agent === 'codex' || resolved.agent === 'claude') session = resolved.sessionId;
    else session = piSessionId(resolved.path); // pi and omp: the id rides the file's name
    // A failed resolve or stat is a transient miss, not a new conversation: a cursor names
    // bytes, not cache state, so the generations survive it. Only a session change retires
    // them — and a cursor hashes the session id, so a stale one can never match anyway.
    if (this.sessions.get(cacheKey) !== session) {
      this.sessions.set(cacheKey, session);
      this.generations.delete(cacheKey);
    }
    let path: string | undefined;
    let dir: string | undefined;
    if (resolved.agent === 'codex') {
      if (agent) return; // no subagent views: Codex writes none
      path = await this.rollout(paneKey, resolved.sessionId, target);
      if (!path) return;
    } else if (resolved.agent === 'claude') {
      const cwd = (await this.hub.state()).panes.find(item => item.key === paneKey)?.cwd;
      if (!cwd) return;
      const home = target ? '$HOME' : this.home;
      dir = transcriptDir(cwd, resolved.sessionId, home);
      path = agent ? join(dir, 'subagents', `agent-${agent}.jsonl`) : transcriptPath(cwd, resolved.sessionId, home);
    } else {
      if (agent) return; // pi and omp keep no subagent directory either
      path = resolved.path;
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
    const outputs = new Map<string, string>();
    const details = new Map<string, string>();
    const subagentIds = new Map<string, string>();
    for (const item of list) if (item.toolUseId) subagentIds.set(item.toolUseId, item.id);
    const opts: ParseOpts = { images, previews, outputs, details, subagentIds, ...(agent ? { sidechain: true } : {}) };
    if (subagentDir) list = await this.states(paneKey, subagentDir, target, session, list);
    const parsed = resolved.agent === 'codex' ? parseCodexRollout(jsonl, opts)
      : (resolved.agent === 'pi' || resolved.agent === 'omp' ? parsePiTranscript : parseTranscript)(jsonl, opts);
    // A Codex parse without stable identity (Wave 12.1) is no Chat: the Pane keeps its Screen.
    if (!parsed) { this.cache.delete(cacheKey); return; }
    // The amendment: every pending tool's whole detail rides inline, so each approval row shows
    // the whole command or diff with no fetch — the lens restores what the parser cut.
    for (const pending of pendingTools(parsed)) {
      const tool = parsed[pending.turn]!.tools[pending.tool]!;
      const whole = tool.id !== undefined ? details.get(tool.id) : undefined;
      if (whole !== undefined) {
        tool.detail = whole;
        delete tool.detailTruncated;
        delete tool.detailLines;
      }
    }
    const value: Cached = { sessionId: session, agentKind: resolved.agent, signature, cursor: cursorOf(session, agent, signature), turns: parsed, images, previews, outputs, details, subagents: list, at: Date.now() };
    this.cache.set(cacheKey, value);
    this.remember(paneKey, agent, cacheKey, value);
    return value;
  }

  /** Each Pane's resolved Codex rollout: Wave 12.1's exact-id search runs once per thread,
   *  and again only when the mapped file's stat misses (an archived rollout moved). */
  private rollouts = new Map<string, { sessionId: string; path: string }>();
  private async rollout(paneKey: string, threadId: string, target: string | undefined): Promise<string | undefined> {
    const cached = this.rollouts.get(paneKey);
    if (cached?.sessionId === threadId && await this.io.stat(cached.path, target)) return cached.path;
    if (cached) this.rollouts.delete(paneKey);
    const path = await resolveCodexPath(this.io, threadId, target ? '$HOME/.codex' : codexHome(this.home), target);
    if (path) this.rollouts.set(paneKey, { sessionId: threadId, path });
    return path;
  }

  /** Keep the newest eight generations of a conversation (ADR 0007). One without native Turn
   *  ids keeps its digest only: the quiet same-cursor answer serves it, while a `?since=`
   *  naming older bytes still resets — no fingerprint can diff it. */
  private remember(paneKey: string, agent: string | undefined, cacheKey: string, value: Cached): void {
    const prints = value.turns.every(turn => turn.id !== undefined) ? new Map(value.turns.map(turn => [turn.id!, print(turn)])) : new Map<string, string>();
    const list = this.generations.get(cacheKey) ?? [];
    const fresh: Generation = { cursor: value.cursor, prints, subs: subagentsDigest(value.subagents) };
    if (list[0]?.cursor === value.cursor) list[0] = fresh; // a re-parse of the same bytes (an eviction) is no new generation
    else {
      list.unshift(fresh);
      this.onChat?.({ pane: paneKey, cursor: value.cursor, ...(agent ? { agent } : {}) });
    }
    list.length = Math.min(list.length, GENERATIONS);
    this.generations.set(cacheKey, list);
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
