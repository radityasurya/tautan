import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import { paneCompletion } from '../server/complete.ts';
import type { CompleteItem } from '../server/complete.ts';
import type { Explain, Mux, Pane, Screen, Tree, Workspace } from '../shared/types.ts';

describe('completion route', () => {
  let repo: string, plain: string, out: string;
  let hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  let tree: Tree;
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const path = (key = 'local/fake/p1') => `/api/panes/${encodeURIComponent(key)}/complete`;
  const get = (query: string, key?: string) => handle(new Request(`http://tautan.test${path(key)}?${query}`, { headers: { host: 'tautan.test' } }));
  const items = async (query: string, key?: string): Promise<CompleteItem[]> => ((await (await get(query, key)).json()) as { items: CompleteItem[] }).items;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'tautan-complete-repo-'));
    plain = mkdtempSync(join(tmpdir(), 'tautan-complete-plain-'));
    out = mkdtempSync(join(tmpdir(), 'tautan-complete-out-')); // outside every cwd
    git(['init', '-b', 'main']);
    writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'app.ts'), 'x');           // tracked
    writeFileSync(join(repo, 'src', 'my file.txt'), 'x');       // untracked
    writeFileSync(join(repo, 'src', 'café.md'), 'x');           // untracked, non-ASCII: git quotes it
    mkdirSync(join(repo, 'ignored')); writeFileSync(join(repo, 'ignored', 'secret.txt'), 'x');
    git(['add', 'src/app.ts']);
    mkdirSync(join(plain, 'sub')); writeFileSync(join(plain, 'alpha.txt'), 'x');
    writeFileSync(join(plain, 'beta-alpha.txt'), 'x');
    writeFileSync(join(plain, 'UPPER.txt'), 'x');
    writeFileSync(join(plain, 'sub', 'gamma.txt'), 'x');
    mkdirSync(join(plain, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(plain, 'node_modules', 'pkg', 'skip.txt'), 'x');
    writeFileSync(join(out, 'escape.txt'), 'x');
    symlinkSync(out, join(plain, 'link-out'));
    tree = {
      workspaces: [{ id: 'w1', label: 'Repo', cwd: repo }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'Tab' }],
      panes: [
        { id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'Claude', cwd: repo, agent: 'claude', status: 'idle', revision: 0 },
        { id: 'p2', tabId: 't1', workspaceId: 'w1', title: 'Shell', cwd: plain, status: 'unknown', revision: 0 },
        { id: 'p3', tabId: 't1', workspaceId: 'w1', title: 'Pi', cwd: repo, agent: 'pi', status: 'idle', revision: 0 },
      ],
    };
    const mux: Mux = {
      kind: 'herdr', id: 'fake', tree: async () => structuredClone(tree),
      read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, explain: async (): Promise<Explain | null> => null,
      newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); },
      rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, close: () => {},
    };
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); await hub.state();
    const serve = Bun.serve;
    try {
      Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve;
      startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: plain });
    } finally { Bun.serve = serve; }
  });
  afterEach(() => { hub?.close(); rmSync(repo, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });

  test('rank: prefix before substring, case-insensitive, rest last, q empty caps at limit', async () => {
    // Walk order is byte order: UPPER.txt, alpha.txt, beta-alpha.txt, link-out, sub/, sub/gamma.txt.
    let list = await items('kind=file&q=alp&limit=2', 'local/fake/p2');
    expect(list.map(item => item.value)).toEqual(['alpha.txt', 'beta-alpha.txt']);
    list = await items('kind=file&q=ALPHA&limit=2', 'local/fake/p2');
    expect(list[0]!.value).toBe('alpha.txt');
    list = await items('kind=file&q=upper&limit=2', 'local/fake/p2');
    expect(list[0]!.value).toBe('UPPER.txt');
    // No match: the rest still fills the list, in discovery order.
    list = await items('kind=file&q=zzz&limit=2', 'local/fake/p2');
    expect(list.map(item => item.value)).toEqual(['UPPER.txt', 'alpha.txt']);
    list = await items('kind=file&q=&limit=3', 'local/fake/p2');
    expect(list).toHaveLength(3);
    const full = await items('kind=file&q=&limit=100', 'local/fake/p2');
    expect(full.find(item => item.value === 'sub/')?.dir).toBe(true);
    expect(full.find(item => item.value === 'alpha.txt')?.dir).toBeUndefined();
  });

  test('walk skips node_modules and never leaves the cwd', async () => {
    const values = (await items('kind=file&q=&limit=100', 'local/fake/p2')).map(item => item.value);
    expect(values).not.toContain('node_modules/');
    expect(values.some(value => value.includes('skip.txt'))).toBe(false);
    expect(values).toContain('link-out'); // listed by name…
    expect(values.some(value => value.includes('escape.txt'))).toBe(false); // …but never descended into
    expect(values.every(value => !value.startsWith('/') && !value.includes('..'))).toBe(true);
  });

  test('containment: q=../ returns no escape for the git source and the walk', async () => {
    for (const key of ['local/fake/p1', 'local/fake/p2']) {
      const list = await items(`kind=file&q=${encodeURIComponent('../')}&limit=100`, key);
      expect(list.every(item => !item.value.includes('..'))).toBe(true);
      expect(list.some(item => item.value.includes('escape.txt'))).toBe(false);
    }
  });

  test('git source: tracked and untracked, ignored excluded, quoted paths unquoted', async () => {
    const values = (await items('kind=file&q=&limit=100')).map(item => item.value);
    expect(values).toContain('src/app.ts');      // tracked (--cached)
    expect(values).toContain('src/my file.txt'); // untracked (--others)
    expect(values).toContain('src/café.md');     // git's octal quoting undone
    expect(values).toContain('src/');            // parent directories offered for drill-down
    expect(values.some(value => value.startsWith('ignored/'))).toBe(false); // gitignored
    expect(values.some(value => value.includes('secret.txt'))).toBe(false);
  });

  test('discovers Claude commands and skills from the project .claude', async () => {
    mkdirSync(join(repo, '.claude', 'commands', 'frontend'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'commands', 'deploy.md'), '---\ndescription: Deploy the app\n---\nShip it $ARGUMENTS\n');
    writeFileSync(join(repo, '.claude', 'commands', 'frontend', 'component.md'), '---\ndescription: Scaffold a component\n---\nBody\n');
    mkdirSync(join(repo, '.claude', 'skills', 'ship'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'ship', 'SKILL.md'), '---\nname: ship\ndescription: Ship the branch\n---\nInstructions\n');
    mkdirSync(join(repo, '.claude', 'skills', 'internal'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'internal', 'SKILL.md'), '---\nname: internal\nuser-invocable: false\n---\nHidden\n');
    const list = await items('kind=slash&q=dep&limit=200');
    expect(list[0]).toEqual({ value: '/deploy', label: '/deploy', detail: 'Deploy the app' });
    expect(list.some(item => item.value === '/frontend:component')).toBe(true);
    expect(list.find(item => item.value === '/ship')).toEqual({ value: '/ship', label: '/ship', detail: 'Ship the branch' });
    expect(list.some(item => item.value === '/internal')).toBe(false);
    // Built-ins stay available and head the empty query.
    const top = await items('kind=slash&q=&limit=20');
    expect(top[0]!.value).toBe('/clear');
    expect(top.some(item => item.value === '/model')).toBe(true);
  });

  test('pi Panes get the built-in list; shell Panes get none', async () => {
    const pi = await items('kind=slash&q=mod&limit=10', 'local/fake/p3');
    expect(pi[0]).toEqual({ value: '/model', label: '/model', detail: 'Select a model' });
    expect(await items('kind=slash&q=', 'local/fake/p2')).toEqual([]);
    expect(await items('kind=model&q=', 'local/fake/p2')).toEqual([]);
    // Files complete for a shell Pane too: @ mentions are not Agent-specific.
    const files = await items('kind=file&q=alpha&limit=2', 'local/fake/p2');
    expect(files.map(item => item.value)).toEqual(['alpha.txt', 'beta-alpha.txt']);
  });

  test('model kind returns the Claude aliases, ranked', async () => {
    let list = await items('kind=model&q=&limit=50');
    expect(list.map(item => item.value)).toContain('default');
    expect(list.map(item => item.value)).toContain('opus[1m]');
    list = await items('kind=model&q=fab&limit=10');
    expect(list[0]!.value).toBe('fable');
    list = await items('kind=model&q=1m&limit=10');
    expect(list.slice(0, 3).map(item => item.value).sort()).toEqual(['fable[1m]', 'opus[1m]', 'sonnet[1m]']);
  });

  test('pi models come from pi --list-models, parsed and cached', async () => {
    const table = 'provider      model                       context  max-out  thinking  images\nanthropic     claude-fable-5              1M       128K     yes       yes   \nzai           glm-5                       128K     32K      yes       no    \n';
    let calls = 0;
    const spawn = ((command: string[]) => {
      calls++;
      expect(command).toEqual(['pi', '--list-models']);
      return { stdout: new Response(table).body, exited: Promise.resolve(0), kill() {} };
    }) as unknown as typeof Bun.spawn;
    const first = await paneCompletion(hub, 'local/fake/p3', 'model', '', 50, { spawn });
    expect(first).toEqual([
      { value: 'anthropic/claude-fable-5', label: 'claude-fable-5', detail: 'anthropic' },
      { value: 'zai/glm-5', label: 'glm-5', detail: 'zai' },
    ]);
    const ranked = await paneCompletion(hub, 'local/fake/p3', 'model', 'glm', 50, { spawn });
    expect(ranked[0]!.value).toBe('zai/glm-5');
    expect(calls).toBe(1); // second call served from the cache
  });

  test('validates kind, limit, and pane', async () => {
    let response = await get('kind=nope&q=');
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'kind' });
    response = await get('kind=slash&q=&limit=abc');
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'limit' });
    response = await get('kind=slash&q=&limit=0');
    expect(response.status).toBe(400);
    response = await get('kind=slash&q=', 'local/fake/missing');
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'pane not found' });
    const capped = await items('kind=file&q=&limit=500', 'local/fake/p2');
    expect(capped.length).toBeLessThanOrEqual(200);
  });
});
