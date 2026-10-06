import { expect, test } from 'bun:test';
import type { Explain, Mux, Pane, Screen, ScreenEvent, ScreenMode, Tree, Workspace } from '../shared/types.ts';
import { startHttp } from '../server/http.ts';
import { hostId } from '../server/hosts.ts';
import { Hub } from '../server/mux.ts';
import { offeredKeys } from '../shared/blocked.ts';
import { isUnseen } from '../shared/seen.ts';

test('Hub adds tabs, status timestamps, and cached agent last lines', async () => {
  let reads = 0;
  const tree: Tree = {
    workspaces: [{ id: 'w1', label: 'Work' }],
    tabs: [{ id: 't1', workspaceId: 'w1', label: 'Tab' }],
    panes: [
      { id: 'agent', tabId: 't1', workspaceId: 'w1', title: 'Agent', agent: 'codex', status: 'working', revision: 1 },
      { id: 'shell', tabId: 't1', workspaceId: 'w1', title: 'Shell', status: 'unknown', revision: 1 },
    ],
  };
  const mux: Mux = {
    kind: 'herdr', id: 'fake', socketPath: '/run/tautan/host-main.sock', tree: async () => tree,
    read: async (_paneId: string, mode: ScreenMode): Promise<Screen> => { reads++; return { text: 'first\n\x1b[31m last line \x1b[0m\n\n', ansi: true, revision: 1, mode }; },
    sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {},
    newTab: async (): Promise<Pane> => tree.panes[0]!, newWorkspace: async (): Promise<Workspace> => tree.workspaces[0]!,
    rename: async () => {}, closePane: async () => {}, closeWorkspace: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {},
  };
  const hub = new Hub(); hub.add('local', mux);
  const first = await hub.state();
  expect(first.muxes).toEqual([{ key: 'local/fake', hostId: 'local', kind: 'herdr', label: 'fake', online: true, socket: '/run/tautan/host-main.sock' }]);
  expect(first.tabs).toEqual([{ key: 'local/fake/t1', muxKey: 'local/fake', id: 't1', workspaceId: 'w1', label: 'Tab' }]);
  expect(first.panes.find(pane => pane.id === 'agent')?.lastLine).toBe('last line');
  expect(first.panes.find(pane => pane.id === 'shell')?.lastLine).toBeUndefined();
  const firstAt = first.panes[0]!.statusChangedAt!;
  expect(firstAt).toBeNumber(); expect(reads).toBe(1);
  await hub.refreshHost('local'); expect(reads).toBe(1);
  await Bun.sleep(2); tree.panes[0]!.status = 'done';
  await hub.refreshHost('local');
  expect((await hub.state()).panes[0]!.statusChangedAt).toBeGreaterThan(firstAt);
  expect(reads).toBe(1);
  hub.close();
});

