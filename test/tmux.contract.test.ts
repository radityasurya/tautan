import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TmuxMux, type TmuxExec } from '../server/tmux.ts';
import { AGENT_KEYS, SHELL_KEYS } from '../web/keys.ts';

const tmuxAvailable = Bun.which('tmux') !== null && process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1';
const eventually = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(50); value = await read(); }
  return value;
};

describe.skipIf(!tmuxAvailable)('TmuxMux contract', () => {
  let dir: string;
  let sock: string;
  let mux: TmuxMux;
  let paneId: string;

  const tmux = async (args: string[]) => {
    const proc = Bun.spawn(['tmux', '-S', sock, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(stderr.trim() || 'tmux failed');
    return stdout;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tautan-tmux-'));
    sock = join(dir, 't.sock');
    const proc = Bun.spawn(['tmux', '-f', '/dev/null', '-S', sock, 'new', '-d', '-s', 't', '-x', '80', '-y', '24', 'exec sh'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    const ready = await eventually(async () => {
      const check = Bun.spawn(['tmux', '-S', sock, 'list-panes', '-a'], { stdout: 'ignore', stderr: 'ignore' });
      return await check.exited;
    }, code => code === 0, 5_000);
    expect(ready).toBe(0);
    mux = new TmuxMux({ id: 't', socket: sock, treeIntervalMs: 200, screenIntervalMs: 100 });
    paneId = (await mux.tree()).panes[0]!.id;
  }, 15_000);

  afterAll(async () => {
    mux?.close();
    if (sock) { try { await tmux(['kill-server']); } catch {} }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('tree returns one workspace, tab, and pane with dimensions', async () => {
    const tree = await mux.tree();
    expect(tree.workspaces).toHaveLength(1); expect(tree.tabs).toHaveLength(1); expect(tree.panes).toHaveLength(1);
    expect(tree.workspaces[0]!.label).toBe('t');
    expect(tree.panes[0]).toMatchObject({ cols: 80, rows: 24 });
  });

  test('text and keys reach visible and recent screens', async () => {
    await mux.sendText(paneId, 'echo tautan-ok'); await mux.sendKeys(paneId, ['enter']);
    const visible = await eventually(() => mux.read(paneId, 'visible'), value => value.text.includes('tautan-ok'), 5_000);
    expect(visible).toMatchObject({ ansi: true }); expect(visible.text).toContain('tautan-ok');
    const recent = await mux.read(paneId, 'recent');
    expect(recent).toMatchObject({ ansi: false }); expect(recent.text).toContain('tautan-ok');
  });

  test('onChange fires after a send to a watched pane', async () => {
    await mux.read(paneId, 'visible');
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { off(); reject(new Error('onChange timed out')); }, 3_000);
      const off = mux.onChange(ids => {
        if (ids === 'all' || ids.includes(paneId)) { clearTimeout(timeout); off(); resolve(); }
      });
    });
    await mux.sendText(paneId, `echo change-${Date.now()}`); await mux.sendKeys(paneId, ['enter']);
    await changed;
  });

  test('all key-bar names are accepted', async () => {
    const originalTabId = (await mux.tree()).panes.find(item => item.id === paneId)!.tabId;
    await tmux(['new-window', '-d', '-n', 'keys', 'exec sh']);
    // ctrl+c and ctrl+d at the end of the list can kill the window's shell while it is
    // still starting (the default-shell wrap is not instant), which would fail the NEXT
    // send with `can't find pane`. A retained pane keeps every key name checkable.
    await tmux(['set-option', '-t', 'keys', 'remain-on-exit', 'on']);
    const keyPane = (await mux.tree()).panes.find(pane => pane.tabId !== originalTabId)?.id;
    expect(keyPane).toBeTruthy();
    const names = [...new Set([...AGENT_KEYS, ...SHELL_KEYS].map(([name]) => name)), 'backspace', 'space', 'shift+tab'];
    const safe = names.filter(name => name !== 'ctrl' && name !== 'ctrl+c' && name !== 'ctrl+d');
    for (const name of safe) await mux.sendKeys(keyPane!, [name]);
    for (const name of ['ctrl+c', 'ctrl+d']) await mux.sendKeys(keyPane!, [name]);
  });

  test('unsupported operations reject and explain resolves null', async () => {
    expect(mux.newTab('$0', {})).rejects.toThrow('unsupported');
    expect(mux.newWorkspace({})).rejects.toThrow('unsupported');
    expect(mux.rename({ paneId }, 'x')).rejects.toThrow('unsupported');
    expect(mux.closePane(paneId)).rejects.toThrow('unsupported');
    expect(await mux.explain(paneId)).toBeNull();
  });

  test.skipIf(Bun.which('bash') === null)('detects an agent command', async () => {
    await tmux(['new-window', '-d', '-n', 'agent', "bash -c 'exec -a claude sleep 30'"]);
    const tree = await eventually(() => mux.tree(), value => value.panes.some(pane => pane.agent === 'claude'), 3_000);
    expect(tree.panes.some(pane => pane.agent === 'claude')).toBe(true);
  });
});

describe.skipIf(!tmuxAvailable)('TmuxMux control mode', () => {
  let dir: string;
  let sock: string;

  const tmux = async (args: string[]) => {
    const proc = Bun.spawn(['tmux', '-S', sock, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(stderr.trim() || 'tmux failed');
    return stdout;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tautan-tmuxctl-'));
    sock = join(dir, 't.sock');
    const proc = Bun.spawn(['tmux', '-f', '/dev/null', '-S', sock, 'new', '-d', '-s', 't', '-x', '80', '-y', '24', 'exec cat'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    await eventually(async () => {
      const check = Bun.spawn(['tmux', '-S', sock, 'list-panes', '-a'], { stdout: 'ignore', stderr: 'ignore' });
      return await check.exited;
    }, code => code === 0, 5_000);
    for (let i = 0; i < 5; i++) await tmux(['new-window', '-d', '-t', 't', 'exec cat']);
  }, 15_000);

  afterAll(async () => {
    if (sock) { try { await tmux(['kill-server']); } catch {} }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('idle watched Panes cost no captures; output re-captures only its Pane; close kills the client', async () => {
    let captures = 0;
    const exec: TmuxExec = async args => {
      if (args[0] === 'capture-pane') captures++;
      const proc = Bun.spawn(['tmux', '-S', sock, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    const mux = new TmuxMux({ id: 'ctl', socket: sock, exec, treeIntervalMs: 200, screenIntervalMs: 100 });
    const size = () => tmux(['display-message', '-p', '-t', 't', '#{window_width}x#{window_height}']);
    try {
      const panes = (await mux.tree()).panes.map(pane => pane.id);
      expect(panes).toHaveLength(6);
      const sizeBefore = (await size()).trim();
      const changed: (string[] | 'all')[] = [];
      const off = mux.onChange(ids => changed.push(ids));
      for (const pane of panes) await mux.read(pane, 'visible'); // watch all six: the control client attaches on the first
      captures = 0; // the reads are their own captures; measure the idle steady state
      await Bun.sleep(2_500);
      // Polling cost before: 6 idle Panes × 1 capture/s ≈ 15 captures here. A healthy control
      // client pushes %output instead, so idle costs zero.
      expect(captures).toBe(0);
      const clients = (await tmux(['list-clients', '-F', '#{client_control} #{client_readonly} [#{client_flags}]'])).trim();
      expect(clients).toContain('control-mode');
      expect(clients).toContain('read-only');
      expect(clients).toContain('ignore-size');
      expect((await size()).trim()).toBe(sizeBefore); // the client never resized the Workspace
      await mux.sendText(panes[2]!, 'hello-control'); // cat echoes it: %output → one sweep, one capture
      await eventually(() => Promise.resolve(changed), list => list.some(ids => Array.isArray(ids) && ids.includes(panes[2]!)), 3_000);
      expect(changed.filter(Array.isArray).flat().filter(id => id !== panes[2])).toHaveLength(0); // only its Pane changed
      expect(captures).toBeLessThanOrEqual(2); // the sweep, not a poll of all six
    } finally {
      mux.close();
      const gone = await eventually(async () => (await tmux(['list-clients'])).trim(), value => value === '', 2_000);
      expect(gone).toBe(''); // hub.close() → mux.close() kills the control client
    }
  }, 15_000);
});
