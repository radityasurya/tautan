import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { discoverRemote, forwarderArgs, herdrSupportsMachines, hostId, listHosts, localSockPath, nextBackoff, readHostsConfig, runtimeDir, startRemoteHost, stopRemoteHost, validTarget, validateHosts, writeHostsConfig } from '../server/hosts.ts';
import { remoteAttachmentCommand, remoteAttachmentResult } from '../server/attach.ts';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('Host sources merge by target with config taking precedence', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'tautan-hosts-')); dirs.push(dir); const path = join(dir, 'hosts.json');
  await writeFile(path, JSON.stringify([{ id: 'configured', label: 'Config label', target: 'u@same', session: 'chosen' }, { id: 'extra', target: 'u@extra' }]));
  const machinesJson = JSON.stringify({ machines: [
    { id: 'machine', label: 'Machine label', target: 'u@same', session: 'old', enabled: true },
    { id: 'off', target: 'u@off', enabled: false },
  ] });
  const hosts = await listHosts({ machinesJson, configPath: path });
  expect(hosts[0]).toEqual({ id: hostId, label: hostId, online: true, source: 'local' });
  expect(hosts[1]).toMatchObject({ id: 'configured', label: 'Config label', target: 'u@same', session: 'chosen', source: 'config' });
  expect(hosts[2]).toMatchObject({ id: 'extra', source: 'config' }); expect(hosts).toHaveLength(3);
});

test('failed machine discovery yields only local/config and versions gate machine list', async () => {
  expect(herdrSupportsMachines('herdr 0.8.0')).toBe(false); expect(herdrSupportsMachines('herdr 0.9.0')).toBe(true); expect(herdrSupportsMachines('1.0.0')).toBe(true);
  const hosts = await listHosts({ machinesJson: async () => { throw new Error('unknown command'); }, configPath: '/definitely/missing/tautan-hosts.json' });
  expect(hosts.map(host => host.id)).toEqual([hostId]);
});

test('hosts config writes atomically and reads back', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'tautan-hosts-')); dirs.push(dir); const path = join(dir, 'nested/hosts.json');
  await writeHostsConfig([{ id: 'vps', target: 'me@vps' }], path);
  expect(await readHostsConfig(path)).toEqual([{ id: 'vps', target: 'me@vps' }]);
  expect(await readFile(path, 'utf8')).toEndWith('\n');
});

test('forwarder argv is exact', () => {
  expect(forwarderArgs('/run/tautan', 'me@host', '/run/tautan/h.sock', '/remote/h.sock')).toEqual([
    'ssh', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto', '-o', 'ControlPath=/run/tautan/cm-%C', '-o', 'ControlPersist=600', '-o', 'BatchMode=yes', '-L', '/run/tautan/h.sock:/remote/h.sock', 'me@host',
  ]);
});

test('socket paths stay below the unix limit and hash only when needed', () => {
  expect(localSockPath('/tmp/tautan', 'host', 'mux')).toBe('/tmp/tautan/host-mux.sock');
  const long = localSockPath(`/tmp/${'r'.repeat(81)}`, 'host', 'mux');
  expect(Buffer.byteLength(long)).toBeLessThan(100); expect(long).not.toContain('host-mux');
  for (const [id, session] of [['../x', 'mux'], ['a/b', 'mux'], ['host', '../x']]) {
    const path = localSockPath('/tmp/tautan', id!, session!); expect(path.startsWith('/tmp/tautan/')).toBe(true); expect(path).not.toContain('..');
  }
});

test('ssh discovery rejects invalid targets before spawn and bad remote socket paths', async () => {
  let calls = 0;
  const spawn = ((_: string[]) => { calls++; return { stdout: new Response('{"sessions":[]}').body!, stderr: new Response('').body!, exited: Promise.resolve(0) }; }) as typeof Bun.spawn;
  await expect(discoverRemote('-bad', undefined, { spawn })).rejects.toThrow('invalid target'); expect(calls).toBe(0);
  const badSpawn = ((_: string[]) => ({ stdout: new Response('{"sessions":[{"running":true,"name":"x","socket_path":"relative.sock"}]}').body!, stderr: new Response('').body!, exited: Promise.resolve(0) })) as typeof Bun.spawn;
  await expect(discoverRemote('host', undefined, { spawn: badSpawn })).rejects.toThrow('bad socket path');
});

