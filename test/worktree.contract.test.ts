import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { State, WorktreeStatus } from '../shared/types.ts';
import { herdrAvailable, herdrMux, startThrowawayHerdr } from './harness.ts';

const eventually = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(50); value = await read(); }
  return value;
};

describe.skipIf(!herdrAvailable)('worktree contract (herdr ≥ 0.9.3)', () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>>;
  let mux: ReturnType<typeof herdrMux>;
  let hub: Hub;
  let server: ReturnType<typeof startHttp>;
  let repo: string;
  let bare = '';
  let origin = 'http://127.0.0.1:1';
  const git = (args: string[], cwd = repo) => Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

  beforeAll(async () => {
    fixture = await startThrowawayHerdr();
    mux = herdrMux(fixture.sock); // direct herdr drives; the Hub gets its own connection
    // A scratch repo whose `origin` is a bare clone, so origin/main resolves and a
    // `git fetch` of the base succeeds — everything lives under fixture.dir, which stop() removes.
    repo = join(fixture.dir, 'repo'); bare = join(fixture.dir, 'origin.git');
    await mkdir(repo);
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'tautan@example.test'], ['config', 'user.name', 'Tautan'], ['commit', '--allow-empty', '-m', 'init']]) git(args);
    git(['clone', '--bare', repo, bare]);
    git(['remote', 'add', 'origin', bare]);
    git(['fetch', 'origin']);
    git(['remote', 'set-head', 'origin', '--auto']);
    const hubMux = herdrMux(fixture.sock);
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('contract', hubMux);
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
    origin = `http://127.0.0.1:${server.port}`;
  }, 30_000);
  afterAll(async () => { server?.stop(); hub?.close(); mux?.close(); await fixture?.stop(); });

  /** A linked-worktree Workspace through real herdr, waited into the Hub's state. */
  const worktree = async (branch: string) => {
    const workspace = await mux.newWorkspace({ cwd: repo, branch, label: branch });
    const key = `contract/throwaway/${workspace.id}`;
    const state = () => fetch(`${origin}/api/state`).then(response => response.json() as Promise<State>);
    const found = await eventually(state, value => value.workspaces.some(item => item.key === key), 10_000);
    const entry = found.workspaces.find(item => item.key === key)!;
    // herdr's create reply can still carry the root Pane's starting cwd, so the checkout
    // path comes from the tree's own worktree pair — which is what the routes use.
    expect(entry.worktree?.root).toBe(repo);
    expect(entry.cwd).toBe(entry.worktree?.path);
    return { key, cwd: entry.worktree!.path };
  };
  const status = (key: string) => fetch(`${origin}/api/workspaces/${encodeURIComponent(key)}/worktree`).then(response => response.json() as Promise<WorktreeStatus>);
  const remove = (key: string, body: unknown) => fetch(`${origin}/api/workspaces/${encodeURIComponent(key)}/worktree/remove`, { method: 'POST', headers: { origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const branchExists = (branch: string) => Boolean(git(['branch', '--list', branch]).stdout.toString().trim());

  test('status answers merged on a fresh branch, ahead and dirty after work', async () => {
    const { key, cwd } = await worktree('tautan-fresh');
    expect(await status(key)).toEqual({ branch: 'tautan-fresh', path: cwd, base: 'origin/main', fetched: true, ahead: 0, dirty: 0, merged: true });

    await writeFile(join(cwd, 'work.txt'), 'one\n');
    git(['add', '.'], cwd); git(['commit', '-m', 'work'], cwd);
    expect(await status(key)).toMatchObject({ ahead: 1, merged: false, dirty: 0 });

    await writeFile(join(cwd, 'scratch.txt'), 'x\n');
    expect(await status(key)).toMatchObject({ dirty: 1, ahead: 1 });
  }, 30_000);

  test('remove refuses a dirty checkout, forces through, and the state follows', async () => {
    const { key, cwd } = await worktree('tautan-dirty');
    await writeFile(join(cwd, 'untracked.txt'), 'x\n');
    let response = await remove(key, {});
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'dirty' });

    response = await remove(key, { force: true });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ branchDeleted: false });
    const state = () => fetch(`${origin}/api/state`).then(response => response.json() as Promise<State>);
    const settled = await eventually(state, value => !value.workspaces.some(item => item.key === key), 10_000);
    expect(settled.workspaces.some(item => item.key === key)).toBe(false);
    expect(git(['worktree', 'list', '--porcelain']).stdout.toString()).not.toContain(cwd);
    expect(branchExists('tautan-dirty')).toBe(true); // force removes the checkout, never the branch
  }, 30_000);

  test('deleteBranch deletes a branch merged into main and keeps an unmerged one', async () => {
    const merged = await worktree('tautan-ship');
    await writeFile(join(merged.cwd, 'ship.txt'), 'work\n');
    git(['add', '.'], merged.cwd); git(['commit', '-m', 'ship'], merged.cwd);
    git(['merge', 'tautan-ship']);
    let response = await remove(merged.key, { deleteBranch: true });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ branchDeleted: true });
    expect(branchExists('tautan-ship')).toBe(false);

    const stray = await worktree('tautan-stray');
    await writeFile(join(stray.cwd, 'stray.txt'), 'unmerged\n');
    git(['add', '.'], stray.cwd); git(['commit', '-m', 'stray'], stray.cwd);
    response = await remove(stray.key, { deleteBranch: true, force: false });
    // `git branch -d` refuses; this repo has no GitHub remote, so no merged pull request
    // ever argues for -D.
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ branchDeleted: false });
    expect(branchExists('tautan-stray')).toBe(true);
  }, 30_000);
});
