export interface Tool {
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
}

/** An image pasted into a user turn, as a data URL; no `src` when it is over the cap. */
export interface Pasted { src?: string }

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  tools: Tool[];
  images?: Pasted[];
  at?: number;
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown; source?: unknown };

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
    for (const key of ['file_path', 'command', 'pattern', 'url']) if (typeof value[key] === 'string' && value[key].trim()) return shortened(value[key].replace(/\s+/g, ' ').trim());
  }
  try { return shortened(JSON.stringify(input) ?? ''); } catch { return ''; }
}

function cap(text: string): string { return text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text; }

const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const preview = (text: string) => text.length > 600 ? `${text.slice(0, 599)}…` : text;

/** The full tool input for the expanded row: newlines kept, capped like turn text. */
function detail(name: string, input: unknown): string {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const lines: string[] = [];
  if (str(value.command)) {
    if (str(value.description)) lines.push(`# ${value.description as string}`);
    lines.push(value.command as string);
  } else if (str(value.file_path)) {
    lines.push(value.file_path as string);
    const edits = Array.isArray(value.edits) ? value.edits as Record<string, unknown>[] : [value];
    for (const edit of edits) {
      if (typeof edit?.old_string !== 'string' || typeof edit.new_string !== 'string') continue;
      lines.push('', `- ${preview(edit.old_string).replace(/\n/g, '\n- ')}`, `+ ${preview(edit.new_string).replace(/\n/g, '\n+ ')}`);
    }
  } else if (str(value.pattern)) {
    lines.push(value.pattern as string);
    if (str(value.path)) lines.push(`in ${value.path as string}`);
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
const PASTED_TYPE = /^image\/(?:png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// ponytail: pasted images ride inside the chat JSON, which is refetched on every revision. Caps:
// about 1 MB each, 4 per turn, 4 MB per transcript (newest kept). Serve them from a route if that bites.
const PASTED_MAX = 1_400_000; // base64 characters, about 1 MB decoded
const PASTED_PER_TURN = 4;
const PASTED_TOTAL = 5_700_000; // four full-size images and their data: prefixes

function readImage(input: unknown): string | undefined {
  const path = str((input as Record<string, unknown> | null)?.file_path);
  return path && IMAGE_FILE.test(path) ? path : undefined;
}

function pasted(source: unknown): Pasted {
  const { type, media_type: media, data } = source && typeof source === 'object' ? source as Record<string, unknown> : {};
  return type === 'base64' && typeof media === 'string' && PASTED_TYPE.test(media) && typeof data === 'string' && data.length <= PASTED_MAX && BASE64.test(data)
    ? { src: `data:${media};base64,${data}` }
    : {};
}

/** Parse Claude Code's JSONL into display-safe turns; raw transcript lines never leave this module. */
export function parseTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  const pending: Tool[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      entry = value as Record<string, unknown>;
    } catch { continue; }
    if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
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
        tools.push({ name: block.name, brief: brief(block.input), detail: detail(block.name, block.input), ...(image ? { image } : {}) });
      }
      if (block.type === 'image' && role === 'user') {
        images.push(pasted(block.source));
      }
    }
    if (role === 'user' && wrapper(text)) continue;
    if (!text && !tools.length && !images.length) continue;
    const at = time(entry.timestamp);
    const previous = turns.at(-1);
    if (previous?.role === role) {
      previous.text = cap(previous.text && text ? `${previous.text}\n\n${text}` : previous.text || text);
      previous.tools.push(...tools);
      if (images.length) previous.images = [...previous.images ?? [], ...images];
    } else turns.push({ role, text: cap(text), tools, ...(images.length ? { images } : {}), ...(at !== undefined ? { at } : {}) });
  }
  let budget = PASTED_TOTAL;
  for (const turn of [...turns].reverse()) {
    let kept = 0;
    for (const image of turn.images ?? []) {
      if (image.src && (++kept > PASTED_PER_TURN || (budget -= image.src.length) < 0)) delete image.src;
    }
  }
  return turns;
}
