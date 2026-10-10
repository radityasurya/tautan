import { describe, expect, test } from 'bun:test';
import { parseTranscript, pendingTools, type TranscriptImage } from '../shared/chat.ts';
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
      { type: 'user', message: { content: '<local-command-stdout>Switched model.</local-command-stdout>' } },
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

  test('merges adjacent turns uncapped; each source block caps at 16 000', () => {
    const jsonl = [
      { type: 'assistant', message: { content: 'a'.repeat(3_000) } },
      { type: 'assistant', message: { content: 'b'.repeat(3_000) } },
      { type: 'assistant', message: { content: 'c'.repeat(20_000) } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn] = parseTranscript(jsonl);
    expect(turn!.text).toHaveLength(3_000 + 2 + 3_000 + 2 + 16_000); // the merged run keeps its end
    expect(turn!.text.endsWith('…')).toBe(true); // the one oversized block was cut
  });

  test('recovers a human queued prompt as a user turn; the flushed copy does not double it', () => {
    const jsonl = [
      { type: 'assistant', timestamp: '2026-10-06T00:00:00.000Z', message: { content: 'Working.' } },
      { type: 'attachment', isSidechain: false, timestamp: '2026-10-06T00:00:01.000Z', uuid: 'q-1',
        attachment: { type: 'queued_command', prompt: 'Ship it next.', commandMode: 'prompt', origin: { kind: 'human' }, timestamp: '2026-10-06T00:00:01.000Z' } },
      { type: 'attachment', timestamp: '2026-10-06T00:00:02.000Z',
        attachment: { type: 'queued_command', prompt: 'no origin is human too', commandMode: 'prompt' } },
      { type: 'attachment', timestamp: '2026-10-06T00:00:03.000Z',
        attachment: { type: 'queued_command', prompt: 'peer is not the user', commandMode: 'prompt', origin: { kind: 'peer' } } },
      { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-06T00:00:04.000Z' },
      { type: 'assistant', timestamp: '2026-10-06T00:00:05.000Z', message: { content: 'Done.' } },
      { type: 'user', timestamp: '2026-10-06T00:00:06.000Z', message: { content: 'Ship it next.' } }, // the flushed copy
      { type: 'assistant', timestamp: '2026-10-06T00:00:07.000Z', message: { content: 'Shipping.' } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    expect(parseTranscript(jsonl).map(turn => [turn.id, turn.role, turn.text])).toEqual([
      [undefined, 'assistant', 'Working.'],
      ['q-1', 'user', 'Ship it next.\n\nno origin is human too'], // two queued prompts merge, like typed ones
      [undefined, 'assistant', 'Done.\n\nShipping.'], // the flushed copy merged away
    ]);
  });

  test('renders slash commands and shell lines as the user sent them', () => {
    const jsonl = [
      { type: 'user', message: { content: '<command-message>lead</command-message>\n<command-name>/lead</command-name>\n<command-args>extend the chat view</command-args>' } },
      { type: 'assistant', message: { content: 'Leading.' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' } },
      { type: 'assistant', message: { content: 'Cleared.' } },
      { type: 'user', message: { content: '<bash-input>npm login</bash-input>' } },
      { type: 'user', message: { content: '<local-command-stdout>Logged in</local-command-stdout>' } },
      { type: 'user', message: { content: '<bash-stderr>not logged in</bash-stderr>' } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    // a `!` line's output follows it as its own entry and shows under it; a slash command's does not
    expect(parseTranscript(jsonl).map(turn => turn.text)).toEqual(['/lead extend the chat view', 'Leading.', '/clear', 'Cleared.', '!npm login\n\n```\nnot logged in\n```']);
  });

  test("a shell line's long output keeps its last 40 lines, fenced past any backticks inside", () => {
    const out = [...Array.from({ length: 50 }, (_, n) => `line ${n + 1}`), '```done```'].join('\n');
    const jsonl = [
      { type: 'user', message: { content: '<bash-input>make dev</bash-input>' } },
      { type: 'user', message: { content: `<bash-stdout>\x1b[32m${out}\x1b[0m</bash-stdout><bash-stderr></bash-stderr>` } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn] = parseTranscript(jsonl);
    const [command, block] = turn!.text.split('\n\n');
    expect(command).toBe('!make dev');
    expect(block!.split('\n').slice(0, 3)).toEqual(['````', '…', 'line 12']);
    expect(block!.endsWith('```done```\n````')).toBe(true);
  });

  test('drops isMeta records and compacts a compact summary', () => {
    const jsonl = [
      { type: 'user', isMeta: true, message: { content: 'A skill body or image placeholder.' } },
      { type: 'user', isCompactSummary: true, uuid: 'c-1', timestamp: '2026-10-06T00:00:00.000Z',
        message: { content: 'This conversation is being continued from a previous one. Giant summary follows.' } },
      { type: 'assistant', message: { content: 'Continuing.' } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    expect(parseTranscript(jsonl)).toEqual([
      { id: 'c-1', role: 'assistant', text: '_Conversation compacted._\n\nContinuing.', tools: [], at: Date.parse('2026-10-06T00:00:00.000Z') },
    ]);
  });

  test('keeps thinking, joined with a blank line, and caps it like text', () => {
    const jsonl = [
      { type: 'assistant', message: { content: [
        { type: 'thinking', thinking: '', signature: 'CAIS1xUKpgEIERgC' }, // signature-only: no words
        { type: 'thinking', thinking: 'Weigh the two fixes.' },
        { type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' },
      ] } },
      { type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'Then ship.' },
        { type: 'thinking', thinking: 'y'.repeat(20_000) },
        { type: 'text', text: 'Take the first.' },
      ] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn] = parseTranscript(jsonl);
    expect(turn!.thinking).toBe(`Weigh the two fixes.\n\nThen ship.\n\n${'y'.repeat(15_999)}…`);
    expect(turn!.text).toBe('Take the first.');
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
    const [turn, after] = parseTranscript(jsonl);
    expect(turn!.text).toBe('Checking both.');
    expect(after!.text).toBe('Done.'); // words after the tool rows open the next Turn
    expect(turn!.tools.map(t => [t.brief, t.output, t.truncated])).toEqual([['a.png', '**A** fine', undefined], ['b.png', 'B cut…', true]]);
  });

  test('lifts z.ai blocks whose markers vary in case and spacing, or whose Input fence never closed', () => {
    const loose = '** 🌐 Z.AI BUILT-IN TOOL: web_search **\n**Input:**\n```JSON\n{"query":"tautan"}\n```\n*executing on server…*\n';
    const cut = '**🌐 z.ai Built-in Tool: web_search**\n**Input:**\n```json\n{"query":"still running ';
    const out = '**output:** \n**Web_Search_Result_Summary:** [{"text": "\\"found\\""}]\n';
    const jsonl = [
      { type: 'assistant', message: { content: [{ type: 'text', text: `Loose one.\n${loose}` }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: cut }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `${out}\nDone.` }] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn, after] = parseTranscript(jsonl);
    expect(turn!.text).toBe('Loose one.');
    expect(after!.text).toBe('Done.');
    expect(turn!.tools.map(t => [t.name, t.brief, t.output])).toEqual([
      ['web_search', 'tautan', 'found'],
      // the cut input never parsed, so its brief keeps the raw JSON head
      ['web_search', JSON.stringify('{"query":"still running'), undefined],
    ]);
    expect(turn!.tools[1]!.detail).toBe('{"query":"still running'); // the unclosed fence keeps its input
  });

  test('ordinary prose that names the tool or heads a section Output stays prose', () => {
    const jsonl = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The z.ai built-in tool: web_search ran fine.\n\n**Output:**\n**Notes:** nothing here.' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const [turn] = parseTranscript(jsonl);
    expect(turn!.tools).toEqual([]);
    expect(turn!.text).toContain('**Output:**');
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

  test('pasted images number out of band in file order; the rest become placeholders', () => {
    const image = (data: string, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } });
    const jsonl = [
      { type: 'user', message: { content: [
        { type: 'text', text: 'Look [Image #1]' },
        image('iVBORw0KGgo='),
        image('PHN2Zz4=', 'image/svg+xml'),
        image('not base64!'),
        image('A'.repeat(8_000_001)),
        image('AAAA'),
      ] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const images: TranscriptImage[] = [];
    const [turn] = parseTranscript(jsonl, { images });
    expect(turn!.text).toBe('Look [Image #1]');
    expect(turn!.images).toEqual([{ imageId: 0 }, {}, {}, {}, { imageId: 1 }]);
    expect(images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { mediaType: 'image/png', data: 'AAAA' }]);
    expect(JSON.stringify(turn)).not.toContain('data:image'); // no bytes ride in the turns
  });

  test('a pasted image and a tool-result image number together in file order', () => {
    const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    const jsonl = [
      { type: 'user', message: { content: [image('AAAA')] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.png' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [image('BBBB')] }] } },
    ].map(entry => JSON.stringify(entry)).join('\n');
    const images: TranscriptImage[] = [];
    const turns = parseTranscript(jsonl, { images });
    expect(turns[0]!.images).toEqual([{ imageId: 0 }]);
    expect(turns[1]!.tools[0]!.imageId).toBe(1);
    expect(images.map(item => item.data)).toEqual(['AAAA', 'BBBB']);
  });

  test('an image-only user turn is kept', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lG' } }] } });
    const images: TranscriptImage[] = [];
    expect(parseTranscript(jsonl, { images })).toEqual([{ role: 'user', text: '', tools: [], images: [{ imageId: 0 }] }]);
    expect(images).toEqual([{ mediaType: 'image/gif', data: 'R0lG' }]);
  });

  test('leaves a plain Output heading in the text', () => {
    const text = 'Run it.\n\n**Output:**\n**exit:** 0';
    expect(parseTranscript(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }))[0]!.text).toBe(text);
  });

  describe('tool results', () => {
    const use = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
    const result = (id: string, content: unknown, extra: Record<string, unknown> = {}) =>
      ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
    const parse = (...entries: unknown[]) => parseTranscript(entries.map((e) => JSON.stringify(e)).join('\n'));

    test('pairs each result with its tool_use by id, text blocks only', () => {
      const [turn] = parse(
        { type: 'assistant', message: { content: [use('t1', 'ls'), use('t2', 'pwd')] } },
        result('t2', [{ type: 'text', text: '/home/dev' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]),
        result('t1', 'a\nb\n'),
      );
      expect(turn!.tools.map((t) => [t.result, t.resultLines, t.isError])).toEqual([['a\nb', 2, undefined], ['/home/dev', 1, undefined]]);
    });

    test('is_error marks the row, and an empty result leaves no result', () => {
      const [turn] = parse(
        { type: 'assistant', message: { content: [use('t1', 'false'), use('t2', 'true')] } },
        result('t1', 'Exit code 1', { is_error: true }),
        result('t2', ''),
      );
      expect(turn!.tools[0]).toMatchObject({ result: 'Exit code 1', isError: true });
      expect('result' in turn!.tools[1]!).toBe(false);
    });

    test('strips ANSI and control characters, keeps newlines and the last carriage-return segment', () => {
      const [turn] = parse(
        { type: 'assistant', message: { content: [use('t1', 'bun test')] } },
        result('t1', '\x1b[32m✓ pass\x1b[0m\r\n\x1b]0;title\x07 10%\r 100%\n\tdone\x07\x08'),
      );
      expect(turn!.tools[0]!.result).toBe('✓ pass\n 100%\n\tdone');
    });

    test('a long result keeps its last 40 lines after a … marker, whole, with the full text out of band', () => {
      const lines = Array.from({ length: 1_240 }, (_, n) => `line ${n + 1}`);
      const jsonl = [
        { type: 'assistant', message: { content: [use('t1', 'seq')] } },
        result('t1', lines.join('\n')),
      ].map(entry => JSON.stringify(entry)).join('\n');
      const outputs = new Map<string, string>();
      const [turn] = parseTranscript(jsonl, { outputs });
      const tool = turn!.tools[0]!;
      expect(tool.resultLines).toBe(1_240);
      expect(tool.resultTruncated).toBe(true);
      expect(tool.result).toBe(`…\n${lines.slice(1_200).join('\n')}`); // no half line after the marker
      expect(outputs).toEqual(new Map([['t1', lines.join('\n')]]));
    });

    test('a subagent transcript pairs its sidechain results too', () => {
      const jsonl = [
        { type: 'assistant', isSidechain: true, message: { content: [use('t1', 'ls')] } },
        { ...result('t1', 'web'), isSidechain: true },
      ].map((e) => JSON.stringify(e)).join('\n');
      expect(parseTranscript(jsonl, { sidechain: true })[0]!.tools[0]!.result).toBe('web');
    });
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

  describe('previews, links and subagents', () => {
    const page = '<html><head><title>Deck</title></head><body><p>one</p></body></html>';
    const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
    const result = (id: string, content: unknown) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

    test('a Write of an .html file gets a previewId; the Artifact of the same path reuses it and links with the title', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [
          use('toolu_w', 'Write', { file_path: '/tmp/deck.html', content: page }),
          use('toolu_a', 'Artifact', { file_path: '/tmp/deck.html', action: 'publish' }),
          use('toolu_e', 'Edit', { file_path: '/tmp/deck.html', old_string: 'one', new_string: 'two' }),
        ] } },
        result('toolu_a', [{ type: 'text', text: 'Published /tmp/deck.html at https://claude.ai/code/artifact/ee67305a-ece1 (Version 1)' }]),
      ].map(entry => JSON.stringify(entry)).join('\n');
      const previews: string[] = [];
      const turns = parseTranscript(jsonl, { previews });
      const [write, artifact, edit] = turns[0]!.tools;
      expect(write!.previewId).toBe(0);
      expect(artifact!.previewId).toBe(0); // the same path reuses the Write's number
      expect(artifact!.link).toEqual({ url: 'https://claude.ai/code/artifact/ee67305a-ece1', title: 'Deck' });
      expect(edit!.previewId).toBe(1); // its own disk-backed slot: the file on disk serves it
      expect(previews).toEqual([page]);
      expect(JSON.stringify(turns)).not.toContain('<title>'); // the source never rides in the JSON
    });

    test('an Edit or MultiEdit of an .html file, and a Write past the cap, preview from the file on disk', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [
          use('toolu_e', 'Edit', { file_path: 'page.html', old_string: 'one', new_string: 'two' }),
          use('toolu_m', 'MultiEdit', { file_path: 'page.html', edits: [{ old_string: 'a', new_string: 'b' }] }),
          use('toolu_w', 'Write', { file_path: 'big.html', content: '<p>'.repeat(700_000) }),
          use('toolu_s', 'Edit', { file_path: 'style.css', old_string: 'a', new_string: 'b' }),
        ] } },
      ].map(entry => JSON.stringify(entry)).join('\n');
      const previews: string[] = [];
      const previewFiles = new Map<number, string>();
      const [turn] = parseTranscript(jsonl, { previews, previewFiles });
      expect(turn!.tools.map(tool => tool.previewId)).toEqual([0, 0, 1, undefined]);
      expect(previewFiles).toEqual(new Map([[0, 'page.html'], [1, 'big.html']])); // both spellings of one file share its slot
      expect(previews).toEqual([]); // no source rides the parse; disk serves by id
    });

    test('an Artifact result as a plain string links without a title when no source matched', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [use('toolu_a', 'Artifact', { url: 'https://claude.ai/artifact/CKCZc8', file_path: '/tmp/canvas/canvas.json' })] } },
        result('toolu_a', 'Published /tmp/canvas/Tabs.dc.html at https://claude.ai/artifact/4AMZUkdtNKG9dPiTrohCsu (Version 1)'),
      ].map(entry => JSON.stringify(entry)).join('\n');
      const [artifact] = parseTranscript(jsonl, { previews: [] })[0]!.tools;
      expect(artifact!.link).toEqual({ url: 'https://claude.ai/artifact/4AMZUkdtNKG9dPiTrohCsu' });
      expect(artifact!.previewId).toBeUndefined();
    });

    test('a Task or Agent call linked by toolUseId carries subagentId; sidechain entries parse for a subagent file', () => {
      const jsonl = [
        { type: 'assistant', message: { content: [use('toolu_t', 'Task', { prompt: 'Draft it.' })] } },
        { type: 'user', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent prompt' }] } },
      ].map(entry => JSON.stringify(entry)).join('\n');
      const subagentIds = new Map([['toolu_t', 'a0545184616cb692f']]);
      expect(parseTranscript(jsonl, { subagentIds })[0]!.tools[0]!.subagentId).toBe('a0545184616cb692f');
      expect(parseTranscript(jsonl)).toHaveLength(1); // sidechain entries stay hidden in the main conversation
      const subagent = parseTranscript(jsonl, { subagentIds, sidechain: true });
      expect(subagent).toHaveLength(2);
      expect(subagent[1]!.text).toBe('subagent prompt');
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

describe('pendingTools', () => {
  const tool = (name: string, result?: string, isError?: boolean) => ({ name, brief: name, detail: name, ...(result !== undefined ? { result } : {}), ...(isError ? { isError } : {}) });
  test('every tool with no result on a final assistant turn, in call order', () => {
    expect(pendingTools([{ role: 'assistant', text: '', tools: [tool('Read', 'ok'), tool('Bash'), tool('Edit', 'done')] }])).toEqual([{ turn: 0, tool: 1 }]);
  });
  test('parallel calls that each wait for approval all list, oldest first', () => {
    expect(pendingTools([{ role: 'assistant', text: '', tools: [tool('Bash'), tool('Edit'), tool('Read', 'ok'), tool('Write')] }]))
      .toEqual([{ turn: 0, tool: 0 }, { turn: 0, tool: 1 }, { turn: 0, tool: 3 }]);
  });
  test('none when every tool finished or failed, or the final turn is the user', () => {
    expect(pendingTools([{ role: 'assistant', text: '', tools: [tool('Read', 'ok'), tool('Bash', undefined, true)] }])).toEqual([]);
    expect(pendingTools([{ role: 'assistant', text: '', tools: [tool('Bash')] }, { role: 'user', text: 'hi', tools: [] }])).toEqual([]);
    expect(pendingTools([])).toEqual([]);
  });
});
