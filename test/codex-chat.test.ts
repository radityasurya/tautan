import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { parseCodexRollout, type TranscriptImage } from '../shared/chat.ts';
import { ChatLens, localIo, resolveSession, type ChatHub, type SessionHub, type TranscriptIo } from '../server/chat.ts';
import { resolveCodexPath } from '../server/codex-chat.ts';
import type { State } from '../shared/types.ts';

const paneKey = 'local/mux/pane';
// Synthetic ids: the hex prefix spells 'aaaaaaaa' so no real thread id can collide.
const uuidA = 'aaaaaaaa-0000-4000-8000-000000000001';
const uuidD = 'aaaaaaaa-0000-4000-8000-000000000002';
const uuidM = 'aaaaaaaa-0000-4000-8000-000000000003';
const uuidQ = 'aaaaaaaa-0000-4000-8000-000000000005';
const uuidZ = 'aaaaaaaa-0000-4000-8000-000000000006';
const fixtureHome = join(import.meta.dir, 'fixtures/codex-home');
const rolloutA = join(fixtureHome, 'sessions/2026/10/07', `rollout-2026-10-07T10-00-00-${uuidA}.jsonl`);
const rolloutQ = join(fixtureHome, 'archived_sessions/2026/10/03', `rollout-2026-10-03T10-00-00-${uuidQ}.jsonl`);
const rich = readFileSync(rolloutA, 'utf8');

