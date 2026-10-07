import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePiTranscript, type TranscriptImage } from '../shared/chat.ts';
import { ChatLens, localIo, resolveSession, type ChatHub, type SessionHub, type TranscriptIo } from '../server/chat.ts';
import type { State } from '../shared/types.ts';

const paneKey = 'local/mux/pane';
const piPath = '/home/tama/.pi/agent/sessions/--home-tama-projects-taut--/2026-10-05T21-16-32-763Z_01a10dec-ea7a-7302-9117-476e7919dddf.jsonl';
const piSession = '01a10dec-ea7a-7302-9117-476e7919dddf';

// Shapes sanitised from real pi transcripts: entries form a parentId tree, messages carry
// content blocks (`text`, `thinking`, `toolCall`), tool results are their own `toolResult` role.
const entry = (id: string, parentId: string | null, body: Record<string, unknown>, timestamp = '2026-10-05T21:16:32.763Z') =>
  ({ id, parentId, timestamp, ...body });
const jsonl = (entries: Record<string, unknown>[]) => entries.map(item => JSON.stringify(item)).join('\n');

describe('parsePiTranscript', () => {
  test('keeps display turns, drops thinking, renders tool rows with their results', () => {
    const source = jsonl([
      { type: 'session', version: 3, id: piSession, timestamp: '2026-10-05T21:16:32.763Z', cwd: '/home/tama/projects/taut' },
      entry('m1', null, { type: 'model_change', provider: 'zai', modelId: 'glm-5.3' }),
      entry('m2', 'm1', { type: 'message', message: { role: 'system', content: 'system prompt' } }),
      entry('u1', 'm2', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Check the failing test.' }] } }),
      entry('a1', 'u1', { type: 'message', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'bun test chat' } },
        { type: 'toolCall', id: 'call_2', name: 'read', arguments: { path: 'shared/chat.ts', offset: 1, limit: 50 } },
        { type: 'toolCall', id: 'call_3', name: 'edit', arguments: { path: 'server/chat.ts', edits: [{ oldText: 'one\ntwo', newText: 'three' }] } },
        { type: 'toolCall', id: 'call_4', name: 'grep', arguments: { pattern: 'TODO', path: 'web' } },
        { type: 'text', text: 'I will inspect it.' },
      ] } }),
      entry('t1', 'a1', { type: 'message', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'test output' }] } }),
      entry('a2', 't1', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'It passes now.' }] } }),
    ]);
    expect(parsePiTranscript(source)).toEqual([
      { id: 'u1', role: 'user', text: 'Check the failing test.', tools: [], at: Date.parse('2026-10-05T21:16:32.763Z') },
      { id: 'a1', role: 'assistant', text: 'I will inspect it.\n\nIt passes now.', at: Date.parse('2026-10-05T21:16:32.763Z'), tools: [
        { id: 'call_1', name: 'bash', brief: 'bun test chat', detail: 'bun test chat', result: 'test output', resultLines: 1 },
        { id: 'call_2', name: 'read', brief: 'shared/chat.ts', detail: 'shared/chat.ts' },
        { id: 'call_3', name: 'edit', brief: 'server/chat.ts', detail: 'server/chat.ts\n\n- one\n- two\n+ three' },
        { id: 'call_4', name: 'grep', brief: 'TODO', detail: 'TODO\nin web' },
      ] },
    ]);
  });

  test('pairs a toolResult with its toolCall by id, with isError and stripped ANSI', () => {
    const source = jsonl([
      entry('u1', null, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Run it.' }] } }),
      entry('a1', 'u1', { type: 'message', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'false' } },
        { type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'ls' } },
      ] } }),
      // Results arrive out of call order; the id pairs them.
      entry('t2', 'a1', { type: 'message', message: { role: 'toolResult', toolCallId: 'call_2', content: [{ type: 'text', text: '\x1b[34mweb\x1b[0m\nshared\n' }], isError: false } }),
      entry('t1', 't2', { type: 'message', message: { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'exit 1' }], isError: true } }),
    ]);
    const [first, second] = parsePiTranscript(source)[1]!.tools;
    expect(first).toMatchObject({ result: 'exit 1', isError: true });
    expect(second).toMatchObject({ result: 'web\nshared', resultLines: 2 });
    expect(second!.isError).toBeUndefined();
  });

  test('a read of an image links its tool result image out of band', () => {
    const source = jsonl([
      entry('u1', null, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Check the layout.' }] } }),
      entry('a1', 'u1', { type: 'message', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/shot.png' } },
        { type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'ls' } },
      ] } }),
      entry('t1', 'a1', { type: 'message', message: { role: 'toolResult', toolCallId: 'call_1', content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ] } }),
    ]);
    const images: TranscriptImage[] = [];
    const turns = parsePiTranscript(source, { images });
    expect(turns[1]!.tools.map(tool => [tool.image, tool.imageId])).toEqual([['/tmp/shot.png', 0], [undefined, undefined]]);
    expect(images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(JSON.stringify(turns)).not.toContain('iVBORw0KGgo');
  });

  test('renders only the active branch of a forked session', () => {
    const source = jsonl([
      entry('u1', null, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'First attempt.' }] } }),
      entry('a1', 'u1', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } }),
      entry('u2', 'u1', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Second attempt.' }] } }),
      entry('a2', 'u2', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] } }),
    ]);
    expect(parsePiTranscript(source).map(turn => turn.text)).toEqual(['First attempt.', 'Second attempt.', 'new answer']);
  });

  test('a string user content and same-role merging with caps behave like the Claude path', () => {
    const source = jsonl([
      entry('u1', null, { type: 'message', message: { role: 'user', content: 'plain string prompt' } }),
      entry('a1', 'u1', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(3_000) }] } }),
      entry('a2', 'a1', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(3_000) }] } }),
    ]);
    const turns = parsePiTranscript(source);
    expect(turns[0]).toEqual({ id: 'u1', role: 'user', text: 'plain string prompt', tools: [], at: Date.parse('2026-10-05T21:16:32.763Z') });
    expect(turns[1]!.text).toHaveLength(4_000);
    expect(turns[1]!.text.endsWith('…')).toBe(true);
  });
});

