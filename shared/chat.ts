export interface Tool {
  /** The row's native id (Claude's tool_use `toolu_…`, pi's `toolCallId`): when
   *  `resultTruncated` is set, the whole text serves from
   *  `GET /api/panes/:key/chat/output/<id>`. Absent on z.ai rows, which have no native id. */
  id?: string;
  name: string;
  brief: string;
  /** The tool's whole input, or its head when it was cut: the first `DETAIL_LINES` lines
   *  within `DETAIL_CHARS` characters (ADR 0007's amendment), with `detailTruncated` set and
   *  the whole text served from `GET /api/panes/:key/chat/output/<id>?part=detail`. Every
   *  pending tool keeps its whole detail inline, so an approval row needs no fetch. */
  detail: string;
  /** The inline `detail` keeps only its head; the whole text serves by the row's id. */
  detailTruncated?: boolean;
  /** Lines in the whole detail, so a cut one can say "first 6 of 240". */
  detailLines?: number;
  /** Set on a z.ai built-in tool, which z.ai writes into the assistant text, not as tool_use. */
  via?: 'z.ai';
  /** The decoded z.ai output (Markdown), capped like detail. */
  output?: string;
  /** z.ai cut the output short before it reached the transcript. */
  truncated?: boolean;
  /** The image the tool read or analysed: a file path for Read, a URL for a z.ai tool. */
  image?: string;
  /** The image a Read returned, kept in the transcript: served by
   *  `GET /api/panes/:key/chat/image/:imageId`, never inlined in the chat JSON. */
  imageId?: number;
  /** A published page the tool returned (the Artifact tool's claude.ai URL), for a link card. */
  link?: { url: string; title?: string };
  /** HTML the Agent wrote or edited, served by
   *  `GET /api/panes/:key/chat/preview/:previewId` as text/html under a sandbox CSP, for a
   *  sandboxed preview. Never inlined in the chat JSON. A Write's source (or an Artifact's)
   *  rides the cached parse; an Edit's row, or a Write past PREVIEW_MAX, names the file on
   *  disk, which the Hub serves only when the path resolves inside the Pane's cwd and ends
   *  .html or .htm. */
  previewId?: number;
  /** The subagent this tool started (Task/Agent): its turns come from
   *  `GET /api/panes/:key/chat?agent=<subagentId>`. */
  subagentId?: string;
  /** What the tool returned (Claude's tool_result, pi's toolResult), text blocks only: plain
   *  text, ANSI and control characters stripped, newlines kept. Over RESULT_CHARS it keeps the
   *  tail, whole lines, after a leading `…` line. Absent when the tool returned no text. */
  result?: string;
  /** The inline `result` keeps only the last 40 lines; the whole text serves from
   *  `GET /api/panes/:key/chat/output/<id>`. */
  resultTruncated?: boolean;
  /** Lines in the whole result, so a sliced one can say "last 40 of 1 240". */
  resultLines?: number;
  /** The tool reported a failure (Claude's `is_error`, pi's `isError`). */
  isError?: boolean;
}

/** A subagent of the conversation, from Claude Code's `<session>/subagents/agent-<id>.meta.json`. */
export interface Subagent {
  id: string;
  type?: string;
  description?: string;
  /** The tool_use that started it, which carries `subagentId` in the parent's turns. */
  toolUseId?: string;
  /** The subagent that started this one, when nested; absent for the main conversation's. */
  parentId?: string;
  at?: number;
  /** Its conversation file's mtime in ms; it moves while the subagent runs. */
  updatedAt?: number;
  /** Whether it still runs, judged by the Hub from the file's ending and the parent's
   *  completion records. Absent on an older Hub; the browser then keeps its own guess. */
  state?: 'running' | 'done';
}

/** `GET /api/panes/:key/chat[?agent=<id>]`. `subagents` lists the whole tree, on both forms. */
export interface ChatResponse {
  sessionId: string;
  turns: Turn[];
  at: number;
  subagents?: Subagent[];
  /** Set when the response is a subagent's own conversation. */
  agent?: string;
  /** Which agent's transcript this is, for the Chat view's agent badge (Wave 12.4). */
  agentKind?: 'claude' | 'pi' | 'codex' | 'omp';
}

/** `GET /api/panes/:key/chat?since=<cursor>[&agent=<id>]` (ADR 0007): only what changed
 *  since the cursor. Merge `upserts` by `Turn.id`; on `reset` replace the whole list. */
export interface ChatDelta {
  sessionId: string;      // as today
  cursor: string;         // names this parse; send it back as ?since next time
  reset: boolean;         // true: upserts is the whole conversation, replace the list
  upserts: Turn[];        // transcript order; merge by id
  subagents?: Subagent[]; // the whole tree, when it changed, and always on a reset
  /** The conversation's whole turn count, on a windowed answer (the amendment): the turns
   *  served are the last page, and `Load earlier` asks for the rest. */
  total?: number;
  /** Set when the response is a subagent's own conversation, as today. */
  agent?: string;
  /** Which agent's transcript this is, as on `ChatResponse`. */
  agentKind?: 'claude' | 'pi' | 'codex' | 'omp';
}

/** The `chat` event on `/api/events`: a watched Pane's conversation moved to a new
 *  generation. A wake-up, not the data — the client then makes the same idempotent
 *  `?since=` GET, and a missed event only delays it. */
export interface ChatEvent {
  pane: string;
  cursor: string;
  /** Set when the generation is a `?agent=` view's own conversation. */
  agent?: string;
}

/** An image pasted into a user turn: served by `GET /api/panes/:key/chat/image/:imageId`,
 *  numbered in file order with tool-result images, never inlined. `imageId` is absent when
 *  the image was over the per-image memory bound. `src` (a data URL) is the pre-11.2 shape;
 *  this Hub never sets it. */
