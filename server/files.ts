import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { Hub } from './mux.ts';

/** GET /api/files/list and /api/files/raw — the folder browser and the streaming viewer.
 *  Roots: the Host's home and, when a Pane is named, that Pane's cwd; the realpath of the
 *  requested path must stay inside one root (Phase 13 containment, `..` and symlinks alike). */
export class FilesError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

export const quoteShell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export const inside = (root: string, path: string) => {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || !isAbsolute(pathFromRoot) && !pathFromRoot.startsWith('..');
};

/** GET /api/files/list */
export interface FileEntry { name: string; path: string; kind: 'dir' | 'file'; size?: number; mtime?: number }
export interface FileListResult { host: string; path: string; home: string; parent: string | null; entries: FileEntry[]; truncated: boolean }

const LIST_CAP = 1000;

/** Expand `~`/`~/x` the way the remote script's `case` does, for the local Host. */
const expandTilde = (path: string) => path === '~' ? os.homedir() : path.startsWith('~/') ? join(os.homedir(), path.slice(2)) : path;

async function filesContext(hub: Hub, opts: { host: string; path?: string; pane?: string }): Promise<{ target?: string; paneCwd?: string; rawPath: string; hostId: string }> {
  const state = await hub.state();
  const host = hub.host(opts.host) ?? state.hosts.find(item => item.id === opts.host);
  if (!host) throw new FilesError(404, 'host');
  let paneCwd: string | undefined;
  if (opts.pane) {
    const pane = state.panes.find(item => item.key === opts.pane);
    if (!pane) throw new FilesError(404, 'pane not found');
    paneCwd = pane.cwd;
  }
  const rawPath = opts.path?.trim() ? opts.path : '~';
  if (rawPath !== '~' && !rawPath.startsWith('~/') && !isAbsolute(rawPath)) throw new FilesError(400, 'path');
  return { target: host.target, paneCwd, rawPath, hostId: opts.host };
}

/** Realpath the request and prove it stays inside a root. A pane cwd that no longer exists
 *  just drops that root; the home root still holds. */
async function resolveLocal(rawPath: string, paneCwd?: string): Promise<{ target: string; roots: string[] }> {
  const home = await realpath(os.homedir());
  const roots = [home];
  if (paneCwd) { const root = await realpath(paneCwd).catch(() => undefined); if (root) roots.push(root); }
  const target = await realpath(expandTilde(rawPath)).catch(() => { throw new FilesError(404, 'not found'); });
  if (!roots.some(root => inside(root, target))) throw new FilesError(403, 'escape');
  return { target, roots };
}

/** Filter, sort (dirs first, then case-insensitive by name) and cap, shared by both Hosts. */
function finish(hostId: string, target: string, roots: string[], raw: FileEntry[], q: string, hidden: boolean): FileListResult {
  const needle = q.toLowerCase();
  const byName = (a: FileEntry, b: FileEntry) => { const x = a.name.toLowerCase(); const y = b.name.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
  const entries = raw
    .filter(entry => (hidden || !entry.name.startsWith('.')) && (!needle || entry.name.toLowerCase().includes(needle)))
    .sort((a, b) => a.kind === b.kind ? byName(a, b) : a.kind === 'dir' ? -1 : 1);
  return {
    host: hostId, path: target, home: roots[0]!,
    parent: roots.some(root => root === target) ? null : dirname(target),
    entries: entries.slice(0, LIST_CAP), truncated: entries.length > LIST_CAP,
  };
}

export async function fileList(hub: Hub, opts: { host: string; path?: string; pane?: string; q?: string; hidden?: boolean }): Promise<FileListResult> {
  const { target, paneCwd, rawPath, hostId } = await filesContext(hub, opts);
  return target ? listRemote(hostId, target, rawPath, paneCwd, opts.q ?? '', opts.hidden === true)
    : listLocal(hostId, rawPath, paneCwd, opts.q ?? '', opts.hidden === true);
}

async function listLocal(hostId: string, rawPath: string, paneCwd: string | undefined, q: string, hidden: boolean): Promise<FileListResult> {
  const { target, roots } = await resolveLocal(rawPath, paneCwd);
  if (!(await stat(target)).isDirectory()) throw new FilesError(415, 'not a directory');
  const raw: FileEntry[] = [];
  // stat follows symlinks: a symlink is listed by what it points at, a broken one is skipped.
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = join(target, entry.name);
    const followed = await stat(full).catch(() => undefined);
    if (followed?.isDirectory()) raw.push({ name: entry.name, path: full, kind: 'dir' });
    else if (followed?.isFile()) raw.push({ name: entry.name, path: full, kind: 'file', size: followed.size, mtime: Math.floor(followed.mtimeMs / 1000) });
  }
  return finish(hostId, target, roots, raw, q, hidden);
}

