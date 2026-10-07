import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DiffResult, DiffScope, HostConfig, InputBody, MouseBody, NewTabBody, NewWorkspaceBody, ProbeBody, PushSubscriptionBody, RenameBody, ScreenMode, SeenBody, SettingsBody, SuggestSettingBody } from '../shared/types.ts';
import { parseUnifiedDiff } from '../shared/diff.ts';
import { promptId } from '../shared/blocked.ts';
import { HerdrMux } from './herdr.ts';
import { discoverLocalMuxes, discoverRemote, hostId, startRemoteHost, syncHosts, validTarget, validateHosts, writeHostsConfig } from './hosts.ts';
import { mouseBytes, type Hub } from './mux.ts';
import { LeaseError, LeaseHolder } from './lease.ts';
import { ChatLens } from './chat.ts';
import { EmptyBody, sanitizeName, TooLarge, writeAttachment } from './attach.ts';

const json = (value: unknown, status = 200) => Response.json(value, { status });
const tautanVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const QUOTA_TTL = 5 * 60 * 1_000;
let quotaCache: { value: unknown; at: number } | undefined;
let quotaRequest: Promise<unknown> | undefined;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validLabel = (value: unknown, required = false) => value === undefined ? !required : typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80;
const validCwd = (value: unknown) => value === undefined || typeof value === 'string' && isAbsolute(value);
const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const quoteShell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
type GitResult = { stdout: string; stderr: string; code: number };

class FileRouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const maxFileBytes = () => {
  const value = Number(process.env.TAUTAN_MAX_FILE_MB);
  return Math.floor((Number.isFinite(value) && value > 0 ? value : 5) * 1024 * 1024);
};
const fileType = (path: string) => ({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8');
const fileHeaders = (path: string) => ({ 'content-type': fileType(path), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
const agentId = /^[A-Za-z0-9_-]{1,64}$/;
// A preview of HTML the Agent wrote: `sandbox` without allow-scripts or allow-same-origin, so
// scripts never run and the page cannot reach the Hub's origin even when opened directly.
const previewHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; media-src data: https:",
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, max-age=86400',
  'referrer-policy': 'no-referrer',
};
const inside = (root: string, path: string) => {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || !isAbsolute(pathFromRoot) && !pathFromRoot.startsWith('..');
};

async function localFile(cwd: string, path: string, cap: number): Promise<Response> {
  let root: string; let target: string;
  try { root = await realpath(cwd); } catch { throw new FileRouteError(404, 'not found'); }
  try { target = await realpath(path); } catch { throw new FileRouteError(404, 'not found'); }
  if (!inside(root, target)) throw new FileRouteError(403, 'escape');
  let info: Awaited<ReturnType<typeof stat>>;
  try { info = await stat(target); } catch { throw new FileRouteError(404, 'not found'); }
  // A directory has no file payload for the viewer.
  if (!info.isFile()) throw new FileRouteError(415, 'not a file');
  if (info.size > cap) throw new FileRouteError(413, 'too large');
  const body = await Bun.file(target).slice(0, cap + 1).arrayBuffer();
  if (body.byteLength > cap) throw new FileRouteError(413, 'too large');
  return new Response(body, { headers: fileHeaders(path) });
}

function remoteFileCommand(cwd: string, path: string, cap: number): string {
  return `command -v realpath >/dev/null 2>&1 && command -v stat >/dev/null 2>&1 && command -v head >/dev/null 2>&1 || exit 15; [ -d ${quoteShell(cwd)} ] || exit 10; [ -e ${quoteShell(path)} ] || exit 11; cwd=$(realpath -- ${quoteShell(cwd)}) || exit 10; file=$(realpath -- ${quoteShell(path)}) || exit 10; if [ "$cwd" != / ]; then case "$file" in "$cwd"|"$cwd"/*) ;; *) exit 12;; esac; fi; if [ -d "$file" ]; then exit 13; fi; [ -f "$file" ] || exit 13; size=$(stat -c %s -- "$file" 2>/dev/null || stat -f %z -- "$file") || exit 15; case "$size" in ''|*[!0-9]*) exit 15;; esac; [ "$size" -le ${cap} ] || exit 14; head -c ${cap} -- "$file" || exit 15`;
}

async function remoteFile(cwd: string, path: string, cap: number, target: string): Promise<Response> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', target, '--', remoteFileCommand(cwd, path, cap)], { stdout: 'pipe', stderr: 'pipe' });
  const [body, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code === 10 || code === 12) throw new FileRouteError(403, 'escape');
  if (code === 11) throw new FileRouteError(404, 'not found');
  if (code === 13) throw new FileRouteError(415, 'not a file');
  if (code === 14) throw new FileRouteError(413, 'too large');
  if (code === 15) throw new FileRouteError(502, 'remote');
  if (code) throw new Error(stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) || 'ssh failed');
  return new Response(body, { headers: fileHeaders(path) });
}

async function quotaReport(): Promise<unknown> {
  if (quotaCache && Date.now() - quotaCache.at < QUOTA_TTL) return quotaCache.value;
  if (!quotaRequest) quotaRequest = (async () => {
    const child = Bun.spawn(['quota-axi', '--json'], { stdout: 'pipe', stderr: 'ignore' });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code) throw new Error('unavailable');
    const value: unknown = JSON.parse(stdout);
    quotaCache = { value, at: Date.now() };
    return value;
  })().finally(() => { quotaRequest = undefined; });
  return quotaRequest;
}

