import { strWidth } from './wcwidth.ts';
import type { Action, Affordance, Span } from './types.ts';

export interface AffordanceProfile {
  hints?: RegExp[];
  statusItems?: { pattern: RegExp; action: Action }[];
}

export function herdrKey(name: string): string {
  const key = name.toLowerCase().replaceAll('-', '+');
  const aliases: Record<string, string> = {
    '↑': 'up', '↓': 'down', '←': 'left', '→': 'right', escape: 'esc', return: 'enter',
  };
  return aliases[key] ?? key;
}

/** A run of SGR wheel reports as one raw string, so a swipe's notches leave the phone in
 *  one POST — the mouse route takes a single report. A wheel notch has no release report.
 *  Mirrors `mouseBytes` in server/mux.ts; keep the two in step. */
export function wheelBytes(up: boolean, col: number, row: number, count: number): string {
  return `\x1b[<${up ? 64 : 65};${col};${row}M`.repeat(Math.max(0, count));
}

const generic: { pattern: RegExp; action: (match: RegExpExecArray) => Action; label: (match: RegExpExecArray) => string; range?: (match: RegExpExecArray) => [number, number] }[] = [
  {
    pattern: /<([a-z0-9]+(?:-[a-z0-9]+)?)>\s*([A-Za-z][\w /-]*?)(?=\s{2,}|<|$)/g,
    action: m => ({ keys: [herdrKey(m[1]!)] }), label: m => m[2]!.trim(),
  },
  {
    pattern: /F(\d{1,2})([A-Z][A-Za-z +-]*?)(?=F\d{1,2}[A-Z]|\s{2,}|$)/g,
    action: m => ({ keys: [`f${m[1]}`] }), label: m => m[2]!.trim(),
  },
  {
    pattern: /\[([a-z0-9]+(?:[-+][a-z0-9]+)?)\]\s*([A-Za-z][\w /-]*?)(?=\s{2,}|\[|$)/gi,
    action: m => ({ keys: [herdrKey(m[1]!)] }), label: m => m[2]!.trim(),
  },
  {
    pattern: /\b(esc|enter|tab|space|shift\+tab|ctrl\+[a-z]|[↑↓←→]|[a-z]|\d) to ([a-z][a-z ]{1,24}?)(?=[,.)·]|\s{2,}|$)/gi,
    action: m => ({ keys: [herdrKey(m[1]!)] }), label: m => m[2]!.trim(),
  },
];

export function findAffordances(lines: Span[][], profile: AffordanceProfile): Affordance[] {
  // Match in UTF-16 indexes, place in display columns (shared/wcwidth.ts): a wide glyph
  // covers two cells and a combining mark none, so the box sits under what the eye sees.
  const textLines = lines.map(line => line.map(span => span.text).join(''));
  const found: Affordance[] = [];
  const add = (row: number, text: string, start: number, end: number, label: string, action: Action) => {
    if (end <= start) return;
    const colStart = strWidth(text.slice(0, start));
    const colEnd = strWidth(text.slice(0, end));
    if (found.some(item => item.row === row && colStart < item.colEnd && colEnd > item.colStart)) return;
    found.push({ row, colStart, colEnd, label, action });
  };

  const options = textLines.map((text, row) => ({ text, row, match: /^[│┃|]?\s*(❯|>)?\s*(\d+)\.\s(.*)$/.exec(text) })).filter(item => item.match);
  const cursors = options.filter(item => item.match![1] === '❯');
  if (cursors.length === 1) {
    const cur = options.indexOf(cursors[0]!);
    options.forEach((item, index) => {
      const start = /^[│┃|]?\s*/.exec(item.text)![0]!.length;
      const withoutFrame = item.text.replace(/\s*[│┃|]\s*$/, '');
      const end = withoutFrame.trimEnd().length;
      const label = item.match![3]!.replace(/\s*[│┃|]\s*$/, '').trim();
      add(item.row, item.text, start, end, label, { keys: Array(Math.abs(index - cur)).fill(index > cur ? 'down' : 'up') });
    });
  }

  for (let row = 0; row < textLines.length; row++) {
    const text = textLines[row]!;
    if (!text) continue;
    for (const item of profile.statusItems ?? []) {
      const pattern = new RegExp(item.pattern.source, item.pattern.flags.includes('g') ? item.pattern.flags : `${item.pattern.flags}g`);
      for (const match of text.matchAll(pattern)) add(row, text, match.index, match.index + match[0].length, match[0], item.action);
    }
    for (const item of generic) for (const match of text.matchAll(item.pattern)) {
      add(row, text, match.index, match.index + match[0].length, item.label(match), item.action(match));
    }
    // Profile Hint convention: capture group 1 is the key and group 2 is its label.
    for (const hint of profile.hints ?? []) {
      const pattern = new RegExp(hint.source, hint.flags.includes('g') ? hint.flags : `${hint.flags}g`);
      for (const match of text.matchAll(pattern)) if (match[1] && match[2]) add(row, text, match.index, match.index + match[0].length, match[2].trim(), { keys: [herdrKey(match[1])] });
    }
    // A link is not a chip: the Screen draws it as a real link (`linksIn`), whole even when
    // the terminal wrapped it, and a long-press on it offers Copy.
    for (const match of text.matchAll(/(?:^|\s)((?:~|\/)[\w./-]{3,})/g)) {
      const value = match[1]!; const start = match.index + match[0].indexOf(value);
      add(row, text, start, start + value.length, value, { copy: value });
    }
  }
  return found;
}
