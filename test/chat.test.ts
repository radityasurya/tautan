import { describe, expect, test } from 'bun:test';
import { parseTranscript } from '../shared/chat.ts';
import { ChatLens, resolveSession, transcriptPath, type ChatHub, type SessionHub, type TranscriptIo } from '../server/chat.ts';
import type { State } from '../shared/types.ts';

const id = '11111111-1111-1111-1111-111111111111';
const paneKey = 'local/mux/pane';

const sessionHub = (agentSession?: string, processes: { pid?: number; name?: string; argv?: string[] }[] = []): SessionHub => ({
  resolvePane: () => ({ paneId: 'pane', entry: { mux: { kind: 'herdr', processInfo: async () => ({ foregroundProcessGroupId: 2, foregroundProcesses: processes }) }, tree: { panes: [{ id: 'pane', agentSession }] } } }),
});

describe('parseTranscript', () => {
  test('keeps display turns and drops Claude control records', () => {
    const jsonl = [
      { type: 'user', timestamp: '2026-10-06T00:00:00.000Z', message: { content: 'Explain this failure.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I will inspect it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status --short' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'hidden' }] } },
      { type: 'user', message: { content: '<command-name>git status</command-name>' } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', text: 'Explain this failure.', tools: [], at: Date.parse('2026-10-06T00:00:00.000Z') },
      { role: 'assistant', text: 'I will inspect it.', tools: [{ name: 'Bash', brief: 'git status --short', detail: 'git status --short' }] },
    ]);
  });

  test('keeps the full tool input as detail, newlines kept and capped', () => {
    const command = 'cd /home/tama/projects/uxui-issue-9 && git add .claude/skills/slides/scripts/generate.ts \\\n  && git commit -m "slides"';
    const jsonl = [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command, description: 'Commit the slides script' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts', old_string: 'one\ntwo', new_string: 'three' } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', path: 'web' } },
        { type: 'tool_use', name: 'Task', input: { prompt: 'x'.repeat(5_000) } },
      ] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [bash, edit, grep, task] = parseTranscript(jsonl)[0]!.tools;
    expect(bash!.brief).toBe('cd /home/tama/projects/uxui-issue-9 && git add .claude/skills/slides/scripts/ge…');
    expect(bash!.detail).toBe(`# Commit the slides script\n${command}`);
    expect(edit!.detail).toBe('/a.ts\n\n- one\n- two\n+ three');
    expect(grep!.detail).toBe('TODO\nin web');
    expect(task!.detail).toHaveLength(4_000);
    expect(task!.detail.endsWith('…')).toBe(true);
  });

  test('merges adjacent turns and caps their text', () => {
    const jsonl = [
      { type: 'assistant', message: { content: 'a'.repeat(3_000) } },
      { type: 'assistant', message: { content: 'b'.repeat(3_000) } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn] = parseTranscript(jsonl);
    expect(turn!.text).toHaveLength(4_000);
    expect(turn!.text.endsWith('…')).toBe(true);
  });
});

test('uses Claude Code project path munging', () => {
  expect(transcriptPath('/home/tama/projects/taut', id, '/home/tama')).toBe(`/home/tama/.claude/projects/-home-tama-projects-taut/${id}.jsonl`);
});

describe('resolveSession', () => {
  test('uses herdr agent_session before process arguments', async () => {
    await expect(resolveSession(sessionHub(id, [{ name: 'claude', argv: ['claude', '--resume', '22222222-2222-2222-2222-222222222222'] }]), paneKey)).resolves.toEqual({ sessionId: id });
  });

  test('finds a Claude resume descriptor in the foreground processes', async () => {
    await expect(resolveSession(sessionHub(undefined, [
      { pid: 1, name: 'zsh', argv: ['zsh'] },
      { pid: 2, name: 'claude', argv: ['claude', '--session-id', id] },
    ]), paneKey)).resolves.toEqual({ sessionId: id });
  });
});

test('ChatLens parses only when the transcript signature changes', async () => {
  let reads = 0;
  const hub: ChatHub = {
    ...sessionHub(id),
    state: async () => ({ panes: [{ key: paneKey, cwd: '/home/tama/projects/taut' }] }) as State,
    paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
  };
  const io: TranscriptIo = {
    stat: async () => ({ inode: '1', size: 10, mtime: 'now' }),
    read: async () => { reads++; return JSON.stringify({ type: 'user', message: { content: 'hello' } }); },
  };
  const lens = new ChatLens(hub, io, '/home/tama');
  await lens.query(paneKey);
  await lens.query(paneKey);
  lens.close();
  expect(reads).toBe(1);
});