/** One ssh round trip: first stdout line is `realpath\thome[\tpane-root]`, every later line
 *  `d\t\t\tname` or `f\tsize\tmtime\tname`. Exit codes map like remoteFileCommand:
 *  11 not found, 12 escape, 13 not a directory, 15 tools missing.
 *  ponytail: tab/newline inside a remote name misparses; emit NUL-delimited records if a
 *  real Host turns one up. */
function remoteListCommand(rawPath: string, paneCwd?: string): string {
  return `command -v realpath >/dev/null 2>&1 || exit 15; home=$(realpath -- "$HOME") || exit 15; p=${quoteShell(rawPath)}; case "$p" in '~') p=$HOME;; '~'/*) p=$HOME/\${p#~};; esac; [ -e "$p" ] || exit 11; rp=$(realpath -- "$p") || exit 11; [ -d "$rp" ] || exit 13; ok=0; case "$rp" in "$home"|"$home"/*) ok=1;; esac; ${
    paneCwd ? `proot=$(realpath -- ${quoteShell(paneCwd)} 2>/dev/null) || proot=; if [ -n "$proot" ]; then case "$rp" in "$proot"|"$proot"/*) ok=1;; esac; fi;` : ''
  } [ "$ok" -eq 1 ] || exit 12; printf '%s\\t%s\\t%s\\n' "$rp" "$home" "\${proot:-}"; for f in "$rp"/* "$rp"/.[!.]* "$rp"/..?*; do [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'd\\t\\t\\t%s\\n' "\${f##*/}"; elif [ -f "$f" ]; then size=$(stat -c %s -- "$f" 2>/dev/null || stat -f %z -- "$f") || continue; mtime=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f") || continue; printf 'f\\t%s\\t%s\\t%s\\n' "$size" "$mtime" "\${f##*/}"; fi; done`;
}

async function listRemote(hostId: string, target: string, rawPath: string, paneCwd: string | undefined, q: string, hidden: boolean): Promise<FileListResult> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', target, '--', remoteListCommand(rawPath, paneCwd)], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code === 11) throw new FilesError(404, 'not found');
  if (code === 12) throw new FilesError(403, 'escape');
  if (code === 13) throw new FilesError(415, 'not a directory');
  if (code === 15) throw new FilesError(502, 'remote');
  if (code) throw new FilesError(502, stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? 'ssh failed');
  const lines = stdout.split('\n'); if (lines.at(-1) === '') lines.pop();
  const head = (lines.shift() ?? '').split('\t');
  const rp = head[0] ?? ''; const home = head[1] ?? ''; const proot = head[2] || undefined;
  const raw: FileEntry[] = [];
  for (const line of lines) {
    const parts = line.split('\t'); if (parts.length < 4) continue;
    const name = parts.slice(3).join('\t');
    if (parts[0] === 'd') raw.push({ name, path: join(rp, name), kind: 'dir' });
    else if (parts[0] === 'f' && /^\d+$/.test(parts[1]!) && /^\d+$/.test(parts[2]!)) raw.push({ name, path: join(rp, name), kind: 'file', size: Number(parts[1]), mtime: Number(parts[2]) });
  }
  return finish(hostId, rp, [home, ...(proot ? [proot] : [])], raw, q, hidden);
}

// The extensions the viewer plays or shows; everything else is a download.
const RAW_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'application/xhtml+xml', xml: 'application/xml',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', jsx: 'text/plain; charset=utf-8',
  mjs: 'text/plain; charset=utf-8', cjs: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8', scss: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8', go: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8', h: 'text/plain; charset=utf-8', cpp: 'text/plain; charset=utf-8', rb: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', env: 'text/plain; charset=utf-8',
};
// Never an active same-origin document: `sandbox` without allow-scripts (previewHeaders' rule).
const SANDBOXED = new Set(['html', 'htm', 'svg', 'xml', 'xhtml']);

function rawHeaders(path: string, download: boolean): Record<string, string> {
  const ext = extname(path).toLowerCase().slice(1);
  const headers: Record<string, string> = {
    'content-type': RAW_TYPES[ext] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/'/g, '%27')}`,
  };
  if (SANDBOXED.has(ext)) headers['content-security-policy'] = 'sandbox';
  return headers;
}

