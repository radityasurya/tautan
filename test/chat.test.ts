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
  // A real z.ai turn (GLM through Claude Code), the signed image URL shortened.
  const zaiTurn = "This environment reads images through the analyze-image tool \u2014 inspecting both flagged slides:\n\n**\ud83c\udf10 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{\"imageSource\":\"https://maas-log-prod.cn-wlcb.ufileos.com/anthropic/9ba4f7e5-4c2a-467b-bd24-c00186ba3758/dark-slide-3.png?sig=x\",\"prompt\":\"This is a 1920x1080 presentation slide with a chart. Measure and report the approximate pixel heights of the capital text (x-height or cap-height) for each of these elements, and state which is the largest text on the slide: (1) the slide headline at the top (\\\"Where the p99 goes\\\" or similar), (2) the small badge/pill label above the headline, (3) the chart's axis tick labels (numbers on the axes), (4) the chart legend labels at the bottom of the chart, (5) the footer text at the very bottom of the slide, (6) any chart card title inside the chart card. Also report: is any text clipped, overflowing its container, or overlapping? Does the type hierarchy read clearly (headline dominant)? Be specific with pixel estimates.\"}\n```\n*Executing on server...*\n\n\n**Output:**\n**analyze_image_result_summary:** [{\"text\": \"\\\"# Text Measurement Analysis\\\\n\\\\n## Approximate Cap Heights (pixel measurements)\\\\n\\\\n| Element | Cap Height | Notes |\\\\n|---|---|---|\\\\n| (1) Headline \\\\\\\"Where the p99 goes\\\\\\\" | **~45\u201348 px** | Cap height of \\\\\\\"W\\\\\\\"; full font size ~62\u201364 px |\\\\n| (2) Badge/pill \\\\\\\"Latency\\\\\\\" | *...\n                                                \n\ndark-slide-3 fixed: headline ~62-64px font vs ticks ~20-22px, chart title between them, no clipping. Now the acme one:\n";

  test('lifts a z.ai built-in tool out of the text into a tool row, output decoded', () => {
    const jsonl = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: zaiTurn }] } });
    const [turn] = parseTranscript(jsonl);
    expect(turn!.text).toBe('This environment reads images through the analyze-image tool — inspecting both flagged slides:\n\ndark-slide-3 fixed: headline ~62-64px font vs ticks ~20-22px, chart title between them, no clipping. Now the acme one:');
    const [tool] = turn!.tools;
    expect(tool!.name).toBe('analyze_image');
    expect(tool!.via).toBe('z.ai');
    expect(tool!.brief).toBe('dark-slide-3.png');
    expect(JSON.parse(tool!.detail).prompt.startsWith('This is a 1920x1080 presentation slide')).toBe(true);
    expect(tool!.truncated).toBe(true);
    expect(tool!.output!.startsWith('# Text Measurement Analysis\n\n## Approximate Cap Heights (pixel measurements)\n\n| Element | Cap Height | Notes |\n|---|---|---|\n| (1) Headline "Where the p99 goes" |')).toBe(true);
    expect(tool!.output!.endsWith('| *…')).toBe(true);
  });

  test('pairs parallel z.ai calls with their outputs in order, across messages', () => {
    const call = (file: string) => `**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n\`\`\`json\n{"imageSource":"https://x.test/${file}","prompt":"p"}\n\`\`\`\n*Executing on server...*\n`;
    const out = (text: string) => `**Output:**\n**analyze_image_result_summary:** ${JSON.stringify([{ text: JSON.stringify(text) }])}\n`;
    const jsonl = [
      { type: 'assistant', message: { content: [{ type: 'text', text: `Checking both.\n${call('a.png')}\n${call('b.png')}` }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `${out('**A** fine')}\n   \n\n${out('B cut...')}\nDone.` }] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn] = parseTranscript(jsonl);
    expect(turn!.text).toBe('Checking both.\n\nDone.');
    expect(turn!.tools.map(t => [t.brief, t.output, t.truncated])).toEqual([['a.png', '**A** fine', undefined], ['b.png', 'B cut…', true]]);
  });

  test('leaves a plain Output heading in the text', () => {
    const text = 'Run it.\n\n**Output:**\n**exit:** 0';
    expect(parseTranscript(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }))[0]!.text).toBe(text);
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
