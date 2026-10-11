import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import { TmuxMux } from '../server/tmux.ts';
import type { Integration, PluginAction, State } from '../shared/types.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

const tmuxAvailable = Bun.which('tmux') !== null && process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1';
const eventually = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(50); value = await read(); }
  return value;
};

// A plugin written for this test: a pane action whose effect is observable (it dumps the env
// herdr gave it), a global-only action (hidden from the list), a contextless one (shows as
// pane), and a mixed pane+global one (keeps only pane).
const pluginFiles = (out: string) => ({
  'herdr-plugin.toml': `id = "tautan.test-plugin"
name = "Tautan Test Plugin"
version = "0.1.0"
min_herdr_version = "0.7.0"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "mark"
title = "Mark the pane"
description = "Writes the invocation env to a file"
contexts = ["pane", "global"]
command = ["/bin/sh", "-c", "env > ${out}"]

[[actions]]
id = "global-only"
title = "Global only"
contexts = ["global"]
command = ["/bin/sh", "-c", ":"]

[[actions]]
id = "plain"
title = "No contexts"
command = ["/bin/sh", "-c", ":"]
`,
});

describe.skipIf(!herdrAvailable)('plugin and Agent contract', () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>>;
  let mux: ReturnType<typeof herdrMux>;
  let hub: Hub;
  let server: ReturnType<typeof startHttp>;
  let paneId: string;
  let workspaceId: string;
  let tabId: string;
  let out: string;
  const origin = () => `http://127.0.0.1:${server.port}`;
  const paneKey = () => `contract/throwaway/${paneId}`;
  const statePane = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/state`)).json() as State).panes.find(pane => pane.id === paneId);

  beforeAll(async () => {
    fixture = await startThrowawayHerdr();
    // Link the test plugin into the throwaway (isolated config, so the live set is untouched).
    const pluginDir = join(fixture.dir, 'test-plugin');
    await mkdir(pluginDir);
    out = join(fixture.dir, 'mark-env.txt');
    for (const [name, body] of Object.entries(pluginFiles(out))) await writeFile(join(pluginDir, name), body);
    await herdrRpc(fixture.sock, 'plugin.link', { path: pluginDir });
    mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'plugins-contract' });
    workspaceId = workspace.id;
    const tree = await mux.tree();
    paneId = tree.panes.find(pane => pane.workspaceId === workspaceId)!.id;
    tabId = tree.panes.find(pane => pane.id === paneId)!.tabId;
    await herdrRpc(fixture.sock, 'pane.report_agent', { pane_id: paneId, source: 'tautan-contract', agent: 'claude', state: 'idle' });
    hub = new Hub(); hub.add('contract', mux); await hub.state();
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
  }, 30_000);

  afterAll(async () => { server?.stop(); hub?.close(); await fixture?.stop(); });

  test('lists pane actions with plugin names, hides global-only, defaults contexts to pane', async () => {
    const list = async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/panes/${encodeURIComponent(paneKey())}/actions`);
      return { status: response.status, body: await response.json() as { actions: PluginAction[] } };
    };
    const { status, body } = await eventually(list, result => result.status === 200, 5_000);
    expect(status).toBe(200);
    const { actions } = body;
    const byId = new Map(actions.map(action => [action.actionId, action]));
    expect(byId.get('mark')).toMatchObject({ pluginId: 'tautan.test-plugin', plugin: 'Tautan Test Plugin', title: 'Mark the pane', description: 'Writes the invocation env to a file' });
    expect(byId.get('mark')!.contexts).toEqual(['pane']); // mixed pane+global keeps pane only
    expect(byId.get('plain')!.contexts).toEqual(['pane']); // no contexts shows on the Pane menu
    expect(byId.has('global-only')).toBe(false);          // global drives herdr's own window
  }, 10_000);

  test('invokes a pane action; herdr passes the Pane context herdr derives from ours', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/panes/${encodeURIComponent(paneKey())}/actions/mark`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: origin() }, body: '{}',
    });
    expect(response.status).toBe(204);
    const env = await eventually(async () => existsSync(out) ? await readFile(out, 'utf8') : '', text => text.length > 0, 10_000);
    expect(env).toContain('HERDR_PLUGIN_ID=tautan.test-plugin');
    expect(env).toContain('HERDR_PLUGIN_ACTION_ID=mark');
    const context = JSON.parse(/^HERDR_PLUGIN_CONTEXT_JSON=(.+)$/m.exec(env)![1]!);
    expect(context).toMatchObject({ focused_pane_id: paneId, workspace_id: workspaceId, tab_id: tabId });
    // The cwd fields come from the tree tautan already holds, not a fresh read.
    expect(context.focused_pane_cwd).toBe(fixture.dir);
  }, 15_000);

  test('renames the Agent, shows agentName in state, keeps the agent type, and clears on empty', async () => {
    const rename = (label: string) => fetch(`http://127.0.0.1:${server.port}/api/rename`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: origin() },
      body: JSON.stringify({ muxKey: 'contract/throwaway', paneId, label, agent: true }),
    });
    expect((await rename('reviewer')).status).toBe(204);
    const renamed = (await eventually(async () => await statePane(), pane => pane?.agentName === 'reviewer', 5_000))!;
    expect(renamed.agentName).toBe('reviewer');
    expect(renamed.agent).toBe('claude'); // Batch 3 rule: `agent` stays the Agent TYPE
    expect((await rename('  ')).status).toBe(204);
    const cleared = (await eventually(async () => await statePane(), pane => pane?.agentName === undefined, 5_000))!;
    expect(cleared.agentName).toBeUndefined();
  }, 10_000);

  test('Settings carries this Host integration list', async () => {
    const settings = await (await fetch(`http://127.0.0.1:${server.port}/api/settings`)).json() as { integrations?: { muxKey: string; label: string; integrations?: Integration[]; error?: string }[] };
    const entry = settings.integrations?.find(item => item.muxKey === 'contract/throwaway');
    expect(entry?.error).toBeUndefined();
    const claude = entry?.integrations?.find(item => item.target === 'claude');
    expect(claude).toBeTruthy();
    expect(typeof claude!.command).toBe('string');
    expect(typeof claude!.available).toBe('boolean');
    expect(['not_installed', 'current', 'outdated']).toContain(claude!.state);
  }, 10_000);
});