export type RangeSpec = { start: number; end?: number } | { suffix: number } | null;
/** `bytes=a-b` / `a-` / `-n`; a comma means multi-range, malformed means ignored (RFC 9110). */
function parseRange(header: string | null): RangeSpec | 'multi' {
  if (!header) return null;
  const spec = header.trim();
  // ponytail: multi-range serves the whole file (200); a single-part 206 covers every viewer.
  if (spec.includes(',')) return 'multi';
  const match = /^bytes=(\d*)-(\d*)$/.exec(spec);
  if (!match || !match[1] && !match[2]) return null;
  if (!match[1]) return { suffix: Number(match[2]) };
  const end = match[2] ? Number(match[2]) : undefined;
  if (end !== undefined && end < Number(match[1])) return null;
  return { start: Number(match[1]), end };
}

export async function fileRaw(hub: Hub, opts: { host: string; path?: string; pane?: string; download?: boolean }, rangeHeader: string | null): Promise<Response> {
  const { target, paneCwd, rawPath } = await filesContext(hub, opts);
  const range = parseRange(rangeHeader);
  const headers = rawHeaders(rawPath, opts.download === true);
  return target ? rawRemote(target, rawPath, paneCwd, range, headers) : rawLocal(rawPath, paneCwd, range, headers);
}

const unsatisfiable = (size: number) => new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' } });
const partial = (headers: Record<string, string>, start: number, len: number, size: number, body: ReturnType<typeof Bun.file> | ReadableStream<Uint8Array>) =>
  new Response(body, { status: 206, headers: { ...headers, 'accept-ranges': 'bytes', 'content-length': String(len), 'content-range': `bytes ${start}-${start + len - 1}/${size}` } });

async function rawLocal(rawPath: string, paneCwd: string | undefined, range: RangeSpec | 'multi', headers: Record<string, string>): Promise<Response> {
  const { target } = await resolveLocal(rawPath, paneCwd);
  const info = await stat(target);
  if (!info.isFile()) throw new FilesError(415, 'not a file');
  const size = info.size;
  if (!range || range === 'multi') return new Response(Bun.file(target), { status: 200, headers: { ...headers, 'accept-ranges': 'bytes', 'content-length': String(size) } });
  if ('suffix' in range) {
    if (size === 0 || range.suffix <= 0) return unsatisfiable(size); // any range on an empty file is unsatisfiable
    const start = Math.max(0, size - range.suffix);
    return partial(headers, start, size - start, size, Bun.file(target).slice(start));
  }
  if (range.start >= size) return unsatisfiable(size);
  const end = Math.min(range.end ?? size - 1, size - 1);
  return partial(headers, range.start, end - range.start + 1, size, Bun.file(target).slice(range.start, end + 1));
}

/** Stream ssh stdout as the body. The handshake is the FIRST STDERR LINE, before any body:
 *  `SIZE <size> <start> <len>` (start/len of what is being streamed) or `E<code>[ <size>]`
 *  when the script refused (11/12/13/15, and 16 with the size for a 416). Reading it as a
 *  stream keeps stdout undrained — buffering stdout instead deadlocks once the pipe fills.
 *  ponytail: a connection that dies mid-stream truncates the body; no end-to-end checksum. */