const piHub = (agentSession?: string, processes: { pid?: number; name?: string; argv?: string[] }[] = []): SessionHub => ({
  resolvePane: () => ({ paneId: 'pane', entry: { mux: { kind: 'herdr', processInfo: async () => ({ foregroundProcessGroupId: 2, foregroundProcesses: processes }) }, tree: { panes: [{ id: 'pane', agent: 'pi', agentSession }] } } }),
});

describe('resolveSession (pi)', () => {
  test('uses the herdr-reported path even when the argv carries nothing', async () => {
    await expect(resolveSession(piHub(piPath, [{ pid: 2, name: 'pi', argv: ['pi'] }]), paneKey)).resolves.toEqual({ agent: 'pi', path: piPath });
  });

  test('falls back to a --session file in the foreground processes', async () => {
    await expect(resolveSession(piHub(undefined, [
      { pid: 1, name: 'zsh', argv: ['zsh'] },
      { pid: 2, name: 'pi', argv: ['/home/tama/.local/bin/pi', '--session', '/tmp/other.jsonl'] },
    ]), paneKey)).resolves.toEqual({ agent: 'pi', path: '/tmp/other.jsonl' });
  });

  test('a plain pi process and an id with no sessions file stay unresolved', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tautan-pi-none-'));
    try {
      await expect(resolveSession(piHub(undefined, [{ pid: 2, name: 'pi', argv: ['pi', '--session', piSession] }]), paneKey, localIo, empty)).resolves.toBeUndefined();
      await expect(resolveSession(piHub(undefined, [{ pid: 2, name: 'pi', argv: ['pi'] }]), paneKey, localIo, empty)).resolves.toBeUndefined();
      await expect(resolveSession(piHub(piSession), paneKey, localIo, empty)).resolves.toBeUndefined(); // an id without a file is not a path
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('resolveSession (pi id scan)', () => {
  // Two sessions sharing a timestamp, distinct in the uuid's second group: 'cccccccc-0000'
  // and 'cccccccc-ffff' are unique prefixes, 'cccccccc' alone is ambiguous.
  const uuidA = 'cccccccc-0000-4000-8000-00000000000a';
  const uuidF = 'cccccccc-ffff-4000-8000-00000000000f';
  let home: string;
  const file = (uuid: string) => join(home, '.pi', 'agent', 'sessions', '--tmp-repo--', `2026-10-05T21-16-32-763Z_${uuid}.jsonl`);
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'tautan-pi-home-'));
    const dir = join(home, '.pi', 'agent', 'sessions', '--tmp-repo--');
    mkdirSync(dir, { recursive: true });
    for (const uuid of [uuidA, uuidF]) writeFileSync(file(uuid), jsonl([entry('u1', null, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Hi.' }] } })]));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('a bare or partial --session id resolves through the sessions directory', async () => {
    await expect(resolveSession(piHub(undefined, [{ pid: 2, name: 'pi', argv: ['pi', '--session', uuidA] }]), paneKey, localIo, home)).resolves.toEqual({ agent: 'pi', path: file(uuidA) });
    await expect(resolveSession(piHub(undefined, [{ pid: 2, name: 'pi', argv: ['pi', '--session-id', 'cccccccc-ffff'] }]), paneKey, localIo, home)).resolves.toEqual({ agent: 'pi', path: file(uuidF) });
    await expect(resolveSession(piHub(uuidA), paneKey, localIo, home)).resolves.toEqual({ agent: 'pi', path: file(uuidA) }); // herdr's bare id report
  });

  test('an ambiguous prefix, an unknown id and a non-id argument stay unresolved', async () => {
    await expect(resolveSession(piHub(undefined, [{ pid: 2, name: 'pi', argv: ['pi', '--session', 'cccccccc'] }]), paneKey, localIo, home)).resolves.toBeUndefined();
    await expect(resolveSession(piHub('dddddddd-0000-4000-8000-00000000000d'), paneKey, localIo, home)).resolves.toBeUndefined();
    await expect(resolveSession(piHub(undefined, [{ pid: 2, name: 'pi', argv: ['pi', '--session', 'not an id'] }]), paneKey, localIo, home)).resolves.toBeUndefined();
  });
});

describe('ChatLens (pi)', () => {
  const source = jsonl([
    entry('u1', null, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Check the layout.' }] } }),
    entry('a1', 'u1', { type: 'message', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/shot.png' } },
      { type: 'text', text: 'Reading the shot.' },
    ] } }),
    entry('t1', 'a1', { type: 'message', message: { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] } }),
  ]);
  const hub = (agentSession?: string): ChatHub => ({
    ...piHub(agentSession),
    state: async () => ({ panes: [{ key: paneKey, cwd: '/home/tama/projects/taut' }] }) as State,
    paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
  });
  const io = (source: string): { io: TranscriptIo; reads: () => number } => {
    let reads = 0;
    return { reads: () => reads, io: {
      stat: async () => ({ inode: '1', size: 10, mtime: 'now' }),
      read: async () => { reads++; return source; },
    } };
  };

  test('serves the pi session, its uuid as sessionId, and its image', async () => {
    const { io: transcriptIo, reads } = io(source);
    const lens = new ChatLens(hub(piPath), transcriptIo, '/home/tama');
    const chat = await lens.query(paneKey);
    expect(chat?.sessionId).toBe(piSession);
    expect(chat?.turns.map(turn => [turn.role, turn.text])).toEqual([['user', 'Check the layout.'], ['assistant', 'Reading the shot.']]);
    const image = (await lens.image(paneKey, 0))?.image;
    expect(image?.mediaType).toBe('image/png');
    expect(Buffer.from(image!.bytes).toString('base64')).toBe('iVBORw0KGgo=');
    await lens.query(paneKey);
    lens.close();
    expect(reads()).toBe(1);
  });

  test('no trusted source leaves the pane without a session', async () => {
    const { io: transcriptIo, reads } = io(source);
    const lens = new ChatLens(hub(undefined), transcriptIo, '/home/tama');
    expect(await lens.query(paneKey)).toBeUndefined();
    expect(await lens.image(paneKey, 0)).toBeUndefined();
    lens.close();
    expect(reads()).toBe(0);
  });

  test('a branch switch answers a reset, a new leaf answers its diff', async () => {
    let text = jsonl([
      entry('u1', null, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'First attempt.' }] } }),
      entry('a1', 'u1', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } }),
    ]);
    const io: TranscriptIo = {
      stat: async () => ({ inode: '1', size: text.length, mtime: Bun.hash(text).toString(36) }),
      read: async () => text,
    };
    const lens = new ChatLens(hub(piPath), io, '/home/tama');
    const first = await lens.delta(paneKey, 'unknown');
    expect(first?.reset).toBe(true);
    expect(first?.upserts.map(turn => [turn.id, turn.text])).toEqual([['u1', 'First attempt.'], ['a1', 'old answer']]);

    text += '\n' + jsonl([ // pi appends a fork's new leaf after the branch it replaces
      entry('u2', 'u1', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Second attempt.' }] } }),
      entry('a2', 'u2', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] } }),
    ]);
    const switched = await lens.delta(paneKey, first!.cursor);
    expect(switched?.reset).toBe(true); // a1 ceased to exist: the shrink rule
    expect(switched?.upserts.map(turn => turn.text)).toEqual(['First attempt.', 'Second attempt.', 'new answer']);

    text += '\n' + jsonl([entry('a3', 'a2', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] } })]);
    const grown = await lens.delta(paneKey, switched!.cursor);
    expect(grown?.reset).toBe(false); // the active branch only grew
    expect(grown?.upserts.map(turn => [turn.id, turn.text])).toEqual([['a2', 'new answer\n\nmore']]);
    lens.close();
  });
});
