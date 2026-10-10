import { constants } from 'node:fs';
import { access, chmod, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
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

/** The CSP for every sandboxed HTML tautan serves — the Agent preview in http.ts and the
 *  raw file viewer alike: `sandbox` without allow-scripts or allow-same-origin, so scripts
 *  never run and the page cannot reach the Hub's origin even when opened directly. */
export const PREVIEW_CSP = "sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; media-src data: https:";

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

/** The containment preamble every remote file script shares: `~`/`~/x` name the remote
 *  $HOME (`\~` in the strip — a bare `~` never strips in sh), then the realpath must sit
 *  under $HOME or the Pane cwd. Exit codes, each with an `E<code>` line on stderr for the
 *  streaming raw route: 11 not found, 12 escape, 15 tools missing. */
function remoteContainment(rawPath: string, paneCwd?: string): string {
  return `command -v realpath >/dev/null 2>&1 || { echo E15 >&2; exit 15; }; home=$(realpath -- "$HOME") || { echo E15 >&2; exit 15; }; p=${quoteShell(rawPath)}; case "$p" in '~') p=$HOME;; '~'/*) p=$HOME\${p#\\~};; esac; [ -e "$p" ] || { echo E11 >&2; exit 11; }; rp=$(realpath -- "$p") 2>/dev/null || { echo E11 >&2; exit 11; }; ok=0; case "$rp" in "$home"|"$home"/*) ok=1;; esac; ${
    paneCwd ? `proot=$(realpath -- ${quoteShell(paneCwd)} 2>/dev/null) || proot=; if [ -n "$proot" ]; then case "$rp" in "$proot"|"$proot"/*) ok=1;; esac; fi;` : ''
  } [ "$ok" -eq 1 ] || { echo E12 >&2; exit 12; };`;
}

/** One ssh round trip: first stdout line is `realpath\thome[\tpane-root]`, every later line
 *  `d\t\t\tname` or `f\tsize\tmtime\tname`. Exit codes map like the read and save scripts:
 *  11 not found, 12 escape, 13 not a directory, 15 tools missing.
 *  ponytail: tab/newline inside a remote name misparses; emit NUL-delimited records if a
 *  real Host turns one up. */
export function remoteListCommand(rawPath: string, paneCwd?: string): string {
  return `${remoteContainment(rawPath, paneCwd)} [ -d "$rp" ] || exit 13; printf '%s\\t%s\\t%s\\n' "$rp" "$home" "\${proot:-}"; for f in "$rp"/* "$rp"/.[!.]* "$rp"/..?*; do [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'd\\t\\t\\t%s\\n' "\${f##*/}"; elif [ -f "$f" ]; then size=$(stat -c %s -- "$f" 2>/dev/null || stat -f %z -- "$f") || continue; mtime=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f") || continue; printf 'f\\t%s\\t%s\\t%s\\n' "$size" "$mtime" "\${f##*/}"; fi; done`;
}

async function listRemote(hostId: string, target: string, rawPath: string, paneCwd: string | undefined, q: string, hidden: boolean): Promise<FileListResult> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', target, '--', remoteListCommand(rawPath, paneCwd)], { stdout: 'pipe', stderr: 'pipe' });
  // A listing that never ends must not hang the caller (the saveRemote kill pattern).
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) throw new FilesError(504, 'timeout');
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
  } finally { clearTimeout(timer); }
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
// Never an active same-origin document: PREVIEW_CSP, the same sandbox the Agent preview uses.
const SANDBOXED = new Set(['html', 'htm', 'svg', 'xml', 'xhtml']);

