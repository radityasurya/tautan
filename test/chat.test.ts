import { describe, expect, test } from 'bun:test';
import { parseTranscript, type TranscriptImage } from '../shared/chat.ts';
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

  test('a z.ai tool carries its imageSource; a Read of an image carries its path', () => {
    const call = `**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n\`\`\`json\n{"imageSource":"https://x.test/a.png?sig=1","prompt":"p"}\n\`\`\`\n*Executing on server...*\n`;
    const jsonl = [
      { type: 'assistant', message: { content: [
        { type: 'text', text: call },
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/shots/home.PNG' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/icon.svg' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/repo/out.png', content: 'x' } },
      ] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    expect(parseTranscript(jsonl)[0]!.tools.map(t => t.image)).toEqual(['https://x.test/a.png?sig=1', '/repo/shots/home.PNG', undefined, undefined]);
  });

  test('pasted images become data URLs within the caps; the rest become placeholders', () => {
    const image = (data: string, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } });
    const jsonl = [
      { type: 'user', message: { content: [
        { type: 'text', text: 'Look [Image #1]' },
        image('iVBORw0KGgo='),
        image('PHN2Zz4=', 'image/svg+xml'),
        image('not base64!'),
        image('A'.repeat(1_400_001)),
        image('AAAA'), image('AAAA'), image('AAAA'), image('AAAA'),
      ] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn] = parseTranscript(jsonl);
    expect(turn!.text).toBe('Look [Image #1]');
    expect(turn!.images!.map(i => i.src)).toEqual([
      'data:image/png;base64,iVBORw0KGgo=', undefined, undefined, undefined,
      'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA', undefined,
    ]);
  });

  test('pasted images over the transcript budget keep the newest', () => {
    const big = 'A'.repeat(1_400_000);
    const turn = { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: big } }] } };
    const reply = { type: 'assistant', message: { content: 'ok' } };
    const jsonl = [turn, reply, turn, reply, turn, reply, turn, reply, turn].map(entry => JSON.stringify(entry)).join('\n');
    const kept = parseTranscript(jsonl).filter(t => t.role === 'user').map(t => Boolean(t.images![0]!.src));
    expect(kept).toEqual([false, true, true, true, true]);
  });

  test('an image-only user turn is kept', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lG' } }] } });
    expect(parseTranscript(jsonl)).toEqual([{ role: 'user', text: '', tools: [], images: [{ src: 'data:image/gif;base64,R0lG' }] }]);
  });

  test('leaves a plain Output heading in the text', () => {
    const text = 'Run it.\n\n**Output:**\n**exit:** 0';
    expect(parseTranscript(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }))[0]!.text).toBe(text);
  });

  describe('tool_result images', () => {
    const image = (data: string, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } });
    const read = (id: string, file_path: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path } });
    const result = (id: string, content: unknown) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

    test('two Reads get imageId 0 and 1; the bytes come back out of band', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [read('toolu_1', '/tmp/a.png'), read('toolu_2', '/tmp/b.jpg')] } },
        result('toolu_1', [image('iVBORw0KGgo=')]),
        result('toolu_2', [image('/9j/', 'image/jpeg')]),
      ].map(entry => JSON.stringify(entry)).join('\n');
      const images: TranscriptImage[] = [];
      const turns = parseTranscript(jsonl, { images });
      expect(turns[0]!.tools.map(tool => tool.imageId)).toEqual([0, 1]);
      expect(images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { mediaType: 'image/jpeg', data: '/9j/' }]);
      expect(JSON.stringify(turns)).not.toContain('iVBORw0KGgo');
    });

    test('a non-image tool_result and an unsupported media type give no imageId', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [read('toolu_1', '/tmp/a.png'), read('toolu_2', '/tmp/b.svg'), read('toolu_3', '/tmp/c.png')] } },
        result('toolu_1', [{ type: 'text', text: 'plain text result' }]),
        result('toolu_2', [image('PHN2Zz4=', 'image/svg+xml')]),
        result('toolu_3', 'a string result'),
      ].map(entry => JSON.stringify(entry)).join('\n');
      const images: TranscriptImage[] = [];
      expect(parseTranscript(jsonl, { images })[0]!.tools.map(tool => tool.imageId)).toEqual([undefined, undefined, undefined]);
      expect(images).toEqual([]);
    });

    test('only the first image of a result links; the rest still count', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [read('toolu_1', '/tmp/a.png')] } },
        result('toolu_1', [image('AAAA'), image('BBBB')]),
      ].map(entry => JSON.stringify(entry)).join('\n');
      const images: TranscriptImage[] = [];
      expect(parseTranscript(jsonl, { images })[0]!.tools.map(tool => tool.imageId)).toEqual([0]);
      expect(images).toHaveLength(2);
    });

    test('an image over the cap is skipped without taking an id', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [read('toolu_1', '/tmp/a.png'), read('toolu_2', '/tmp/b.png')] } },
        result('toolu_1', [image('A'.repeat(8_000_001))]),
        result('toolu_2', [image('BBBB')]),
      ].map(entry => JSON.stringify(entry)).join('\n');
      const images: TranscriptImage[] = [];
      expect(parseTranscript(jsonl, { images })[0]!.tools.map(tool => tool.imageId)).toEqual([undefined, 0]);
      expect(images).toEqual([{ mediaType: 'image/png', data: 'BBBB' }]);
    });
  });
});

test('uses Claude Code project path munging', () => {
  expect(transcriptPath('/home/tama/projects/taut', id, '/home/tama')).toBe(`/home/tama/.claude/projects/-home-tama-projects-taut/${id}.jsonl`);
});

describe('resolveSession', () => {
  test('uses herdr agent_session before process arguments', async () => {
    await expect(resolveSession(sessionHub(id, [{ name: 'claude', argv: ['claude', '--resume', '22222222-2222-2222-2222-222222222222'] }]), paneKey)).resolves.toEqual({ agent: 'claude', sessionId: id });
  });

  test('finds a Claude resume descriptor in the foreground processes', async () => {
    await expect(resolveSession(sessionHub(undefined, [
      { pid: 1, name: 'zsh', argv: ['zsh'] },
      { pid: 2, name: 'claude', argv: ['claude', '--session-id', id] },
    ]), paneKey)).resolves.toEqual({ agent: 'claude', sessionId: id });
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

test('ChatLens serves a tool_result image from the cached parse', async () => {
  let reads = 0;
  const jsonl = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.png' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } },
  ].map(entry => JSON.stringify(entry)).join('\n');
  const hub: ChatHub = {
    ...sessionHub(id),
    state: async () => ({ panes: [{ key: paneKey, cwd: '/home/tama/projects/taut' }] }) as State,
    paneHost: async () => 'local', host: () => undefined, watchedPaneKeys: () => new Set(),
  };
  const io: TranscriptIo = {
    stat: async () => ({ inode: '1', size: 10, mtime: 'now' }),
    read: async () => { reads++; return jsonl; },
  };
  const lens = new ChatLens(hub, io, '/home/tama');
  const image = (await lens.image(paneKey, 0))?.image;
  expect(image?.mediaType).toBe('image/png');
  expect(Buffer.from(image!.bytes).toString('base64')).toBe('iVBORw0KGgo=');
  expect(await lens.image(paneKey, 1)).toEqual({ image: undefined });
  expect(await lens.image('local/mux/none', 0)).toBeUndefined();
  lens.close();
  expect(reads).toBe(1);
});
