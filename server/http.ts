import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import type { BranchList, DiffResult, DiffScope, HostConfig, InputBody, MouseBody, MoveBody, NewTabBody, NewWorkspaceBody, ProbeBody, PushSubscriptionBody, RenameBody, ScreenMode, SeenBody, SettingsBody, SplitBody, SuggestSettingBody, SwitchBody, Worktree, WorktreeRemoveBody, WorktreeRemoveResult, WorktreeStatus } from '../shared/types.ts';
import { CHAT_PAGE_TURNS, type ChatEvent } from '../shared/chat.ts';
import { parseUnifiedDiff } from '../shared/diff.ts';
import { promptId } from '../shared/blocked.ts';
import { HerdrMux } from './herdr.ts';
import { discoverLocalMuxes, discoverRemote, hostId, parseTailnet, startRemoteHost, syncHosts, validTarget, validateHosts, writeHostsConfig } from './hosts.ts';
import { mouseBytes, type Hub } from './mux.ts';
import { LeaseError, LeaseHolder } from './lease.ts';
import { ChatLens } from './chat.ts';
import { EmptyBody, sanitizeName, TooLarge, writeAttachment } from './attach.ts';
import { CompleteError, paneCompletion } from './complete.ts';
import { fileList, fileRaw, fileRead, fileSave, FilesError, PREVIEW_CSP, quoteShell } from './files.ts';
import { searchHistory } from './history.ts';

/** The Agents whose transcripts the ChatLens parses. */
const CHAT_AGENTS = new Set(['claude', 'pi', 'omp', 'codex']);

