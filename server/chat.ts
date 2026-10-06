import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePiTranscript, parseTranscript, type TranscriptImage, type Turn } from '../shared/chat.ts';
import type { State, StateHost } from '../shared/types.ts';

export interface TranscriptSignature { inode: string; size: number; mtime: string }
export interface TranscriptIo {
  stat(path: string, target?: string): Promise<TranscriptSignature | undefined>;
  read(path: string, target?: string): Promise<string>;
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

const localIo: TranscriptIo = {
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
};

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

type Cached = { sessionId: string; signature: TranscriptSignature; turns: Turn[]; images: TranscriptImage[]; at: number };
export class ChatLens {
  private cache = new Map<string, Cached>();
  private reads = new Map<string, Promise<Cached | undefined>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly hub: ChatHub, private readonly io: TranscriptIo = remoteIo, private readonly home = homedir()) {}

  async query(paneKey: string): Promise<{ sessionId: string; turns: Turn[]; at: number } | undefined> {
    const value = await this.value(paneKey);
    return value && { sessionId: value.sessionId, turns: value.turns, at: value.at };
  }

  /** Image `id` from the Pane's cached parse: `undefined` when the Pane has no session,
   *  `image: undefined` when the id is out of range. */
  async image(paneKey: string, id: number): Promise<{ image?: { bytes: Uint8Array<ArrayBuffer>; mediaType: string } } | undefined> {
    const value = await this.value(paneKey);
    const found = value?.images[id];
    // A fresh Uint8Array so the bytes carry their own ArrayBuffer, which BodyInit demands.
    return value ? { image: found && { bytes: new Uint8Array(Buffer.from(found.data, 'base64')), mediaType: found.mediaType } } : undefined;
  }

  private async value(paneKey: string): Promise<Cached | undefined> {
    let request = this.reads.get(paneKey);
    if (!request) {
      request = this.refresh(paneKey);
      this.reads.set(paneKey, request);
      void request.finally(() => this.reads.delete(paneKey));
    }
    try {
      return await request;
    } finally { this.schedule(paneKey); }
  }

  close(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  private async refresh(paneKey: string): Promise<Cached | undefined> {
    const resolved = await resolveSession(this.hub, paneKey);
    if (!resolved) { this.cache.delete(paneKey); return; }
    const host = this.hub.host(await this.hub.paneHost(paneKey));
    let path: string | undefined;
    if (resolved.agent === 'pi') path = resolved.path;
    else {
      const state = await this.hub.state();
      const pane = state.panes.find(item => item.key === paneKey);
      if (pane?.cwd) path = transcriptPath(pane.cwd, resolved.sessionId, host?.target ? '$HOME' : this.home);
    }
    if (!path) return;
    const signature = await this.io.stat(path, host?.target);
    if (!signature) { this.cache.delete(paneKey); return; }
    const session = resolved.agent === 'pi' ? piSessionId(resolved.path) : resolved.sessionId;
    const cached = this.cache.get(paneKey);
    if (cached?.sessionId === session && sameSignature(cached.signature, signature)) return cached;
    const jsonl = await this.io.read(path, host?.target);
    const images: TranscriptImage[] = [];
    const value: Cached = { sessionId: session, signature, turns: (resolved.agent === 'pi' ? parsePiTranscript : parseTranscript)(jsonl, { images }), images, at: Date.now() };
    this.cache.set(paneKey, value);
    return value;
  }

  private schedule(paneKey: string): void {
    clearTimeout(this.timers.get(paneKey)); this.timers.delete(paneKey);
    if (!this.hub.watchedPaneKeys().has(paneKey)) return;
    this.timers.set(paneKey, setTimeout(() => {
      this.timers.delete(paneKey);
      if (this.hub.watchedPaneKeys().has(paneKey)) void this.query(paneKey);
    }, 4_000));
  }
}
