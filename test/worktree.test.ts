import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, State, Tree, WorktreeStatus, Workspace } from '../shared/types.ts';

describe('worktree routes', () => {
  let dir: string, plain: string;
  let hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  let tree: Tree;
  let failure: string | undefined;
  let scratch: string[] = [];

  const git = (args: string[], cwd = dir) => Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tautan-wt-repo-')); plain = mkdtempSync(join(tmpdir(), 'tautan-wt-plain-'));
    scratch = [];
    git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'a.txt'), 'one\n'); git(['add', '.']); git(['commit', '-m', 'initial']);
    tree = { workspaces: [{ id: 'w1', label: 'Repo', cwd: dir }, { id: 'plain', label: 'Plain', cwd: plain }], tabs: [], panes: [] };
    const fail = () => { if (failure) throw new Error(failure); };
    // The write fake shells out to the real `git worktree remove`, so herdr's answers —
    // a dirty checkout refused, forced through with force — are the real git ones.
    const mux: Mux & { removeWorktree(workspaceId: string, force: boolean): Promise<void> } = {
      kind: 'herdr', id: 'fake', tree: async () => structuredClone(tree),
      read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {},
      newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); },
      rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {},
      split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {},
      moveWorkspace: async () => {}, moveTab: async () => {},
      pluginActions: async () => [], invokePluginAction: async () => {}, renameAgent: async () => {}, integrations: async () => [],
      explain: async (): Promise<Explain | null> => null, close: () => {},
      removeWorktree: async (workspaceId, force) => {
        fail();
        const workspace = tree.workspaces.find(item => item.id === workspaceId);
        if (!workspace?.worktree) throw new Error('not_linked_worktree: gone');
        const result = Bun.spawnSync(['git', '-C', workspace.worktree.root, 'worktree', 'remove', ...(force ? ['--force'] : []), workspace.worktree.path], { stdout: 'pipe', stderr: 'pipe' });
        if (result.exitCode) throw new Error(`dirty_worktree_requires_force: ${result.stderr}`);
        tree.workspaces = tree.workspaces.filter(item => item.id !== workspaceId);
        tree.tabs = tree.tabs.filter(item => item.workspaceId !== workspaceId);
        tree.panes = tree.panes.filter(item => item.workspaceId !== workspaceId);
      },
    };
    // kind: tmux in state is what the routes 501 on, so this fake carries the worktree pair.
    const tmuxTree: Tree = { workspaces: [{ id: 'tw', label: 'TW', cwd: '/wt', worktree: { root: '/repo', path: '/wt' } }], tabs: [], panes: [] };
    const tmux: Mux = { ...mux, kind: 'tmux' as const, tree: async () => structuredClone(tmuxTree) };
    hub = new Hub({ refreshMs: 0, suggest: null });
    hub.add('local', mux); hub.add('tmuxhost', tmux); await hub.state();
    const serve = Bun.serve;
    try {
      Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve;
      startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir });
    } finally { Bun.serve = serve; }
  });
  afterEach(() => {
    hub?.close(); rmSync(dir, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true });
    for (const path of scratch) rmSync(path, { recursive: true, force: true });
  });

  /** A real linked worktree on branch `branch`, plus its Workspace in the tree. */
  const worktree = async (branch: string) => {
    const path = mkdtempSync(join(tmpdir(), 'tautan-wt-checkout-')); scratch.push(path);
    git(['worktree', 'add', path, '-b', branch]);
    tree.workspaces.push({ id: `wt-${branch}`, label: branch, cwd: realpathSync(path), worktree: { root: realpathSync(dir), path: realpathSync(path) } });
    await hub.refreshHost('local');
    return { key: `local/fake/wt-${branch}`, path };
  };
  const status = (key: string) => handle(new Request(`http://tautan.test/api/workspaces/${encodeURIComponent(key)}/worktree`, { headers: { host: 'tautan.test' } }));
  const remove = (key: string, body: unknown) => handle(new Request(`http://tautan.test/api/workspaces/${encodeURIComponent(key)}/worktree/remove`, { method: 'POST', headers: { host: 'tautan.test', origin: 'http://tautan.test', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const branchExists = (branch: string) => Boolean(git(['branch', '--list', branch]).stdout.toString().trim());

  test('status: a clean branch is merged, with fetched false when the fetch fails', async () => {
    const { key, path } = await worktree('clean');
    // No `origin` remote exists, so refreshing the base fails and fetched must say so.
    expect(await (await status(key)).json()).toEqual({ branch: 'clean', path: realpathSync(path), base: 'main', fetched: false, ahead: 0, dirty: 0, merged: true });
  });

  test('status: a commit puts the branch ahead and unmerged; an untracked file counts dirty', async () => {
    const { key, path } = await worktree('ahead');
    writeFileSync(join(path, 'b.txt'), 'new\n');
    git(['add', '.'], path); git(['commit', '-m', 'work'], path);
    writeFileSync(join(path, 'c.txt'), 'scratch\n');
    const body = await (await status(key)).json() as WorktreeStatus;
    expect(body).toMatchObject({ branch: 'ahead', ahead: 1, dirty: 1, merged: false });
  });

  test('both routes answer 404 unknown, 409 not-linked, and 501 on a tmux Mux', async () => {
    for (const [keyAsked, code, wanted] of [
      ['local/fake/missing', 404, 'unknown-workspace'],
      ['local/fake/w1', 409, 'not-linked'],
      ['tmuxhost/fake/tw', 501, 'unsupported'],
    ] as const) {
      let response = await status(keyAsked); expect(response.status).toBe(code); expect(await response.json()).toEqual({ error: wanted });
      response = await remove(keyAsked, {}); expect(response.status).toBe(code); expect(await response.json()).toEqual({ error: wanted });
    }
  });

  test('remove refuses bad bodies, a dirty checkout, and maps herdr errors', async () => {
    const { key, path } = await worktree('dirty');
    for (const bad of [{ force: 'yes' }, { deleteBranch: 1 }, null]) {
      const response = await remove(key, bad);
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'body' });
    }
    writeFileSync(join(path, 'untracked.txt'), 'x\n');
    let response = await remove(key, {});
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'dirty' });
    // The Workspace survives the refusal; state still lists it.
    expect(((await (await handle(new Request('http://tautan.test/api/state'))).json()) as State).workspaces.some(item => item.key === key)).toBe(true);

    failure = 'not_linked_worktree: gone';
    response = await remove(key, {});
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'not-linked' });
    failure = 'boom: detail';
    response = await remove(key, {});
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: 'boom' });
    failure = undefined;

    response = await remove(key, { force: true });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ branchDeleted: false });
    const state = await (await handle(new Request('http://tautan.test/api/state'))).json() as State;
    expect(state.workspaces.some(item => item.key === key)).toBe(false);
  });

  test('force removes the checkout and the state reflects it by the reply', async () => {
    const { key, path } = await worktree('forced');
    writeFileSync(join(path, 'untracked.txt'), 'x\n');
    const response = await remove(key, { force: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ branchDeleted: false });
    const state = await (await handle(new Request('http://tautan.test/api/state'))).json() as State;
    expect(state.workspaces.some(item => item.key === key)).toBe(false);
    expect(branchExists('forced')).toBe(true); // the branch is never removed unasked
  });

  test('deleteBranch deletes a branch merged into main, and keeps an unmerged one', async () => {
    const merged = await worktree('shipit');
    writeFileSync(join(merged.path, 'b.txt'), 'work\n'); git(['add', '.'], merged.path); git(['commit', '-m', 'work'], merged.path);
    git(['merge', 'shipit']);
    let response = await remove(merged.key, { deleteBranch: true });
    expect(await response.json()).toEqual({ branchDeleted: true });
    expect(branchExists('shipit')).toBe(false);

    const stray = await worktree('stray');
    writeFileSync(join(stray.path, 'c.txt'), 'unmerged\n'); git(['add', '.'], stray.path); git(['commit', '-m', 'unmerged'], stray.path);
    response = await remove(stray.key, { deleteBranch: true });
    // `git branch -d` refuses; gh finds no merged pull request here, so -D never runs.
    expect(await response.json()).toEqual({ branchDeleted: false });
    expect(branchExists('stray')).toBe(true);
  });

  test('deleteBranch never touches the base branch', async () => {
    // git refuses to check a branch out twice, so the worktree rides an existing branch
    // and review.base names it — the branch === base guard must hold even though it is merged.
    git(['branch', 'keeper']);
    git(['config', 'review.base', 'keeper']);
    const path = mkdtempSync(join(tmpdir(), 'tautan-wt-checkout-')); scratch.push(path);
    rmSync(path, { recursive: true, force: true }); // `worktree add` wants the directory empty or gone
    git(['worktree', 'add', path, 'keeper']);
    tree.workspaces.push({ id: 'wt-keeper', label: 'keeper', cwd: realpathSync(path), worktree: { root: realpathSync(dir), path: realpathSync(path) } });
    await hub.refreshHost('local');
    const response = await remove('local/fake/wt-keeper', { deleteBranch: true });
    expect(await response.json()).toEqual({ branchDeleted: false });
    expect(branchExists('keeper')).toBe(true);
  });
});
