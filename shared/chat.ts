export interface Tool {
  /** The row's native id (Claude's tool_use `toolu_…`, pi's `toolCallId`): when
   *  `resultTruncated` is set, the whole text serves from
   *  `GET /api/panes/:key/chat/output/<id>`. Absent on z.ai rows, which have no native id. */
  id?: string;
  name: string;
  brief: string;
  detail: string;
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
  /** HTML the Agent wrote (Write of a .html file, or the source an Artifact publish names),
   *  kept in the transcript: served by `GET /api/panes/:key/chat/preview/:previewId` as
   *  text/html under a sandbox CSP, for a sandboxed preview. Never inlined in the chat JSON. */
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
}

/** `GET /api/panes/:key/chat?since=<cursor>[&agent=<id>]` (ADR 0007): only what changed
 *  since the cursor. Merge `upserts` by `Turn.id`; on `reset` replace the whole list. */
export interface ChatDelta {
  sessionId: string;      // as today
  cursor: string;         // names this parse; send it back as ?since next time
  reset: boolean;         // true: upserts is the whole conversation, replace the list
  upserts: Turn[];        // transcript order; merge by id
  subagents?: Subagent[]; // the whole tree, when it changed, and always on a reset
  /** Set when the response is a subagent's own conversation, as today. */
  agent?: string;
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
  tools: Tool[];
  images?: Pasted[];
  at?: number;
}

/**
 * The tool row a blocked Agent is asking about: the last tool of the final turn, when that
 * turn is the assistant's and the tool has no result, output or error yet. Null otherwise,
 * so the caller shows the blocked card on its own (a question, not a tool).
 */
// ponytail: the last pending tool wins; parallel calls that each wait for approval would need
// the prompt's own command matched against `detail`.
export function pendingTool(turns: Turn[]): { turn: number; tool: number } | null {
  const turn = turns.length - 1;
  const last = turns[turn];
  if (last?.role !== 'assistant') return null;
  for (let tool = last.tools.length - 1; tool >= 0; tool--) {
    const t = last.tools[tool]!;
    if (t.result === undefined && t.output === undefined && !t.isError) return { turn, tool };
  }
  return null;
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown; arguments?: unknown; data?: unknown; mimeType?: unknown; source?: unknown; id?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };

const commandWrapper = /^(?:command-name|command-message|local-command(?:-[\w-]+)?|task-notification|bash-(?:input|stdout))$/;
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

function brief(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    for (const key of ['file_path', 'command', 'pattern', 'url', 'path']) if (typeof value[key] === 'string' && value[key].trim()) return shortened(value[key].replace(/\s+/g, ' ').trim());
  }
  try { return shortened(JSON.stringify(input) ?? ''); } catch { return ''; }
}

function cap(text: string): string { return text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text; }

const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const preview = (text: string) => text.length > 600 ? `${text.slice(0, 599)}…` : text;

