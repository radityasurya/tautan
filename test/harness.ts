import { access, cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { HerdrMux } from '../server/herdr.ts';

const herdr = Bun.which('herdr');
// The managed Codex sandbox blocks unix socket creation even when the binary is installed.
export const herdrAvailable = Boolean(herdr) && process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1';

export function herdrRpc(sock: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sock);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: crypto.randomUUID(), method, params })}\n`));
    socket.on('data', chunk => {
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      socket.destroy();
      const message = JSON.parse(data.slice(0, end));
      message.error ? reject(new Error(`${message.error.code}: ${message.error.message}`)) : resolve(message.result);
    });
    socket.on('error', reject);
  });
}

export async function startThrowawayHerdr(): Promise<{ sock: string; dir: string; stop(): Promise<void> }> {
  if (!herdr) throw new Error('herdr is not on PATH');
  const dir = await mkdtemp(join(os.tmpdir(), 'tautan-herdr-'));
  const state = join(dir, 'state');
  const manifests = join(os.homedir(), '.local/state/herdr/agent-detection/remote');
  await mkdir(join(state, 'herdr/agent-detection'), { recursive: true });
  await mkdir(join(dir, 'runtime'), { recursive: true });
  // herdr 0.9 panes run the user's $SHELL. With zsh and an empty HOME that is the
  // zsh-newuser-install prompt, which eats the first typed command; one empty .zshrc
  // keeps the pane a plain shell.
  await writeFile(join(dir, '.zshrc'), '# tautan contract test\n');
  // Agent manifests are downloaded state, so an isolated HOME otherwise has none.
  try { await cp(manifests, join(state, 'herdr/agent-detection/remote'), { recursive: true }); } catch {}
  const sock = join(dir, 'h.sock');
  const child = Bun.spawn([herdr, 'server'], {
    cwd: dir,
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: state, XDG_RUNTIME_DIR: join(dir, 'runtime'), HERDR_SOCKET_PATH: sock },
    stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(sock); break; } catch {}
    if (child.exitCode !== null) {
      const stderr = await new Response(child.stderr).text();
      await rm(dir, { recursive: true, force: true });
      throw new Error(`herdr server exited ${child.exitCode}: ${stderr.trim()}`);
    }
    await Bun.sleep(25);
  }
  try { await access(sock); } catch {
    child.kill(); await child.exited; await rm(dir, { recursive: true, force: true });
    throw new Error('herdr server did not create HERDR_SOCKET_PATH');
  }
  let stopped = false;
  return {
    sock, dir,
    async stop() {
      if (stopped) return;
      stopped = true;
      try { await herdrRpc(sock, 'server.stop'); } catch {}
      if (await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]) === false) child.kill();
      await child.exited;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const herdrMux = (sock: string) => new HerdrMux('throwaway', sock);

/**
 * The test plugin, shared by the contract test and e2e: the pane actions the contract test
 * asserts on (an env dump, a global-only one, a contextless one), a scratch action that
 * calls herdr back through HERDR_BIN_PATH (the plugin API is the CLI), and a failing action
 * in a second plugin so a grouped list has two groups. Returns the env-dump path.
 */
export async function linkTestPlugin(fixture: { sock: string; dir: string }): Promise<{ out: string }> {
  const out = join(fixture.dir, 'mark-env.txt');
  const one = join(fixture.dir, 'test-plugin');
  await mkdir(one);
  await writeFile(join(one, 'herdr-plugin.toml'), `id = "tautan.test-plugin"
name = "Tautan Test Plugin"
version = "0.1.0"
min_herdr_version = "0.7.0"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "mark"
title = "Mark the pane"
description = "Writes the invocation env to a file"
contexts = ["pane", "global"]
command = ["/bin/sh", "-c", "env > ${out}"]

[[actions]]
id = "global-only"
title = "Global only"
contexts = ["global"]
command = ["/bin/sh", "-c", ":"]

[[actions]]
id = "plain"
title = "No contexts"
command = ["/bin/sh", "-c", ":"]

[[actions]]
id = "scratch"
title = "Open a scratch Tab"
description = "Calls herdr back through HERDR_BIN_PATH, the plugin API"
contexts = ["pane"]
command = ["/bin/sh", "-c", 'exec "$HERDR_BIN_PATH" tab create --workspace "$HERDR_WORKSPACE_ID" --label scratch']
`);
  const two = join(fixture.dir, 'test-plugin-two');
  await mkdir(two);
  await writeFile(join(two, 'herdr-plugin.toml'), `id = "tautan.test-plugin-two"
name = "Tautan Second Plugin"
version = "0.1.0"
min_herdr_version = "0.7.0"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "boom"
title = "Fail on purpose"
description = "Exits non-zero so the UI can show herdr's failure text"
contexts = ["pane"]
command = ["/bin/sh", "-c", "echo 'the scratch script is missing' >&2; exit 3"]
`);
  await herdrRpc(fixture.sock, 'plugin.link', { path: one });
  await herdrRpc(fixture.sock, 'plugin.link', { path: two });
  return { out };
}
