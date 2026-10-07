import { describe, expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { remoteTmuxSockets } from '../server/tmux-discover.ts';
import { parseTree, TmuxMux, tmuxKey, type TmuxExec } from '../server/tmux.ts';
import { Hub } from '../server/mux.ts';
import { AGENT_KEYS, MODIFIERS, SHELL_KEYS, trayGroups } from '../web/keys.ts';

const row = (o: { workspace?: string; workspaceLabel?: string; tab?: string; tabLabel?: string; pane?: string; command?: string; cwd?: string; title?: string; cols?: number; rows?: number; left?: number; top?: number; zoomed?: string; active?: string } = {}) => [
  o.workspace ?? '$0', o.workspaceLabel ?? 'work', o.tab ?? '@1', o.tabLabel ?? 'code', o.pane ?? '%0',
  o.command ?? 'sh', o.cwd ?? '/repo', o.title ?? '', String(o.cols ?? 80), String(o.rows ?? 24),
  String(o.left ?? 0), String(o.top ?? 0), o.zoomed ?? '0', o.active ?? '0',
].join('\t');

describe('parseTree', () => {
  test('parses grouping, titles, agents, dimensions, and first-pane cwd', () => {
    const tree = parseTree([
      row({ pane: '%2', command: 'claude', cwd: '/first', title: 'Agent\tTitle', cols: 101, rows: 33, left: 40, top: 12 }),
      row({ pane: '%3', command: 'sh', cwd: '/second', title: '' }),
      row({ workspace: '$2', workspaceLabel: 'other', tab: '@4', tabLabel: 'shell', pane: '%5', command: 'zsh', title: hostname() }),
    ].join('\n'));
    expect(tree.workspaces[0]).toEqual({ id: '$0', label: 'work', cwd: '/first' });
    expect(tree.tabs[0]).toEqual({ id: '@1', workspaceId: '$0', label: 'code' });
    expect(tree.panes[0]).toMatchObject({ id: '%2', title: 'Agent\tTitle', agent: 'claude', cols: 101, rows: 33, x: 40, y: 12, status: 'unknown', revision: 1 });
    expect(tree.panes[1]).toMatchObject({ id: '%3', title: 'sh', x: 0, y: 0 });
    expect(tree.panes[1]!.agent).toBeUndefined();
    expect(tree.panes[2]).toMatchObject({ title: 'zsh' });
  });

  test('omits x and y for every pane of a zoomed window', () => {
    const tree = parseTree([
      row({ pane: '%7', tab: '@7', left: 0, top: 0, zoomed: '1' }),
      row({ pane: '%8', tab: '@7', left: 80, top: 0, zoomed: '1', active: '1' }),
    ].join('\n'));
    // ADR 0006: a zoomed window's rects are hidden bookkeeping, so no cell placement.
    for (const pane of tree.panes) { expect(pane.x).toBeUndefined(); expect(pane.y).toBeUndefined(); }
    // The active Pane is the zoomed one.
    expect(tree.panes.map(pane => pane.zoomed)).toEqual([undefined, true]);
  });
});

function fakeMux() {
  const calls: string[][] = [];
  let treeText = row();
  let captureText = 'same';
  const exec: TmuxExec = async args => {
    calls.push(args);
    return { stdout: args[0] === 'list-panes' ? treeText : args[0] === 'capture-pane' ? captureText : '', stderr: '', code: 0 };
  };
  return {
    calls,
    mux: new TmuxMux({ id: 'test', socket: '/unused', exec, treeIntervalMs: 20, screenIntervalMs: 20 }),
    setTree(value: string) { treeText = value; }, setCapture(value: string) { captureText = value; },
  };
}

describe('TmuxMux', () => {
  test('translates every key preset and extra named keys', () => {
    const expected: Record<string, string> = { esc: 'Escape', up: 'Up', down: 'Down', tab: 'Tab', 'shift+tab': 'BTab', enter: 'Enter', 'ctrl+c': 'C-c', left: 'Left', right: 'Right', c: 'c', d: 'd', l: 'l', r: 'r', backspace: 'BSpace', space: 'Space' };
    for (const name of [...new Set([...AGENT_KEYS, ...SHELL_KEYS].map(([key]) => key)), 'backspace', 'space', 'shift+tab'].filter(name => name !== 'ctrl')) expect(tmuxKey(name)).toBe(expected[name]);
    expect(tmuxKey('A')).toBe('A');
    expect(tmuxKey('ALT+X')).toBe('M-x');
  });

  test('translates every name the Keys tray sends', () => {
    expect(tmuxKey('f1')).toBe('F1');
    expect(tmuxKey('f12')).toBe('F12');
    const names = trayGroups({ shell: true, claude: true, profileKeys: ['f1', 'f10'] })
      .flatMap((group) => group.caps.flatMap((cap) => cap.keys ?? []));
    for (const name of [...names, ...MODIFIERS.map((mod) => `${mod}+r`)]) expect(() => tmuxKey(name)).not.toThrow();
  });

  test('validates keys before sending and sends inputs in one command', async () => {
    const f = fakeMux();
    expect(f.mux.sendKeys('%0', ['bogus'])).rejects.toThrow('invalid_key');
    expect(f.calls).toHaveLength(0);
    await f.mux.sendKeys('%0', ['ctrl+c', 'enter']);
    expect(f.calls).toEqual([['send-keys', '-t', '%0', '--', 'C-c', 'Enter']]);
    await f.mux.sendText('%0', 'hello');
    expect(f.calls.at(-1)).toEqual(['send-keys', '-t', '%0', '-l', '--', 'hello']);
    await f.mux.sendText('%0', '');
    expect(f.calls).toHaveLength(2);
  });

  test('increments revision only when captured text changes', async () => {
    const f = fakeMux();
    expect((await f.mux.read('%0', 'visible')).revision).toBe(1);
    expect((await f.mux.read('%0', 'visible')).revision).toBe(1);
    f.setCapture('changed');
    expect((await f.mux.read('%0', 'recent')).revision).toBe(2);
    expect((await f.mux.tree()).panes[0]!.revision).toBe(2);
  });

  test('unsupported operations reject and explain resolves null', async () => {
    const f = fakeMux();
    expect(f.mux.newTab('$0', {})).rejects.toThrow('unsupported');
    expect(f.mux.newWorkspace({})).rejects.toThrow('unsupported');
    expect(f.mux.rename({ paneId: '%0' }, 'x')).rejects.toThrow('unsupported');
    expect(f.mux.closePane('%0')).rejects.toThrow('unsupported');
    expect(await f.mux.explain('%0')).toBeNull();
  });

  test('the -V probe ships the version to Hub state without a tree change', async () => {
    // -V resolves late, so the first refresh provably misses it; the tree text never changes,
    // and with no refresh interval only the probe's own nudge can deliver the version.
    const exec: TmuxExec = async args => {
      if (args[0] === '-V') { await Bun.sleep(10); return { stdout: 'tmux 3.4\n', stderr: '', code: 0 }; }
      return { stdout: row(), stderr: '', code: 0 };
    };
    const mux = new TmuxMux({ id: 'test', socket: '/unused', exec, treeIntervalMs: 60_000, screenIntervalMs: 60_000 });
    const hub = new Hub({ refreshMs: 0, suggest: null });
    try {
      hub.add('local', mux);
      expect((await hub.state()).muxes[0]!.version).toBeUndefined();
      const deadline = Date.now() + 2_000;
      let version: string | undefined;
      while (Date.now() < deadline && !version) { await Bun.sleep(20); version = (await hub.state()).muxes[0]!.version; }
      expect(version).toBe('3.4');
    } finally {
      hub.close();
    }
  });

  test('polls tree and watched screens, then stops after unsubscribe', async () => {
    const f = fakeMux();
    const events: (string[] | 'all')[] = [];
    const off = f.mux.onChange(value => events.push(value));
    await Bun.sleep(30);
    f.setTree(`${row()}\n${row({ pane: '%1' })}`);
    const treeDeadline = Date.now() + 500;
    while (!events.includes('all') && Date.now() < treeDeadline) await Bun.sleep(10);
    expect(events).toContain('all');

    await f.mux.read('%0', 'visible');
    f.setCapture('new screen');
    const screenDeadline = Date.now() + 500;
    while (!events.some(value => Array.isArray(value) && value.includes('%0')) && Date.now() < screenDeadline) await Bun.sleep(10);
    expect(events.some(value => Array.isArray(value) && value.includes('%0'))).toBe(true);

    off();
    await Bun.sleep(30);
    const count = f.calls.length;
    await Bun.sleep(60);
    expect(f.calls).toHaveLength(count);
    f.mux.close();
  });
});

test('remoteTmuxSockets resolves the uid, filters names, and checks candidates', async () => {
  const commands: string[] = [];
  const result = await remoteTmuxSockets(async cmd => {
    commands.push(cmd);
    if (cmd === 'id -u') return { stdout: '1000\n', stderr: '', code: 0 };
    if (cmd.startsWith('ls ')) return { stdout: 'default\nbad name\nother\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: cmd.includes('/default ') ? 0 : 1 };
  });
  expect(result).toEqual([{ id: 'default', socketPath: '/tmp/tmux-1000/default' }]);
  expect(commands.some(command => command.includes('bad name'))).toBe(false);
});