function rawHeaders(path: string, download: boolean): Record<string, string> {
  const ext = extname(path).toLowerCase().slice(1);
  const headers: Record<string, string> = {
    'content-type': RAW_TYPES[ext] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/'/g, '%27')}`,
  };
  if (SANDBOXED.has(ext)) { headers['content-security-policy'] = PREVIEW_CSP; headers['referrer-policy'] = 'no-referrer'; }
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
export function remoteRawCommand(rawPath: string, paneCwd: string | undefined, range: RangeSpec): string {
  const r = range ? `START=${'suffix' in range ? '' : range.start}; END=${'suffix' in range || range.end === undefined ? '' : range.end}; SUFFIX=${'suffix' in range ? range.suffix : ''};` : '';
  return `${r ? `${r} ` : ''}${remoteContainment(rawPath, paneCwd)} [ -f "$rp" ] || { echo E13 >&2; exit 13; }; size=$(stat -c %s -- "$rp" 2>/dev/null || stat -f %z -- "$rp") || { echo E15 >&2; exit 15; }; if [ -n "$START$END$SUFFIX" ]; then if [ -n "$SUFFIX" ]; then if [ "$SUFFIX" -le 0 ] || [ "$size" -eq 0 ]; then echo "E16 $size" >&2; exit 16; fi; st=$(( size - SUFFIX )); [ "$st" -lt 0 ] && st=0; ln=$(( size - st )); else if [ "$START" -ge "$size" ]; then echo "E16 $size" >&2; exit 16; fi; en=\${END:-$(( size - 1 ))}; [ "$en" -ge "$size" ] && en=$(( size - 1 )); st=$START; ln=$(( en - st + 1 )); fi; echo "SIZE $size $st $ln" >&2; tail -c +$(( st + 1 )) -- "$rp" | head -c "$ln"; else echo "SIZE $size 0 $size" >&2; cat -- "$rp"; fi`;
}

// Exit codes the remote scripts report as `E<code>` on stderr before any body.
const REFUSED: Record<number, { status: number; message: string }> = {
  11: { status: 404, message: 'not found' },
  12: { status: 403, message: 'escape' },
  13: { status: 415, message: 'not a file' },
  14: { status: 413, message: 'too large' },
  15: { status: 502, message: 'remote' },
  16: { status: 416, message: 'range' },
  17: { status: 403, message: 'read-only' },
  18: { status: 502, message: 'cut' },
  19: { status: 412, message: 'changed' },
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

/** GET /api/panes/:key/file — one file's bytes and its version token (empty when a remote
 *  Host has no `cksum`, so the UI hides Edit). Roots: the Host's home plus the Pane cwd —
 *  the Folder view browses the whole home, so the read must too. */
export async function fileRead(rawPath: string, paneCwd: string, cap: number, target?: string): Promise<{ body: ArrayBuffer; version: string }> {
  return target ? readRemote(target, rawPath, paneCwd, cap) : readLocal(rawPath, paneCwd, cap);
}

/** PUT /api/panes/:key/file — overwrite one existing file through a same-folder temp file
 *  and a rename that keeps its mode; never creates. Answers the file's new version token. */
export async function fileSave(rawPath: string, paneCwd: string, body: Uint8Array, version: string, cap: number, target?: string): Promise<string> {
  return target ? saveRemote(target, rawPath, paneCwd, body, version, cap) : saveLocal(rawPath, paneCwd, body, version, cap);
}

/** A relative path names the Pane cwd; `~`/`~/x` and absolute paths pass through (the
 *  remote script expands `~` against its own $HOME, which is not the Hub's). */
const anchorFile = (rawPath: string, paneCwd: string) =>
  rawPath === '~' || rawPath.startsWith('~/') || isAbsolute(rawPath) ? rawPath : join(paneCwd, rawPath);

async function readLocal(rawPath: string, paneCwd: string, cap: number): Promise<{ body: ArrayBuffer; version: string }> {
  const { target } = await resolveLocal(anchorFile(rawPath, paneCwd), paneCwd);
  if (!(await stat(target)).isFile()) throw new FilesError(415, 'not a file');
  const body = await Bun.file(target).slice(0, cap + 1).arrayBuffer();
  if (body.byteLength > cap) throw new FilesError(413, 'too large');
  return { body, version: Bun.hash(new Uint8Array(body)).toString(36) };
}

/** The body is stdout, the version the last stderr line: `V<cksum|tr ' ' ->` (an empty V
 *  when the Host has no cksum). Both are buffered — the read is capped, so no deadlock. */
export function remoteReadCommand(rawPath: string, paneCwd: string | undefined, cap: number): string {
  return `${remoteContainment(rawPath, paneCwd)} [ -f "$rp" ] || exit 13; size=$(stat -c %s -- "$rp" 2>/dev/null || stat -f %z -- "$rp") || exit 15; case "$size" in ''|*[!0-9]*) exit 15;; esac; [ "$size" -le ${cap} ] || exit 14; if command -v cksum >/dev/null 2>&1; then v=$(cksum < "$rp" | tr ' ' -) || exit 15; else v=; fi; echo "V$v" >&2; head -c ${cap} -- "$rp" || exit 15;`;
}

async function readRemote(target: string, rawPath: string, paneCwd: string, cap: number): Promise<{ body: ArrayBuffer; version: string }> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', target, '--', remoteReadCommand(rawPath, paneCwd, cap)], { stdout: 'pipe', stderr: 'pipe' });
  // A read that never ends must not hang the caller (the saveRemote kill pattern).
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
  try {
    const [body, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) throw new FilesError(504, 'timeout');
    if (code) {
      const mapped = REFUSED[code];
      if (mapped) throw new FilesError(mapped.status, mapped.message);
      throw new FilesError(502, stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? 'ssh failed');
    }
    return { body, version: /^V(.*)$/.exec(stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? '')?.[1] ?? '' };
  } finally { clearTimeout(timer); }
}

async function saveLocal(rawPath: string, paneCwd: string, body: Uint8Array, version: string, cap: number): Promise<string> {
  const { target: file } = await resolveLocal(anchorFile(rawPath, paneCwd), paneCwd);
  const info = await stat(file);
  if (!info.isFile()) throw new FilesError(415, 'not a file');
  // The guard also bounds the whole-file read below — a multi-GB target would OOM the Hub.
  if (info.size > cap) throw new FilesError(413, 'too large');
  await access(file, constants.W_OK).catch(() => { throw new FilesError(403, 'read-only'); });
  const temp = join(dirname(file), `.tautan-${Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('')}`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.write(body); } finally { await handle.close(); }
    // ponytail: hash-compare-then-rename is no compare-and-swap — two concurrent saves with
    // the same version can both pass and both land, the last rename winning; an OS-level
    // atomic CAS (renameat2 RENAME_EXCHANGE on a lock file) is the upgrade path.
    const current = new Uint8Array(await Bun.file(file).arrayBuffer());
    if (Bun.hash(current).toString(36) !== version) throw new FilesError(412, 'changed');
    await chmod(temp, info.mode & 0o7777);
    await rename(temp, file);
    return Bun.hash(body).toString(36);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Containment, writability (17), the mode, a `mktemp` sibling removed by a trap, the
 *  length check against the bytes the Hub sent (18), the cap (14), the cksum compare
 *  against the version token (19), then chmod and `mv -f`; the new version is stdout. */
export function remoteSaveCommand(rawPath: string, paneCwd: string | undefined, cap: number, length: number, version: string): string {
  return `${remoteContainment(rawPath, paneCwd)} [ -f "$rp" ] || exit 13; [ -w "$rp" ] || exit 17; mode=$(stat -c %a -- "$rp" 2>/dev/null || stat -f %Lp -- "$rp") || exit 15; tmp=$(mktemp "\${rp%/*}/.tautan.XXXXXX") || exit 15; trap 'rm -f -- "$tmp"' EXIT; cat > "$tmp" || exit 18; len=$(wc -c < "$tmp" | tr -d ' '); [ "$len" -eq ${length} ] || exit 18; [ "$len" -le ${cap} ] || exit 14; command -v cksum >/dev/null 2>&1 || exit 15; cur=$(cksum < "$rp" | tr ' ' -) || exit 15; [ "$cur" = ${quoteShell(version)} ] || exit 19; chmod "$mode" "$tmp" || exit 15; mv -f -- "$tmp" "$rp" || exit 15; cksum < "$rp" | tr ' ' -`;
}

async function saveRemote(target: string, rawPath: string, paneCwd: string, body: Uint8Array, version: string, cap: number): Promise<string> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', target, '--', remoteSaveCommand(rawPath, paneCwd, cap, body.byteLength, version)], { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
  // A remote save that never ends must not hang the caller (the chat.ts kill pattern).
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
  try {
    const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    try { await child.stdin.write(body); await child.stdin.end(); } catch { /* the script may refuse before it drains stdin */ }
    const [stdout, stderr, code] = await done;
    if (timedOut) throw new FilesError(502, 'remote');
    if (code) {
      const mapped = REFUSED[code];
      if (mapped) throw new FilesError(mapped.status, mapped.message);
      throw new FilesError(502, stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? 'ssh failed');
    }
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
