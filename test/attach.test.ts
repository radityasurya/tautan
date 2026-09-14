import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sanitizeName } from '../server/attach.ts';
import { hostId } from '../server/hosts.ts';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { AttachResult, Explain, Mux, Pane, Screen, ScreenMode, Tree, Workspace } from '../shared/types.ts';

const canListen = (() => {
  try {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    probe.stop(); return true;
  } catch { return false; }
})();

describe.skipIf(!canListen)('pane attachments', () => {
  const oldCacheHome = process.env.XDG_CACHE_HOME;
  const oldStateHome = process.env.XDG_STATE_HOME;
  const oldMax = process.env.TAUTAN_MAX_ATTACHMENT_MB;
  const cacheHome = mkdtempSync(join(tmpdir(), 'tautan-attach-'));
  const attachmentDir = join(cacheHome, 'tautan/attachments');
  const paneKey = `${hostId}/fake/pane`;
  let server: ReturnType<typeof Bun.serve>;
  let hub: Hub;
  let origin: string;

  const files = () => existsSync(attachmentDir) ? readdirSync(attachmentDir) : [];
  const post = (key = paneKey, init: RequestInit = {}) => fetch(`${origin}/api/panes/${encodeURIComponent(key)}/attach`, {
    ...init, method: 'POST', headers: { origin, ...init.headers },
  });

  beforeAll(async () => {
    process.env.XDG_CACHE_HOME = cacheHome;
    process.env.XDG_STATE_HOME = cacheHome;
    const tree: Tree = {
      workspaces: [{ id: 'work', label: 'Tautan' }], tabs: [{ id: 'tab', workspaceId: 'work', label: 'Tab' }],
      panes: [{ id: 'pane', tabId: 'tab', workspaceId: 'work', title: 'Pane', status: 'working', revision: 1 }],
    };
    const mux: Mux = {
      kind: 'herdr', id: 'fake', tree: async () => tree,
      read: async (_id: string, mode: ScreenMode): Promise<Screen> => ({ text: '', ansi: false, revision: 1, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {},
      newTab: async (): Promise<Pane> => tree.panes[0]!, newWorkspace: async (): Promise<Workspace> => tree.workspaces[0]!,
      rename: async () => {}, closePane: async () => {}, closeWorkspace: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {},
    };
    hub = new Hub({ refreshMs: 0 }); hub.add(hostId, mux); await hub.state();
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: cacheHome });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(); hub?.close();
    if (oldCacheHome === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCacheHome;
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldStateHome;
    if (oldMax === undefined) delete process.env.TAUTAN_MAX_ATTACHMENT_MB; else process.env.TAUTAN_MAX_ATTACHMENT_MB = oldMax;
  });

  test('sanitizes attachment names', () => {
    expect(sanitizeName('a b..c.png')).toBe('a_b..c.png');
    expect(sanitizeName('../../x')).toBe('x');
    expect(sanitizeName(null)).toBe('file');
    expect(sanitizeName('/')).toBe('file');
    expect(sanitizeName('x'.repeat(200))).toHaveLength(120);
  });

  test('streams a large attachment to the pane host cache', async () => {
    const size = 3 * 1024 * 1024;
    const body = randomBytes(size);
    // Everything before the last slash is dropped, so a b/../c.png sanitizes to c.png.
    const response = await post(paneKey, { headers: { 'x-name': 'a b/../c.png' }, body });
    expect(response.status).toBe(200);
    const result = await response.json() as AttachResult;
    expect(result.path).toMatch(/\/tautan\/attachments\/\d{13}-c\.png$/);
    expect(result.bytes).toBe(size);
    expect(statSync(result.path).size).toBe(size);
    // This test uses an OS tmpdir, outside the user's home, so display remains absolute.
    expect(result.display).toBe(result.path);
    unlinkSync(result.path);
  });

  test('rejects declared and streamed bodies over the cap without partial files', async () => {
    process.env.TAUTAN_MAX_ATTACHMENT_MB = '1';
    const body = new Uint8Array(2 * 1024 * 1024);
    let response = await post(paneKey, { body });
    expect(response.status).toBe(413); expect(files()).toHaveLength(0);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(body.subarray(0, 1024 * 1024)); controller.enqueue(body.subarray(1024 * 1024)); controller.close(); },
    });
    response = await post(paneKey, { body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
    expect(response.status).toBe(413); expect(files()).toHaveLength(0);
    delete process.env.TAUTAN_MAX_ATTACHMENT_MB;
  });

  test('enforces origin, pane existence, and non-empty bodies', async () => {
    expect((await fetch(`${origin}/api/panes/${encodeURIComponent(paneKey)}/attach`, { method: 'POST', body: 'x' })).status).toBe(403);
    expect((await post('missing/fake/pane', { body: 'x' })).status).toBe(404);
    expect((await post(paneKey, { body: new Uint8Array(0) })).status).toBe(400);
  });

  test('deletes a partial attachment when the client disconnects', async () => {
    const oneMiB = new Uint8Array(1024 * 1024);
    // A raw socket can promise 3 MiB, send 1 MiB, and close without fetch normalizing Content-Length.
    await new Promise<void>((resolve, reject) => {
      void Bun.connect({ hostname: '127.0.0.1', port: server.port!, socket: {
        open(socket) {
          socket.write(`POST /api/panes/${encodeURIComponent(paneKey)}/attach HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${origin}\r\nContent-Length: ${3 * 1024 * 1024}\r\nX-Name: aborted.bin\r\n\r\n`);
          socket.write(oneMiB); socket.end();
        },
        data() {}, close() { resolve(); }, error(_socket, error) { reject(error); },
      } });
    });
    const deadline = Date.now() + 2_000;
    while (files().length && Date.now() < deadline) await Bun.sleep(25);
    expect(files()).toHaveLength(0);
  });
});
