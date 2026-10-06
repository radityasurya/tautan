import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, type Turn } from '../shared/chat.ts';
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
  entry: { mux: { kind: 'herdr' | 'tmux'; processInfo?: (paneId: string) => Promise<ProcessInfo> }; tree?: { panes: { id: string; agentSession?: string }[] } };
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

function remotePath(path: string): string {
  const relative = path.replace(/^\$HOME\//, '');
  return `"$HOME/"${quoteShell(relative)}`;
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

export async function resolveSession(hub: SessionHub, paneKey: string): Promise<{ sessionId: string } | undefined> {
  const found = hub.resolvePane(paneKey);
  if (!found || found.entry.mux.kind !== 'herdr') return undefined;
  const known = found.entry.tree?.panes.find(pane => pane.id === found.paneId)?.agentSession;
  if (known && sessionId.test(known)) return { sessionId: known };
  const info = await found.entry.mux.processInfo?.(found.paneId);
  if (!info) return undefined;
  const processes = [...info.foregroundProcesses].sort((a, b) => Number(b.pid === info.foregroundProcessGroupId) - Number(a.pid === info.foregroundProcessGroupId));
  for (const process of processes) {
    const argv = process.argv ?? [];
    if (process.name?.toLowerCase() !== 'claude' && !argv.some(arg => /(?:^|\/)claude$/i.test(arg))) continue;
    for (let index = 0; index < argv.length - 1; index++) if (['-r', '--resume', '--session-id'].includes(argv[index]!) && sessionId.test(argv[index + 1]!)) return { sessionId: argv[index + 1]! };
  }
}

type Cached = { sessionId: string; signature: TranscriptSignature; turns: Turn[]; at: number };
export class ChatLens {
  private cache = new Map<string, Cached>();
  private reads = new Map<string, Promise<Cached | undefined>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly hub: ChatHub, private readonly io: TranscriptIo = remoteIo, private readonly home = homedir()) {}

  async query(paneKey: string): Promise<{ sessionId: string; turns: Turn[]; at: number } | undefined> {
    let request = this.reads.get(paneKey);
    if (!request) {
      request = this.refresh(paneKey);
      this.reads.set(paneKey, request);
      void request.finally(() => this.reads.delete(paneKey));
    }
    try {
      const value = await request;
      return value && { sessionId: value.sessionId, turns: value.turns, at: value.at };
    } finally { this.schedule(paneKey); }
  }

  close(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  private async refresh(paneKey: string): Promise<Cached | undefined> {
    const resolved = await resolveSession(this.hub, paneKey);
    if (!resolved) { this.cache.delete(paneKey); return; }
    const state = await this.hub.state();
    const pane = state.panes.find(item => item.key === paneKey);
    if (!pane?.cwd) return;
    const host = this.hub.host(await this.hub.paneHost(paneKey));
    const path = transcriptPath(pane.cwd, resolved.sessionId, host?.target ? '$HOME' : this.home);
    const signature = await this.io.stat(path, host?.target);
    if (!signature) { this.cache.delete(paneKey); return; }
    const cached = this.cache.get(paneKey);
    if (cached?.sessionId === resolved.sessionId && sameSignature(cached.signature, signature)) return cached;
    const jsonl = await this.io.read(path, host?.target);
    const value = { sessionId: resolved.sessionId, signature, turns: parseTranscript(jsonl), at: Date.now() };
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