export interface Pasted { imageId?: number; src?: string }

export interface Turn {
  /** The native id of the run's first contributing entry — Claude's entry `uuid`, pi's
   *  entry `id` (ADR 0007). Stable across re-parses; absent when the transcript carries no
   *  native ids, which makes every `?since=` answer a reset. */
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  /** The run's reasoning text, when the transcript keeps it (pi; Claude only with thinking
   *  summaries on). Empty and signature-only blocks leave it absent. */
  thinking?: string;
  tools: Tool[];
  images?: Pasted[];
  at?: number;
  /** A message another Agent of the team sent this one (`@orchestrator`): `text` is its body.
   *  Such a Turn stands alone, never merged with the run around it. */
  from?: string;
}

/**
 * The tool rows a blocked Agent is asking about: every tool of the final turn, in call order,
 * that has no result, output or error yet. The first is the one the on-screen prompt asks
 * about, because the prompt answers one tool at a time; the rest queue behind it. Empty when
 * the final turn is the user's or every tool finished, so the caller shows the blocked card on
 * its own (a question, not a tool).
 */
export function pendingTools(turns: Turn[]): { turn: number; tool: number }[] {
  const turn = turns.length - 1;
  const last = turns[turn];
  if (last?.role !== 'assistant') return [];
  const out: { turn: number; tool: number }[] = [];
  for (let tool = 0; tool < last.tools.length; tool++) {
    const t = last.tools[tool]!;
    if (t.result === undefined && t.output === undefined && !t.isError) out.push({ turn, tool });
  }
  return out;
}

type Block = { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown; arguments?: unknown; data?: unknown; mimeType?: unknown; source?: unknown; image_url?: unknown; id?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };

const commandWrapper = /^(?:command-name|command-message|local-command(?:-[\w-]+)?|task-notification|bash-(?:input|stdout|stderr))$/;
const shortened = (text: string) => text.length > 80 ? `${text.slice(0, 79)}…` : text;
const turnText = (content: unknown) => typeof content === 'string' ? content : '';

function time(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
}

function wrapper(text: string): boolean {
  const tag = text.split(/\r?\n/, 1)[0]?.match(/^<([^>]+)>/)?.[1];
  return Boolean(tag && commandWrapper.test(tag));
}

// The user's own words inside control wrappers: a slash command (the tag order varies, the
// name already carries its slash) and a `!` shell line.
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const BASH_INPUT = /<bash-input>([\s\S]*?)<\/bash-input>/;
const BASH_OUTPUT = /<bash-(stdout|stderr)>([\s\S]*?)<\/bash-\1>/g;
const SHELL_LINES = 40;

/** A `!` line's output as a fenced block under it: ANSI stripped, the last SHELL_LINES lines
 *  (the end is where an error or a "moved to the background" notice lands), and a fence
 *  longer than any backtick run inside. Empty output is no block at all. */
function shellOutput(output: string): string | undefined {
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '').split(/\r?\n/);
  if (!lines.join('').trim()) return;
  const shown = lines.length > SHELL_LINES ? ['…', ...lines.slice(-SHELL_LINES)] : lines;
  const body = cap(shown.join('\n'));
  const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(run => run[0].length + 1)));
  return `${fence}\n${body}\n${fence}`;
}
function commandText(text: string): string | undefined {
  const name = text.match(COMMAND_NAME)?.[1]?.trim();
  const args = text.match(COMMAND_ARGS)?.[1]?.trim();
  if (name !== undefined) return capTurn(`${name.startsWith('/') ? '' : '/'}${name}${args ? ` ${args}` : ''}`);
  const bash = text.match(BASH_INPUT)?.[1]?.trim();
  return bash === undefined ? undefined : `!${bash}`;
}

/** A prompt the user queued while Claude worked, as a human's words: `origin.kind` `peer`
 *  and `task-notification` are not the user's, and neither is a missing prompt. */
function queuedPrompt(entry: Record<string, unknown>): string | undefined {
  const attachment = entry.attachment;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return;
  const record = attachment as Record<string, unknown>;
  if (record.type !== 'queued_command') return;
  const origin = record.origin;
  const kind = origin && typeof origin === 'object' && !Array.isArray(origin) ? (origin as Record<string, unknown>).kind : undefined;
  if (kind !== undefined && kind !== 'human') return;
  return str(record.prompt);
}

/** A teammate's message as Claude queued it (`origin.kind: peer`): who sent it, and its body. */
function peerMessage(entry: Record<string, unknown>): { from: string; text: string } | undefined {
  const attachment = entry.attachment;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return;
  const record = attachment as Record<string, unknown>;
  const origin = record.origin;
  if (record.type !== 'queued_command' || !origin || typeof origin !== 'object' || Array.isArray(origin)) return;
  const peer = origin as Record<string, unknown>;
  const text = str(peer.body);
  if (peer.kind !== 'peer' || !text) return;
  return { from: str(peer.name) ?? str(peer.from) ?? 'agent', text };
}

function brief(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    for (const key of ['file_path', 'command', 'cmd', 'pattern', 'url', 'path']) if (typeof value[key] === 'string' && value[key].trim()) return shortened(value[key].replace(/\s+/g, ' ').trim());
  }
  try { return shortened(JSON.stringify(input) ?? ''); } catch { return ''; }
}

function cap(text: string): string { return text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text; }

// ADR 0007's amendment (2026-10-10): each source text block caps at 16 000 before it merges;
// the merged Turn caps not at all. A Turn is a whole agent run, so its end — the final
// summary — must survive (the old 4 000 cap on the merged text cut pi's final ~23 %).
const TURN_CHARS = 16_000;
const capTurn = (text: string) => text.length > TURN_CHARS ? `${text.slice(0, TURN_CHARS - 1)}…` : text;