async function runGit(cwd: string, args: string[], target?: string): Promise<GitResult> {
  const command = target
    ? ['ssh', '-o', 'BatchMode=yes', target, '--', `cd ${quoteShell(cwd)} && git ${args.map(quoteShell).join(' ')}`]
    : ['git', ...args];
  const child = Bun.spawn(command, { ...(target ? {} : { cwd }), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

async function resolveDiffBase(cwd: string, target?: string): Promise<string | undefined> {
  for (const args of [
    ['config', 'review.base'], ['rev-parse', '--abbrev-ref', '@{upstream}'],
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
  ]) {
    const result = await runGit(cwd, args, target);
    if (!result.code && result.stdout.trim()) return result.stdout.trim();
    if (/not a git repository/i.test(result.stderr)) throw new Error('not-a-repo');
  }
  for (const name of ['main', 'master', 'trunk']) {
    const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', name], target);
    if (!result.code) return name;
    if (/not a git repository/i.test(result.stderr)) throw new Error('not-a-repo');
  }
}

export function startHttp(hub: Hub, opts: {
  port: number; hostname: string; staticDir: string;
  discover?: typeof discoverLocalMuxes;
  discoverRemote?: (target: string, session?: string) => Promise<{ name: string; socketPath: string }[]>;
  configPath?: string;
  /** Test seam: the chat transcript lens the chat routes read; the Hub's own when absent. */
  chats?: ChatLens;
}): ReturnType<typeof Bun.serve> {
  const root = resolve(opts.staticDir);
  const retries = new Set<string>(); let probes = 0;
  const leases = new LeaseHolder(hub);
  const chats = opts.chats ?? new ChatLens(hub);
  hub.onClose?.(() => { void leases.releaseAll(); chats.close(); });
  return Bun.serve({
    port: opts.port, hostname: opts.hostname,
    // SSE streams idle between pings; adapter has its own 10 s RPC timeout
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // A Funnel publish puts the Hub on the public internet, and the forward carries a real
      // Origin, so the Origin check below cannot see it. Refuse before anything else.
      if (req.headers.has('Tailscale-Funnel-Request')) return json({ error: 'funnel' }, 403);
      if (hub.trustedUser && req.headers.get('tailscale-user-login') !== hub.trustedUser) return json({ error: 'login' }, 403);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.get('origin');
        try {
          if (!origin || new URL(origin).host !== req.headers.get('host')) return json({ error: 'origin' }, 403);
        } catch { return json({ error: 'origin' }, 403); }
      }
      try {
        if (req.method === 'GET' && url.pathname === '/api/state') return json(await hub.state());
        const workspaceClose = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/close$/);
        if (req.method === 'POST' && workspaceClose) {
          let key: string;
          try { key = decodeURIComponent(workspaceClose[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          const workspace = (await hub.state()).workspaces.find(item => item.key === key);
          if (!workspace) return json({ error: 'unknown-workspace' }, 404);
          await hub.closeWorkspace(workspace.muxKey, workspace.id);
          return new Response(null, { status: 204 });
        }
        const workspaceDiff = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/diff$/);
        if (req.method === 'GET' && workspaceDiff) {
          let key: string;
          try { key = decodeURIComponent(workspaceDiff[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          const scope = url.searchParams.get('scope');
          if (!['working', 'staged', 'base'].includes(scope ?? '')) return json({ error: 'scope' }, 400);
          const state = await hub.state(); const workspace = state.workspaces.find(item => item.key === key);
          if (!workspace) return json({ error: 'unknown-workspace' }, 404);
          if (!workspace.cwd) return json({ error: 'not-a-repo' }, 409);
          const host = state.hosts.find(item => item.id === workspace.muxKey.split('/')[0]);
          const diffScope = scope as DiffScope; let base: string | undefined;
          if (diffScope === 'base') {
            try { base = await resolveDiffBase(workspace.cwd, host?.target); }
            catch (error) { if (errorMessage(error) === 'not-a-repo') return json({ error: 'not-a-repo' }, 409); throw error; }
            if (!base) return json({ error: 'no-base' }, 502);
          }
          const args = ['diff', '--no-color', '-U3'];
          if (diffScope === 'staged') args.push('--staged');
          if (base) args.push(`${base}...HEAD`);
          const requestedFile = url.searchParams.get('file'); if (requestedFile !== null) args.push('--', requestedFile);
          const result = await runGit(workspace.cwd, args, host?.target);
          if (result.code) {
            if (/not a git repository/i.test(result.stderr)) return json({ error: 'not-a-repo' }, 409);
            return json({ error: result.stderr.split(/\r?\n/).find(Boolean) ?? `git exited ${result.code}` }, 502);
          }
          let raw = result.stdout, truncated = false;
          if (requestedFile === null && Buffer.byteLength(raw) > 64 * 1024) {
            truncated = true; raw = ''; let bytes = 0;
            for (const chunk of result.stdout.split(/(?=diff --git )/).filter(Boolean)) {
              const size = Buffer.byteLength(chunk); if (bytes + size > 64 * 1024) break;
              raw += chunk; bytes += size;
            }
          }
          const payload: DiffResult = { scope: diffScope, ...(base ? { base } : {}), files: parseUnifiedDiff(raw), truncated };
          return json(payload);
        }
        const muxWrite = url.pathname.match(/^\/api\/muxes\/([^/]+)\/(tabs|workspaces)$/);
        if (req.method === 'POST' && muxWrite) {
          let key: string;
          try { key = decodeURIComponent(muxWrite[1]!); } catch { return json({ error: 'body' }, 400); }
          let body: unknown;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (!plainObject(body)) return json({ error: 'body' }, 400);
          if (typeof body.label === 'string') body.label = body.label.trim();
          if (muxWrite[2] === 'tabs') {
            if (!nonEmpty(body.workspaceId) || !validCwd(body.cwd) || !validLabel(body.label) || body.agent !== undefined && !nonEmpty(body.agent)) return json({ error: 'body' }, 400);
            return json(await hub.newTab(key, body as unknown as NewTabBody), 201);
          }
          if (!validCwd(body.cwd) || !validLabel(body.label) || body.branch !== undefined && !nonEmpty(body.branch)) return json({ error: 'body' }, 400);
          return json(await hub.newWorkspace(key, body as NewWorkspaceBody), 201);
        }
        if (req.method === 'POST' && url.pathname === '/api/rename') {
          let body: unknown;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (!plainObject(body)) return json({ error: 'body' }, 400);
          if (typeof body.label === 'string') body.label = body.label.trim();
          const targetKeys = ['workspaceId', 'tabId', 'paneId'].filter(key => Object.hasOwn(body, key));
          if (!nonEmpty(body.muxKey) || !validLabel(body.label, true) || targetKeys.length !== 1 || !nonEmpty(body[targetKeys[0]!])) return json({ error: 'body' }, 400);
          await hub.rename(body as unknown as RenameBody); return new Response(null, { status: 204 });
        }
        if (req.method === 'GET' && url.pathname === '/api/settings/quota') {
          try { return json(await quotaReport()); }
          catch { return json({ error: 'unavailable' }, 503); }
        }
        if (req.method === 'GET' && url.pathname === '/api/settings') return json({
          ...hub.settings(), login: req.headers.get('tailscale-user-login') ?? undefined,
          version: { tautan: tautanVersion, herdr: await hub.herdrVersions() },
        });
        if (req.method === 'PUT' && url.pathname === '/api/settings') {
          let body: SettingsBody;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (!plainObject(body)) return json({ error: 'body' }, 400);
          if (body.trustedUser !== undefined && body.trustedUser !== null && typeof body.trustedUser !== 'string') return json({ error: 'login' }, 400);
          const trusted = typeof body.trustedUser === 'string' ? body.trustedUser.trim() : body.trustedUser;
          if (trusted && req.headers.get('tailscale-user-login') !== trusted) return json({ error: 'login' }, 400);
          if (body.hosts !== undefined) {
            if (validateHosts(body.hosts)) return json({ error: 'hosts' }, 400);
            await writeHostsConfig(body.hosts as HostConfig[], opts.configPath);
          }
          if (body.trustedUser !== undefined) hub.setTrustedUser(trusted || undefined);
          if (body.hosts !== undefined) void syncHosts(hub, { configPath: opts.configPath, discover: opts.discoverRemote });
          return json(hub.settings());
        }
        if (req.method === 'POST' && url.pathname === '/api/settings/suggest') {
          let body: SuggestSettingBody;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (typeof body?.enabled !== 'boolean') return json({ error: 'body' }, 400);
          hub.setSuggestEnabled(body.enabled); return json(hub.settings());
        }
        if (req.method === 'GET' && url.pathname === '/api/push/vapid') return json({ publicKey: hub.vapidPublicKey() });
        if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
          let body: PushSubscriptionBody;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          let validEndpoint = false;
          try { validEndpoint = ['http:', 'https:'].includes(new URL(body?.endpoint).protocol); } catch {}
          if (!validEndpoint || typeof body?.keys?.p256dh !== 'string' || !body.keys.p256dh || typeof body.keys.auth !== 'string' || !body.keys.auth ||
            body.expirationTime !== undefined && body.expirationTime !== null && typeof body.expirationTime !== 'number')
            return json({ error: 'body' }, 400);
          hub.addSubscription(body); return new Response(null, { status: 204 });
        }
        if (req.method === 'DELETE' && url.pathname === '/api/push/subscribe') {
          let body: { endpoint?: unknown };
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (typeof body?.endpoint !== 'string' || !body.endpoint) return json({ error: 'body' }, 400);
          hub.removeSubscription(body.endpoint); return new Response(null, { status: 204 });
        }
        const hostRetry = url.pathname.match(/^\/api\/hosts\/([^/]+)\/retry$/);
        if (req.method === 'POST' && hostRetry) {
          let id: string;
          try { id = decodeURIComponent(hostRetry[1]!); } catch { return json({ error: 'bad host id' }, 400); }
          const known = hub.host?.(id) ?? (await hub.state()).hosts.find(host => host.id === id);
          if (!known) return json({ error: 'host not found' }, 404);
          if (id === hostId) {
            for (const item of await (opts.discover ?? discoverLocalMuxes)()) if (!hub.hasMux(id, item.id)) hub.add(id, new HerdrMux(item.id, item.socketPath));
            await hub.refreshHost(id);
          } else if (known.target) {
            if (retries.has(id)) return json(known);
            retries.add(id);
            try {
              if (opts.discoverRemote) {
                try { const found = await opts.discoverRemote(known.target); hub.setHost({ ...known, online: found.length > 0, error: found.length ? undefined : 'no running Muxes' }); }
                catch (error) { hub.setHost({ ...known, online: false, error: errorMessage(error) }); }
              } else await startRemoteHost(hub, known);
            } finally { retries.delete(id); }
          }
          const host = (await hub.state()).hosts.find(host => host.id === id);
          return host ? json(host) : json({ error: 'host not found' }, 404);
        }
        if (req.method === 'POST' && url.pathname === '/api/hosts/probe') {
          let body: ProbeBody;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (!validTarget(body?.target) || body.session !== undefined && !nonEmpty(body.session)) return json({ error: 'target' }, 400);
          if (probes >= 4) return json({ error: 'busy' }, 429);
          probes++;
          try {
            const found = await (opts.discoverRemote ?? discoverRemote)(body.target, body.session);
            return json({ online: true, sessions: found.map(item => item.name) });
          } catch (error) { return json({ online: false, error: errorMessage(error).split(/\r?\n/).filter(Boolean).at(-1) }); }
          finally { probes--; }
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          // ADR 0006: `pane` repeats, up to 4 watched Panes on one stream (a desktop split),
          // de-duplicated. Unresolved keys drop; all of them unresolved keeps the old 404.
          const asked = [...new Set(url.searchParams.getAll('pane'))];
          if (asked.length > 4) return json({ error: 'too-many-panes' }, 400);
          const paneKeys: string[] = [];
          for (const paneKey of asked) if (await hub.hasPane(paneKey)) paneKeys.push(paneKey);
          if (asked.length && !paneKeys.length) return json({ error: 'pane not found' }, 404);
          const mode: ScreenMode = url.searchParams.get('mode') === 'recent' ? 'recent' : 'visible';
          // The stream announces its own id in the first event (`hello`, `{stream: id}`); a
          // client sends that id back as the lease POST's `stream` field, so the lease dies
          // with this stream (ADR 0006).
          const streamId = crypto.randomUUID();
          const encoder = new TextEncoder(); let cleanup = () => {};
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              let closed = false;
              // A dead client shows up as an enqueue throw, not as an abort: on Bun the
              // request signal aborts as soon as the streaming response is returned, so it
              // can never be the disconnect signal (every stream unsubscribed at once —
              // the client got the initial state and nothing after it).
              const send = (event: string, value: unknown) => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)); }
                catch { cleanup(); }
              };
              send('hello', { stream: streamId });
              send('state', await hub.state());
              const unsubscribe = hub.subscribe({ paneKeys: paneKeys.length ? paneKeys : undefined, mode, stream: streamId, onState: state => send('state', state), onScreen: screen => send('screen', screen) });
              const ping = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { cleanup(); } }  }, 25_000);
              cleanup = () => { if (closed) return; closed = true; unsubscribe(); clearInterval(ping); try { controller.close(); } catch {} };
            },
            cancel() { cleanup(); },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }
        const chatMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/chat$/);
        if (req.method === 'GET' && chatMatch) {
          let key: string;
          try { key = decodeURIComponent(chatMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          if (!await hub.hasPane(key)) return json({ error: 'pane not found' }, 404);
          if (hub.resolvePane(key)?.entry.mux.kind !== 'herdr') return json({ error: 'unsupported' }, 501);
          const agent = url.searchParams.get('agent') ?? undefined;
          if (agent !== undefined && !agentId.test(agent)) return json({ error: 'no-agent' }, 404);
          if (agent !== undefined) {
            const list = await chats.subagentList(key);
            if (list && !list.some(item => item.id === agent)) return json({ error: 'no-agent' }, 404);
          }
          const found = await chats.tagged(key, agent);
          if (!found) return json({ error: 'no-session' }, 404);
          // The Chat view polls with If-None-Match; an unchanged transcript costs a stat and a 304.
          const headers = { etag: found.etag, 'cache-control': 'no-cache' };
          const fresh = req.headers.get('if-none-match')?.split(',').some(tag => tag.trim().replace(/^W\//, '') === found.etag);
          return fresh ? new Response(null, { status: 304, headers }) : Response.json(found.chat, { headers });
        }
        const chatImageMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/chat\/image\/([^/]+)$/);
        if (req.method === 'GET' && chatImageMatch) {
          let key: string;
          try { key = decodeURIComponent(chatImageMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          if (!/^\d+$/.test(chatImageMatch[2]!)) return json({ error: 'id' }, 400);
          if (!await hub.hasPane(key)) return json({ error: 'no-session' }, 404);
          const agent = url.searchParams.get('agent') ?? undefined;
          if (agent !== undefined && (!agentId.test(agent) || !(await chats.subagentList(key))?.some(item => item.id === agent))) return json({ error: 'no-agent' }, 404);
          const found = await chats.image(key, Number(chatImageMatch[2]!), agent);
          if (!found) return json({ error: 'no-session' }, 404);
          if (!found.image) return json({ error: 'no-image' }, 404);
          return new Response(found.image.bytes, { headers: { 'content-type': found.image.mediaType, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
        }
        const chatPreviewMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/chat\/preview\/([^/]+)$/);
        if (req.method === 'GET' && chatPreviewMatch) {
          let key: string;
          try { key = decodeURIComponent(chatPreviewMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          if (!/^\d+$/.test(chatPreviewMatch[2]!)) return json({ error: 'id' }, 400);
          if (!await hub.hasPane(key)) return json({ error: 'no-session' }, 404);
          const agent = url.searchParams.get('agent') ?? undefined;
          if (agent !== undefined && (!agentId.test(agent) || !(await chats.subagentList(key))?.some(item => item.id === agent))) return json({ error: 'no-agent' }, 404);
          const found = await chats.preview(key, Number(chatPreviewMatch[2]!), agent);
          if (!found) return json({ error: 'no-session' }, 404);
          if (found.html === undefined) return json({ error: 'no-preview' }, 404);
          return new Response(found.html, { headers: previewHeaders });
        }
        const fileMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/file$/);
        if (req.method === 'GET' && fileMatch) {
          let key: string;
          try { key = decodeURIComponent(fileMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          const path = url.searchParams.get('path');
          if (!path) return json({ error: 'path' }, 400);
          const pane = (await hub.state()).panes.find(item => item.key === key);
          if (!pane) return json({ error: 'pane not found' }, 404);
          if (!pane.cwd) return json({ error: 'cwd' }, 409);
          const candidate = resolve(pane.cwd, path); const host = hub.host(await hub.paneHost(key));
          return host?.target
            ? await remoteFile(pane.cwd, candidate, maxFileBytes(), host.target)
            : await localFile(pane.cwd, candidate, maxFileBytes());
        }
        const leaseMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/lease$/);
        if (req.method === 'POST' && leaseMatch) {
          let key: string;
          try { key = decodeURIComponent(leaseMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          if (!await hub.hasPane(key)) return json({ error: 'pane not found' }, 404);
          let body: { cols?: unknown; rows?: unknown; takeover?: unknown; stream?: unknown };
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          const cols = Number(body.cols); const rows = Number(body.rows);
          if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 500 || rows < 4 || rows > 200)
            return json({ error: 'geometry' }, 400);
          // `stream` names the owning SSE stream — the id its first `hello` event announced
          // (ADR 0006): the lease releases when that stream ends. Absent → the old rule.
          if (body.stream !== undefined && (typeof body.stream !== 'string' || !body.stream)) return json({ error: 'body' }, 400);
          try {
            await leases.acquire(key, { cols, rows, takeover: body.takeover === true, owner: typeof body.stream === 'string' ? body.stream : undefined });
            return new Response(null, { status: 204 });
          } catch (error) {
            if (error instanceof LeaseError) {
              const status = { 'slot-held': 409, 'not-herdr': 501, 'not-found': 404, 'lease-failed': 502 }[error.code]!;
              return json({ error: error.code }, status);
            }
            throw error;
          }
        }
        if (req.method === 'DELETE' && leaseMatch) {
          let key: string;
          try { key = decodeURIComponent(leaseMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          await leases.release(key);
          return new Response(null, { status: 204 });
        }
        const mouseMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/mouse$/);
        if (req.method === 'POST' && mouseMatch) {
          let body: MouseBody;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          const coordinate = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 9999;
          if (!plainObject(body) || !['click', 'right', 'double', 'wheelUp', 'wheelDown'].includes(body.kind) || !coordinate(body.col) || !coordinate(body.row))
            return json({ error: 'body' }, 400);
          if (body.allow !== true) return json({ error: 'mouse-off' }, 409);
          let key: string;
          try { key = decodeURIComponent(mouseMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          await hub.input(key, { raw: mouseBytes(body) }); return new Response(null, { status: 204 });
        }
        const match = url.pathname.match(/^\/api\/panes\/([^/]+)\/(screen|input|seen|explain|attach|suggest|close|zoom)$/);
        if (match) {
          let key: string;
          try { key = decodeURIComponent(match[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          if (!await hub.hasPane(key)) return json({ error: 'pane not found' }, 404);
          const action = match[2];
          if (req.method === 'POST' && action === 'close') { await hub.closePane(key); return new Response(null, { status: 204 }); }
          if (req.method === 'POST' && action === 'zoom') {
            let body: unknown;
            try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
            if (!plainObject(body) || typeof body.zoomed !== 'boolean') return json({ error: 'body' }, 400);
            await hub.zoomPane(key, body.zoomed); return new Response(null, { status: 204 });
          }
          if (req.method === 'POST' && action === 'suggest') return json(await hub.forceSuggest(key));
          if (req.method === 'POST' && action === 'attach') {
            if (!req.body) return json({ error: 'body' }, 400);
            const cap = (Number(process.env.TAUTAN_MAX_ATTACHMENT_MB) || 200) * 1024 * 1024;
            const lengthHeader = req.headers.get('content-length');
            const length = Number(lengthHeader);
            if (length > cap) return json({ error: 'too large' }, 413);
            try {
              let received = 0;
              const body = lengthHeader === null ? req.body : req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) { received += chunk.byteLength; controller.enqueue(chunk); },
                flush() { if (received < length) throw new Error('attachment aborted'); },
              }));
              const paneHost = await hub.paneHost(key);
              return json(await writeAttachment(paneHost, sanitizeName(req.headers.get('x-name')), body, cap, hub.host(paneHost)?.target));
            } catch (error) {
              if (error instanceof TooLarge) return json({ error: 'too large' }, 413);
              if (error instanceof EmptyBody) return json({ error: 'body' }, 400);
              throw error;
            }
          }
          if (req.method === 'GET' && action === 'screen') {
            const mode: ScreenMode = url.searchParams.get('mode') === 'recent' ? 'recent' : 'visible';
            return json(await hub.read(key, mode));
          }
          if (req.method === 'GET' && action === 'explain') {
            const explain = await hub.explain(key);
            if (!explain) return json(null);
            return json({ ...explain, promptId: await promptId(explain, await hub.read(key, 'visible')) });
          }
          if (req.method === 'POST' && action === 'input') {
            let body: InputBody;
            try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
            if (typeof body !== 'object' || body === null || Array.isArray(body) || body.text !== undefined && typeof body.text !== 'string' ||
              body.keys !== undefined && (!Array.isArray(body.keys) || body.keys.some(key => typeof key !== 'string')) ||
              body.raw !== undefined && typeof body.raw !== 'string' ||
              body.promptId !== undefined && typeof body.promptId !== 'string') return json({ error: 'body' }, 400);
            // The card draws from one prompt; an id it carried must still name the prompt on
            // screen, or the answer lands in whatever moved on. No id: the key bar and the
            // quick replies, unchanged.
            if (body.promptId !== undefined) {
              const explain = await hub.explain(key);
              const id = explain ? await promptId(explain, await hub.read(key, 'visible')) : undefined;
              if (id !== body.promptId) return json({ error: 'prompt_changed' }, 409);
            }
            await hub.input(key, body); return new Response(null, { status: 204 });
          }
          if (req.method === 'POST' && action === 'seen') {
            let body: SeenBody;
            try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
            if (typeof body?.revision !== 'number' || !Number.isFinite(body.revision)) return json({ error: 'body' }, 400);
            hub.markSeen(key, body.revision); return new Response(null, { status: 204 });
          }
        }
        if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
        if (!['GET', 'HEAD'].includes(req.method)) return json({ error: 'not found' }, 404);

        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        let path = resolve(root, relative);
        if (path !== root && !path.startsWith(`${root}${sep}`)) return json({ error: 'not found' }, 404);
        let file = Bun.file(path);
        if (!await file.exists()) { path = resolve(root, 'index.html'); file = Bun.file(path); }
        if (!await file.exists()) return new Response('tautan web build not found; run pnpm build\n', { status: 404 });
        const headers = new Headers();
        if (path.endsWith('/index.html') || path.endsWith('/sw.js') || path.endsWith('/manifest.webmanifest')) headers.set('cache-control', 'no-cache');
        if (file.type) headers.set('content-type', file.type);
        return new Response(req.method === 'HEAD' ? null : file, { headers });
      } catch (error) {
        if (error instanceof FileRouteError) return json({ error: error.message }, error.status);
        const message = errorMessage(error);
        if (message === 'pane not found' || message === 'mux not found' || message === 'workspace not found' || message === 'tab not found') return json({ error: message }, 404);
        if (message === 'unsupported') return json({ error: message }, 501);
        return json({ error: message.split(': ')[0] || message }, 502);
      }
    },
  });
}
