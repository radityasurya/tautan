import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import { inputBox } from '../shared/inputbox.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

const rule = '─'.repeat(32);
// A Claude input box with a draft in it, as 20.1's fixtures shape it: two rules around the `❯ ` line.
const box = (text: string) => `${rule}\n❯ ${text}\n${rule}`;
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const eventually = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(50); value = await read(); }
  return value;
};

describe.skipIf(!herdrAvailable)('held reply contract', () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>>;
  let mux: ReturnType<typeof herdrMux>;
  let hub: Hub;
  let server: ReturnType<typeof startHttp>;
  let paneId: string;

  beforeAll(async () => {
    fixture = await startThrowawayHerdr();
    mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'held-contract' });
    paneId = (await mux.tree()).panes.find(pane => pane.workspaceId === workspace.id)!.id;
    await herdrRpc(fixture.sock, 'pane.report_agent', { pane_id: paneId, source: 'tautan-contract', agent: 'claude', state: 'idle' });
    hub = new Hub(); hub.add('contract', mux);
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
  }, 15_000);

  afterAll(async () => { server?.stop(); hub?.close(); await fixture?.stop(); });

  const input = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${server.port}/api/panes/${encodeURIComponent(`contract/throwaway/${paneId}`)}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` },
      body: JSON.stringify(body),
    });
  const run = async (command: string) => { await mux.sendText(paneId, command); await mux.sendKeys(paneId, ['enter']); };
  // Wait on the classifier, not on raw text: the shell's echo of the printf command carries the
  // box lines too, before the real box is on screen.
  const boxIs = (state: 'draft' | 'empty' | null) => eventually(() => mux.read(paneId, 'visible'), screen => inputBox(screen.text, screen.ansi) === state, 5_000);

  test('a draft or no box refuses a held reply; an empty box sends it stripped', async () => {
    // The box holds a draft: the reply must not type over it.
    await run(`clear; printf '%s\\n' ${quoted(box('draft'))}`);
    await boxIs('draft');
    const refused = await input({ text: 'reply', keys: ['enter'], held: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'draft' });

    // No box at all: a panel (/config) or a prompt has taken its place, where Enter picks a
    // row or answers. The reply waits (here the user cleared the screen).
    await run('clear');
    await boxIs(null);
    const held = await input({ text: 'reply', keys: ['enter'], held: true });
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: 'panel' });

    // The box is back, empty: the reply goes through, without the zero-width space.
    await run(`clear; printf '%s\\n' ${quoted(box(''))}`);
    await boxIs('empty');
    expect((await input({ text: 'echo held​ok', held: true })).status).toBe(204);
    const screen = await eventually(() => mux.read(paneId, 'visible'), value => value.text.includes('heldok'), 5_000);
    expect(screen.text.includes('​')).toBe(false);
  });
});
