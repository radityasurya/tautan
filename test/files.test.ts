import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { startHttp } from '../server/http.ts';
import { Hub } from '../server/mux.ts';
import { PREVIEW_CSP, remoteListCommand, remoteRawCommand, remoteReadCommand, remoteSaveCommand } from '../server/files.ts';
import type { FileListResult } from '../server/files.ts';
import type { Explain, Mux, Pane, Screen, Tree, Workspace } from '../shared/types.ts';

const KEY = 'local/fake/p1';
const MB = 1024 * 1024;
const BIG_SIZE = 20 * MB;
// big.bin repeats one 1 MiB pattern: byte at global offset o is (o % 1MiB) % 251.
const expected = (offset: number) => (offset % MB) % 251;

describe('files routes', () => {
  let dir: string, out: string;
  let hub: Hub;
  let handle: (request: Request) => Response | Promise<Response>;
  const list = (params: Record<string, string>) => handle(new Request(`http://tautan.test/api/files/list?${new URLSearchParams(params)}`));
  const raw = (params: Record<string, string>, headers: Record<string, string> = {}) => handle(new Request(`http://tautan.test/api/files/raw?${new URLSearchParams(params)}`, { headers }));
  const listing = async (params: Record<string, string>) => (await (await list(params)).json()) as FileListResult;

  beforeEach(async () => {
    dir = mkdtempSync(join(os.tmpdir(), 'tautan-files-'));
    out = mkdtempSync(join(os.tmpdir(), 'tautan-files-out-')); // outside every root
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'nested.txt'), 'nest');
    writeFileSync(join(dir, 'Beta.txt'), 'b');
    writeFileSync(join(dir, 'alpha.txt'), 'abcdef');
    writeFileSync(join(dir, 'CHARLIE.md'), 'c');
    writeFileSync(join(dir, '.secret'), 'hidden one');
    mkdirSync(join(dir, 'Zulu'));
    mkdirSync(join(dir, 'alpha-dir'));
    writeFileSync(join(dir, 'report.html'), '<html></html>');
    writeFileSync(join(dir, 'pic.png'), 'png');
    writeFileSync(join(dir, 'café.txt'), 'cafe');
    writeFileSync(join(dir, 'data.bin'), 'bin');
    symlinkSync('sub', join(dir, 'ln-sub'));            // a symlink inside the root: fine
    symlinkSync(out, join(dir, 'link-out'));            // a symlink out of the root: escape
    symlinkSync(join(dir, 'nowhere'), join(dir, 'broken'));
    writeFileSync(join(out, 'escape.txt'), 'escape');
    const pattern = Buffer.alloc(MB);
    for (let i = 0; i < MB; i++) pattern[i] = i % 251;
    const fd = openSync(join(dir, 'big.bin'), 'w');
    for (let i = 0; i < 20; i++) writeSync(fd, pattern, 0, MB, i * MB);
    closeSync(fd);
    const tree: Tree = {
      workspaces: [{ id: 'w1', label: 'W', cwd: dir }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'Tab' }],
      panes: [{ id: 'p1', tabId: 't1', workspaceId: 'w1', title: 'Shell', cwd: dir, status: 'unknown', revision: 0 }],
    };
    const mux: Mux = {
      kind: 'herdr', id: 'fake', tree: async () => structuredClone(tree),
      read: async (_id, mode): Promise<Screen> => ({ text: '', ansi: false, revision: 0, mode }),
      sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {}, explain: async (): Promise<Explain | null> => null,
      newTab: async (): Promise<Pane> => { throw new Error('unused'); }, newWorkspace: async (): Promise<Workspace> => { throw new Error('unused'); },
      rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, close: () => {},
    };
    hub = new Hub({ refreshMs: 0, suggest: null }); hub.add('local', mux); await hub.state();
    const serve = Bun.serve;
    try {
      Bun.serve = ((options: { fetch: typeof handle }) => { handle = options.fetch; return { stop() {} } as ReturnType<typeof Bun.serve>; }) as typeof Bun.serve;
      startHttp(hub, { port: 0, hostname: '127.0.0.1', staticDir: dir });
    } finally { Bun.serve = serve; }
  });
  afterEach(() => { hub?.close(); rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); });

  test('dirs first, then files, case-insensitive; dot entries hidden; broken symlinks skipped', async () => {
    const body = await listing({ host: 'local', pane: KEY, path: dir });
    expect(body.path).toBe(realpathSync(dir));
    expect(body.parent).toBeNull(); // the pane root is a root
    expect(body.entries.map(entry => entry.name)).toEqual(['alpha-dir', 'link-out', 'ln-sub', 'sub', 'Zulu', 'alpha.txt', 'Beta.txt', 'big.bin', 'café.txt', 'CHARLIE.md', 'data.bin', 'pic.png', 'report.html']);
    expect(body.entries.find(entry => entry.name === 'ln-sub')?.kind).toBe('dir'); // listed by what it points at
    expect(body.entries.find(entry => entry.name === '.secret')).toBeUndefined();
    expect(body.entries.find(entry => entry.name === 'broken')).toBeUndefined();
    expect(body.entries.find(entry => entry.name === 'link-out')?.kind).toBe('dir');
    const file = body.entries.find(entry => entry.name === 'alpha.txt')!;
    expect(file.kind).toBe('file'); expect(file.size).toBe(6); expect(file.mtime).toBeGreaterThan(0);
  });

  test('hidden=1 shows dot entries; q filters case-insensitively on the name', async () => {
    const shown = await listing({ host: 'local', pane: KEY, path: dir, hidden: '1' });
    expect(shown.entries.map(entry => entry.name)).toContain('.secret');
    const filtered = await listing({ host: 'local', pane: KEY, path: dir, q: 'ALP' });
    expect(filtered.entries.map(entry => entry.name)).toEqual(['alpha-dir', 'alpha.txt']);
  });

  test('the listing caps at 1000 entries and reports truncation', async () => {
    mkdirSync(join(dir, 'many'));
    for (let i = 0; i < 1002; i++) writeFileSync(join(dir, 'many', `f${String(i).padStart(4, '0')}`), 'x');
    const body = await listing({ host: 'local', pane: KEY, path: join(dir, 'many') });
    expect(body.entries).toHaveLength(1000);
    expect(body.truncated).toBe(true);
  });

  test('parent is the directory above, still inside a root', async () => {
    const body = await listing({ host: 'local', pane: KEY, path: join(dir, 'sub') });
    expect(body.path).toBe(realpathSync(join(dir, 'sub')));
    expect(body.parent).toBe(realpathSync(dir));
  });

  test('a path with no pane defaults to the home root', async () => {
    const body = await listing({ host: 'local' });
    expect(body.path).toBe(realpathSync(os.homedir()));
    expect(body.home).toBe(body.path);
    expect(body.parent).toBeNull(); // home is a root
  });

  test('escapes: .. and a symlink out of the root are refused on both routes', async () => {
    let response = await list({ host: 'local', pane: KEY, path: join(dir, '..', basename(out)) });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'escape' });
    response = await list({ host: 'local', pane: KEY, path: join(dir, 'link-out') });
    expect(response.status).toBe(403);
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'link-out', 'escape.txt') });
    expect(response.status).toBe(403);
    response = await raw({ host: 'local', path: '/etc/passwd' }); // outside both roots, no pane
    expect(response.status).toBe(403);
  });

  test('a symlink inside the root resolves through', async () => {
    const body = await listing({ host: 'local', pane: KEY, path: join(dir, 'ln-sub') });
    expect(body.path).toBe(realpathSync(join(dir, 'sub')));
    expect(body.entries.map(entry => entry.name)).toEqual(['nested.txt']);
    const response = await raw({ host: 'local', pane: KEY, path: join(dir, 'ln-sub', 'nested.txt') });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('nest');
  });

  test('missing, not a directory, not a file, unknown host, unknown pane', async () => {
    let response = await list({ host: 'local', pane: KEY, path: join(dir, 'nope') });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not found' });
    response = await list({ host: 'local', pane: KEY, path: join(dir, 'alpha.txt') });
    expect(response.status).toBe(415); expect(await response.json()).toEqual({ error: 'not a directory' });
    response = await raw({ host: 'local', pane: KEY, path: dir });
    expect(response.status).toBe(415); expect(await response.json()).toEqual({ error: 'not a file' });
    response = await list({ host: 'nosuch', path: '~' });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'host' });
    response = await list({ host: 'local', pane: 'local/fake/zz', path: dir });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'pane not found' });
  });

  test('ranges on a 20 MB file: a-b returns exactly those bytes', async () => {
    const response = await raw({ host: 'local', pane: KEY, path: join(dir, 'big.bin') }, { range: 'bytes=100-115' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-length')).toBe('16');
    expect(response.headers.get('content-range')).toBe(`bytes 100-115/${BIG_SIZE}`);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from({ length: 16 }, (_, i) => expected(100 + i)));
    const small = await raw({ host: 'local', pane: KEY, path: join(dir, 'alpha.txt') }, { range: 'bytes=2-3' });
    expect(small.status).toBe(206);
    expect(await small.text()).toBe('cd');
  });

  test('open-ended and suffix ranges stream without the whole file', async () => {
    const offset = 1048570;
    let response = await raw({ host: 'local', pane: KEY, path: join(dir, 'big.bin') }, { range: `bytes=${offset}-` });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-length')).toBe(String(BIG_SIZE - offset));
    expect(response.headers.get('content-range')).toBe(`bytes ${offset}-${BIG_SIZE - 1}/${BIG_SIZE}`);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(value![0]).toBe(expected(offset));
    await reader.cancel();
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'big.bin') }, { range: 'bytes=-100' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${BIG_SIZE - 100}-${BIG_SIZE - 1}/${BIG_SIZE}`);
    const tail = response.body!.getReader();
    const first = await tail.read();
    expect(first.value![0]).toBe(expected(BIG_SIZE - 100));
    await tail.cancel();
  });

  test('unsatisfiable, multi-range and inverted ranges', async () => {
    let response = await raw({ host: 'local', pane: KEY, path: join(dir, 'big.bin') }, { range: `bytes=${BIG_SIZE}-` });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${BIG_SIZE}`);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'alpha.txt') }, { range: 'bytes=6-' });
    expect(response.status).toBe(416);
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'alpha.txt') }, { range: 'bytes=0-1,3-4' });
    expect(response.status).toBe(200); // multi-range serves the whole file
    expect(response.headers.get('content-length')).toBe('6');
    await response.body?.cancel();
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'alpha.txt') }, { range: 'bytes=5-2' });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    writeFileSync(join(dir, 'empty.bin'), '');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'empty.bin') }, { range: 'bytes=-5' });
    expect(response.status).toBe(416); // any range on a zero-byte file is unsatisfiable
    expect(response.headers.get('content-range')).toBe('bytes */0');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'empty.bin') }, { range: 'bytes=0-' });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */0');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'empty.bin') });
    expect(response.status).toBe(200); // without a range the empty body still streams
    await response.body?.cancel();
  });

  test('content types, sandbox CSP, nosniff and disposition', async () => {
    let response = await raw({ host: 'local', pane: KEY, path: join(dir, 'report.html') });
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'CHARLIE.md') });
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'pic.png') });
    expect(response.headers.get('content-type')).toBe('image/png');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'data.bin') });
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'café.txt') });
    expect(response.headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''caf%C3%A9.txt`);
    response = await raw({ host: 'local', pane: KEY, path: join(dir, 'café.txt'), download: '1' });
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''caf%C3%A9.txt`);
    for (const [ext, type] of [['m4v', 'video/mp4'], ['ogv', 'video/ogg'], ['oga', 'audio/ogg'], ['flac', 'audio/flac'], ['aac', 'audio/aac'], ['opus', 'audio/ogg']]) {
      writeFileSync(join(dir, `clip.${ext}`), 'x'); // every extension viewerFor plays must serve a playable type
      response = await raw({ host: 'local', pane: KEY, path: join(dir, `clip.${ext}`) });
      expect(response.headers.get('content-type')).toBe(type);
    }
  });
});

