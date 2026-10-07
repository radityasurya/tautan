import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { HostConfig, StateHost } from '../shared/types.ts';
import { HerdrMux } from './herdr.ts';
import { TmuxMux } from './tmux.ts';
import { remoteTmuxSockets } from './tmux-discover.ts';
import type { Hub } from './mux.ts';

export const hostId = os.hostname();
export type HostDescriptor = StateHost & Pick<HostConfig, 'session' | 'herdr' | 'tmux'>;
type Spawn = typeof Bun.spawn;
const malformedWarnings = new Set<string>();

export function hostsConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'tautan/hosts.json');
}

export async function readHostsConfig(path = hostsConfigPath()): Promise<HostConfig[]> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(value)) throw new Error('expected an array');
    if (value.some(row => !row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || typeof row.target !== 'string' || !row.target)) throw new Error('invalid Host config');
    return value;
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && !malformedWarnings.has(path)) { malformedWarnings.add(path); console.warn(`tautan: ignoring malformed ${path}: ${error instanceof Error ? error.message : error}`); }
    return [];
  }
}

export async function writeHostsConfig(hosts: HostConfig[], path = hostsConfigPath()): Promise<void> {
  const error = validateHosts(hosts); if (error) throw new Error(error);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function commandText(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(lastError(stderr) || `${argv[0]} exited ${code}`);
  return stdout;
}

export async function listHosts(opts: { machinesJson?: string | (() => Promise<string>); configPath?: string } = {}): Promise<HostDescriptor[]> {
  let machines: any[] = [];
  try {
    let text: string;
    if (typeof opts.machinesJson === 'string') text = opts.machinesJson;
    else if (opts.machinesJson) text = await opts.machinesJson();
    else {
      const version = await commandText(['herdr', '--version']);
      const match = version.match(/(\d+)\.(\d+)/);
      if (!herdrSupportsMachines(version)) throw new Error('herdr machine list unavailable');
      text = await commandText(['herdr', 'machine', 'list', '--json']);
    }
    const parsed = JSON.parse(text);
    machines = Array.isArray(parsed) ? parsed : parsed.machines ?? [];
  } catch {}
  const config = await readHostsConfig(opts.configPath);
  const result: HostDescriptor[] = [{ id: hostId, label: hostId, online: true, source: 'local' }];
  const targets = new Map<string, number>();
  for (const row of machines.filter(row => row?.enabled && typeof row.target === 'string')) {
    if (!validTarget(row.target)) { console.warn(`tautan: ignoring host ${String(row.id)}: invalid target`); continue; }
    targets.set(row.target, result.length);
    result.push({ id: String(row.id), label: String(row.label || row.id), target: row.target, session: row.session, online: false, source: 'machines' });
  }
  for (const row of config) {
    if (!validTarget(row.target)) { console.warn(`tautan: ignoring host ${row.id}: invalid target`); continue; }
    const index = targets.get(row.target);
    const value: HostDescriptor = { ...row, label: row.label || row.id, online: false, source: 'config' };
    if (index === undefined) { targets.set(row.target, result.length); result.push(value); }
    else result[index] = value;
  }
  return result;
}

export async function discoverLocalMuxes(): Promise<{ id: string; socketPath: string }[]> {
  if (process.env.HERDR_SOCKET_PATH) {
    try { await access(process.env.HERDR_SOCKET_PATH); return [{ id: 'default', socketPath: process.env.HERDR_SOCKET_PATH }]; } catch { return []; }
  }
  try {
    const output = await commandText(['herdr', 'session', 'list', '--json']);
    const rows = JSON.parse(output).sessions ?? [];
    const found = rows.filter((row: any) => row.running).map((row: any) => ({ id: row.name, socketPath: row.socket_path }));
    if (found.length) return found;
  } catch {}
  const socketPath = join(os.homedir(), '.config/herdr/herdr.sock');
  try { await access(socketPath); return [{ id: 'default', socketPath }]; } catch { return []; }
}

const safeId = /^[A-Za-z0-9._-]+$/;
export const validTarget = (target: unknown): target is string => typeof target === 'string' && target.length > 0 && !/^-|\s|[\x00-\x1f\x7f]/.test(target);
export function validateHosts(hosts: unknown): string | null {
  if (!Array.isArray(hosts)) return 'invalid hosts';
  const ids = new Set<string>(), targets = new Set<string>();
  for (const host of hosts) {
    if (!host || typeof host !== 'object') return 'invalid host';
    const row = host as Record<string, unknown>;
    if (typeof row.id !== 'string' || !safeId.test(row.id)) return 'invalid id';
    if (!validTarget(row.target)) return 'invalid target';
    if (ids.has(row.id)) return 'duplicate id'; if (targets.has(row.target)) return 'duplicate target';
    if (row.session !== undefined && (typeof row.session !== 'string' || !safeId.test(row.session))) return 'invalid session';
    if (row.label !== undefined && typeof row.label !== 'string') return 'invalid label';
    ids.add(row.id); targets.add(row.target);
  }
  return null;
}
export const herdrSupportsMachines = (version: string): boolean => { const match = version.match(/(\d+)\.(\d+)/); return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 9)); };
export const lastError = (stderr: string): string => stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || 'ssh failed';