const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const preview = (text: string) => text.length > 600 ? `${text.slice(0, 599)}…` : text;

/** The full tool input for the expanded row: newlines kept, capped like turn text. */
function detail(name: string, input: unknown): string {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const filePath = str(value.file_path) ?? str(value.path);
  const lines: string[] = [];
  if (str(value.command) ?? str(value.cmd)) {
    if (str(value.description)) lines.push(`# ${value.description as string}`);
    lines.push((str(value.command) ?? str(value.cmd))!);
  } else if (str(value.pattern)) {
    lines.push(value.pattern as string);
    if (str(value.path)) lines.push(`in ${value.path as string}`);
  } else if (filePath) {
    lines.push(filePath);
    const edits = Array.isArray(value.edits) ? value.edits as Record<string, unknown>[] : [value];
    for (const edit of edits) {
      const oldText = typeof edit?.old_string === 'string' ? edit.old_string : typeof edit?.oldText === 'string' ? edit.oldText : undefined;
      const newText = typeof edit?.new_string === 'string' ? edit.new_string : typeof edit?.newText === 'string' ? edit.newText : undefined;
      if (oldText === undefined || newText === undefined) continue;
      lines.push('', `- ${preview(oldText).replace(/\n/g, '\n- ')}`, `+ ${preview(newText).replace(/\n/g, '\n+ ')}`);
    }
  }
  if (lines.length) return cap(lines.join('\n'));
  try { return cap(JSON.stringify(input, null, 2) ?? name); } catch { return ''; }
}

