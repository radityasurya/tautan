import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parsePiTranscript, type TranscriptImage } from '../shared/chat.ts';
import { ChatLens, resolveSession, type ChatHub, type SessionHub, type TranscriptIo } from '../server/chat.ts';
import type { State } from '../shared/types.ts';

const paneKey = 'local/mux/pane';
const ompPath = join(import.meta.dir, 'fixtures/omp-session.jsonl');
const source = readFileSync(ompPath, 'utf8');

describe('parsePiTranscript (omp)', () => {
  test('renders the active branch: text, both image positions, an errored result', () => {
    const images: TranscriptImage[] = [];
    const turns = parsePiTranscript(source, { images });
    expect(turns?.map(turn => [turn.id, turn.role, turn.text])).toEqual([
      ['u1', 'user', 'Read the screenshot.'],
      ['a1', 'assistant', ''],
      ['a2', 'assistant', 'Running.'], // words after tool rows open the next Turn
      ['a3', 'assistant', 'new answer'], // the inactive fork never renders, but splits the merge
    ]);
    expect(turns![0]!.images).toEqual([{ imageId: 0 }]);
    expect(images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(JSON.stringify(turns)).not.toContain('iVBORw0KGgo');
    const [read] = turns![1]!.tools;
    const [bash] = turns![2]!.tools;
    expect(read).toMatchObject({ id: 'omp_call_1', name: 'read', image: '/tmp/shot.png', imageId: 1, result: 'Read image file [image/png]' });
    expect(bash).toMatchObject({ id: 'omp_call_2', name: 'bash', result: 'exit 1', isError: true });
  });
});

const agentHub = (agent: string | undefined, agentSession?: string, processes: { pid?: number; name?: string; argv?: string[] }[] = []): SessionHub => ({
  resolvePane: () => ({ paneId: 'pane', entry: { mux: { kind: 'herdr', processInfo: async () => ({ foregroundProcessGroupId: 2, foregroundProcesses: processes }) }, tree: { panes: [{ id: 'pane', agent, agentSession }] } } }),
});

describe('resolveSession (omp / omo / gjc)', () => {
  test('omp trusts the Herdr path report only', async () => {
    await expect(resolveSession(agentHub('omp', ompPath), paneKey)).resolves.toEqual({ agent: 'omp', path: ompPath });
  });

  test('an id-only or relative report leaves omp unresolved', async () => {
    await expect(resolveSession(agentHub('omp', 'omp-session'), paneKey)).resolves.toBeUndefined();
    await expect(resolveSession(agentHub('omp', 'sessions/omp-session.jsonl'), paneKey)).resolves.toBeUndefined();
  });

  test('omo and gjc panes never resolve, even with a path-shaped report', async () => {
    await expect(resolveSession(agentHub('omo'), paneKey)).resolves.toBeUndefined();
    await expect(resolveSession(agentHub('gjc', ompPath), paneKey)).resolves.toBeUndefined();
  });
});

describe('ChatLens (omp)', () => {
  const hub = (agent: string | undefined, agentSession?: string): ChatHub => ({
    ...agentHub(agent, agentSession),
    state: async () => ({ panes: [{ key: paneKey, cwd: '/home/user/fixture' }] }) as State,
    paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
  });
  const io: TranscriptIo = {
    stat: async () => ({ inode: '1', size: source.length, mtime: 'now' }),
    read: async () => source,
  };

  test('serves the file’s name as sessionId under the omp agent kind, with no subagent views', async () => {
    const lens = new ChatLens(hub('omp', ompPath), io, '/home/tama');
    const chat = await lens.query(paneKey);
    expect(chat?.sessionId).toBe('omp-session');
    expect(chat?.agentKind).toBe('omp');
    expect(chat?.turns).toHaveLength(4);
    expect(chat?.subagents).toEqual([]);
    await expect(lens.subagentList(paneKey)).resolves.toEqual([]);
    lens.close();
  });

  test('an omo pane stays on its Screen', async () => {
    const lens = new ChatLens(hub('omo', ompPath), io, '/home/tama');
    await expect(lens.query(paneKey)).resolves.toBeUndefined();
    lens.close();
  });
});