function remoteRawCommand(rawPath: string, paneCwd: string | undefined, range: RangeSpec): string {
  const r = range ? `START=${'suffix' in range ? '' : range.start}; END=${'suffix' in range || range.end === undefined ? '' : range.end}; SUFFIX=${'suffix' in range ? range.suffix : ''};` : '';
  return `command -v realpath >/dev/null 2>&1 || exit 15; ${r} home=$(realpath -- "$HOME") || exit 15; p=${quoteShell(rawPath)}; case "$p" in '~') p=$HOME;; '~'/*) p=$HOME/\${p#~};; esac; [ -e "$p" ] || { echo E11 >&2; exit 11; }; rp=$(realpath -- "$p") 2>/dev/null || { echo E11 >&2; exit 11; }; ok=0; case "$rp" in "$home"|"$home"/*) ok=1;; esac; ${
    paneCwd ? `proot=$(realpath -- ${quoteShell(paneCwd)} 2>/dev/null) || proot=; if [ -n "$proot" ]; then case "$rp" in "$proot"|"$proot"/*) ok=1;; esac; fi;` : ''
  } [ "$ok" -eq 1 ] || { echo E12 >&2; exit 12; }; [ -f "$rp" ] || { echo E13 >&2; exit 13; }; size=$(stat -c %s -- "$rp" 2>/dev/null || stat -f %z -- "$rp") || { echo E15 >&2; exit 15; }; if [ -n "$START$END$SUFFIX" ]; then if [ -n "$SUFFIX" ]; then if [ "$SUFFIX" -le 0 ] || [ "$size" -eq 0 ]; then echo "E16 $size" >&2; exit 16; fi; st=$(( size - SUFFIX )); [ "$st" -lt 0 ] && st=0; ln=$(( size - st )); else if [ "$START" -ge "$size" ]; then echo "E16 $size" >&2; exit 16; fi; en=\${END:-$(( size - 1 ))}; [ "$en" -ge "$size" ] && en=$(( size - 1 )); st=$START; ln=$(( en - st + 1 )); fi; echo "SIZE $size $st $ln" >&2; tail -c +$(( st + 1 )) -- "$rp" | head -c "$ln"; else echo "SIZE $size 0 $size" >&2; cat -- "$rp"; fi`;
}

// Exit codes the remote script reports as `E<code>` on stderr before any body.
const REFUSED: Record<number, { status: number; message: string }> = {
  11: { status: 404, message: 'not found' },
  12: { status: 403, message: 'escape' },
  13: { status: 415, message: 'not a file' },
  15: { status: 502, message: 'remote' },
  16: { status: 416, message: 'range' },
};

async function rawRemote(target: string, rawPath: string, paneCwd: string | undefined, range: RangeSpec | 'multi', headers: Record<string, string>): Promise<Response> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', target, '--', remoteRawCommand(rawPath, paneCwd, range && range !== 'multi' ? range : null)], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stderr.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const line = text.split('\n')[0] ?? '';
  const fail = async (status: number, message: string, extra: Record<string, string> = {}): Promise<never> => {
    await new Response(child.stdout).arrayBuffer().catch(() => {});
    await child.exited;
    throw new FilesError(status, message, extra);
  };
  const size = /^SIZE (\d+) (\d+) (\d+)$/.exec(line);
  if (size) {
    const [, total, start, len] = size;
    return range && range !== 'multi'
      ? partial(headers, Number(start), Number(len), Number(total), child.stdout)
      : new Response(child.stdout, { status: 200, headers: { ...headers, 'accept-ranges': 'bytes', 'content-length': len } });
  }
  const refused = /^E(\d+)(?: (\d+))?$/.exec(line);
  const mapped = refused ? REFUSED[Number(refused[1])] : undefined;
  if (mapped) return fail(mapped.status, mapped.message, mapped.status === 416 && refused![2] ? { 'content-range': `bytes */${refused![2]}`, 'accept-ranges': 'bytes' } : {});
  return fail(502, 'remote');
}