describe.skipIf(!tmuxAvailable)('tmux answers 501 for the plugin and Agent routes', () => {
  let dir: string;
  let sock: string;
  let hub: Hub;
  let server: ReturnType<typeof startHttp>;
  let paneKey: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tautan-plugins-tmux-'));
    sock = join(dir, 't.sock');
    const proc = Bun.spawn(['tmux', '-f', '/dev/null', '-S', sock, 'new', '-d', '-s', 't', '-x', '80', '-y', '24', 'exec sh'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    await eventually(async () => {
      const check = Bun.spawn(['tmux', '-S', sock, 'list-panes', '-a'], { stdout: 'ignore', stderr: 'ignore' });
      return await check.exited;
    }, code => code === 0, 5_000);
    const mux = new TmuxMux({ id: 't', socket: sock, treeIntervalMs: 200, screenIntervalMs: 100 });
    hub = new Hub(); hub.add('tmux-local', mux); await hub.state();
    paneKey = `tmux-local/t/${(await mux.tree()).panes[0]!.id}`;
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir });
  }, 15_000);

  afterAll(async () => {
    server?.stop(); hub?.close();
    if (sock) { try { const kill = Bun.spawn(['tmux', '-S', sock, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }); await kill.exited; } catch {} }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('501 for the actions list, the invoke, and an Agent rename; integrations stay empty', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const origin = base;
    const list = await fetch(`${base}/api/panes/${encodeURIComponent(paneKey)}/actions`);
    expect(list.status).toBe(501); expect(await list.json()).toEqual({ error: 'unsupported' });
    const invoke = await fetch(`${base}/api/panes/${encodeURIComponent(paneKey)}/actions/mark`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}',
    });
    expect(invoke.status).toBe(501); expect(await invoke.json()).toEqual({ error: 'unsupported' });
    const rename = await fetch(`${base}/api/rename`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ muxKey: 'tmux-local/t', paneId: paneKey.split('/')[2]!, label: 'x', agent: true }),
    });
    expect(rename.status).toBe(501); expect(await rename.json()).toEqual({ error: 'unsupported' });
    const settings = await (await fetch(`${base}/api/settings`)).json() as { integrations?: unknown[] };
    expect(settings.integrations).toEqual([]); // tmux Muxes are left out entirely
  }, 10_000);
});
