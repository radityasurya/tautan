import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchHistory } from '../server/history.ts';
import { TmuxMux } from '../server/tmux.ts';
import { herdrAvailable, herdrMux, herdrRpc, startThrowawayHerdr } from './harness.ts';

const tmuxAvailable = Bun.which('tmux') !== null && process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1';
const WORD = 'TAUTAN-HISTORY-WORD';
const eventually = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout: number) => {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) { await Bun.sleep(50); value = await read(); }
  return value;
};

describe.skipIf(!herdrAvailable)('herdr history contract', () => {
  let fixture: Awaited<ReturnType<typeof startThrowawayHerdr>>;
  let mux: ReturnType<typeof herdrMux>;
  let paneId: string;

  beforeAll(async () => {
    fixture = await startThrowawayHerdr();
    mux = herdrMux(fixture.sock);
    await mux.newWorkspace({ cwd: fixture.dir, label: 'history-contract' });
    paneId = (await mux.tree()).panes[0]!.id;
  }, 15_000);

  afterAll(async () => { mux?.close(); await fixture?.stop(); });

  test('reads the whole ring: a word pushed past the visible screen, with context', async () => {
    await mux.sendText(paneId, `echo ${WORD}`);
    await mux.sendKeys(paneId, ['enter']);
    await mux.sendText(paneId, 'for i in $(seq 1 1200); do echo "filler $i"; done');
    await mux.sendKeys(paneId, ['enter']);
    // viewport_rows is ~40, so > 1100 lines read means the read reached scrollback
    const result = await eventually(async () => searchHistory(await mux.history(paneId), WORD),
      value => value.lines > 1_100 && value.matches.some(match => match.after.some(line => line.includes('filler'))), 15_000);
    expect(result.total).toBeGreaterThanOrEqual(1); // the echoed command and its output both hold the word
    const match = result.matches.find(item => item.text.includes(WORD))!;
    expect(match.after.slice(0, 5).some(line => line.includes('filler'))).toBe(true);
  }, 30_000);

  test('no match answers an empty result', async () => {
    const lines = await mux.history(paneId);
    expect(searchHistory(lines, 'tautan-no-such-word')).toEqual({ lines: lines.length, total: 0, matches: [] });
  });

  test('a live read shows the bottom while the herdr client scrolls the Pane back', async () => {
    await mux.sendText(paneId, `seq 1 200; echo ${WORD}-BOTTOM`);
    await mux.sendKeys(paneId, ['enter']);
    const atBottom = (text: string) => text.split('\n').some(line => line.trim() === `${WORD}-BOTTOM`);
    expect(atBottom((await eventually(() => mux.read(paneId, 'visible'), screen => atBottom(screen.text), 10_000)).text)).toBe(true);
    await herdrRpc(fixture.sock, 'pane.scroll', { pane_id: paneId, offset_from_bottom: 100 });
    // herdr's `visible` follows the client's scroll; the Hub's status read must not
    expect(atBottom((await mux.read(paneId, 'visible')).text)).toBe(false);
    const live = await mux.read(paneId, 'visible', { live: true });
    expect(atBottom(live.text)).toBe(true);
    expect(live.ansi).toBe(false);
  }, 20_000);
});

describe.skipIf(!tmuxAvailable)('tmux history contract', () => {
  let dir: string;
  let sock: string;
  let mux: TmuxMux;
  let paneId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tautan-history-tmux-'));
    sock = join(dir, 't.sock');
    const proc = Bun.spawn(['tmux', '-f', '/dev/null', '-S', sock, 'new', '-d', '-s', 't', '-x', '80', '-y', '24', 'exec sh'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    await eventually(async () => {
      const check = Bun.spawn(['tmux', '-S', sock, 'list-panes', '-a'], { stdout: 'ignore', stderr: 'ignore' });
      return await check.exited;
    }, code => code === 0, 5_000);
    mux = new TmuxMux({ id: 't', socket: sock, treeIntervalMs: 200, screenIntervalMs: 100 });
    paneId = (await mux.tree()).panes[0]!.id;
  }, 15_000);

  afterAll(async () => {
    mux?.close();
    if (sock) { try { const kill = Bun.spawn(['tmux', '-S', sock, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }); await kill.exited; } catch {} }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('finds a match pushed past the visible screen', async () => {
    await mux.sendText(paneId, `echo ${WORD}`);
    await mux.sendKeys(paneId, ['enter']);
    await mux.sendText(paneId, 'for i in $(seq 1 100); do echo "filler $i"; done');
    await mux.sendKeys(paneId, ['enter']);
    // the window is 24 rows, so > 100 lines read means the capture reached history
    const result = await eventually(async () => searchHistory(await mux.history(paneId), WORD),
      value => value.lines > 100 && value.matches.some(match => match.after.some(line => line.includes('filler'))), 10_000);
    expect(result.total).toBeGreaterThanOrEqual(1);
    const match = result.matches.find(item => item.text.includes(WORD))!;
    expect(match.after.slice(0, 5).some(line => line.includes('filler'))).toBe(true);
  }, 20_000);
});