describe('remote file scripts under sh', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(os.tmpdir(), 'tautan-rscript-'));
    mkdirSync(join(home, 'sub')); writeFileSync(join(home, 'sub', 'nested.txt'), 'nest');
    writeFileSync(join(home, 'file.txt'), 'remote body\n');
    chmodSync(join(home, 'file.txt'), 0o640);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const run = (script: string, stdin?: Uint8Array) => {
    const child = Bun.spawnSync(['sh', '-c', script], { cwd: home, env: { ...process.env, HOME: home }, stdin: stdin ?? 'ignore' });
    return { out: child.stdout.toString(), err: child.stderr.toString(), code: child.exitCode };
  };
  const cksumOf = (path: string) => run(`cksum < ${JSON.stringify(path)} | tr ' ' -`).out.trim();

  test('list and raw expand ~ against $HOME', () => {
    const list = run(remoteListCommand('~/sub'));
    expect(list.code).toBe(0);
    const head = list.out.split('\n')[0]!.split('\t');
    expect(head[0]).toBe(realpathSync(join(home, 'sub')));
    expect(list.out).toMatch(/^f\t4\t\d+\tnested.txt$/m);
    const raw = run(remoteRawCommand('~/sub/nested.txt', undefined, null));
    expect(raw.code).toBe(0);
    expect(raw.err.split('\n')[0]).toBe(`SIZE 4 0 4`);
    expect(raw.out).toBe('nest');
  });

  test('read serves the body and the cksum version', () => {
    const read = run(remoteReadCommand(join(home, 'file.txt'), undefined, 1024));
    expect(read.code).toBe(0);
    expect(read.out).toBe('remote body\n');
    expect(read.err.trim()).toBe(`V${cksumOf(join(home, 'file.txt'))}`);
  });

  test('save writes through the temp file, keeps the mode, prints the new version', () => {
    const body = 'new body\n';
    const save = run(remoteSaveCommand(join(home, 'file.txt'), undefined, 1024, body.length, cksumOf(join(home, 'file.txt'))), new TextEncoder().encode(body));
    expect(save.code).toBe(0);
    expect(readFileSync(join(home, 'file.txt'), 'utf8')).toBe(body);
    expect(statSync(join(home, 'file.txt')).mode & 0o777).toBe(0o640);
    expect(readdirSync(home).some(name => name.startsWith('.tautan.'))).toBe(false);
    expect(save.out.trim()).toBe(cksumOf(join(home, 'file.txt')));
  });

  test('save refuses a stale version (19), a short stream (18), and an escape (12)', () => {
    const body = new TextEncoder().encode('abcd');
    // a stale version token: the file on disk does not match what the Hub last read
    let r = run(remoteSaveCommand(join(home, 'file.txt'), undefined, 1024, 4, '0-0'), body);
    expect(r.code).toBe(19);
    expect(readFileSync(join(home, 'file.txt'), 'utf8')).toBe('remote body\n');
    // a short stream: the script was told 10 bytes, ssh delivered 3
    r = run(remoteSaveCommand(join(home, 'file.txt'), undefined, 1024, 10, cksumOf(join(home, 'file.txt'))), new TextEncoder().encode('abc'));
    expect(r.code).toBe(18);
    expect(readFileSync(join(home, 'file.txt'), 'utf8')).toBe('remote body\n');
    expect(readdirSync(home).some(name => name.startsWith('.tautan.'))).toBe(false); // the trap cleaned up
    // outside both roots: /etc is not $HOME and no pane cwd is named
    r = run(remoteSaveCommand('/etc/passwd', undefined, 1024, 3, '0-0'), new TextEncoder().encode('abc'));
    expect(r.code).toBe(12);
  });
});
