export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  tools: { name: string; brief: string }[];
  at?: number;
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown };

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

/** Parse Claude Code's JSONL into display-safe turns; raw transcript lines never leave this module. */
export function parseTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
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
    if (Array.isArray(content)) for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const block = item as Block;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block.type === 'tool_use' && typeof block.name === 'string') tools.push({ name: block.name, brief: brief(block.input) });
    }
    if (role === 'user' && wrapper(text)) continue;
    if (!text && !tools.length) continue;
    const at = time(entry.timestamp);
    const previous = turns.at(-1);
    if (previous?.role === role) {
      previous.text = cap(previous.text && text ? `${previous.text}\n${text}` : previous.text || text);
      previous.tools.push(...tools);
    } else turns.push({ role, text: cap(text), tools, ...(at !== undefined ? { at } : {}) });
  }
  return turns;
}