describe('parseCodexRollout', () => {
  test('maps messages and every call kind to turns with native ids and results', () => {
    const images: TranscriptImage[] = [];
    const turns = parseCodexRollout(rich, { images });
    expect(turns?.map(turn => [turn.id, turn.role, turn.text])).toEqual([
      ['turn-t1:user', 'user', 'What changed in the parser?'],
      ['turn-t1:assistant', 'assistant', 'I will check the diff.\n\nThe parser keeps native ids.'], // duplicate event_msg presentation ignored
      ['turn-t2:user', 'user', 'Run the flaky one.'],
      ['turn-t2:assistant', 'assistant', 'Running it.\n\nIt failed.'],
      ['turn-t3:user', 'user', 'One more thing.'], // aborted exchange stays as its turns
      ['turn-t3:assistant', 'assistant', 'Working on it…'],
    ]); // the dangling task_started for turn-t4 produced nothing
    expect(turns![0]!.images).toEqual([{ imageId: 0 }]); // the pasted user image, out of band
    expect(images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(JSON.stringify(turns)).not.toContain('iVBORw0KGgo');
    expect(turns![0]!.at).toBe(Date.parse('2026-10-07T10:00:01.300Z'));
    const [execCommand, exec, search, toolSearch] = turns![1]!.tools;
    expect(execCommand).toMatchObject({ id: 'call_fn1', name: 'exec_command', brief: 'git diff --stat', result: ' shared/chat.ts | 2 +-\n 1 file changed', resultLines: 2 });
    expect(exec).toMatchObject({ id: 'call_cu1', name: 'exec', brief: 'bun test codex', result: '3 passed', imageId: 1 });
    expect(search).toMatchObject({ id: 'call_ws1', name: 'web_search', brief: 'bun test filter', result: 'Bun test docs — https://bun.sh/docs/test\nFiltering tests — https://bun.sh/docs/test/filter' });
    expect(toolSearch).toMatchObject({ id: 'call_ts1', name: 'tool_search_call', result: 'ansi' });
    expect(turns![3]!.tools[0]).toMatchObject({ id: 'call_cu2', name: 'exec', brief: 'bun test flaky', result: 'error: test failed', isError: true });
  });

  test('one turn_id across two user groups, or no ids at all, is no Chat', () => {
    expect(parseCodexRollout(readFileSync(join(import.meta.dir, 'fixtures/codex-overlap.jsonl'), 'utf8'))).toBeUndefined();
    expect(parseCodexRollout(readFileSync(join(import.meta.dir, 'fixtures/codex-no-ids.jsonl'), 'utf8'))).toBeUndefined();
  });
});

describe('resolveCodexPath', () => {
  test('exactly one rollout with a matching header id resolves', async () => {
    await expect(resolveCodexPath(localIo, uuidA, fixtureHome)).resolves.toBe(rolloutA);
    await expect(resolveCodexPath(localIo, uuidQ, fixtureHome)).resolves.toBe(rolloutQ); // the archived root counts
  });

  test('zero, duplicate, header-mismatch and non-uuid ids stay unresolved', async () => {
    await expect(resolveCodexPath(localIo, uuidZ, fixtureHome)).resolves.toBeUndefined();
    await expect(resolveCodexPath(localIo, uuidD, fixtureHome)).resolves.toBeUndefined(); // two files carry the id
    await expect(resolveCodexPath(localIo, uuidM, fixtureHome)).resolves.toBeUndefined(); // header names another id
    await expect(resolveCodexPath(localIo, 'not-a-uuid', fixtureHome)).resolves.toBeUndefined();
  });

  test('a session_meta whose first line passes the head window still resolves', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tautan-codex-long-'));
    try {
      const uuid = 'bbbbbbbb-0000-4000-8000-0000000000ff';
      const dir = join(home, 'sessions', '2026', '10', '07');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-10-07T11-00-00-${uuid}.jsonl`);
      // The header's id sits past the old 256 KB window behind huge base_instructions; the
      // first line must be read whole before the header check can parse it.
      const meta = `{"timestamp":"2026-10-07T11:00:00.000Z","type":"session_meta","payload":{"base_instructions":"${'i'.repeat(280_000)}","id":"${uuid}"}}`;
      const turn = `{"timestamp":"2026-10-07T11:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hi"}]}}`;
      writeFileSync(path, `${meta}\n${turn}\n`);
      await expect(resolveCodexPath(localIo, uuid, home)).resolves.toBe(path);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

const codexHub = (agentSession?: string, processes: { pid?: number; name?: string; argv?: string[] }[] = []): SessionHub => ({
  resolvePane: () => ({ paneId: 'pane', entry: { mux: { kind: 'herdr', processInfo: async () => ({ foregroundProcessGroupId: 2, foregroundProcesses: processes }) }, tree: { panes: [{ id: 'pane', agent: 'codex', agentSession }] } } }),
});

describe('resolveSession (codex)', () => {
  test('the reported thread id resolves as codex, not claude', async () => {
    await expect(resolveSession(codexHub(uuidA), paneKey)).resolves.toEqual({ agent: 'codex', sessionId: uuidA });
  });

  test('the Pane’s own `codex resume <thread-id>` argv carries the same id', async () => {
    await expect(resolveSession(codexHub(undefined, [{ pid: 2, name: 'codex', argv: ['codex', 'resume', uuidA] }]), paneKey)).resolves.toEqual({ agent: 'codex', sessionId: uuidA });
  });

  test('a non-id report and a resume without a thread id stay unresolved', async () => {
    await expect(resolveSession(codexHub('/home/user/rollout.jsonl'), paneKey)).resolves.toBeUndefined();
    await expect(resolveSession(codexHub(undefined, [{ pid: 2, name: 'codex', argv: ['codex', 'resume', 'main'] }]), paneKey)).resolves.toBeUndefined();
  });
});

describe('ChatLens (codex)', () => {
  const saved = process.env.CODEX_HOME;
  beforeAll(() => { process.env.CODEX_HOME = fixtureHome; });
  afterAll(() => { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; });
  const hub = (agentSession?: string): ChatHub => ({
    ...codexHub(agentSession),
    state: async () => ({ panes: [{ key: paneKey, cwd: '/home/user/fixture' }] }) as State,
    paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
  });
  /** localIo for the rollout search, with the transcript itself held in `source`. */
  const io = (): { io: TranscriptIo; text: () => string; append: (line: string) => void } => {
    let source = rich;
    return { text: () => source, append: line => { source += line; }, io: { ...localIo,
      stat: async () => ({ inode: '7', size: source.length, mtime: Bun.hash(source).toString(36) }),
      read: async () => source,
    } };
  };

  test('serves the thread as a codex chat, with no subagent views', async () => {
    const lens = new ChatLens(hub(uuidA), io().io, '/home/tama');
    const chat = await lens.query(paneKey);
    expect(chat?.sessionId).toBe(uuidA);
    expect(chat?.agentKind).toBe('codex');
    expect(chat?.turns).toHaveLength(6);
    expect(chat?.subagents).toEqual([]);
    await expect(lens.subagentList(paneKey)).resolves.toEqual([]);
    lens.close();
  });

  test('a new exchange answers a small delta off the remembered cursor', async () => {
    const { io: transcriptIo, append } = io();
    const lens = new ChatLens(hub(uuidA), transcriptIo, '/home/tama');
    const first = await lens.delta(paneKey, 'unknown');
    expect(first?.reset).toBe(true);
    expect(first?.agentKind).toBe('codex');
    expect(first?.upserts).toHaveLength(6);
    const passthrough = (turnId: string) => JSON.stringify({ internal_chat_message_metadata_passthrough: { turn_id: turnId } });
    append(`{"timestamp":"2026-10-07T10:01:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Later question."}],${passthrough('turn-t5').slice(1)}}\n`);
    append(`{"timestamp":"2026-10-07T10:01:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Later answer."}],${passthrough('turn-t5').slice(1)}}\n`);
    const grown = await lens.delta(paneKey, first!.cursor);
    expect(grown?.reset).toBe(false);
    expect(grown?.upserts.map(turn => [turn.id, turn.text])).toEqual([['turn-t5:user', 'Later question.'], ['turn-t5:assistant', 'Later answer.']]);
    lens.close();
  });

  test('an id with no rollout leaves the pane without a chat', async () => {
    const lens = new ChatLens(hub(uuidZ), io().io, '/home/tama');
    await expect(lens.query(paneKey)).resolves.toBeUndefined();
    lens.close();
  });
});