// z.ai (GLM) runs its built-in tools server side and writes them into the assistant text:
//   **🌐 Z.ai Built-in Tool: NAME**  **Input:** ```json {…}```  *Executing on server...*
// and, later in the same text or a later one, one result per call, in call order:
//   **Output:**\n**NAME_result_summary:** [{"text": "<JSON string, often cut with ...>"}]
// The markers match whatever their case or spacing, and an Input fence z.ai never closed (a
// message cut mid-input) still lifts. The bold markers themselves stay required, so ordinary
// prose that merely names the tool never becomes a row.
const ZAI_CALL = /^[ \t]*\*\*[ \t]*🌐[ \t]*z\.ai built-in tool:[ \t]*([^*\n]+?)[ \t]*\*\*[ \t]*(?:\n|$)(?:\s*\*\*[ \t]*input:[ \t]*\*\*[ \t]*\n[ \t]*```\w*[ \t]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*\n?|(?=\s*(?![\s\S]))))?(?:\s*\*[ \t]*executing on server[ \t]*(?:\.\.\.|…)[ \t]*\*[ \t]*\n?)?/gim;
const ZAI_OUTPUT = /^[ \t]*\*\*[ \t]*output:[ \t]*\*\*[ \t]*\n[ \t]*\*\*([^*\n]+?)(?:_result_summary)?:\*\*[ \t]*([^\n]*(?:\n(?![ \t]*\n)[^\n]*)*)/gim;
const CUT = /(?:\.\.\.|…)$/;

/** Undo JSON string escapes without requiring the closing quote, so a cut string still reads. */
const unescape = (text: string) => text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])|\\$/g, (_, code?: string) =>
  !code ? '' : code[0] === 'u' ? String.fromCharCode(parseInt(code.slice(1), 16)) : ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[code] ?? code);

/** z.ai's result is a JSON array of {text}, and each text is often a JSON string again. */
function zaiOutput(raw: string): { output: string; truncated: boolean } {
  let texts: string[] | undefined;
  let truncated = false;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) texts = value.map((item) => typeof item?.text === 'string' ? item.text : JSON.stringify(item));
  } catch {}
  if (!texts) {
    const body = raw.match(/^\[\s*\{\s*"text"\s*:\s*"([\s\S]*)$/)?.[1];
    if (body === undefined) return { output: cap(raw.trim()), truncated: CUT.test(raw.trim()) };
    truncated = true; // the array never closed, so z.ai cut it
    texts = [unescape(body.replace(/"\s*\}\s*\]\s*$/, '').replace(CUT, ''))];
  }
  const output = texts.map((text) => {
    text = text.trim();
    if (!text.startsWith('"')) return text;
    try { const inner: unknown = JSON.parse(text); if (typeof inner === 'string') return inner; } catch {}
    return unescape(text.slice(1).replace(/"$/, ''));
  }).join('\n\n').trim();
  truncated ||= CUT.test(output);
  return { output: cap(truncated ? `${output.replace(CUT, '').trimEnd()}…` : output), truncated };
}

function zaiBrief(input: unknown): string {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const image = str(value.imageSource);
  if (image) {
    try { const url = new URL(image); return shortened(decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? url.host)); } catch { return shortened(image); }
  }
  for (const key of ['url', 'query', 'search_query', 'prompt']) if (str(value[key])) return shortened((value[key] as string).replace(/\s+/g, ' ').trim());
  return brief(input);
}

/**
 * Lift z.ai built-in tool blocks out of assistant text into tool rows. Outputs pair with
 * calls in order through `pending`, which spans the transcript because a result can land in
 * a later message than its call.
 */
function liftZai(text: string, pending: Tool[]): { text: string; tools: Tool[] } {
  if (!/z\.ai built-in tool/i.test(text) && !/\*\*[ \t]*output:/i.test(text)) return { text, tools: [] };
  const tools: Tool[] = [];
  text = text.replace(ZAI_CALL, (_, name: string, raw?: string) => {
    let input: unknown = raw ?? '';
    try { if (raw) input = JSON.parse(raw); } catch {}
    const tool: Tool = { name: name.trim(), via: 'z.ai', brief: zaiBrief(input), detail: cap(typeof input === 'string' ? input : JSON.stringify(input, null, 2)) };
    const image = str((input as Record<string, unknown> | null)?.imageSource);
    if (image) tool.image = image;
    tools.push(tool);
    pending.push(tool);
    return '\n';
  });
  text = text.replace(ZAI_OUTPUT, (whole, name: string, raw: string) => {
    if (!pending.length && !tools.length && !/^\s*\[\s*\{/.test(raw)) return whole; // a plain "**Output:**" heading, not z.ai's
    const result = zaiOutput(raw.trim());
    const tool = pending.shift() ?? (tools.push({ name: name.trim(), via: 'z.ai', brief: '', detail: '' }), tools.at(-1)!);
    tool.output = result.output;
    if (result.truncated) tool.truncated = true;
    return '\n';
  });
  return { text: text.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), tools };
}

// The Hub's file route serves these four as images; anything else would arrive as text.
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i;
export const HTML_FILE = /\.html?$/i;
// The cap on one preview source: a Write's content over this never rides the cached parse,
// and a disk read over this answers no preview. A request reads at most this much and
// retains nothing, so the cap holds per request, not per cache.
export const PREVIEW_MAX = 2_000_000;
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;
const TITLE_TAG = /<title[^>]*>\s*([^<]*?)\s*<\/title>/i;

/** A tool_result's text, whether Claude Code wrote it as one string or as text blocks. */
const resultText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(item => item && typeof item === 'object' && !Array.isArray(item) && (item as Block).type === 'text' && typeof (item as Block).text === 'string' ? (item as Block).text : '').join('')
    : '';
const PASTED_TYPE = /^image\/(?:png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** An image a tool returned, handed back out of band so no base64 rides inside the turns. */
export interface TranscriptImage { mediaType: string; data: string }

export interface ParseOpts {
  /** Tool-result images and pasted images, numbered in file order as their `imageId`s. */
  images?: TranscriptImage[];
  /** HTML sources the Agent wrote, numbered as their `previewId`s. */
  previews?: string[];
  /** previewId → the .html file on disk that backs the row (an Edit's, or a Write past
   *  PREVIEW_MAX): the Hub serves it from the Pane's cwd, so no large source rides the parse. */
  previewFiles?: Map<number, string>;
  /** tool id → the tool's whole result text, kept only for results past the inline slice. */
  outputs?: Map<string, string>;
  /** tool id → the tool's whole detail text, kept only for details past the inline head. */
  details?: Map<string, string>;
  /** tool_use id → subagent id: a Task/Agent call whose id is in it gets `subagentId`. */
  subagentIds?: Map<string, string>;
  /** Keep isSidechain entries; every entry of a subagent's own file carries the flag. */
  sidechain?: boolean;
}
// ADR 0007: a result past this many lines keeps only its tail inline; the whole text moves
// out of band to /chat/output/:id, so no large result rides in the turns.
const RESULT_LINES = 40;
// ADR 0007's amendment (2026-10-07): a detail past this many lines (or characters) keeps only
// its head inline; the whole text moves out of band to /chat/output/:id?part=detail. 6/300 was
// picked from the live Panes: detail p50 was 559 B, p90 2 103 B — the head keeps a closed row
// readable while the 46% share of detail drops out of the first load.
const DETAIL_LINES = 6;
const DETAIL_CHARS = 300;
/** ADR 0007's amendment: turns per page on a windowed first load and on `Load earlier`.
 *  100 was picked from the live Panes: the busiest Claude Pane's last 100 turns (detail head
 *  applied) serialise to 568 789 B, 43% under the 1 MB budget. */
export const CHAT_PAGE_TURNS = 100;

/** Keep a tool row's detail inline only as its head, mirroring `attachResult`'s tail slice:
 *  the whole text lands in `opts.details`, keyed by the row's native id. Rows without an id
 *  (z.ai's, id-less transcripts) keep their whole detail — nothing serves them out of band. */
function cutDetail(tool: Tool, opts?: ParseOpts): void {
  if (tool.id === undefined || tool.detail.length <= DETAIL_CHARS) return;
  const whole = tool.detail; // already capped at 4 000 by detail()/customDetail
  const lines = whole.split('\n');
  opts?.details?.set(tool.id, whole);
  tool.detail = `${lines.slice(0, DETAIL_LINES).join('\n').slice(0, DETAIL_CHARS)}…`;
  tool.detailTruncated = true;
  tool.detailLines = lines.length;
}
const ESCAPES = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Pin a tool's result text and its failure flag on the row. A carriage return keeps only what
 *  followed it on its line, as a terminal would show a progress bar. Over RESULT_LINES lines
 *  only the tail rides inline (`resultTruncated`); the whole text lands in `outputs`. */
function attachResult(tool: Tool | undefined, content: unknown, isError: unknown, outputs?: Map<string, string>) {
  if (!tool) return;
  if (isError === true) tool.isError = true;
  const text = resultText(content).replace(ESCAPES, '').replace(/\r\n/g, '\n').replace(/[^\n]*\r/g, '').replace(CONTROLS, '').replace(/\s+$/, '');
  if (!text.trim()) return;
  const lines = text.split('\n');
  tool.resultLines = lines.length;
  if (lines.length <= RESULT_LINES) { tool.result = text; return; }
  tool.result = `…\n${lines.slice(-RESULT_LINES).join('\n')}`;
  tool.resultTruncated = true;
  if (tool.id !== undefined) outputs?.set(tool.id, text);
}

// A tool_result image over this is skipped whole (no id consumed), and that stays: the result
// is what the Agent saw, not a file at the Pane's cwd, so no disk route backs it, and serving
// it would hold bytes past ADR 0007's per-image memory bound on every request.
const RESULT_MAX = 8_000_000; // base64 characters, about 6 MB decoded

function readImage(input: unknown): string | undefined {
  const value = input as Record<string, unknown> | null | undefined;
  const path = str(value?.file_path) ?? str(value?.path);
  return path && IMAGE_FILE.test(path) ? path : undefined;
}

/** An image source valid for out-of-band serving: over RESULT_MAX it is skipped whole, so no
 *  id is consumed (ADR 0007 keeps RESULT_MAX as the Hub's per-image memory bound). */
function imageSource(source: unknown): { mediaType: string; data: string } | undefined {
  const { type, media_type: media, data } = source && typeof source === 'object' ? source as Record<string, unknown> : {};
  return type === 'base64' && typeof media === 'string' && PASTED_TYPE.test(media) && typeof data === 'string' && data.length <= RESULT_MAX && BASE64.test(data)
    ? { mediaType: media, data }
    : undefined;
}

/** Parse Claude Code's JSONL into display-safe turns; raw transcript lines never leave this module.
 *  `opts.images` and `opts.previews`, when given, collect what tool_results returned and the Agent
 *  wrote, numbered as their `imageId`s and `previewId`s. */
/** Whether an entry folds into the Turn before it: same role, except that an Agent's words
 *  after its tool rows open a new Turn, so text and tools read in the order they happened. */
const joins = (previous: Turn | undefined, role: Turn['role'], words: string): previous is Turn =>
  previous?.role === role && !previous.from && !(role === 'assistant' && previous.tools.length > 0 && !!words);

export function parseTranscript(jsonl: string, opts?: ParseOpts): Turn[] {
  const turns: Turn[] = [];
  const pending: Tool[] = [];
  const toolUses = new Map<string, Tool>();
  let imageSeq = 0; // result and pasted images number together, in file order
  let previewCount = 0;
  const written = new Map<string, { previewId: number; html: string }>(); // file_path → its preview slot
  const edited = new Map<string, number>(); // file_path → its disk-backed preview slot
  const diskSlot = (filePath: string): number => {
    let slot = edited.get(filePath);
    if (slot === undefined) { slot = previewCount++; edited.set(filePath, slot); }
    opts?.previewFiles?.set(slot, filePath);
    return slot;
  };
  const artifactHtml = new Map<string, string>(); // Artifact tool_use id → the source its file_path matched
  const queuedText = new Set<string>(); // queued prompts already shown; a flushed copy is dropped below
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      entry = value as Record<string, unknown>;
    } catch { continue; }
    // A queued prompt exists only as its attachment entry; when the queue flushes, Claude
    // also writes it as a user entry, which `queuedText` then keeps from showing twice.
    const peer = entry.type === 'attachment' ? peerMessage(entry) : undefined;
    if (peer && (opts?.sidechain || !entry.isSidechain)) {
      const at = time(entry.timestamp);
      turns.push({ role: 'assistant', from: peer.from, text: capTurn(peer.text), tools: [], ...(typeof entry.uuid === 'string' ? { id: entry.uuid } : {}), ...(at !== undefined ? { at } : {}) });
      continue;
    }
    const queued = entry.type === 'attachment' ? queuedPrompt(entry) : undefined;
    if (queued !== undefined) { queuedText.add(queued); entry = { type: 'user', message: { role: 'user', content: queued }, timestamp: entry.timestamp, uuid: entry.uuid, isSidechain: entry.isSidechain }; }
    if ((!opts?.sidechain && entry.isSidechain) || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    if (entry.type === 'user' && entry.isMeta === true) continue; // skill bodies, placeholders, injected agent messages
    if (entry.type === 'user' && entry.isCompactSummary === true)
      entry = { type: 'assistant', message: { role: 'assistant', content: '_Conversation compacted._' }, timestamp: entry.timestamp, uuid: entry.uuid };
    const message = entry.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    const role = entry.type === 'user' ? 'user' : 'assistant'; // transforms above may have rewritten it
    let text = capTurn(turnText(content));
    let thinking = '';
    const tools: Turn['tools'] = [];
    const images: Pasted[] = [];
    if (Array.isArray(content)) for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const block = item as Block;
      if (block.type === 'text' && typeof block.text === 'string') {
        // ponytail: lifted z.ai rows join the turn's tool list after its text, like tool_use rows; split the turn into segments if their position matters.
        const lifted = role === 'assistant' ? liftZai(block.text, pending) : { text: block.text, tools: [] };
        text += capTurn(lifted.text);
        tools.push(...lifted.tools);
      }
      // Signature-only thinking blocks (`thinking: ""`) and `redacted_thinking` carry no words.
      if (role === 'assistant' && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim())
        thinking += (thinking ? '\n\n' : '') + capTurn(block.thinking);
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const image = block.name === 'Read' ? readImage(block.input) : undefined;
        const tool: Tool = { name: block.name, brief: brief(block.input), detail: detail(block.name, block.input), ...(typeof block.id === 'string' ? { id: block.id } : {}), ...(image ? { image } : {}) };
        const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {};
        const filePath = str(input.file_path);
        if (block.name === 'Write' && filePath && HTML_FILE.test(filePath)) {
          const content = typeof input.content === 'string' ? input.content : undefined;
          if (content && content.length <= PREVIEW_MAX) {
            let slot = written.get(filePath);
            if (!slot) { slot = { previewId: previewCount++, html: content }; written.set(filePath, slot); }
            else slot.html = content; // a later Write of the same path reuses its slot with the newest source
            if (opts?.previews) opts.previews[slot.previewId] = content;
            tool.previewId = slot.previewId;
          } else if (content) {
            tool.previewId = diskSlot(filePath); // past PREVIEW_MAX: the file on disk serves by id
          }
        }
        // An Edit's input holds only the changed spans, so the file on disk is its preview's
        // source; the Hub reads it at the Pane's cwd when the route asks.
        if ((block.name === 'Edit' || block.name === 'MultiEdit') && filePath && HTML_FILE.test(filePath)) {
          tool.previewId = diskSlot(filePath);
        }
        if (block.name === 'Artifact') {
          const slot = str(input.file_path) ? written.get(str(input.file_path)!) : undefined;
          if (slot) {
            tool.previewId = slot.previewId;
            if (typeof block.id === 'string') artifactHtml.set(block.id, slot.html);
          }
        }
        if ((block.name === 'Task' || block.name === 'Agent') && typeof block.id === 'string') {
          const subagent = opts?.subagentIds?.get(block.id);
          if (subagent) tool.subagentId = subagent;
        }
        if (typeof block.id === 'string') toolUses.set(block.id, tool);
        cutDetail(tool, opts);
        tools.push(tool);
      }
      if (block.type === 'tool_result') {
        const tool = typeof block.tool_use_id === 'string' ? toolUses.get(block.tool_use_id) : undefined;
        attachResult(tool, block.content, block.is_error, opts?.outputs);
        if (tool?.name === 'Artifact' && tool.link === undefined) {
          const url = resultText(block.content).match(ARTIFACT_URL)?.[0];
          if (url) {
            const title = (typeof block.tool_use_id === 'string' ? artifactHtml.get(block.tool_use_id) : undefined)?.match(TITLE_TAG)?.[1];
            tool.link = title ? { url, title } : { url };
          }
        }
        if (Array.isArray(block.content)) for (const item of block.content) {
          if (!item || typeof item !== 'object' || Array.isArray(item) || (item as Block).type !== 'image') continue;
          const found = imageSource((item as Block).source);
          if (!found) continue;
          const imageId = imageSeq++;
          opts?.images?.push(found);
          if (tool && tool.imageId === undefined) tool.imageId = imageId; // the first image only when a result carries several
        }
      }
      if (block.type === 'image' && role === 'user') {
        const found = imageSource(block.source);
        if (found) { opts?.images?.push(found); images.push({ imageId: imageSeq++ }); }
        else images.push({}); // malformed or over the memory bound: a placeholder, no id consumed
      }
    }
    if (role === 'user' && wrapper(text)) {
      const command = commandText(text);
      if (command === undefined) {
        // A `!` line's output is the next entry; it shows under the line, as Claude prints it.
        const previous = turns.at(-1);
        const output = shellOutput([...text.matchAll(BASH_OUTPUT)].map(match => match[2]!).filter(part => part.trim()).join('\n'));
        if (output && previous?.role === 'user' && previous.text.split('\n\n').at(-1)?.startsWith('!')) previous.text += `\n\n${output}`;
        continue; // stdout, caveats, task notifications: control records
      }
      text = command;
    }
    // ponytail: only the first later copy of a queued prompt is swallowed — a user who retypes the same words on purpose loses that repeat
    if (role === 'user' && queued === undefined && text && queuedText.delete(text)) continue;
    if (!text && !tools.length && !images.length && !thinking) continue;
    const at = time(entry.timestamp);
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
    const previous = turns.at(-1);
    if (joins(previous, role, text || thinking)) {
      previous.text = previous.text && text ? `${previous.text}\n\n${text}` : previous.text || text;
      if (thinking) previous.thinking = previous.thinking ? `${previous.thinking}\n\n${thinking}` : thinking;
      previous.tools.push(...tools);
      if (images.length) previous.images = [...previous.images ?? [], ...images];
    } else turns.push({ role, text, tools, ...(thinking ? { thinking } : {}), ...(uuid ? { id: uuid } : {}), ...(images.length ? { images } : {}), ...(at !== undefined ? { at } : {}) });
  }
  return turns;
}

/** Parse pi's session JSONL into the same turns. Each line is an entry in a parentId tree;
 *  only the active branch is rendered — the chain that ends at the last entry, because pi
 *  appends a fork's new leaf after the branch it replaces. */
export function parsePiTranscript(jsonl: string, opts?: ParseOpts): Turn[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value as Record<string, unknown>);
    } catch { continue; }
  }
  const byId = new Map<string, number>();
  entries.forEach((entry, index) => { if (typeof entry.id === 'string') byId.set(entry.id, index); });
  const active = new Set<number>();
  for (let index = entries.length - 1; index >= 0 && !active.has(index);) {
    active.add(index);
    const parent = entries[index]!.parentId;
    index = typeof parent === 'string' ? byId.get(parent) ?? -1 : -1;
  }
  const turns: Turn[] = [];
  const toolUses = new Map<string, Tool>();
  let imageSeq = 0;
  let forked = false; // a message from another branch sat between two active ones: no merging across it
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== 'message' && entry.type !== 'custom_message' && entry.type !== 'compaction') continue;
    if (!active.has(index)) { forked = true; continue; }
    const record = entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message) ? entry.message as Record<string, unknown> : undefined;
    let role: 'user' | 'assistant';
    let text = '';
    let thinking = '';
    const tools: Turn['tools'] = [];
    const images: Pasted[] = [];
    if (entry.type === 'compaction') { role = 'assistant'; text = '_Conversation compacted._'; }
    else if (entry.type === 'custom_message') {
      if (entry.display !== true) continue; // display:false feeds the model, not the reader
      role = 'assistant';
      text = capTurn(resultText(entry.content)); // a string, or text blocks
    }
    else if (!record) continue;
    else if (record.role === 'bashExecution') {
      const command = str(record.command);
      if (command === undefined) continue;
      role = 'user';
      const output = shellOutput(str(record.output) ?? '');
      text = output ? `!${command}\n\n${output}` : `!${command}`;
    }
    else if (record.role !== 'user' && record.role !== 'assistant') {
      if (record.role !== 'toolResult' || !Array.isArray(record.content)) continue;
      attachResult(typeof record.toolCallId === 'string' ? toolUses.get(record.toolCallId) : undefined, record.content, record.isError, opts?.outputs);
      for (const item of record.content) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || (item as Block).type !== 'image') continue;
        const block = item as Block;
        if (typeof block.mimeType !== 'string' || !PASTED_TYPE.test(block.mimeType) || typeof block.data !== 'string' || block.data.length > RESULT_MAX || !BASE64.test(block.data)) continue;
        const imageId = imageSeq++;
        opts?.images?.push({ mediaType: block.mimeType, data: block.data });
        const tool = typeof record.toolCallId === 'string' ? toolUses.get(record.toolCallId) : undefined;
        if (tool && tool.imageId === undefined) tool.imageId = imageId; // the first image only when a result carries several
      }
      continue;
    }
    else {
      role = record.role === 'user' ? 'user' : 'assistant';
      const content = record.content;
      text = capTurn(turnText(content));
      if (Array.isArray(content)) for (const item of content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const block = item as Block;
        if (block.type === 'text' && typeof block.text === 'string') text += capTurn(block.text);
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim())
          thinking += (thinking ? '\n\n' : '') + capTurn(block.thinking);
        if (block.type === 'image' && role === 'user') {
          if (typeof block.mimeType === 'string' && PASTED_TYPE.test(block.mimeType) && typeof block.data === 'string' && block.data.length <= RESULT_MAX && BASE64.test(block.data)) {
            opts?.images?.push({ mediaType: block.mimeType, data: block.data });
            images.push({ imageId: imageSeq++ });
          } else images.push({}); // malformed or over the memory bound: a placeholder, no id consumed
        }
        if (block.type === 'toolCall' && typeof block.name === 'string') {
          const image = block.name === 'read' ? readImage(block.arguments) : undefined;
          const tool: Tool = { name: block.name, brief: brief(block.arguments), detail: detail(block.name, block.arguments), ...(typeof block.id === 'string' ? { id: block.id } : {}), ...(image ? { image } : {}) };
          if (block.name === 'Agent' && typeof block.id === 'string') {
            const subagent = opts?.subagentIds?.get(block.id);
            if (subagent) tool.subagentId = subagent;
          }
          if (typeof block.id === 'string') toolUses.set(block.id, tool);
          cutDetail(tool, opts);
          tools.push(tool);
        }
      }
      if (role === 'assistant' && (record.stopReason === 'error' || record.stopReason === 'aborted')) {
        const message = str(record.errorMessage);
        text += (text ? '\n\n' : '') + (message ? `**Stopped:** ${message}` : '**Stopped.**');
      }
    }
    if (!text && !tools.length && !images.length && !thinking) continue;
    const at = time(entry.timestamp);
    const previous = forked ? undefined : turns.at(-1);
    forked = false;
    if (joins(previous, role, text || thinking)) {
      previous.text = previous.text && text ? `${previous.text}\n\n${text}` : previous.text || text;
      if (thinking) previous.thinking = previous.thinking ? `${previous.thinking}\n\n${thinking}` : thinking;
      previous.tools.push(...tools);
      if (images.length) previous.images = [...previous.images ?? [], ...images];
    } else turns.push({ role, text, tools, ...(thinking ? { thinking } : {}), ...(typeof entry.id === 'string' ? { id: entry.id } : {}), ...(images.length ? { images } : {}), ...(at !== undefined ? { at } : {}) });
  }
  return turns;
}

// Codex's rollout JSONL: every display-bearing record — a user/assistant `message`, a call,
// an output — carries `internal_chat_message_metadata_passthrough.turn_id`; the `event_msg`
// `user_message`/`agent_message` records are duplicate presentation of the same text.
const codexTurnId = (payload: Record<string, unknown>): string | undefined => {
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  const turn = passthrough && typeof passthrough === 'object' && !Array.isArray(passthrough) ? (passthrough as Record<string, unknown>).turn_id : undefined;
  return typeof turn === 'string' && turn.trim() ? turn : undefined;
};
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
// The only call kinds Codex writes as `response_item`s (observed across this host's rollouts);
// anything else is not a tool row.
const CODEX_CALLS = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
const CODEX_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);
// A custom tool's input is free text (Codex `exec`), not JSON, so it renders directly.
const customDetail = (input: unknown): string => {
  const text = typeof input === 'string' ? input : (() => { try { return JSON.stringify(input) ?? ''; } catch { return ''; } })();
  return cap(text);
};

/** Parse Codex's rollout JSONL into the same turns. One `turn_id` spans a whole user↔assistant
 *  exchange, so a Turn's id is the native `turn_id` qualified by role — native identity without
 *  collisions, never array position. If identity is absent (a record without the passthrough) or
 *  ambiguous (one qualified id on two Turns), the parse returns `undefined` and the Pane keeps
 *  its Screen (Wave 12.1). */
export function parseCodexRollout(jsonl: string, opts?: ParseOpts): Turn[] | undefined {
  const turns: Turn[] = [];
  const calls = new Map<string, Tool>(); // native call id → its row, wherever it lives
  let imageSeq = 0; // pasted and tool-result images number together, in file order
  // One image source → a servable slot, or a placeholder that consumes no id (ADR 0007's bound).
  const image = (source: unknown): Pasted => {
    const found = typeof source === 'string' ? source.match(DATA_IMAGE) : undefined;
    if (found && found[2]!.length <= RESULT_MAX) {
      opts?.images?.push({ mediaType: found[1]!, data: found[2]! });
      return { imageId: imageSeq++ };
    }
    return {};
  };
  // Codex writes text blocks as `input_text` in both directions; `attachResult` reads `text`.
  const content = (output: unknown): unknown => !Array.isArray(output) ? output
    : (output as Record<string, unknown>[]).map(block => block && typeof block === 'object' && !Array.isArray(block)
      && (block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string'
      ? { type: 'text', text: block.text } : block);
  const images = (output: unknown, tool: Tool | undefined) => {
    for (const block of Array.isArray(output) ? output : []) {
      if (!block || typeof block !== 'object' || Array.isArray(block) || (block as Block).type !== 'input_image') continue;
      const imageId = image((block as Block).image_url).imageId; // a tool row keeps the first image only
      if (imageId !== undefined && tool && tool.imageId === undefined) tool.imageId = imageId;
    }
  };
  /** Append a tool row to the assistant Turn its `turn_id` names, opening that Turn when the
   *  exchange produced no assistant message yet. */
  const callTurn = (turnId: string | undefined, tool: Tool, at: number | undefined): void => {
    const id = turnId === undefined ? undefined : `${turnId}:assistant`;
    const previous = turns.at(-1);
    if (previous?.role === 'assistant' && previous.id === id) previous.tools.push(tool);
    else turns.push({ role: 'assistant', text: '', tools: [tool], ...(id ? { id } : {}), ...(at !== undefined ? { at } : {}) });
  };
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      entry = value as Record<string, unknown>;
    } catch { continue; }
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    const turnId = codexTurnId(record);
    const at = time(entry.timestamp);
    if (entry.type === 'response_item') {
      if (record.type === 'message' && (record.role === 'user' || record.role === 'assistant')) {
        const role = record.role;
        const id = turnId === undefined ? undefined : `${turnId}:${role}`;
        let text = '';
        const pasted: Pasted[] = [];
        if (Array.isArray(record.content)) for (const item of record.content) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const block = item as Block;
          if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') text += capTurn(block.text);
          if (block.type === 'input_image') pasted.push(image(block.image_url));
        }
        // `local_images` rides the payload beside `content`; no sample exists on this host, so
        // ponytail: entries need inline `data` + a media type to serve — a bare file path
        // becomes a placeholder until a real capture fixes the shape.
        for (const item of Array.isArray(record.local_images) ? record.local_images : []) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const local = item as Record<string, unknown>;
          const mediaType = str(local.mime_type) ?? str(local.media_type) ?? str(local.mimeType);
          const data = str(local.data);
          if (mediaType && PASTED_TYPE.test(mediaType) && data && data.length <= RESULT_MAX && BASE64.test(data)) {
            opts?.images?.push({ mediaType, data });
            pasted.push({ imageId: imageSeq++ });
          } else pasted.push({});
        }
        if (!text && !pasted.length) continue;
        const previous = turns.at(-1);
        if (previous?.role === role && previous.id === id) {
          previous.text = previous.text && text ? `${previous.text}\n\n${text}` : previous.text || text;
          if (pasted.length) previous.images = [...previous.images ?? [], ...pasted];
        } else turns.push({ role, text, tools: [], ...(id ? { id } : {}), ...(pasted.length ? { images: pasted } : {}), ...(at !== undefined ? { at } : {}) });
      } else if (CODEX_CALLS.has(record.type as string)) {
        const name = str(record.name) ?? (record.type as string);
        let tool: Tool;
        if (record.type === 'custom_tool_call') {
          tool = { name, brief: shortened(String(record.input ?? '').replace(/\s+/g, ' ').trim()), detail: customDetail(record.input) };
        } else {
          let input: unknown = record.arguments;
          if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* not JSON: the brief shows it raw */ } }
          tool = { name, brief: brief(input), detail: detail(name, input) };
        }
        const id = str(record.call_id);
        if (id) { tool.id = id; calls.set(id, tool); }
        if (record.status === 'failed') tool.isError = true;
        cutDetail(tool, opts);
        callTurn(turnId, tool, at);
      } else if (record.type === 'web_search_call') {
        // A web search has no `call_id` and no output item: its `id` joins the `web_search_end`
        // event that carries the results.
        const action = record.action && typeof record.action === 'object' && !Array.isArray(record.action) ? record.action as Record<string, unknown> : {};
        const query = str(action.query) ?? (Array.isArray(action.queries) ? (action.queries as unknown[]).map(String).join(' ') : undefined);
        const what = query ?? str(action.url) ?? str(action.pattern) ?? '';
        const tool: Tool = { name: 'web_search', brief: shortened(what), detail: cap(what) };
        const id = str(record.id);
        if (id) { tool.id = id; calls.set(id, tool); }
        if (record.status === 'failed') tool.isError = true;
        cutDetail(tool, opts);
        callTurn(turnId, tool, at);
      } else if (CODEX_OUTPUTS.has(record.type as string)) {
        const callId = str(record.call_id);
        const tool = callId ? calls.get(callId) : undefined;
        const output = record.type === 'tool_search_output' && record.output === undefined
          ? (Array.isArray(record.tools) ? (record.tools as Record<string, unknown>[]).map(item => str(item?.name)).filter(Boolean).join('\n') : '')
          : record.output;
        attachResult(tool, content(output), record.is_error === true || record.isError === true, opts?.outputs);
        images(record.output, tool);
      }
    } else if (entry.type === 'event_msg' && record.type === 'web_search_end') {
      const callId = str(record.call_id);
      const tool = callId ? calls.get(callId) : undefined;
      const results = Array.isArray(record.results) ? (record.results as Record<string, unknown>[]).map(item => {
        const title = str(item.title), url = str(item.url);
        return title && url ? `${title} — ${url}` : title ?? url ?? '';
      }).filter(Boolean).join('\n') : '';
      attachResult(tool, results, false, opts?.outputs);
    }
  }
  // Wave 12.1: identity absent or ambiguous → Screen, never ids from array position.
  if (turns.some(turn => turn.id === undefined)) return undefined;
  return new Set(turns.map(turn => turn.id)).size === turns.length ? turns : undefined;
}
