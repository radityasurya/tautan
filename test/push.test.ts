import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import type { Explain, Mux, Pane, Screen, ScreenMode, Tree, Workspace } from '../shared/types.ts';

const eventually = async (accepts: () => boolean, timeout = 2_000) => {
  const deadline = Date.now() + timeout;
  while (!accepts() && Date.now() < deadline) await Bun.sleep(25);
  expect(accepts()).toBe(true);
};

const canListen = (() => {
  try {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    probe.stop(); return true;
  } catch { return false; }
})();

describe.skipIf(!canListen)('web push', () => {
  const oldStateHome = process.env.XDG_STATE_HOME;
  const stateHome = mkdtempSync(join(tmpdir(), 'tautan-push-'));
  let pushServer: ReturnType<typeof Bun.serve>;
  let server: ReturnType<typeof Bun.serve>;
  let hub: Hub;
  let changed: ((ids: string[] | 'all') => void) | undefined;
  let status: Pane['status'] = 'working';
  const received: { path: string; headers: Headers; body: Uint8Array<ArrayBuffer> }[] = [];

  beforeAll(async () => {
    process.env.XDG_STATE_HOME = stateHome;
    pushServer = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/gone') return new Response(null, { status: 410 });
      received.push({ path: url.pathname, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(null, { status: 201 });
    } });
    const tree: Tree = {
      workspaces: [{ id: 'work', label: 'Tautan' }], tabs: [{ id: 'tab', workspaceId: 'work', label: 'Tab' }],
      panes: [{ id: 'pane', tabId: 'tab', workspaceId: 'work', title: 'Prompt', agent: 'Codex', status, revision: 1 }],
    };
    const mux: Mux = {
      kind: 'herdr', id: 'fake', tree: async () => ({ ...tree, panes: [{ ...tree.panes[0]!, status }] }),
      read: async (_id: string, mode: ScreenMode): Promise<Screen> => ({ text: 'Need approval', ansi: false, revision: 1, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: cb => { changed = cb; return () => {}; },
      newTab: async (): Promise<Pane> => tree.panes[0]!, newWorkspace: async (): Promise<Workspace> => tree.workspaces[0]!,
      rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {},
    };
    hub = new Hub({ refreshMs: 0 }); hub.add('local', mux);
    server = startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: stateHome });
    await hub.state();
  });

  afterAll(() => {
    server?.stop(); pushServer?.stop(); hub?.close();
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldStateHome;
  });

  test('routes persist subscriptions and blocked sends encrypted pushes', async () => {
    const origin = `http://127.0.0.1:${server.port}`;
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const vapidResponse = await fetch(`${origin}/api/push/vapid`);
    expect(vapidResponse.status).toBe(200);
    expect((await vapidResponse.json() as { publicKey: string }).publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    const subscribe = (endpoint: string) => fetch(`${origin}/api/push/subscribe`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, keys: { p256dh, auth } }),
    });
    const ok = `http://127.0.0.1:${pushServer.port}/ok`;
    const gone = `http://127.0.0.1:${pushServer.port}/gone`;
    expect((await subscribe(ok)).status).toBe(204); expect((await subscribe(gone)).status).toBe(204); expect((await subscribe(ok)).status).toBe(204);
    const statePath = join(stateHome, 'tautan/state.json');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).subscriptions).toHaveLength(2);

    status = 'blocked'; changed?.('all');
    await eventually(() => received.length === 1 && JSON.parse(readFileSync(statePath, 'utf8')).subscriptions.length === 1);
    const request = received[0]!;
    expect(request.path).toBe('/ok'); expect(request.body.length).toBeGreaterThan(86);
    expect(request.headers.get('content-encoding')).toBe('aes128gcm');
    expect(request.headers.get('ttl')).toBe('3600'); expect(request.headers.get('urgency')).toBe('high');
    expect(request.headers.get('authorization')).toMatch(/^vapid t=.+, k=.+$/i);
    // Apple's push service answers 403 BadJwtToken for a `mailto:` subject without a real domain;
    // the contact must be an https URL or a routable mailbox.
    {
      const token = String(request.headers.get('authorization')).match(/t=([^,]+)/)![1]!;
      const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
      expect(claims.sub).toMatch(/^https:\/\/[^/]+\.[a-z]+|^mailto:[^@]+@[^@]+\.[a-z]+$/);
      expect(typeof claims.aud).toBe('string'); expect(claims.aud.startsWith('http')).toBe(true);
    }
    status = 'working'; changed?.('all'); await Bun.sleep(250);
    status = 'done'; changed?.('all'); await Bun.sleep(300);
    expect(received).toHaveLength(1);
  });

  test('a blocked push quotes the Screen line the transition produced', async () => {
    // RFC 8291, mirrored from server/push.ts: the subscription's keys open the body, so the
    // payload a transition builds — not just its shape — is what gets asserted.
    const decrypt = async (body: Uint8Array<ArrayBuffer>, pair: CryptoKeyPair, auth: Uint8Array<ArrayBuffer>, subscriberPublic: Uint8Array<ArrayBuffer>) => {
      const text = (value: string) => new TextEncoder().encode(value);
      const idLength = body[20]!;
      const serverPublicBytes = body.slice(21, 21 + idLength);
      const serverPublic = await crypto.subtle.importKey('raw', serverPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPublic }, pair.privateKey, 256));
      const hkdf = async (key: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bits: number) =>
        new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']), bits));
      const ikm = await hkdf(shared, auth, new Uint8Array([...text('WebPush: info\0'), ...subscriberPublic, ...serverPublicBytes]), 256);
      const salt = body.slice(0, 16);
      const cek = await hkdf(ikm, salt, text('Content-Encoding: aes128gcm\0'), 128);
      const nonce = await hkdf(ikm, salt, text('Content-Encoding: nonce\0'), 96);
      const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, body.slice(21 + idLength)));
      let end = plain.length; while (end > 0 && plain[end - 1] === 0) end--; // strip padding
      if (plain[end - 1] === 2) end--; // the delimiter before the padding
      return new TextDecoder().decode(plain.slice(0, end));
    };
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const subscriberPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const pane: Pane = { id: 'p', tabId: 't', workspaceId: 'w', title: 'Prompt', agent: 'Claude', status: 'working', revision: 1 };
    const tree: Tree = { workspaces: [{ id: 'w', label: 'Fix' }], tabs: [{ id: 't', workspaceId: 'w', label: 'T' }], panes: [pane] };
    const mux: Mux = {
      kind: 'herdr', id: 'fresh', tree: async () => tree,
      read: async (_id: string, mode: ScreenMode): Promise<Screen> => ({ text: `${pane.revision === 1 ? 'old output' : 'Run pnpm test?'}\n❯\n`, ansi: false, revision: pane.revision, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {},
      newTab: async (): Promise<Pane> => pane, newWorkspace: async (): Promise<Workspace> => tree.workspaces[0]!,
      rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {},
    };
    const hub = new Hub({ refreshMs: 0 }); hub.add('local', mux);
    const before = received.length;
    try {
      await hub.state(); // the Screen read caches revision 1 with the old output
      hub.addSubscription({ endpoint: `http://127.0.0.1:${pushServer.port}/fresh`, keys: { p256dh: Buffer.from(subscriberPublic).toString('base64url'), auth: Buffer.from(auth).toString('base64url') } });
      pane.status = 'blocked'; pane.revision = 2;
      await hub.refreshHost('local');
      // The Hub loads the first test's persisted `ok` subscription too, so match by endpoint.
      await eventually(() => received.length > before && received.some(item => item.path === '/fresh'));
      const fresh = received.find(item => item.path === '/fresh')!.body;
      expect(JSON.parse(await decrypt(fresh, pair, auth, subscriberPublic))).toEqual({
        title: 'Claude needs you', body: 'Fix · Run pnpm test?', url: '#/pane/local/fresh/p', tag: 'local/fresh/p',
      });
    } finally { hub.close(); }
  });

  test('periodic refresh works without an onChange event', async () => {
    let calls = 0;
    const mux = {
      kind: 'herdr', id: 'timer', tree: async () => { calls++; return { workspaces: [], tabs: [], panes: [] }; },
      read: async () => { throw new Error('unused'); }, sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {},
      newTab: async () => { throw new Error('unused'); }, newWorkspace: async () => { throw new Error('unused'); }, rename: async () => {},
      closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, explain: async () => null, close: () => {},
    } satisfies Mux;
    const timerHub = new Hub({ refreshMs: 50 }); timerHub.add('local', mux);
    try { await eventually(() => calls >= 2, 500); } finally { timerHub.close(); }
  });
});