test('host retry runs discovery and returns the refreshed host', async () => {
  let discoveries = 0;
  let refreshes = 0;
  let handle: ((request: Request) => Response | Promise<Response>) | undefined;
  const hub = {
    hasMux: () => true,
    add: () => {},
    refreshHost: async (id: string) => { expect(id).toBe(hostId); refreshes++; },
    state: async () => ({
      hosts: [{ id: hostId, label: hostId, online: true, source: 'local' as const }],
      muxes: [], workspaces: [], tabs: [], panes: [],
    }),
  } as unknown as Hub;
  const serve = Bun.serve;
  try {
    Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return {} as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve;
    startHttp(hub, {
      port: 0, hostname: '127.0.0.1', staticDir: import.meta.dir,
      discover: async () => { discoveries++; return [{ id: 'fake', socketPath: '/unused' }]; },
    });
  } finally {
    Bun.serve = serve;
  }
  const response = await handle!(new Request(`http://tautan.test/api/hosts/${encodeURIComponent(hostId)}/retry`, {
    method: 'POST', headers: { host: 'tautan.test', origin: 'http://tautan.test' },
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: hostId, label: hostId, online: true, source: 'local' });
  expect(discoveries).toBe(1);
  expect(refreshes).toBe(1);
});

test('a new device seeds done revisions while blocked panes remain actionable', () => {
  const base = { muxKey: 'local/fake', workspaceId: 'w1', tabId: 't1', title: 'Pane', seenRevision: 0 };
  const done = { ...base, key: 'done', id: 'done', status: 'done' as const, revision: 7 };
  const blocked = { ...base, key: 'blocked', id: 'blocked', status: 'blocked' as const, revision: 4 };
  const seeded = { [done.key]: done.revision, [blocked.key]: blocked.revision };
  expect(isUnseen(done, seeded)).toBe(false);
  expect(isUnseen(blocked, seeded)).toBe(true);
  expect(isUnseen({ ...done, statusChangedAt: 2_000_000_000_000 }, { done: 1_900_000_000_000 })).toBe(true);
});

test('offeredKeys leads with Yes/No on an approval box and leaves a plain menu alone', () => {
  const footer = [{ key: 'esc', label: 'cancel' }, { key: 'enter', label: 'confirm' }];
  const approval: Explain = {
    ruleId: 'live_blocked_form', state: 'blocked', hintKeys: footer,
    detection: 'Bash command\nDo you want to proceed?\n\u276f 1. Yes\n3. No, and tell Claude what to do differently (esc)\n',
  };
  // The preset leads and the footer's own names for the same two keys drop.
  expect(offeredKeys(approval)).toEqual([{ key: 'enter', label: 'Yes' }, { key: 'esc', label: 'No' }]);
  // Idempotent: the Hub applies it, the card applies it again.
  expect(offeredKeys({ ...approval, hintKeys: offeredKeys(approval) })).toEqual(offeredKeys(approval));
  const menu: Explain = {
    ruleId: 'live_blocked_form', state: 'blocked', hintKeys: footer,
    detection: 'Select a model\n\u276f 1. Opus\n2. Sonnet\n',
  };
  expect(offeredKeys(menu)).toEqual(footer);
});

// ADR 0006: one listener watches two Panes; each key polls on its own 250 ms \u2192 \u00d71.5 \u2192 2 s backoff.
const watchFixture = () => {
  const reads = { a: [] as number[], b: [] as number[] };
  const text: Record<string, () => string> = {};
  let fire: (ids: string[]) => void = () => {};
  const tree: Tree = {
    workspaces: [{ id: 'w1', label: 'W' }],
    tabs: [{ id: 't1', workspaceId: 'w1', label: 'T' }],
    panes: [
      { id: 'a', tabId: 't1', workspaceId: 'w1', title: 'A', status: 'unknown', revision: 1 },
      { id: 'b', tabId: 't1', workspaceId: 'w1', title: 'B', status: 'unknown', revision: 1 },
    ],
  };
  const mux: Mux = {
    kind: 'herdr', id: 'fake', socketPath: '/run/tautan/watch.sock',
    tree: async () => tree,
    read: async (paneId: string, mode: ScreenMode): Promise<Screen> => {
      reads[paneId as 'a' | 'b'].push(Date.now());
      return { text: text[paneId] ? text[paneId]!() : 'same', ansi: true, revision: 1, mode };
    },
    sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {},
    onChange: cb => { fire = cb; return () => {}; },
    newTab: async (): Promise<Pane> => tree.panes[0]!, newWorkspace: async (): Promise<Workspace> => tree.workspaces[0]!,
    rename: async () => {}, closePane: async () => {}, closeWorkspace: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {},
  };
  const hub = new Hub({ refreshMs: 0, suggest: null });
  hub.add('local', mux);
  return { reads, fire, textFor: (pane: 'a' | 'b', fn: () => string) => { text[pane] = fn; }, hub };
};

const until = async <T>(read: () => T, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(10); value = await read(); }
  return value;
};

test('two watched panes on one listener back off independently', async () => {
  const f = watchFixture();
  let tick = 0;
  f.textFor('a', () => `tick ${tick++}`); // a new Screen every read \u2192 key a stays fast
  const screens: ScreenEvent[] = [];
  const off = f.hub.subscribe({ paneKeys: ['local/fake/a', 'local/fake/b'], onState: () => {}, onScreen: screen => screens.push(screen) });
  try {
    await until(() => screens.length, count => count >= 2, 2_000);
    await Bun.sleep(2_400); // key b goes 250 \u2192 \u00d71.5 \u2192 \u2026; key a keeps changing
    const gap = (pane: 'a' | 'b') => { const at = f.reads[pane]; return at.at(-1)! - at.at(-2)!; };
    expect(f.reads.a.length).toBeGreaterThan(f.reads.b.length);
    expect(gap('a')).toBeLessThan(450);
    expect(gap('b')).toBeGreaterThan(700);
  } finally { off(); f.hub.close(); }
}, 8_000);

test('a change on one key re-polls only that key', async () => {
  const f = watchFixture(); // both panes return a constant screen
  const screens: ScreenEvent[] = [];
  const off = f.hub.subscribe({ paneKeys: ['local/fake/a', 'local/fake/b'], onState: () => {}, onScreen: screen => screens.push(screen) });
  try {
    await until(() => screens.length, count => count >= 2, 2_000); // first Screens out; next polls due at +250 ms
    f.textFor('b', () => 'changed');
    f.fire(['b']); // a Mux change for b only \u2192 b re-polls at 150 ms, a keeps its own schedule
    await until(() => screens, list => list.some(screen => screen.key === 'local/fake/b' && screen.text === 'changed'), 1_000);
    expect(f.reads.b.length).toBeGreaterThanOrEqual(2);
    // a was not pulled to the 150 ms re-poll: any extra read of a is its own \u2265250 ms cadence.
    expect(f.reads.a.slice(1).every(at => at - f.reads.a[0]! >= 240)).toBe(true);
  } finally { off(); f.hub.close(); }
}, 5_000);