const json = (value: unknown, status = 200) => Response.json(value, { status });
/** Chat bodies over 8 KB go out gzipped when the client accepts it; small ones stay plain. */
const zipped = (req: Request, body: string, headers: Record<string, string>) => {
  if (body.length <= 8192 || !req.headers.get('accept-encoding')?.includes('gzip')) return new Response(body, { headers });
  return new Response(Bun.gzipSync(body), { headers: { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' } });
};
const jsonHeaders = { 'content-type': 'application/json;charset=utf-8' };
const tautanVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const QUOTA_TTL = 5 * 60 * 1_000;
let quotaCache: { value: unknown; at: number } | undefined;
let quotaRequest: Promise<unknown> | undefined;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validLabel = (value: unknown, required = false) => value === undefined ? !required : typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80;
const validCwd = (value: unknown) => value === undefined || typeof value === 'string' && isAbsolute(value);
const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
/** ADR 0009 move bodies: `index` is a non-negative integer splice index; anything else is a 400. */
const moveIndex = async (req: Request): Promise<number | Response> => {
  let body: { index?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
  if (!plainObject(body) || !Number.isInteger(body.index) || (body.index as number) < 0) return json({ error: 'body' }, 400);
  return body.index as number;
};
type GitResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };

const maxFileBytes = () => {
  const value = Number(process.env.TAUTAN_MAX_FILE_MB);
  return Math.floor((Number.isFinite(value) && value > 0 ? value : 5) * 1024 * 1024);
};
const fileType = (path: string) => ({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8');
const fileHeaders = (path: string) => ({ 'content-type': fileType(path), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
const agentId = /^[A-Za-z0-9_-]{1,64}$/;
/** A native id on a chat route (a tool id, or the amendment's `after`/`before` Turn id): a
 *  strict allow-list; it is only a map key and never names a path. */
const nativeId = /^[A-Za-z0-9_|.:-]{1,256}$/;
// A preview of HTML the Agent wrote: PREVIEW_CSP, the same sandbox the raw file viewer uses.
const previewHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PREVIEW_CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, max-age=86400',
  'referrer-policy': 'no-referrer',
};

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

/** The spawn+kill core git and gh share. A call that never ends (an editor waiting on a
 *  tty) must not hang the caller — the chat.ts kill pattern; the flag tells a kill from an exit. */
async function runSpawn(argv: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<GitResult> {
  const child = Bun.spawn(argv, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    stdout: 'pipe', stderr: 'pipe',
  });
  let timedOut = false;
  const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, ...(timedOut ? { timedOut: true } : {}) };
  } finally { if (timer) clearTimeout(timer); }
}

async function runGit(cwd: string, args: string[], target?: string, timeoutMs?: number, env?: Record<string, string>): Promise<GitResult> {
  // Over ssh the env vars prefix the remote command, so GIT_TERMINAL_PROMPT holds there too.
  const prefix = env ? `${Object.entries(env).map(([name, value]) => `${name}=${quoteShell(value)}`).join(' ')} ` : '';
  return target
    ? runSpawn(['ssh', '-o', 'BatchMode=yes', target, '--', `${prefix}cd ${quoteShell(cwd)} && git ${args.map(quoteShell).join(' ')}`], { timeoutMs })
    : runSpawn(['git', ...args], { cwd, timeoutMs, env });
}

/** The branch's pull request, when `gh` runs on the Host and finds one. Any failure —
 *  gh absent, not a GitHub checkout, a timeout — means no pr, never an error. */
async function ghPr(cwd: string, branch: string, target?: string): Promise<WorktreeStatus['pr'] | undefined> {
  try {
    const result = target
      ? await runSpawn(['ssh', '-o', 'BatchMode=yes', target, '--', `cd ${quoteShell(cwd)} && gh pr view ${quoteShell(branch)} --json number,url,state`], { timeoutMs: 10_000 })
      : await runSpawn(['gh', 'pr', 'view', branch, '--json', 'number,url,state'], { cwd, timeoutMs: 10_000 });
    if (result.code || result.timedOut) return undefined;
    const pr = JSON.parse(result.stdout) as { number?: unknown; url?: unknown; state?: unknown };
    if (typeof pr.number !== 'number' || typeof pr.url !== 'string' || !['OPEN', 'MERGED', 'CLOSED'].includes(pr.state as string)) return undefined;
    return { number: pr.number, url: pr.url, state: pr.state as 'OPEN' | 'MERGED' | 'CLOSED' };
  } catch { return undefined; }
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

/** The Workspace's repo cwd and its Host's ssh target, shared by the diff and branch routes.
 *  The cwd comes from the Mux, never from the request. */
async function workspaceRepo(hub: Hub, key: string): Promise<{ cwd: string; target?: string } | { missing: 'unknown-workspace' | 'not-a-repo' }> {
  const state = await hub.state();
  const workspace = state.workspaces.find(item => item.key === key);
  if (!workspace) return { missing: 'unknown-workspace' };
  if (!workspace.cwd) return { missing: 'not-a-repo' };
  return { cwd: workspace.cwd, target: state.hosts.find(item => item.id === workspace.muxKey.split('/')[0])?.target };
}

/** `git worktree list --porcelain`: blank-line-separated records of `worktree <path>`,
 *  `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `bare` (skipped — no checkout),
 *  `locked [reason]` and `prunable [reason]`. `about` names the checkout the request is
 *  about, so `current` marks it. */
export function parseWorktrees(porcelain: string, about: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const block of porcelain.split('\n\n')) {
    let path = ''; let head = ''; let branch: string | null = null;
    let bare = false; let locked = false; let prunable = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice(9);
      else if (line.startsWith('HEAD ')) head = line.slice(5);
      else if (line.startsWith('branch ')) branch = line.slice('branch refs/heads/'.length);
      else if (line === 'detached') branch = null;
      else if (line === 'bare') bare = true;
      else if (line === 'locked' || line.startsWith('locked ')) locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
    }
    if (bare || !path || !head) continue;
    worktrees.push({ path, branch, head, current: path === about, ...(locked ? { locked: true } : {}), ...(prunable ? { prunable: true } : {}) });
  }
  return worktrees;
}

/** The branch list: the checked-out branch (null when detached), every local branch newest
 *  first, and every worktree. `git rev-parse --show-toplevel` from the cwd the git calls run
 *  in marks `current` — with a `worktree=` the commands run there, so its toplevel is itself. */
async function branchList(cwd: string, target?: string): Promise<BranchList> {
  const [head, refs, worktrees, toplevel] = await Promise.all([
    runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], target, 30_000),
    runGit(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/'], target, 30_000),
    runGit(cwd, ['worktree', 'list', '--porcelain'], target, 30_000),
    runGit(cwd, ['rev-parse', '--show-toplevel'], target, 30_000),
  ]);
  // `symbolic-ref` is EXPECTED to fail on a detached HEAD; only the other two must succeed.
  for (const result of [refs, worktrees, toplevel]) {
    if (result.timedOut) throw new Error('timeout');
    if (/not a git repository/i.test(result.stderr)) throw new Error('not-a-repo');
    if (result.code) throw new Error(result.stderr.split(/\r?\n/).find(Boolean) ?? `git exited ${result.code}`);
  }
  return {
    current: head.code ? null : head.stdout.trim() || null,
    branches: refs.stdout.split('\n').filter(Boolean),
    worktrees: parseWorktrees(worktrees.stdout, toplevel.code ? cwd : toplevel.stdout.trim()),
  };
}

/** Resolve `worktree=` for the diff and branches routes: it must exactly equal a `path` from
 *  this repository's own `git worktree list` (run in the Workspace cwd); anything else is a
 *  404. Returns the repo scope the git calls then run in. */
async function checkoutParam(hub: Hub, key: string, asked: string | null): Promise<{ cwd: string; target?: string } | Response> {
  const repo = await workspaceRepo(hub, key);
  if ('missing' in repo) return json({ error: repo.missing }, repo.missing === 'unknown-workspace' ? 404 : 409);
  if (asked === null) return repo;
  const list = await runGit(repo.cwd, ['worktree', 'list', '--porcelain'], repo.target, 30_000);
  if (list.timedOut) return json({ error: 'timeout' }, 504);
  if (/not a git repository/i.test(list.stderr)) return json({ error: 'not-a-repo' }, 409);
  if (list.code) return json({ error: list.stderr.split(/\r?\n/).find(Boolean) ?? `git exited ${list.code}` }, 502);
  const checkout = parseWorktrees(list.stdout, '').find(worktree => worktree.path === asked)?.path;
  if (!checkout) return json({ error: 'worktree' }, 404);
  return { cwd: checkout, target: repo.target };
}

/** The linked-worktree scope the worktree routes run in: the Mux's own tree sets `worktree`
 *  (only a herdr linked worktree carries it), never the request. */
async function linkedWorktree(hub: Hub, key: string): Promise<
  { cwd: string; root: string; target?: string; muxKey: string; workspaceId: string } | { missing: 'unknown-workspace' | 'not-linked' | 'unsupported' }
> {
  const state = await hub.state();
  const workspace = state.workspaces.find(item => item.key === key);
  if (!workspace) return { missing: 'unknown-workspace' };
  if (state.muxes.find(item => item.key === workspace.muxKey)?.kind !== 'herdr') return { missing: 'unsupported' };
  if (!workspace.worktree) return { missing: 'not-linked' };
  return {
    cwd: workspace.worktree.path, root: workspace.worktree.root,
    target: state.hosts.find(item => item.id === workspace.muxKey.split('/')[0])?.target,
    muxKey: workspace.muxKey, workspaceId: workspace.id,
  };
}

const worktreeMissing = { 'unknown-workspace': 404, 'not-linked': 409, 'unsupported': 501 } as const;

export function startHttp(hub: Hub, opts: {
  port: number; hostname: string; staticDir: string;
  discover?: typeof discoverLocalMuxes;
  discoverRemote?: (target: string, session?: string) => Promise<{ name: string; socketPath: string }[]>;
  configPath?: string;
  /** Test seam: the chat transcript lens the chat routes read; the Hub's own when absent. */
  chats?: ChatLens;
  /** Test seam: the `tailscale` binary GET /api/tailnet runs; `tailscale` on PATH when absent. */
  tailscale?: string;
}): ReturnType<typeof Bun.serve> {
  const root = resolve(opts.staticDir);
  const retries = new Set<string>(); let probes = 0;
  const leases = new LeaseHolder(hub);
  // ADR 0007: a `chat` wake-up goes to every event stream that watches the moved Pane.
  const chatWatchers = new Set<{ panes: Set<string>; send: (value: ChatEvent) => void }>();
  const chats = opts.chats ?? new ChatLens(hub);
  chats.onChat = event => { for (const watch of chatWatchers) if (watch.panes.has(event.pane)) watch.send(event); };
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
        // ADR 0009 order writes: `index` is the pre-move splice index, passed to the Mux
        // unchanged (final position: index moving up, index − 1 moving down, count appends).
        const workspaceMove = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/move$/);
        if (req.method === 'POST' && workspaceMove) {
          let key: string;
          try { key = decodeURIComponent(workspaceMove[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          const index = await moveIndex(req);
          if (index instanceof Response) return index;
          const workspace = (await hub.state()).workspaces.find(item => item.key === key);
          if (!workspace) return json({ error: 'unknown-workspace' }, 404);
          await hub.moveWorkspace(workspace.muxKey, workspace.id, index);
          return new Response(null, { status: 204 });
        }
        const tabMove = url.pathname.match(/^\/api\/tabs\/([^/]+)\/move$/);
        if (req.method === 'POST' && tabMove) {
          let key: string;
          try { key = decodeURIComponent(tabMove[1]!); } catch { return json({ error: 'unknown-tab' }, 404); }
          const index = await moveIndex(req);
          if (index instanceof Response) return index;
          const tab = (await hub.state()).tabs.find(item => item.key === key);
          if (!tab) return json({ error: 'unknown-tab' }, 404);
          await hub.moveTab(tab.muxKey, tab.id, index);
          return new Response(null, { status: 204 });
        }
        const workspaceDiff = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/diff$/);
        if (req.method === 'GET' && workspaceDiff) {
          let key: string;
          try { key = decodeURIComponent(workspaceDiff[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          const scope = url.searchParams.get('scope');
          if (!['working', 'staged', 'base'].includes(scope ?? '')) return json({ error: 'scope' }, 400);
          const repo = await checkoutParam(hub, key, url.searchParams.get('worktree'));
          if (repo instanceof Response) return repo;
          const diffScope = scope as DiffScope; let base: string | undefined;
          if (diffScope === 'base') {
            try { base = await resolveDiffBase(repo.cwd, repo.target); }
            catch (error) { if (errorMessage(error) === 'not-a-repo') return json({ error: 'not-a-repo' }, 409); throw error; }
            if (!base) return json({ error: 'no-base' }, 502);
          }
          const args = ['diff', '--no-color', '-U3'];
          if (diffScope === 'staged') args.push('--staged');
          if (base) args.push(`${base}...HEAD`);
          const requestedFile = url.searchParams.get('file'); if (requestedFile !== null) args.push('--', requestedFile);
          const result = await runGit(repo.cwd, args, repo.target);
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
        const workspaceBranches = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/branches$/);
        if (req.method === 'GET' && workspaceBranches) {
          let key: string;
          try { key = decodeURIComponent(workspaceBranches[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          const repo = await checkoutParam(hub, key, url.searchParams.get('worktree'));
          if (repo instanceof Response) return repo;
          try { return json(await branchList(repo.cwd, repo.target)); }
          catch (error) {
            const message = errorMessage(error);
            if (message === 'timeout') return json({ error: 'timeout' }, 504);
            if (message === 'not-a-repo') return json({ error: 'not-a-repo' }, 409);
            return json({ error: message.slice(0, 1000) }, 502);
          }
        }
        const workspaceWorktree = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/worktree$/);
        if (req.method === 'GET' && workspaceWorktree) {
          let key: string;
          try { key = decodeURIComponent(workspaceWorktree[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          const repo = await linkedWorktree(hub, key);
          if ('missing' in repo) return json({ error: repo.missing }, worktreeMissing[repo.missing]);
          const head = await runGit(repo.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], repo.target, 30_000);
          if (head.timedOut) return json({ error: 'timeout' }, 504);
          if (/not a git repository/i.test(head.stderr)) return json({ error: 'not-a-repo' }, 409);
          if (head.code) return json({ error: head.stderr.split(/\r?\n/).find(Boolean) ?? `git exited ${head.code}` }, 502);
          const branch = head.stdout.trim();
          let base: string | undefined;
          try { base = await resolveDiffBase(repo.cwd, repo.target); }
          catch (error) { if (errorMessage(error) === 'not-a-repo') return json({ error: 'not-a-repo' }, 409); throw error; }
          // Refresh the base before measuring, so merged means "no commits the base lacks" now.
          // A failed or hung fetch is not fatal: `fetched: false` says merged may be stale.
          // ponytail: a slashless base (the local `main` fallback) fetches `origin main`, but
          // ahead still measures the local ref, which that fetch never moves.
          let fetched = false;
          if (base) {
            const slash = base.indexOf('/');
            const fetch = await runGit(repo.cwd, ['fetch', '--quiet', slash > 0 ? base.slice(0, slash) : 'origin', slash > 0 ? base.slice(slash + 1) : base], repo.target, 15_000, { GIT_TERMINAL_PROMPT: '0' });
            fetched = !fetch.code && !fetch.timedOut;
          }
          const ahead = base ? await runGit(repo.cwd, ['rev-list', '--count', `${base}..HEAD`], repo.target, 30_000) : undefined;
          if (ahead?.timedOut) return json({ error: 'timeout' }, 504);
          const status = await runGit(repo.cwd, ['status', '--porcelain'], repo.target, 30_000);
          if (status.timedOut) return json({ error: 'timeout' }, 504);
          const pr = branch !== 'HEAD' ? await ghPr(repo.cwd, branch, repo.target) : undefined;
          const payload: WorktreeStatus = {
            ...(branch !== 'HEAD' ? { branch } : {}),
            path: repo.cwd,
            ...(base ? { base } : {}),
            fetched,
            ahead: ahead && !ahead.code ? Number(ahead.stdout.trim()) || 0 : 0,
            dirty: status.stdout.split('\n').filter(Boolean).length,
            merged: (base !== undefined && !ahead?.code && Number(ahead?.stdout.trim()) === 0) || pr?.state === 'MERGED',
            ...(pr ? { pr } : {}),
          };
          return json(payload);
        }
        const workspaceWorktreeRemove = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/worktree\/remove$/);
        if (req.method === 'POST' && workspaceWorktreeRemove) {
          let key: string;
          try { key = decodeURIComponent(workspaceWorktreeRemove[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          let body: unknown;
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (!plainObject(body) || body.force !== undefined && typeof body.force !== 'boolean'
            || body.deleteBranch !== undefined && typeof body.deleteBranch !== 'boolean') return json({ error: 'body' }, 400);
          const { force, deleteBranch } = body as WorktreeRemoveBody;
          const repo = await linkedWorktree(hub, key);
          if ('missing' in repo) return json({ error: repo.missing }, worktreeMissing[repo.missing]);
          // Read the branch and base before the removal closes the checkout; the root survives it.
          const head = await runGit(repo.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], repo.target, 30_000);
          const branch = !head.code && !head.timedOut && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : undefined;
          let base: string | undefined;
          if (branch) { try { base = await resolveDiffBase(repo.cwd, repo.target); } catch { /* branch -d's own refusal is the guard left */ } }
          try { await hub.removeWorktree(repo.muxKey, repo.workspaceId, force === true); }
          catch (error) {
            const code = errorMessage(error).split(': ')[0];
            if (code === 'dirty_worktree_requires_force') return json({ error: 'dirty' }, 409);
            if (code === 'not_linked_worktree') return json({ error: 'not-linked' }, 409);
            throw error;
          }
          // `git branch -d` alone is safe (it refuses an unmerged branch); -D runs only when
          // GitHub reports the pull request merged — a squash merge leaves the commits unreconciled.
          let branchDeleted = false;
          if (deleteBranch === true && branch && branch !== base && !['main', 'master', 'trunk'].includes(branch)) {
            const attempt = await runGit(repo.root, ['branch', '-d', branch], repo.target, 30_000);
            if (!attempt.code && !attempt.timedOut) branchDeleted = true;
            else if ((await ghPr(repo.root, branch, repo.target))?.state === 'MERGED') {
              const forced = await runGit(repo.root, ['branch', '-D', branch], repo.target, 30_000);
              branchDeleted = !forced.code && !forced.timedOut;
            }
          }
          const result: WorktreeRemoveResult = { branchDeleted };
          return json(result);
        }
        const workspaceSwitch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/switch$/);
        if (req.method === 'POST' && workspaceSwitch) {
          let key: string;
          try { key = decodeURIComponent(workspaceSwitch[1]!); } catch { return json({ error: 'unknown-workspace' }, 404); }
          // The switch always runs in the Workspace's own checkout; a worktree= query is refused, never ignored.
          if (url.searchParams.has('worktree')) return json({ error: 'worktree' }, 400);
          let body: SwitchBody | undefined;
          try { body = await req.json() as SwitchBody; } catch { return json({ error: 'body' }, 400); }
          // The name reaches git: 1–255 characters, no leading dash, no control characters.
          if (typeof body?.branch !== 'string' || !body.branch || body.branch.length > 255 || body.branch.startsWith('-') || /[\x00-\x1f\x7f]/.test(body.branch)) return json({ error: 'body' }, 400);
          const repo = await workspaceRepo(hub, key);
          if ('missing' in repo) return json({ error: repo.missing }, repo.missing === 'unknown-workspace' ? 404 : 409);
          let list: BranchList;
          try { list = await branchList(repo.cwd, repo.target); }
          catch (error) {
            const message = errorMessage(error);
            if (message === 'timeout') return json({ error: 'timeout' }, 504);
            if (message === 'not-a-repo') return json({ error: 'not-a-repo' }, 409);
            return json({ error: message.slice(0, 1000) }, 502);
          }
          if (!list.branches.includes(body.branch)) return json({ error: 'branch' }, 404);
          if (list.current !== body.branch) {
            // The one git write: a local branch from the re-listed set, never guessed, killed at 60 s.
            // ponytail: the kill ends the local ssh only — on a remote Workspace the git switch
            // itself keeps running on the Host; wrap the remote command in `timeout` there.
            const result = await runGit(repo.cwd, ['switch', '--no-guess', body.branch], repo.target, 60_000);
            if (result.timedOut) return json({ error: 'timeout' }, 504);
            if (result.code) return json({ error: (result.stderr.trim() || `git exited ${result.code}`).slice(0, 1000) }, 409);
            try { list = await branchList(repo.cwd, repo.target); }
            catch (error) {
              if (errorMessage(error) === 'timeout') return json({ error: 'timeout' }, 504);
              return json({ error: errorMessage(error).slice(0, 1000) }, 502);
            }
          }
          return json(list);
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
            if (!nonEmpty(body.workspaceId) || !validCwd(body.cwd) || !validLabel(body.label) || body.agent !== undefined && !nonEmpty(body.agent)
              || body.after !== undefined && !nonEmpty(body.after)) return json({ error: 'body' }, 400);
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
          // Wave 21: `agent: true` + paneId renames the Pane's Agent. The label may be
          // empty (that clears the name) but must still be a ≤ 80 string, and a target of
          // its own (workspaceId/tabId) mixed in is a 400, as is any other `agent` value.
          if (body.agent !== undefined) {
            if (body.agent !== true || Object.hasOwn(body, 'workspaceId') || Object.hasOwn(body, 'tabId')
              || !nonEmpty(body.muxKey) || !nonEmpty(body.paneId) || typeof body.label !== 'string' || body.label.length > 80) return json({ error: 'body' }, 400);
            await hub.rename(body as unknown as RenameBody); return new Response(null, { status: 204 });
          }
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
          // Wave 21: one entry per herdr Host; a failed Host carries `error`, not a failure.
          integrations: await hub.hostIntegrations(),
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
        if (req.method === 'GET' && url.pathname === '/api/tailnet') {
          // Read only: the Hub's own `tailscale status`, never up, set or serve. The output is
          // used whatever the exit code; a missing binary, a timeout or junk reads `unavailable`.
          let status: unknown;
          try { status = JSON.parse((await runSpawn([opts.tailscale ?? 'tailscale', 'status', '--json'], { timeoutMs: 5_000 })).stdout); } catch {}
          return json(parseTailnet(status, (await hub.state()).hosts));
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
          if (asked.some(key => !paneKeys.includes(key))) {
            // A key the cached tree lacks may exist on the Mux since its last read: a cold
            // open of a fresh split Tab races the Hub's change debounce. Re-read the owning
            // Muxes once before dropping keys, so the first stream opens on the whole Tab.
            const missing = asked.filter(key => !paneKeys.includes(key));
            const muxKeys = new Set(missing.map(key => key.slice(0, key.lastIndexOf('/'))));
            for (const muxKey of muxKeys) await hub.refresh(muxKey).catch(() => {});
            for (const paneKey of missing) if (await hub.hasPane(paneKey)) paneKeys.push(paneKey);
          }
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
              // ADR 0007: chat wake-ups ride only the streams that watch the Pane that moved.
              const chatWatch = paneKeys.length ? { panes: new Set(paneKeys), send: (value: ChatEvent) => send('chat', value) } : undefined;
              if (chatWatch) chatWatchers.add(chatWatch);
              const ping = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { cleanup(); } }  }, 25_000);
              cleanup = () => { if (closed) return; closed = true; unsubscribe(); if (chatWatch) chatWatchers.delete(chatWatch); clearInterval(ping); try { controller.close(); } catch {} };
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
          const resolved = hub.resolvePane(key);
          if (resolved?.entry.mux.kind !== 'herdr') return json({ error: 'unsupported' }, 501);
          // An Agent whose transcript tautan cannot read (gemini, …) has no Chat: 501 sends the
          // view straight to Screen instead of the 404 wait a fresh Claude gets.
          const kind = resolved.entry.tree?.panes.find(pane => pane.id === resolved.paneId)?.agent;
          if (kind && !CHAT_AGENTS.has(kind)) return json({ error: 'unsupported' }, 501);
          const agent = url.searchParams.get('agent') ?? undefined;
          if (agent !== undefined && !agentId.test(agent)) return json({ error: 'no-agent' }, 404);
          if (agent !== undefined) {
            const list = await chats.subagentList(key);
            if (list && !list.some(item => item.id === agent)) return json({ error: 'no-agent' }, 404);
          }
          const since = url.searchParams.get('since');
          const before = url.searchParams.get('before');
          const limitRaw = url.searchParams.get('limit');
          // The windowing parameters name a `since` or `before` ask, never both and never
          // the plain GET: an unplaceable one is a 400, not a silently ignored parameter.
          if (limitRaw !== null && since === null && before === null) return json({ error: 'limit' }, 400);
          if (since !== null && before !== null) return json({ error: 'since+before' }, 400);
          if (since !== null || before !== null) {
            // The amendment's windowing: `limit` caps a reset's upserts to the newest turns,
            // `after` names the client's oldest held Turn, `before` asks for the earlier page.
            // An absent limit means the page default on a `before` ask and no window on a
            // `since` ask — `Number(null)` is 0, which must not reach either.
            const limit = limitRaw === null ? undefined : Number(limitRaw);
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) return json({ error: 'limit' }, 400);
            const after = url.searchParams.get('after');
            if (after !== null && !nativeId.test(after)) return json({ error: 'after' }, 400);
            if (before !== null && !nativeId.test(before)) return json({ error: 'before' }, 400);
            // ADR 0007: a `?since=` GET always answers 200, If-None-Match ignored; nothing
            // changed is {cursor, reset: false, upserts: []}. A `?before=` page answers the
            // same shape, so the client merges it with the same code.
            const found = before !== null
              ? await chats.earlier(key, before, agent, limit ?? CHAT_PAGE_TURNS)
              : await chats.delta(key, since!, agent, { limit, after: after ?? undefined });
            if (!found) return json({ error: 'no-session' }, 404);
            return zipped(req, JSON.stringify(found), { ...jsonHeaders, 'cache-control': 'no-cache' });
          }
          const found = await chats.tagged(key, agent);
          if (!found) return json({ error: 'no-session' }, 404);
          // The Chat view polls with If-None-Match; an unchanged transcript costs a stat and a 304.
          const headers = { etag: found.etag, 'cache-control': 'no-cache' };
          const fresh = req.headers.get('if-none-match')?.split(',').some(tag => tag.trim().replace(/^W\//, '') === found.etag);
          return fresh ? new Response(null, { status: 304, headers }) : zipped(req, JSON.stringify(found.chat), { ...jsonHeaders, ...headers });
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
        const chatOutputMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/chat\/output\/([^/]+)$/);
        if (req.method === 'GET' && chatOutputMatch) {
          let key: string;
          try { key = decodeURIComponent(chatOutputMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          // ADR 0007: the tool's native id (pi ids carry a pipe), a strict allow-list; it is only a map key and never names a path.
          let toolId: string;
          try { toolId = decodeURIComponent(chatOutputMatch[2]!); } catch { return json({ error: 'id' }, 400); }
          if (!nativeId.test(toolId) || toolId.includes('..')) return json({ error: 'id' }, 400);
          if (!await hub.hasPane(key)) return json({ error: 'no-session' }, 404);
          const agent = url.searchParams.get('agent') ?? undefined;
          if (agent !== undefined && (!agentId.test(agent) || !(await chats.subagentList(key))?.some(item => item.id === agent))) return json({ error: 'no-agent' }, 404);
          // The amendment: `part` picks the whole detail over the whole result.
          const part = url.searchParams.get('part') ?? 'result';
          if (part !== 'result' && part !== 'detail') return json({ error: 'part' }, 400);
          const found = await chats.output(key, toolId, agent, part);
          if (!found) return json({ error: 'no-session' }, 404);
          if (found.text === undefined) return json({ error: 'no-output' }, 404);
          return zipped(req, found.text, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
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
        if (req.method === 'GET' && url.pathname === '/api/files/list') {
          try {
            return json(await fileList(hub, {
              host: url.searchParams.get('host') ?? '',
              path: url.searchParams.get('path') ?? undefined,
              pane: url.searchParams.get('pane') ?? undefined,
              q: url.searchParams.get('q') ?? '',
              hidden: url.searchParams.get('hidden') === '1',
            }));
          } catch (error) {
            if (error instanceof FilesError) return Response.json({ error: error.message }, { status: error.status, headers: error.headers });
            throw error;
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/files/raw') {
          try {
            return await fileRaw(hub, {
              host: url.searchParams.get('host') ?? '',
              path: url.searchParams.get('path') ?? undefined,
              pane: url.searchParams.get('pane') ?? undefined,
              download: url.searchParams.get('download') === '1',
            }, req.headers.get('range'));
          } catch (error) {
            if (error instanceof FilesError) return Response.json({ error: error.message }, { status: error.status, headers: error.headers });
            throw error;
          }
        }
        const fileMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/file$/);
        if (fileMatch && (req.method === 'GET' || req.method === 'PUT')) {
          let key: string;
          try { key = decodeURIComponent(fileMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          const path = url.searchParams.get('path');
          if (!path) return json({ error: 'path' }, 400);
          const pane = (await hub.state()).panes.find(item => item.key === key);
          if (!pane) return json({ error: 'pane not found' }, 404);
          if (!pane.cwd) return json({ error: 'cwd' }, 409);
          const host = hub.host(await hub.paneHost(key)); const cap = maxFileBytes();
          try {
            if (req.method === 'GET') {
              // Chat's fileImage thumbnails read through this same route.
              const { body, version } = await fileRead(path, pane.cwd, cap, host?.target);
              return new Response(body, { headers: { ...fileHeaders(path), ...(version ? { etag: `"${version}"` } : {}) } });
            }
            // A save is a write: the Origin check above already gates it like every other write.
            const match = /^"([A-Za-z0-9-]{1,64})"$/.exec(req.headers.get('if-match') ?? '');
            if (!match) return json({ error: 'version' }, 428);
            // The header check first, as the attach route; the post-read check below still covers a lying header.
            const length = Number(req.headers.get('content-length'));
            if (length > cap) return json({ error: 'too large' }, 413);
            const body = new Uint8Array(await req.arrayBuffer());
            if (body.byteLength > cap) return json({ error: 'too large' }, 413);
            try { new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return json({ error: 'not text' }, 415); }
            const version = await fileSave(path, pane.cwd, body, match[1]!, cap, host?.target);
            return new Response(null, { status: 204, headers: { etag: `"${version}"` } });
          } catch (error) {
            if (error instanceof FilesError) return Response.json({ error: error.message }, { status: error.status, headers: error.headers });
            throw error;
          }
        }
        const completeMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/complete$/);
        if (req.method === 'GET' && completeMatch) {
          let key: string;
          try { key = decodeURIComponent(completeMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          const kind = url.searchParams.get('kind') ?? '';
          if (kind !== 'slash' && kind !== 'file' && kind !== 'model' && kind !== 'effort') return json({ error: 'kind' }, 400);
          const limitRaw = url.searchParams.get('limit');
          const parsedLimit = Number(limitRaw);
          if (limitRaw !== null && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) return json({ error: 'limit' }, 400);
          const limit = Math.min(limitRaw === null ? 50 : parsedLimit, 200);
          try { return json({ items: await paneCompletion(hub, key, kind, url.searchParams.get('q') ?? '', limit, { runGit }) }); }
          catch (error) {
            if (error instanceof CompleteError) return json({ error: error.message }, error.status);
            throw error;
          }
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
        const actionsList = url.pathname.match(/^\/api\/panes\/([^/]+)\/actions$/);
        if (req.method === 'GET' && actionsList) {
          let key: string;
          try { key = decodeURIComponent(actionsList[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          if (!await hub.hasPane(key)) return json({ error: 'pane not found' }, 404);
          // 21.4.2: `?fresh=1` (the menu just opened) reads herdr past the Hub's 30 s cache.
          return json({ actions: await hub.pluginActions(key, url.searchParams.get('fresh') === '1') });
        }
        // Wave 22 (ADR 0010): search one history read. `q` is used literally, never as a
        // regex; `before` pages backwards from a line number.
        const historyMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/history$/);
        if (req.method === 'GET' && historyMatch) {
          let key: string;
          try { key = decodeURIComponent(historyMatch[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
          const q = url.searchParams.get('q') ?? '';
          if (!q || q.length > 200) return json({ error: 'q' }, 400);
          const beforeRaw = url.searchParams.get('before');
          const before = beforeRaw === null ? undefined : Number(beforeRaw);
          if (before !== undefined && (!Number.isInteger(before) || before < 1)) return json({ error: 'before' }, 400);
          if (!await hub.hasPane(key)) return json({ error: 'pane not found' }, 404);
          return json(searchHistory(await hub.history(key), q, before));
        }
        // Wave 21: run one of the listed actions from this Pane. herdr's own message reaches
        // the UI on failure (up to 1000 chars), unlike the code-only 502 the catch maps.
        // 21.4.1: the body is how the run ended (PluginRun); a Mux that cannot say (a test
        // double's void) answers `unknown` instead of the old empty 204.
        const actionInvoke = url.pathname.match(/^\/api\/panes\/([^/]+)\/actions\/([^/]+)$/);
        if (req.method === 'POST' && actionInvoke) {
          let key: string; let actionId: string;
          try { key = decodeURIComponent(actionInvoke[1]!); actionId = decodeURIComponent(actionInvoke[2]!); }
          catch { return json({ error: 'bad pane key' }, 400); }
          if (!await hub.hasPane(key)) return json({ error: 'pane not found' }, 404);
          let body: { pluginId?: unknown };
          try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
          if (!plainObject(body) || body.pluginId !== undefined && (typeof body.pluginId !== 'string' || !body.pluginId)) return json({ error: 'body' }, 400);
          try { return json(await hub.invokePluginAction(key, actionId, body.pluginId) ?? { status: 'unknown' }, 200); }
          catch (error) {
            const message = errorMessage(error);
            // the outer catch owns these two: 404 for the pane, 501 for tmux.
            if (message === 'pane not found' || message === 'unsupported') throw error;
            return json({ error: message.slice(0, 1000) }, 502);
          }
        }
        const match = url.pathname.match(/^\/api\/panes\/([^/]+)\/(screen|input|seen|explain|attach|suggest|close|zoom|split|swap|move|resize)$/);
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
          if (req.method === 'POST' && (action === 'split' || action === 'swap' || action === 'move' || action === 'resize')) {
            let body: unknown;
            try { body = await req.json(); } catch { return json({ error: 'body' }, 400); }
            if (!plainObject(body)) return json({ error: 'body' }, 400);
            if (typeof body.label === 'string') body.label = body.label.trim();
            const validRatio = (value: unknown) => value === undefined || typeof value === 'number' && value > 0 && value < 1;
            // ADR 0008: restore every leased Pane of the source or destination Tab before the edit.
            const state = await hub.state();
            const releaseLeases = async (...tabIds: (string | undefined)[]) => {
              const wanted = new Set(tabIds.flatMap(id => id ? [id] : []));
              const muxKey = state.panes.find(pane => pane.key === key)?.muxKey;
              for (const pane of state.panes) if (pane.muxKey === muxKey && wanted.has(pane.tabId)) await leases.release(pane.key);
            };
            const sourceTab = state.panes.find(pane => pane.key === key)?.tabId;
            const sourceMux = state.panes.find(pane => pane.key === key)?.muxKey;
            if (action === 'split') {
              if (body.direction !== 'right' && body.direction !== 'down' || !validRatio(body.ratio) || !validCwd(body.cwd)
                || body.agent !== undefined && !nonEmpty(body.agent)) return json({ error: 'body' }, 400);
              await releaseLeases(sourceTab);
              return json(await hub.splitPane(key, body as unknown as SplitBody), 201);
            }
            if (action === 'swap') {
              if (!nonEmpty(body.target)) return json({ error: 'body' }, 400);
              await releaseLeases(sourceTab, (p => p?.muxKey === sourceMux ? p?.tabId : undefined)(state.panes.find(pane => pane.key === body.target)));
              await hub.swapPanes(key, body.target as string); return new Response(null, { status: 204 });
            }
            if (action === 'move') {
              // presence discrimination, as /api/rename: exactly one of tab | newTab | newWorkspace
              const targets = ['tab', 'newTab', 'newWorkspace'].filter(field => Object.hasOwn(body, field));
              const target = targets[0];
              if (targets.length !== 1) return json({ error: 'body' }, 400);
              if (target === 'tab') {
                if (!nonEmpty(body.tab) || body.split !== 'right' && body.split !== 'down' || !validRatio(body.ratio)) return json({ error: 'body' }, 400);
              } else if (body[target!] !== true) return json({ error: 'body' }, 400);
              if (body.label !== undefined && target !== 'newWorkspace' || !validLabel(body.label)) return json({ error: 'body' }, 400);
              await releaseLeases(sourceTab, (t => t?.muxKey === sourceMux ? t?.id : undefined)(target === 'tab' ? state.tabs.find(tab => tab.key === body.tab) : undefined));
              return json(await hub.movePane(key, body as unknown as MoveBody), 201);
            }
            if (body.direction !== 'left' && body.direction !== 'right' && body.direction !== 'up' && body.direction !== 'down'
              || typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount < 1 || body.amount > 500) return json({ error: 'body' }, 400);
            await releaseLeases(sourceTab);
            await hub.resizePane(key, body.direction, body.amount); return new Response(null, { status: 204 });
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
              body.promptId !== undefined && typeof body.promptId !== 'string' ||
              body.held !== undefined && body.held !== true) return json({ error: 'body' }, 400);
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
        const message = errorMessage(error);
        if (message === 'pane not found' || message === 'mux not found' || message === 'workspace not found' || message === 'tab not found') return json({ error: message }, 404);
        if (message === 'unsupported') return json({ error: message }, 501);
        // Wave 20: a held reply met a draft (or bash mode) in Claude's box; the Hub typed nothing.
        if (message === 'draft') return json({ error: message }, 409);
        return json({ error: message.split(': ')[0] || message }, 502);
      }
    },
  });
}