export async function discoverRemote(target: string, session?: string, opts: { spawn?: Spawn; extraSshArgs?: string[]; children?: Set<ReturnType<Spawn>> } = {}): Promise<{ name: string; socketPath: string }[]> {
  if (!validTarget(target)) throw new Error('invalid target');
  const spawn = opts.spawn ?? Bun.spawn;
  const child = spawn(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(opts.extraSshArgs ?? []), target,
    'herdr session list --json || ~/.local/bin/herdr session list --json'], { stdout: 'pipe', stderr: 'pipe' });
  opts.children?.add(child);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  opts.children?.delete(child);
  if (code !== 0) throw new Error(lastError(stderr));
  const rows = JSON.parse(stdout).sessions ?? [];
  const found = rows.filter((row: any) => row.running && (!session || row.name === session));
  if (found.some((row: any) => typeof row.socket_path !== 'string' || !row.socket_path.startsWith('/') || /:|[\x00-\x1f\x7f]/.test(row.socket_path))) throw new Error('bad socket path');
  return found.map((row: any) => ({ name: row.name, socketPath: row.socket_path }));
}

export function runtimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg ? join(xdg, 'tautan') : `/tmp/tautan-${process.getuid?.() ?? os.userInfo().uid}`;
}
export function localSockPath(run: string, id: string, session: string): string {
  const raw = join(run, `${id}-${session}.sock`);
  const hashLength = Math.max(1, Math.min(12, 93 - Buffer.byteLength(resolve(run))));
  const result = safeId.test(id) && safeId.test(session) && Buffer.byteLength(raw) < 100 ? raw
    : join(run, `${createHash('sha1').update(`${id}\0${session}`).digest('hex').slice(0, hashLength)}.sock`);
  const resolvedRun = resolve(run), resolved = resolve(result);
  if (!resolved.startsWith(`${resolvedRun}${sep}`)) throw new Error('socket path escaped runtime directory');
  return result;
}
export function forwarderArgs(run: string, target: string, localSock: string, remoteSock: string, extraSshArgs: string[] = []): string[] {
  if (!validTarget(target)) throw new Error('invalid target');
  return ['ssh', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto', '-o', `ControlPath=${join(run, 'cm-%C')}`, '-o', 'ControlPersist=600', '-o', 'BatchMode=yes', ...extraSshArgs, '-L', `${localSock}:${remoteSock}`, target];
}
export function nextBackoff(previousMs: number, upMs: number): number { return upMs >= 60_000 ? 1_000 : Math.min(previousMs * 2, 30_000); }

type RemoteOptions = { discover?: typeof discoverRemote; spawn?: Spawn; extraSshArgs?: string[]; sleep?: (ms: number) => Promise<void>; now?: () => number };
type Managed = { children: Set<ReturnType<Spawn>>; sockets: Set<string>; stopped: boolean };
const managers = new WeakMap<Hub, Map<string, Managed>>();

export async function startRemoteHost(hub: Hub, host: HostDescriptor, opts: RemoteOptions = {}): Promise<void> {
  if (!host.target) return;
  let map = managers.get(hub);
  if (!map) { map = new Map(); managers.set(hub, map); hub.onClose(() => { for (const managed of map!.values()) stopManaged(managed); }); }
  const old = map.get(host.id); if (old) stopManaged(old);
  const managed: Managed = { children: new Set(), sockets: new Set(), stopped: false }; map.set(host.id, managed);
  hub.setHost({ ...host, online: false });
  let herdrError: string | undefined;
  let herdrFound = 0;
  try {
    const found = await (opts.discover ?? discoverRemote)(host.target, host.session, { spawn: opts.spawn, extraSshArgs: opts.extraSshArgs, children: managed.children });
    herdrFound = found.length;
    if (found.length) {
      const run = runtimeDir(); await mkdir(run, { recursive: true, mode: 0o700 });
      for (const item of found) void maintainForwarder(hub, host, item, run, managed, opts);
    }
  } catch (error) { herdrError = error instanceof Error ? error.message : String(error); }
  // tmux needs no forwarder: every command is one ssh round trip, kept cheap by the ControlMaster.
  const tmuxFound = host.tmux === false ? 0 : await attachRemoteTmux(hub, host, managed, opts).catch(() => 0);
  if (!herdrFound && !tmuxFound) {
    hub.setHost({ ...host, online: false, error: herdrError ?? (host.session ? `Mux ${host.session} is not running` : 'no running Muxes') });
  } else if (!herdrFound) {
    hub.setHost({ ...host, online: true, error: undefined }); await hub.refreshHost(host.id).catch(() => {});
  }
}

async function attachRemoteTmux(hub: Hub, host: HostDescriptor, managed: Managed, opts: RemoteOptions): Promise<number> {
  const spawnFn = opts.spawn ?? Bun.spawn;
  const ssh = async (cmd: string) => {
    const child = spawnFn(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(opts.extraSshArgs ?? []), host.target!, cmd], { stdout: 'pipe', stderr: 'pipe' });
    managed.children.add(child);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    managed.children.delete(child);
    return { stdout, stderr, code };
  };
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const found = await remoteTmuxSockets(ssh);
  for (const t of found) {
    const id = `tmux-${t.id}`;
    const exec = (args: string[]) => ssh(['tmux', '-S', t.socketPath, ...args].map(q).join(' '));
    // controlSpawn: null — the ssh exec is one round trip per command; a control client needs
    // its own long-lived channel, so a remote Mux stays on plain polling for now.
    if (!hub.hasMux(host.id, id)) hub.add(host.id, new TmuxMux({ id, socket: t.socketPath, exec, controlSpawn: null }));
  }
  return found.length;
}

