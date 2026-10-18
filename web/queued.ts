// Claude's queue in the Chat view: what the transcript recorded, what the Screen draws, and the
// replies tautan typed while Claude worked, each shown once.
import type { Queued } from '../shared/chat.ts';
import type { Span } from '../shared/types.ts';
import type { Pending } from './pending.ts';

const plain = (line: Span[]) => line.map((span) => span.text).join('');
const HINT = /^\s*ctrl\+enter to send now\s*$/;
const MARKER = /^❯[  ]/;

/**
 * A `❯` row is queued when its words wear the marker's colour: Claude draws a queued message
 * muted end to end, and a sent prompt's echo with brighter words (probed on 2.1.302). Plain
 * text cannot tell the two apart, so it reads as queued.
 */
function queuedRow(line: Span[]): boolean {
  let marker: Span | undefined;
  for (const span of line) {
    if (!marker) {
      const at = span.text.indexOf('❯');
      if (at < 0) continue;
      marker = span;
      if (span.text.slice(at + 1).trim()) return true; // marker and words in one span: one style
      continue;
    }
    if (span.text.trim()) return span.fg === marker.fg;
  }
  return true;
}

/**
 * Claude's queued messages as its Screen draws them, oldest first: `❯ text` rows above the
 * `ctrl+enter to send now` hint, one blank line apart, a wrapped or second line indented two
 * spaces. Reading stops at the first row that is not part of the queue, such as the echo of
 * the prompt Claude works on. Empty when the hint is not on the Screen.
 */
export function screenQueue(lines: Span[][]): string[] {
  let hint = -1;
  for (let i = lines.length - 1; i >= 0 && hint < 0; i--) if (HINT.test(plain(lines[i]!))) hint = i;
  const items: string[] = [];
  let body: string[] = [];
  for (let i = hint - 1; i >= 0; i--) {
    const text = plain(lines[i]!);
    if (/^ {2}\S/.test(text)) { body.unshift(text.trim()); continue; }
    if (!MARKER.test(text) || !queuedRow(lines[i]!)) break;
    items.unshift([text.slice(2).trim(), ...body].join(' ').trim());
    body = [];
    if (plain(lines[i - 1] ?? []).trim()) break; // a queued row has a blank line above it
    i--;
  }
  return items.filter(Boolean);
}

const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
/** The same message: a long one the Screen cut short ends in `…`. */
const same = (a: string, b: string) => {
  const x = norm(a), y = norm(b);
  return x === y || (y.endsWith('…') && x.startsWith(y.slice(0, -1)));
};

export interface QueuedItem { text: string; at?: number; /** a reply tautan sent with Ctrl+Enter: on its way now */ now?: true }

/**
 * The queue to show, oldest first, and the pending replies it stands for. The transcript's
 * queue comes first; a Screen row it lacks joins it (Claude queues before it writes, and
 * once wrote no record for a slash command). A tautan reply that went out while Claude
 * worked is in Claude's queue too, so it shows here, once, until its turn arrives. Each
 * source is matched one for one, so a message queued twice shows twice.
 */
export function queueShown(recorded: Queued[], screen: string[], pending: Pending[], working: boolean): { items: QueuedItem[]; covered: number[] } {
  const items: QueuedItem[] = recorded.map(({ text, at }) => ({ text, ...(at !== undefined ? { at } : {}) }));
  const take = (text: string, used: Set<number>, now?: true) => {
    const at = items.findIndex((item, n) => !used.has(n) && same(item.text, text));
    if (at >= 0) { used.add(at); if (now) items[at]!.now = now; }
    return at >= 0;
  };
  const seen = new Set<number>();
  for (const text of screen) if (!take(text, seen)) { seen.add(items.length); items.push({ text }); }
  const used = new Set<number>();
  const covered: number[] = [];
  for (const entry of pending) {
    if (entry.state === 'held' || entry.state === 'failed' || entry.state === 'sending') continue;
    if (take(entry.text, used, entry.now)) covered.push(entry.id);
    else if (working) { used.add(items.length); items.push({ text: entry.text, at: entry.at, ...(entry.now ? { now: entry.now } : {}) }); covered.push(entry.id); }
  }
  return { items, covered };
}
