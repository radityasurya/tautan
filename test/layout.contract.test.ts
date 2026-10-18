import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostId } from '../server/hosts.ts';
import { Hub } from '../server/mux.ts';
import { startHttp } from '../server/http.ts';
import { TmuxMux } from '../server/tmux.ts';
import type { Mux, State, StatePane } from '../shared/types.ts';
import { herdrAvailable, herdrMux, startThrowawayHerdr } from './harness.ts';

const tmuxAvailable = Bun.which('tmux') !== null && process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1';

/** A Hub plus its HTTP routes on a throwaway port, driven with plain fetch. */
async function serve(mux: Mux, staticDir: string) {
  const hub = new Hub({ refreshMs: 0, suggest: null });
  hub.add(hostId, mux);
  await hub.state();
  const server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir, discover: async () => [] });
  const base = `http://127.0.0.1:${server.port}`;
  const muxKey = `${hostId}/${mux.id}`;
  return {
    base, muxKey, stop: () => { server.stop(); hub.close(); },
    state: async (): Promise<State> => await (await fetch(`${base}/api/state`)).json(),
    post: (paneKey: string, action: string, body: unknown) =>
      fetch(`${base}/api/panes/${encodeURIComponent(paneKey)}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body ?? {}),
      }),
    write: (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) }),
  };
}

/** The ADR 0008 route contract both backends share: split ratio, resize cells, swap rects,
 *  move to an existing Tab, and the 400 battery. Returns the moved Pane's key. */
async function layoutStory(api: Awaited<ReturnType<typeof serve>>, rootId: string, tabId: string, otherTabId: string): Promise<string> {
  const { state, post, muxKey } = api;
  const pane = async (id: string): Promise<StatePane> => (await state()).panes.find(item => item.id === id && item.muxKey === muxKey)
    ?? expect.unreachable(`pane ${id} missing`);
  const byKey = async (key: string): Promise<StatePane> => (await state()).panes.find(item => item.key === key)
    ?? expect.unreachable(`pane key ${key} missing`);

  // Split: the new Pane takes `ratio` of the Tab, and both Panes still tile the Tab's width.
  const width = (await pane(rootId)).cols!;
  const split = await post(`${muxKey}/${rootId}`, 'split', { direction: 'right', ratio: 0.3 });
  expect(split.status).toBe(201);
  const splitKey = ((await split.json()) as { paneKey: string }).paneKey;
  const fresh = await byKey(splitKey);
  expect(fresh.tabId).toBe(tabId);
  expect(Math.abs(fresh.cols! - 0.3 * width)).toBeLessThanOrEqual(1);
  expect(Math.abs((await pane(rootId)).cols! + fresh.cols! - width)).toBeLessThanOrEqual(1);

  // Resize: `amount` whole cells in the direction the Pane grows; the reply is already in state.
  const beforeResize = (await pane(rootId)).cols!;
  expect((await post(`${muxKey}/${rootId}`, 'resize', { direction: 'right', amount: 5 })).status).toBe(204);
  expect(Math.abs((await pane(rootId)).cols! - (beforeResize + 5))).toBeLessThanOrEqual(1);
  expect(Math.abs((await byKey(splitKey)).cols! - (fresh.cols! - 5))).toBeLessThanOrEqual(1);

  // Swap: the two Panes trade rects.
  const before = { root: (await pane(rootId)).x, fresh: (await byKey(splitKey)).x };
  expect(before.root).not.toBe(before.fresh);
  expect((await post(`${muxKey}/${rootId}`, 'swap', { target: splitKey })).status).toBe(204);
  expect((await pane(rootId)).x).toBe(before.fresh);
  expect((await byKey(splitKey)).x).toBe(before.root);

  // Move to an existing Tab: 201 with the moved Pane's current key; the Tab's seed keeps the rest.
  const seedWidth = (await state()).panes.find(item => item.tabId === otherTabId && item.muxKey === muxKey)!.cols!;
  const move = await post(`${muxKey}/${rootId}`, 'move', { tab: `${muxKey}/${otherTabId}`, split: 'right', ratio: 0.4 });
  expect(move.status).toBe(201);
  const movedKey = ((await move.json()) as { paneKey: string }).paneKey;
  const moved = await byKey(movedKey);
  expect(moved.tabId).toBe(otherTabId);
  expect(Math.abs(moved.cols! - 0.4 * seedWidth)).toBeLessThanOrEqual(1);
  expect((await state()).panes.filter(item => item.tabId === otherTabId)).toHaveLength(2);

  // Bad bodies and unknown Panes.
  expect((await post(movedKey, 'split', { direction: 'up' })).status).toBe(400);
  expect((await post(movedKey, 'split', { direction: 'right', ratio: 1 })).status).toBe(400);
  expect((await post(movedKey, 'move', { newTab: true, newWorkspace: true })).status).toBe(400);
  expect((await post(movedKey, 'resize', { direction: 'left', amount: 0 })).status).toBe(400);
  expect((await post(`${muxKey}/nope`, 'split', { direction: 'right' })).status).toBe(404);
  return movedKey;
}

test.skipIf(!herdrAvailable)('herdr: layout edits through the Hub', async () => {
  const fixture = await startThrowawayHerdr();
  try {
    const mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'layout' });
    const root = (await mux.tree()).panes.find(pane => pane.workspaceId === workspace.id)!;
    const api = await serve(mux, fixture.dir);
    try {
      // A second Tab in the same Workspace, through the write route the product itself uses.
      const tab = await api.write(`/api/muxes/${encodeURIComponent(api.muxKey)}/tabs`, { workspaceId: root.workspaceId, cwd: fixture.dir, label: 'Other' });
      expect(tab.status).toBe(201);
      const otherTabId = (await api.state()).tabs.find(item => item.id !== root.tabId && item.muxKey === api.muxKey)!.id;
      const movedKey = await layoutStory(api, root.id, root.tabId, otherTabId);

      // Move to a new Tab: the old Tab loses the Pane, the Pane keeps its key.
      const newTab = await api.post(movedKey, 'move', { newTab: true });
      expect(newTab.status).toBe(201);
      const inNewTab = ((await newTab.json()) as { paneKey: string }).paneKey;
      const afterNewTab = await api.state();
      expect(afterNewTab.panes.find(item => item.key === inNewTab)!.tabId).not.toBe(otherTabId);
      expect(afterNewTab.panes.filter(item => item.tabId === otherTabId)).toHaveLength(1);

      // Move to a new Workspace: the key changes (herdr renumbers), the Workspace exists, the Tab is empty.
      const moved = await api.post(inNewTab, 'move', { newWorkspace: true, label: 'Moved' });
      expect(moved.status).toBe(201);
      const workspaceKey = ((await moved.json()) as { paneKey: string }).paneKey;
      expect(workspaceKey).not.toBe(inNewTab);
      const after = await api.state();
      const arrived = after.panes.find(item => item.key === workspaceKey)!;
      expect(after.workspaces.find(item => item.id === arrived.workspaceId)?.label).toBe('Moved');
      expect(after.panes.some(item => item.key === inNewTab)).toBe(false); // the old key is gone
      expect(after.panes.filter(item => item.workspaceId === arrived.workspaceId)).toHaveLength(1);

      // Clamp: a shrinking Pane never goes below herdr's 12-cell minimum.
      const split = await api.post(workspaceKey, 'split', { direction: 'right', ratio: 0.5 });
      const rightKey = ((await split.json()) as { paneKey: string }).paneKey;
      expect((await api.post(workspaceKey, 'resize', { direction: 'left', amount: 500 })).status).toBe(204);
      expect((await api.state()).panes.find(item => item.key === rightKey)!.cols!).toBeGreaterThanOrEqual(12);
    } finally { api.stop(); }
  } finally { await fixture.stop(); }
}, 90_000);

test.skipIf(!tmuxAvailable)('tmux: layout edits through the Hub', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tautan-tmux-layout-'));
  const sock = join(dir, 't.sock');
  const tmux = (args: string[]) => Bun.spawn(['tmux', '-f', '/dev/null', '-S', sock, ...args], { stdout: 'ignore', stderr: 'ignore' }).exited;
  try {
    expect(await tmux(['new', '-d', '-s', 'l', '-x', '120', '-y', '30', 'exec sh'])).toBe(0);
    expect(await tmux(['new-window', '-d', '-n', 'other', 'exec sh'])).toBe(0);
    const mux = new TmuxMux({ id: 'l', socket: sock, treeIntervalMs: 60_000, screenIntervalMs: 60_000 });
    const tree = await mux.tree();
    const root = tree.panes[0]!;
    const api = await serve(mux, dir);
    try {
      const otherTabId = tree.tabs.find(tab => tab.id !== root.tabId)!.id;
      const movedKey = await layoutStory(api, root.id, root.tabId, otherTabId);
      expect(movedKey).toBe(`${api.muxKey}/${root.id}`); // tmux pane ids are stable across moves

      // Move to a new Tab (break-pane): alone in its Tab, the old Tab keeps one Pane.
      const newTab = await api.post(movedKey, 'move', { newTab: true });
      expect(newTab.status).toBe(201);
      const inNewTab = ((await newTab.json()) as { paneKey: string }).paneKey;
      expect(inNewTab).toBe(movedKey);
      const afterNewTab = await api.state();
      const alone = afterNewTab.panes.find(item => item.key === inNewTab)!;
      expect(afterNewTab.panes.filter(item => item.tabId === alone.tabId)).toHaveLength(1);
      expect(afterNewTab.panes.filter(item => item.tabId === otherTabId)).toHaveLength(1);

      // Move to a new Workspace: one Pane (the seed window died), the label survives sanitising.
      const moved = await api.post(inNewTab, 'move', { newWorkspace: true, label: 'moved.ws' });
      expect(moved.status).toBe(201);
      const workspaceKey = ((await moved.json()) as { paneKey: string }).paneKey;
      const after = await api.state();
      const arrived = after.panes.find(item => item.key === workspaceKey)!;
      expect(after.panes.filter(item => item.workspaceId === arrived.workspaceId)).toHaveLength(1); // no seed Pane left
      expect(after.workspaces.find(item => item.id === arrived.workspaceId)?.label).toMatch(/moved[-.]ws/);
    } finally { api.stop(); }
  } finally {
    await tmux(['kill-server']);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(!herdrAvailable)('herdr: Duplicate through the Hub — a new Tab lands after its source, a split takes the cwd and the Agent kind', async () => {
  const fixture = await startThrowawayHerdr();
  try {
    const mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'duplicate' });
    const root = (await mux.tree()).panes.find(pane => pane.workspaceId === workspace.id)!;
    const second = await mux.newTab(workspace.id, { cwd: fixture.dir, label: 'Second' });
    const sub = join(fixture.dir, 'sub');
    await mkdir(sub);
    const api = await serve(mux, fixture.dir);
    try {
      const tabs = `/api/muxes/${encodeURIComponent(api.muxKey)}/tabs`;
      const order = async () => (await api.state()).tabs.filter(tab => tab.workspaceId === workspace.id).map(tab => tab.id);

      // Duplicate Tab: the copy opens in the source's folder, right after the source.
      const made = await api.write(tabs, { workspaceId: workspace.id, cwd: sub, after: root.tabId });
      expect(made.status).toBe(201);
      const copyKey = ((await made.json()) as { paneKey: string }).paneKey;
      const copy = (await api.state()).panes.find(pane => pane.key === copyKey)!;
      // herdr reports a new Tab's cwd once its shell has started, about half a second later.
      const cwdOf = async (id: string) => (await mux.tree()).panes.find(pane => pane.id === id)?.cwd;
      for (let i = 0; i < 20 && await cwdOf(copy.id) !== sub; i++) await Bun.sleep(150);
      expect(await cwdOf(copy.id)).toBe(sub);
      expect(await order()).toEqual([root.tabId, copy.tabId, second.tabId]);
      // After the last Tab it is already in place; with no `after` it goes last, as New Tab does.
      const last = await api.write(tabs, { workspaceId: workspace.id, after: second.tabId });
      const lastKey = ((await last.json()) as { paneKey: string }).paneKey;
      const lastTab = (await api.state()).panes.find(pane => pane.key === lastKey)!.tabId;
      expect((await order()).at(-1)).toBe(lastTab);

      // Duplicate Pane, a shell: the split opens in the given folder.
      const shell = await api.post(`${api.muxKey}/${root.id}`, 'split', { direction: 'right', cwd: sub });
      expect(shell.status).toBe(201);
      const shellId = ((await shell.json()) as { paneKey: string }).paneKey.slice(api.muxKey.length + 1);
      for (let i = 0; i < 20 && await cwdOf(shellId) !== sub; i++) await Bun.sleep(150);
      expect(await cwdOf(shellId)).toBe(sub);
      // An Agent: the kind reaches herdr's agent.start for the new Pane. An unknown kind is herdr's
      // own error code, and the split Pane stays for the user to see and close.
      const before = (await mux.tree()).panes.filter(pane => pane.tabId === root.tabId).length;
      const agent = await api.post(`${api.muxKey}/${root.id}`, 'split', { direction: 'down', cwd: sub, agent: 'no-such-agent' });
      expect(agent.status).toBe(502);
      expect(await agent.json()).toEqual({ error: 'unsupported_agent_kind' });
      expect((await mux.tree()).panes.filter(pane => pane.tabId === root.tabId)).toHaveLength(before + 1);

      // Bad bodies.
      expect((await api.post(`${api.muxKey}/${root.id}`, 'split', { direction: 'right', agent: '' })).status).toBe(400);
      expect((await api.write(tabs, { workspaceId: workspace.id, after: '' })).status).toBe(400);
    } finally { api.stop(); }
  } finally { await fixture.stop(); }
}, 60_000);
