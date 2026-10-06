#!/usr/bin/env bun
import { open, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const runtimeDir = process.env.HERDR_PLUGIN_DIR ?? join(tmpdir(), 'tautan-herdr-plugin');
const pidPath = join(runtimeDir, 'tautan.pid');
const logPath = join(runtimeDir, 'tautan.log');
const port = Number(process.env.TAUTAN_PORT ?? 7700);

async function recordedPid(): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandOutput(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'ignore' });
  return result.exitCode === 0 ? result.stdout.toString() : '';
}

function taggedHubPids(): number[] {
  const pgrep = Bun.which('pgrep');
  const ps = Bun.which('ps');
  if (!pgrep || !ps) return [];
  const tag = `TAUTAN_PLUGIN_RUNTIME=${runtimeDir}`;
  return commandOutput([pgrep, '-f', 'bun .*server/main\\.ts'])
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0 && commandOutput([ps, 'eww', '-p', String(pid), '-o', 'command=']).includes(tag));
}

async function runningPid(): Promise<number | undefined> {
  const pid = await recordedPid();
  if (pid && alive(pid)) return pid;
  if (pid) await rm(pidPath, { force: true });
  return undefined;
}

function tailnetUrl(): string {
  const tailscale = Bun.which('tailscale');
  if (!tailscale) return `http://localhost:${port}`;
  try {
    const status = JSON.parse(commandOutput([tailscale, 'status', '--json'])) as { Self?: { DNSName?: string } };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
    if (dnsName) return `https://${dnsName}:${port}`;
  } catch {}
  return `http://localhost:${port}`;
}

async function start(): Promise<void> {
  if (await runningPid()) {
    console.error(`tautan: already running on port ${port}`);
    process.exitCode = 1;
    return;
  }
  await mkdir(runtimeDir, { recursive: true });
  // A port that already answers is not ours to take: a dev stack or another Hub would make
  // "started" a lie and a later stop could not tell the two apart.
  if (await serving(port, 400)) {
    console.error(`tautan: port ${port} is already in use — not starting`);
    process.exitCode = 1;
    return;
  }
  const log = await open(logPath, 'a');
  try {
    const child = Bun.spawn(['bun', 'server/main.ts'], {
      cwd: root,
      env: { ...process.env, TAUTAN_PLUGIN_RUNTIME: runtimeDir },
      stdin: 'ignore',
      stdout: log.fd,
      stderr: log.fd,
      detached: true,
    });
    child.unref();
    // "spawned" is not "serving": the child may die on a port clash in silence. The port
    // must answer AND the child must still be alive, or the answer is someone else's.
    const [up, childAlive] = await Promise.all([serving(port, 5_000), Bun.sleep(300).then(() => alive(child.pid!))]);
    if (!up || !childAlive) {
      const tail = (await readFile(logPath, 'utf8').catch(() => '')).trim().split(/\r?\n/).slice(-3).join(' ');
      console.error(`tautan: failed to serve on port ${port}${tail ? `: ${tail}` : ''}`);
      try { process.kill(child.pid!, 'SIGKILL'); } catch {}
      await rm(pidPath, { force: true });
      process.exitCode = 1;
      return;
    }
    await writeFile(pidPath, `${child.pid}\n`);
    console.log(`tautan: started on port ${port}; log: ${logPath}`);
  } finally {
    await log.close();
  }
}

async function stop(): Promise<void> {
  const pid = await runningPid();
  const pids = pid ? [pid] : taggedHubPids().filter(alive);
  if (!pids.length) {
    console.log(`tautan: not running on port ${port}`);
    return;
  }
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  await Promise.race([Promise.all(pids.map(async pid => {
    while (alive(pid)) await Bun.sleep(25);
  })), Bun.sleep(2_000)]);
  await rm(pidPath, { force: true });
  console.log(`tautan: stopped on port ${port}`);
}

async function serving(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch {}
    await Bun.sleep(150);
  }
  return false;
}

async function status(): Promise<void> {
  console.log(`tautan: ${await runningPid() ? 'running' : 'not running'} on ${tailnetUrl()}`);
}

async function phone(): Promise<void> {
  const url = tailnetUrl();
  console.log(url);
  const { qrHalfBlocks } = await import('../shared/' + 'qr.ts') as { qrHalfBlocks(text: string): string };
  console.log(qrHalfBlocks(url));
  setInterval(() => {}, 1 << 30);
}

switch (process.argv[2]) {
  case 'start': await start(); break;
  case 'stop': await stop(); break;
  case 'status': await status(); break;
  case 'phone': await phone(); break;
  default:
    console.error('usage: bun scripts/plugin.ts <start|stop|status|phone>');
    process.exitCode = 1;
}