/** The full tool input for the expanded row: newlines kept, capped like turn text. */
function detail(name: string, input: unknown): string {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const filePath = str(value.file_path) ?? str(value.path);
  const lines: string[] = [];
  if (str(value.command)) {
    if (str(value.description)) lines.push(`# ${value.description as string}`);
    lines.push(value.command as string);
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
// ponytail: matched on z.ai's exact markers as of 2026-10; a changed marker leaves the block as prose.
const ZAI_CALL = /^[ \t]*\*\*🌐 Z\.ai Built-in Tool: ([^*\n]+)\*\*[ \t]*\n(?:\s*\*\*Input:\*\*[ \t]*\n[ \t]*```\w*\n([\s\S]*?)\n[ \t]*```[ \t]*\n?)?(?:\s*\*Executing on server\.\.\.\*[ \t]*\n?)?/gm;
const ZAI_OUTPUT = /^[ \t]*\*\*Output:\*\*[ \t]*\n[ \t]*\*\*([^*\n]+?)(?:_result_summary)?:\*\*[ \t]*([^\n]*(?:\n(?![ \t]*\n)[^\n]*)*)/gm;
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
  if (!text.includes('Z.ai Built-in Tool') && !text.includes('**Output:**')) return { text, tools: [] };
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
const HTML_FILE = /\.html?$/i;
// ponytail: a preview source over this is skipped whole; serve oversized sources from a file route if they appear.
const PREVIEW_MAX = 2_000_000;
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
  /** tool id → the tool's whole result text, kept only for results past the inline slice. */
  outputs?: Map<string, string>;
  /** tool_use id → subagent id: a Task/Agent call whose id is in it gets `subagentId`. */
  subagentIds?: Map<string, string>;
  /** Keep isSidechain entries; every entry of a subagent's own file carries the flag. */
  sidechain?: boolean;
}
// ADR 0007: a result past this many lines keeps only its tail inline; the whole text moves
// out of band to /chat/output/:id, so no large result rides in the turns.
const RESULT_LINES = 40;
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

// ponytail: a tool_result image over this is skipped whole (no id consumed); serve oversized reads from a file route if they appear.
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
export function parseTranscript(jsonl: string, opts?: ParseOpts): Turn[] {
  const turns: Turn[] = [];
  const pending: Tool[] = [];
  const toolUses = new Map<string, Tool>();
  let imageSeq = 0; // result and pasted images number together, in file order
  let previewCount = 0;
  const written = new Map<string, { previewId: number; html: string }>(); // file_path → its preview slot
  const artifactHtml = new Map<string, string>(); // Artifact tool_use id → the source its file_path matched
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      entry = value as Record<string, unknown>;
    } catch { continue; }
    if ((!opts?.sidechain && entry.isSidechain) || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    const message = entry.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    const role = entry.type;
    let text = turnText(content);
    const tools: Turn['tools'] = [];
    const images: Pasted[] = [];
    if (Array.isArray(content)) for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const block = item as Block;
      if (block.type === 'text' && typeof block.text === 'string') {
        // ponytail: lifted z.ai rows join the turn's tool list after its text, like tool_use rows; split the turn into segments if their position matters.
        const lifted = role === 'assistant' ? liftZai(block.text, pending) : { text: block.text, tools: [] };
        text += lifted.text;
        tools.push(...lifted.tools);
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const image = block.name === 'Read' ? readImage(block.input) : undefined;
        const tool: Tool = { name: block.name, brief: brief(block.input), detail: detail(block.name, block.input), ...(typeof block.id === 'string' ? { id: block.id } : {}), ...(image ? { image } : {}) };
        const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {};
        if (block.name === 'Write') {
          const filePath = str(input.file_path);
          const content = typeof input.content === 'string' ? input.content : undefined;
          // ponytail: an Edit of an .html file gives no preview — its input holds only the changed
          // spans, not the full source; read the file from the Pane's Host when an edited page needs one.
          if (filePath && HTML_FILE.test(filePath) && content && content.length <= PREVIEW_MAX) {
            let slot = written.get(filePath);
            if (!slot) { slot = { previewId: previewCount++, html: content }; written.set(filePath, slot); }
            else slot.html = content; // a later Write of the same path reuses its slot with the newest source
            if (opts?.previews) opts.previews[slot.previewId] = content;
            tool.previewId = slot.previewId;
          }
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
    if (role === 'user' && wrapper(text)) continue;
    if (!text && !tools.length && !images.length) continue;
    const at = time(entry.timestamp);
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
    const previous = turns.at(-1);
    if (previous?.role === role) {
      previous.text = cap(previous.text && text ? `${previous.text}\n\n${text}` : previous.text || text);
      previous.tools.push(...tools);
      if (images.length) previous.images = [...previous.images ?? [], ...images];
    } else turns.push({ role, text: cap(text), tools, ...(uuid ? { id: uuid } : {}), ...(images.length ? { images } : {}), ...(at !== undefined ? { at } : {}) });
  }
  return turns;
}

/** Parse pi's session JSONL into the same turns. Each line is an entry in a parentId tree;
 *  only the active branch is rendered — the chain that ends at the last entry, because pi
 *  appends a fork's new leaf after the branch it replaces. */
// ponytail: user-pasted images are unhandled — no pi transcript on this machine carries one;
// map {type:'image'} blocks in user content through `pasted()` when they appear.
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
    if (entry.type !== 'message') continue;
    if (!active.has(index)) { forked = true; continue; }
    const message = entry.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    const role = record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : undefined;
    if (!role) {
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
    const content = record.content;
    let text = turnText(content);
    const tools: Turn['tools'] = [];
    if (Array.isArray(content)) for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const block = item as Block;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block.type === 'toolCall' && typeof block.name === 'string') {
        const image = block.name === 'read' ? readImage(block.arguments) : undefined;
        const tool: Tool = { name: block.name, brief: brief(block.arguments), detail: detail(block.name, block.arguments), ...(typeof block.id === 'string' ? { id: block.id } : {}), ...(image ? { image } : {}) };
        if (typeof block.id === 'string') toolUses.set(block.id, tool);
        tools.push(tool);
      }
    }
    if (!text && !tools.length) continue;
    const at = time(entry.timestamp);
    const previous = forked ? undefined : turns.at(-1);
    forked = false;
    if (previous?.role === role) {
      previous.text = cap(previous.text && text ? `${previous.text}\n\n${text}` : previous.text || text);
      previous.tools.push(...tools);
    } else turns.push({ role, text: cap(text), tools, ...(typeof entry.id === 'string' ? { id: entry.id } : {}), ...(at !== undefined ? { at } : {}) });
  }
  return turns;
}
