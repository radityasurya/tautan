import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiff } from '../shared/diff.ts';
import { parseWorktrees, startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { BranchList, DiffResult, Explain, Mux, Pane, Screen, Tree, Workspace } from '../shared/types.ts';

describe('parseUnifiedDiff', () => {
  test('parses rename, binary, and mode-only files', () => {
    expect(parseUnifiedDiff(`diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n`)[0]).toMatchObject({ oldPath: 'old.txt', path: 'new.txt', hunks: [] });
    expect(parseUnifiedDiff(`diff --git a/pic.png b/pic.png\nBinary files a/pic.png and b/pic.png differ\n`)[0]).toMatchObject({ path: 'pic.png', binary: true, hunks: [] });
    expect(parseUnifiedDiff(`diff --git a/run b/run\nold mode 100644\nnew mode 100755\n`)[0]).toMatchObject({ path: 'run', additions: 0, deletions: 0, hunks: [] });
  });

  test('parses new and deleted files and newline metadata', () => {
    const added = parseUnifiedDiff(`diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n\\ No newline at end of file\n`)[0]!;
    expect(added.oldPath).toBeUndefined();
    expect(added).toMatchObject({ path: 'new.txt', additions: 1 });
    expect(added.hunks[0]!.lines[1]).toEqual({ type: 'meta', text: '\\ No newline at end of file' });
    const deleted = parseUnifiedDiff(`diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n`)[0]!;
    expect(deleted.oldPath).toBeUndefined();
    expect(deleted).toMatchObject({ path: 'old.txt', deletions: 1 });
  });

  test('tracks line numbers across multiple hunks', () => {
    const file = parseUnifiedDiff(`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n one\n-old\n+new\n@@ -10,2 +12,3 @@ tail\n ten\n-eleven\n+ELEVEN\n+twelve\n`)[0]!;
    expect(file.oldPath).toBeUndefined();
    expect(file.hunks[1]!.lines).toEqual([
      { type: 'ctx', text: 'ten', oldNo: 10, newNo: 12 },
      { type: 'del', text: 'eleven', oldNo: 11 },
      { type: 'add', text: 'ELEVEN', newNo: 13 },
      { type: 'add', text: 'twelve', newNo: 14 },
    ]);
  });
});

describe('workspace diff route', () => {
  let dir: string, plain: string, hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  let wtdir: string | undefined;
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const get = (key = 'local/fake/w1', query = 'scope=working') => handle(new Request(`http://tautan.test/api/workspaces/${encodeURIComponent(key)}/diff?${query}`));
  const branches = (key = 'local/fake/w1', query = '') => handle(new Request(`http://tautan.test/api/workspaces/${encodeURIComponent(key)}/branches${query}`));
  const post = (key: string, body: unknown) => handle(new Request(`http://tautan.test/api/workspaces/${encodeURIComponent(key)}/switch`, { method: 'POST', headers: { host: 'tautan.test', origin: 'http://tautan.test', 'content-type': 'application/json' }, body: JSON.stringify(body) }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tautan-diff-repo-')); plain = mkdtempSync(join(tmpdir(), 'tautan-diff-plain-'));
    git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(dir, 'other.txt'), 'old\n'); git(['add', '.']); git(['commit', '-m', 'initial']);
    const tree: Tree = { workspaces: [{ id: 'w1', label: 'Repo', cwd: dir }, { id: 'plain', label: 'Plain', cwd: plain }], tabs: [], panes: [] };
    const mux: Mux = { kind: 'herdr', id: 'fake', tree: async () => tree, read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }), sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); }, rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {} };
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); await hub.state();
    const serve = Bun.serve;
    try { Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve; startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir }); }
    finally { Bun.serve = serve; }
  });
  afterEach(() => { hub.close(); rmSync(dir, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); if (wtdir) { rmSync(wtdir, { recursive: true, force: true }); wtdir = undefined; } });

  test('returns working and staged changes', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
    let body = await (await get()).json() as DiffResult; expect(body.files[0]).toMatchObject({ path: 'a.txt', additions: 1, deletions: 1 });
    writeFileSync(join(dir, 'new.txt'), 'new\n'); git(['add', 'new.txt']);
    body = await (await get('local/fake/w1', 'scope=staged')).json() as DiffResult; expect(body.files.map(file => file.path)).toContain('new.txt');
    body = await (await get()).json() as DiffResult; expect(body.files.map(file => file.path)).not.toContain('new.txt');
  });

  test('resolves base and review.base override', async () => {
    git(['checkout', '-b', 'feature']); writeFileSync(join(dir, 'a.txt'), 'feature one\n'); git(['add', '.']); git(['commit', '-m', 'feature one']);
    writeFileSync(join(dir, 'other.txt'), 'feature two\n'); git(['add', '.']); git(['commit', '-m', 'feature two']);
    let body = await (await get('local/fake/w1', 'scope=base')).json() as DiffResult; expect(body.base).toBe('main'); expect(body.files).toHaveLength(2);
    git(['branch', 'other-base', 'HEAD~1']); git(['config', 'review.base', 'other-base']);
    body = await (await get('local/fake/w1', 'scope=base')).json() as DiffResult; expect(body.base).toBe('other-base'); expect(body.files).toHaveLength(1);
  });

  test('filters files and caps whole-file output', async () => {
    for (const name of ['big-a.txt', 'big-b.txt', 'big-c.txt']) writeFileSync(join(dir, name), 'small\n');
    git(['add', '.']); git(['commit', '-m', 'large fixture']);
    for (const name of ['big-a.txt', 'big-b.txt', 'big-c.txt']) writeFileSync(join(dir, name), `${name}\n${'x'.repeat(30_000)}\n`);
    const capped = await (await get()).json() as DiffResult; expect(capped.truncated).toBe(true); expect(capped.files.length).toBeLessThan(3);
    const single = await (await get('local/fake/w1', 'scope=working&file=big-c.txt')).json() as DiffResult;
    expect(single).toMatchObject({ truncated: false }); expect(single.files.map(file => file.path)).toEqual(['big-c.txt']);
    expect(single.files[0]!.hunks[0]!.lines.some(line => line.type === 'add' && line.text.length === 30_000)).toBe(true);
  });

  test('returns route errors', async () => {
    let response = await get('local/fake/plain'); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'not-a-repo' });
    response = await get('local/fake/missing'); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'unknown-workspace' });
    response = await get('local/fake/w1', 'scope=nope'); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'scope' });
  });

  test('branches lists local branches and marks the current checkout', async () => {
    git(['branch', 'other']);
    const body = await (await branches()).json() as BranchList;
    expect(body.current).toBe('main');
    expect([...body.branches].sort()).toEqual(['main', 'other']);
    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]).toMatchObject({ path: realpathSync(dir), branch: 'main', current: true });
    expect(body.worktrees[0]!.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test('branches: current is null when HEAD is detached', async () => {
    git(['checkout', '--detach']);
    const body = await (await branches()).json() as BranchList;
    expect(body.current).toBeNull();
    expect(body.branches).toContain('main');
  });

  test('switch changes the checkout and answers the re-listed branches', async () => {
    git(['checkout', '-b', 'feature-at']); writeFileSync(join(dir, 'a.txt'), 'feature\n'); git(['add', '.']); git(['commit', '-m', 'feature']); git(['checkout', 'main']);
    const response = await post('local/fake/w1', { branch: 'feature-at' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as BranchList).current).toBe('feature-at');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('feature\n');
    // switching to the branch already current returns the list unchanged
    expect(((await (await post('local/fake/w1', { branch: 'feature-at' })).json()) as BranchList).current).toBe('feature-at');
  });

  test('switch refuses bad input and unknown branches', async () => {
    git(['branch', 'other']);
    for (const bad of [{}, { branch: '' }, { branch: '-dash' }, { branch: 'a'.repeat(256) }, { branch: 'a\nb' }]) {
      const response = await post('local/fake/w1', bad);
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'body' });
    }
    let response = await post('local/fake/w1', { branch: 'nope' });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'branch' });
    response = await post('local/fake/missing', { branch: 'main' });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'unknown-workspace' });
    response = await post('local/fake/plain', { branch: 'main' });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'not-a-repo' });
  });

  test('switch refuses a worktree= query instead of ignoring it', async () => {
    const response = await handle(new Request(`http://tautan.test/api/workspaces/${encodeURIComponent('local/fake/w1')}/switch?worktree=${encodeURIComponent('/nope')}`, { method: 'POST', headers: { host: 'tautan.test', origin: 'http://tautan.test', 'content-type': 'application/json' }, body: JSON.stringify({ branch: 'main' }) }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'worktree' });
  });

  test('switch passes git refusals through verbatim', async () => {
    git(['checkout', '-b', 'feature-at']); writeFileSync(join(dir, 'a.txt'), 'feature\n'); git(['add', '.']); git(['commit', '-m', 'feature']); git(['checkout', 'main']);
    writeFileSync(join(dir, 'a.txt'), 'dirty\n'); // would be overwritten by the switch
    let response = await post('local/fake/w1', { branch: 'feature-at' });
    expect(response.status).toBe(409);
    expect((((await response.json()) as { error: string }).error).length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('dirty\n'); // nothing switched
    git(['checkout', '--', 'a.txt']); // clean the tree
    wtdir = mkdtempSync(join(tmpdir(), 'tautan-diff-wt-'));
    git(['worktree', 'add', wtdir, '-b', 'held']);
    response = await post('local/fake/w1', { branch: 'held' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `fatal: 'held' is already used by worktree at '${realpathSync(wtdir)}'` });
  });

  test('worktree= picks one of the repository\'s own checkouts', async () => {
    wtdir = mkdtempSync(join(tmpdir(), 'tautan-diff-wt-'));
    git(['worktree', 'add', wtdir, '-b', 'wt']);
    const main = realpathSync(dir); const wt = realpathSync(wtdir);
    let body = await (await branches()).json() as BranchList;
    expect(body.worktrees.map(item => item.path)).toEqual([main, wt]);
    expect(body.worktrees.find(item => item.path === main)?.current).toBe(true);
    expect(body.worktrees.find(item => item.path === wt)).toMatchObject({ branch: 'wt', current: false });
    const scoped = await (await branches('local/fake/w1', `?worktree=${encodeURIComponent(wt)}`)).json() as BranchList;
    expect(scoped.current).toBe('wt');
    expect(scoped.worktrees.find(item => item.path === wt)?.current).toBe(true);
    writeFileSync(join(wtdir, 'a.txt'), 'from the worktree\n');
    const scopedDiff = await (await get('local/fake/w1', `scope=working&worktree=${encodeURIComponent(wt)}`)).json() as DiffResult;
    expect(scopedDiff.files.map(file => file.path)).toContain('a.txt');
    const mainDiff = await (await get()).json() as DiffResult;
    expect(mainDiff.files).toHaveLength(0); // the main checkout's a.txt is untouched
    // an unknown path, and a real directory that is not one of this repository's checkouts
    let response = await branches('local/fake/w1', `?worktree=${encodeURIComponent('/nope')}`);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'worktree' });
    response = await branches('local/fake/w1', `?worktree=${encodeURIComponent(realpathSync(plain))}`);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'worktree' });
  });
});

describe('parseWorktrees', () => {
  test('parses porcelain records, skips bare ones, and marks current', () => {
    const a = 'a'.repeat(40); const b = 'b'.repeat(40); const c = 'c'.repeat(40);
    const porcelain = [
      'worktree /repo', `HEAD ${a}`, 'branch refs/heads/main', '',
      'worktree /repo/wt', `HEAD ${b}`, 'branch refs/heads/feature', 'locked reason here', '',
      'worktree /repo/det', `HEAD ${c}`, 'detached', 'prunable', '',
      'worktree /repo/bare.git', 'bare', '',
    ].join('\n');
    expect(parseWorktrees(porcelain, '/repo/wt')).toEqual([
      { path: '/repo', branch: 'main', head: a, current: false },
      { path: '/repo/wt', branch: 'feature', head: b, current: true, locked: true },
      { path: '/repo/det', branch: null, head: c, current: false, prunable: true },
    ]);
  });
});