test('host validation rejects unsafe and duplicate config', () => {
  expect(validateHosts([{ id: '../x', target: 'host' }])).toBe('invalid id');
  expect(validateHosts([{ id: 'a', target: 'host' }, { id: 'a', target: 'other' }])).toBe('duplicate id');
  expect(validateHosts([{ id: 'a', target: 'host' }, { id: 'b', target: 'host' }])).toBe('duplicate target');
});

test('runtimeDir respects XDG_RUNTIME_DIR and falls back to /tmp/tautan-<uid>', () => {
  const old = process.env.XDG_RUNTIME_DIR;
  try {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    expect(runtimeDir()).toBe('/run/user/1000/tautan');
    delete process.env.XDG_RUNTIME_DIR;
    expect(runtimeDir()).toBe(`/tmp/tautan-${process.getuid?.() ?? os.userInfo().uid}`);
  } finally {
    if (old === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = old;
  }
});

test('forwarder backoff doubles, caps, and resets after a stable minute', () => {
  const values = [1_000]; for (let i = 0; i < 6; i++) values.push(nextBackoff(values.at(-1)!, 0));
  expect(values).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  expect(nextBackoff(30_000, 60_000)).toBe(1_000);
});

test('a dropped forwarder marks the Host unreachable with the next retry time', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'tautan-retry-')); dirs.push(dir);
  const oldRun = process.env.XDG_RUNTIME_DIR, oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_RUNTIME_DIR = join(dir, 'run'); process.env.XDG_STATE_HOME = join(dir, 'state');
  // An ssh that always fails, and never creates the forwarded socket.
  const fakeSsh = (): ReturnType<typeof Bun.spawn> => {
    const child = { exitCode: null as number | null, stdout: new Response('').body, stderr: new Response('ssh: connect failed').body } as any;
    child.exited = Promise.resolve(255);
    child.kill = () => { child.exitCode = 255; };
    return child;
  };
  let clock = 1_000_000;
  const hub = new Hub({ refreshMs: 0, suggest: null });
  try {
    await startRemoteHost(hub, { id: 'vps', label: 'vps', target: 'me@vps', online: false, source: 'config' }, {
      spawn: (() => fakeSsh()) as typeof Bun.spawn,
      discover: async () => [{ name: 'main', socketPath: '/remote/herdr.sock' }],
      // Real 0 ms sleeps keep the retry loop from starving the event loop's timers.
      sleep: async () => { await Bun.sleep(0); },
      now: () => (clock += 1_000),
    });
    // The retry loop reaches its setHost only after several event-loop hops, which take
    // unbounded real time under load — so wait for the mark, not a fixed sleep.
    const deadline = Date.now() + 2_000;
    let stored = hub.host('vps')!;
    while (stored.error === undefined && Date.now() < deadline) { await Bun.sleep(10); stored = hub.host('vps')!; }
    expect(stored.online).toBe(false);
    expect(stored.error).toBe('ssh: connect failed');
    // Set from the injected clock plus the backoff, so it predates wall-clock time by far.
    expect(stored.retryAt).toBeGreaterThan(0);
    expect(stored.retryAt!).toBeLessThan(Date.now());
    // Coming back online clears the retry time, so a stale one cannot ride along.
    hub.setHost({ ...stored, online: true });
    expect(hub.host('vps')!.retryAt).toBeUndefined();
  } finally {
    stopRemoteHost(hub, 'vps'); hub.close();
    for (const [name, value] of [['XDG_RUNTIME_DIR', oldRun], ['XDG_STATE_HOME', oldState]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('remote attachment command and returned paths are stable', () => {
  expect(remoteAttachmentCommand('../odd name')).toBe("mkdir -p ~/.cache/tautan/attachments && cat > ~/.cache/tautan/attachments/'odd_name'");
  expect(remoteAttachmentResult('dev@vps', 'file.txt', 4)).toEqual({ path: '/home/dev/.cache/tautan/attachments/file.txt', bytes: 4, display: '~/.cache/tautan/attachments/file.txt' });
  expect(remoteAttachmentResult('vps', 'file.txt', 4).path).toBe('~/.cache/tautan/attachments/file.txt');
  expect(validTarget('me@host')).toBe(true); expect(validTarget('-bad')).toBe(false); expect(validTarget('bad host')).toBe(false);
});

async function routeHarness(discoverRemote: (target: string, session?: string) => Promise<{ name: string; socketPath: string }[]>) {
  const dir = await mkdtemp(join(os.tmpdir(), 'tautan-routes-')); dirs.push(dir);
  const oldConfig = process.env.XDG_CONFIG_HOME, oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, 'config'); process.env.XDG_STATE_HOME = join(dir, 'state');
  const hub = new Hub({ refreshMs: 0, suggest: null }); hub.setHost({ id: hostId, label: hostId, online: true, source: 'local' });
  let handle: ((request: Request) => Response | Promise<Response>) | undefined; const serve = Bun.serve;
  try { Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return {} as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve;
    startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir, discoverRemote });
  } finally { Bun.serve = serve; }
  const request = (path: string, body?: unknown, login?: string) => handle!(new Request(`http://tautan.test${path}`, {
    method: body === undefined ? 'GET' : path === '/api/settings' ? 'PUT' : 'POST', headers: { host: 'tautan.test', origin: 'http://tautan.test', ...(login ? { 'tailscale-user-login': login } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { hub, request, restore() { hub.close(); if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig; if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState; } };
}

test('probe, retry, settings, and trusted login routes', async () => {
  let fail = false;
  const h = await routeHarness(async target => { if (fail) throw new Error('first line\nlast ssh line'); return [{ name: target.includes('two') ? 'two' : 'one', socketPath: '/remote.sock' }]; });
  try {
    let response = await h.request('/api/hosts/probe', { target: 'me@one' }); expect(await response.json()).toEqual({ online: true, sessions: ['one'] });
    fail = true; response = await h.request('/api/hosts/probe', { target: 'me@one' }); expect(await response.json()).toEqual({ online: false, error: 'last ssh line' });
    response = await h.request('/api/hosts/probe', { target: '-bad' }); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'target' });
    response = await h.request('/api/settings', { hosts: [{ id: 'remote', label: 'Remote', target: 'me@two' }] }); expect(response.status).toBe(200);
    response = await h.request('/api/settings', { hosts: [{ id: 'bad/id', target: 'host' }] }); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'hosts' });
    expect((await h.request('/api/settings')).status).toBe(200); expect((await (await h.request('/api/settings')).json()).hosts[0].id).toBe('remote');
    fail = false; h.hub.setHost({ id: 'remote', label: 'Remote', target: 'me@two', source: 'config', online: false, error: 'old' });
    response = await h.request('/api/hosts/remote/retry', {}); expect(await response.json()).toMatchObject({ online: true, source: 'config' });
    response = await h.request('/api/settings', { trustedUser: 'alice' }, 'bob'); expect(response.status).toBe(400);
    response = await h.request('/api/settings', { trustedUser: 'alice' }, 'alice'); expect(response.status).toBe(200);
    expect((await h.request('/api/settings', undefined, 'bob')).status).toBe(403); expect((await h.request('/api/settings', undefined, 'alice')).status).toBe(200);
    response = await h.request('/api/settings', { trustedUser: null }, 'alice'); expect(response.status).toBe(200); expect((await h.request('/api/settings')).status).toBe(200);
  } finally { h.restore(); }
});

test('retry reuses the current host while discovery is in flight', async () => {
  let calls = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const h = await routeHarness(async () => { calls++; await pending; return []; });
  try {
    h.hub.setHost({ id: 'remote', label: 'Remote', target: 'host', source: 'config', online: false });
    const first = h.request('/api/hosts/remote/retry', {}); await Bun.sleep(0);
    const second = await h.request('/api/hosts/remote/retry', {});
    expect(second.status).toBe(200); expect(calls).toBe(1);
    release(); await first;
  } finally { release(); h.restore(); }
});
