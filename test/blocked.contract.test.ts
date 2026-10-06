import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

const prompt = [
  'Bash command',
  'echo tautan-blocked',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "2. Yes, and don't ask again…",
  '3. No, and tell Claude what to do differently (esc)',
  '────────────────────────────────',
  'esc to cancel · enter to confirm',
].join('\n');
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const eventually = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(50); value = await read(); }
  return value;
};

describe.skipIf(!herdrAvailable)('blocked flow contract', () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>>;
  let mux: ReturnType<typeof herdrMux>;
  let hub: Hub;
  let server: ReturnType<typeof startHttp>;
  let paneId: string;

  beforeAll(async () => {
    fixture = await startThrowawayHerdr();
    mux = herdrMux(fixture.sock);
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'blocked-contract' });
    paneId = (await mux.tree()).panes.find(pane => pane.workspaceId === workspace.id)!.id;
    await herdrRpc(fixture.sock, 'pane.report_agent', { pane_id: paneId, source: 'tautan-contract', agent: 'claude', state: 'idle' });
    await mux.sendText(paneId, `clear; printf '%s\\n' ${quoted(prompt)}`);
    await mux.sendKeys(paneId, ['enter']);
    hub = new Hub(); hub.add('contract', mux);
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: fixture.dir });
  }, 15_000);

  afterAll(async () => { server?.stop(); hub?.close(); await fixture?.stop(); });

  test('Claude permission prompt is explained as blocked', async () => {
    const explain = await eventually(() => mux.explain(paneId), value => value?.state === 'blocked', 5_000);
    expect(explain?.state).toBe('blocked');
    // A real permission box hits `live_blocked_form` (980) before `bash_permission_prompt`
    // (850): its footer sits after a horizontal rule. See CLAUDE.md gotchas.
    expect(explain?.ruleId).toMatch(/^live_blocked_form$|_permission_prompt$/);
  });

  test('Hub explain route offers Yes and No before the footer keys', async () => {
    const key = `contract/throwaway/${paneId}`;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/panes/${encodeURIComponent(key)}/explain`);
    expect(response.status).toBe(200);
    const explain = await response.json() as { hintKeys: { key: string; label: string }[] };
    // The footer's own `esc to cancel` / `enter to confirm` are the preset renamed, so the
    // preset wins and the duplicates drop: the card shows Yes and No, nothing else.
    expect(explain.hintKeys).toEqual([{ key: 'enter', label: 'Yes' }, { key: 'esc', label: 'No' }]);
  });

  test('a stale prompt id is refused, a fresh one goes through', async () => {
    const key = `contract/throwaway/${paneId}`;
    const base = `http://127.0.0.1:${server.port}`;
    const send = (promptId?: string) =>
      fetch(`${base}/api/panes/${encodeURIComponent(key)}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(promptId === undefined ? { keys: ['enter'] } : { keys: ['enter'], promptId }),
      });
    const readExplain = async () =>
      (await (await fetch(`${base}/api/panes/${encodeURIComponent(key)}/explain`)).json()) as { promptId?: string } | null;

    // The card was drawn from this id.
    const drawn = await eventually(readExplain, (value) => typeof value?.promptId === 'string', 5_000);
    expect(drawn!.promptId).toMatch(/^[0-9a-f]{12}$/);

    // The box moves on underneath the card the phone still shows.
    await mux.sendText(paneId, `clear; printf '%s\\n' ${quoted(prompt.replaceAll('❯ 1. Yes', '❯ 1. Yes (edited)'))}`);
    await mux.sendKeys(paneId, ['enter']);
    await eventually(() => mux.read(paneId, 'visible'), (screen) => screen.text.includes('(edited)'), 5_000);

    // The stale id must not land: the answer would approve a different prompt.
    const stale = await send(drawn!.promptId);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'prompt_changed' });

    // The fresh id of the edited box goes through, and no id keeps the old behaviour.
    const fresh = await eventually(readExplain, (value) => typeof value?.promptId === 'string' && value.promptId !== drawn!.promptId, 5_000);
    expect((await send(fresh!.promptId)).status).toBe(204);
    expect((await send()).status).toBe(204);
  });
});