async function maintainForwarder(hub: Hub, host: HostDescriptor, remote: { name: string; socketPath: string }, run: string, managed: Managed, opts: RemoteOptions): Promise<void> {
  const sleep = opts.sleep ?? (ms => Bun.sleep(ms)); const now = opts.now ?? Date.now; let backoff = 1_000;
  const local = localSockPath(run, host.id, remote.name); managed.sockets.add(local);
  while (!managed.stopped) {
    await rm(local, { force: true }).catch(() => {});
    const started = now();
    const child = (opts.spawn ?? Bun.spawn)(forwarderArgs(run, host.target!, local, remote.socketPath, opts.extraSshArgs), { stdout: 'ignore', stderr: 'pipe' });
    managed.children.add(child); const stderrPromise = new Response(child.stderr).text();
    const deadline = now() + 5_000;
    while (!managed.stopped && child.exitCode === null && now() < deadline) { try { await access(local); break; } catch { await sleep(25); } }
    try {
      await access(local);
      if (!hub.hasMux(host.id, remote.name)) hub.add(host.id, new HerdrMux(remote.name, local));
      hub.setHost({ ...host, online: true, error: undefined }); await hub.refreshHost(host.id).catch(() => {});
    } catch { child.kill('SIGTERM'); }
    await child.exited; managed.children.delete(child); const stderr = await stderrPromise;
    if (managed.stopped) break;
    hub.removeMux(host.id, remote.name);
    const up = now() - started, wait = up >= 60_000 ? 1_000 : backoff;
    hub.setHost({ ...host, online: false, error: lastError(stderr), retryAt: now() + wait });
    await sleep(wait); backoff = nextBackoff(backoff, up);
  }
}

function stopManaged(managed: Managed): void {
  managed.stopped = true; for (const child of managed.children) child.kill('SIGTERM');
  for (const socket of managed.sockets) void rm(socket, { force: true });
}
export function stopRemoteHost(hub: Hub, id: string): void { const managed = managers.get(hub)?.get(id); if (managed) { stopManaged(managed); managers.get(hub)!.delete(id); } }

export async function syncHosts(hub: Hub, opts: RemoteOptions & { configPath?: string; machinesJson?: string | (() => Promise<string>) } = {}): Promise<void> {
  const hosts = await listHosts(opts); const ids = new Set(hosts.map(host => host.id));
  for (const current of (await hub.state()).hosts) if (!ids.has(current.id)) { stopRemoteHost(hub, current.id); hub.removeHost(current.id); }
  for (const host of hosts) {
    hub.setHost(host);
    if (!host.target) continue;
    if (opts.discover && !opts.spawn) void opts.discover(host.target, host.session).then(found => hub.setHost({ ...host, online: found.length > 0, ...(found.length ? {} : { error: 'no running Muxes' }) })).catch(error => hub.setHost({ ...host, online: false, error: error instanceof Error ? error.message : String(error) }));
    else void startRemoteHost(hub, host, opts);
  }
}
