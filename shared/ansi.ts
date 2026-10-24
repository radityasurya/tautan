import type { Span } from './types.ts';

type Style = Omit<Span, 'text'>;

function color256(n: number): number | string {
  if (n < 16) return n;
  if (n < 232) {
    const x = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(x / 36))},${level(Math.floor(x / 6) % 6)},${level(x % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function sgr(style: Style, raw: string): Style {
  const values = (raw === '' ? [0] : raw.split(';').map(Number));
  let next = { ...style };
  for (let i = 0; i < values.length; i++) {
    const n = values[i]!;
    if (n === 0) next = {};
    else if (n === 1) next.bold = true;
    else if (n === 2) next.dim = true;
    else if (n === 3) next.italic = true;
    else if (n === 4) next.underline = true;
    else if (n === 7) next.inverse = true;
    else if (n === 9) next.strike = true;
    else if (n === 22) { delete next.bold; delete next.dim; }
    else if (n === 23) delete next.italic;
    else if (n === 24) delete next.underline;
    else if (n === 27) delete next.inverse;
    else if (n === 29) delete next.strike;
    else if (n >= 30 && n <= 37) next.fg = n - 30;
    else if (n === 39) delete next.fg;
    else if (n >= 40 && n <= 47) next.bg = n - 40;
    else if (n === 49) delete next.bg;
    else if (n >= 90 && n <= 97) next.fg = n - 82;
    else if (n >= 100 && n <= 107) next.bg = n - 92;
    else if ((n === 38 || n === 48) && values[i + 1] === 5 && values[i + 2] !== undefined) {
      next[n === 38 ? 'fg' : 'bg'] = color256(values[i + 2]!);
      i += 2;
    } else if ((n === 38 || n === 48) && values[i + 1] === 2 && values[i + 4] !== undefined) {
      next[n === 38 ? 'fg' : 'bg'] = `rgb(${values[i + 2]},${values[i + 3]},${values[i + 4]})`;
      i += 4;
    }
  }
  return next;
}

/** The spans of one line between two plain-text offsets, styles kept. */
export function sliceSpans(spans: Span[], start: number, end: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const sp of spans) {
    const from = Math.max(start, at);
    const to = Math.min(end, at + sp.text.length);
    if (from < to) out.push({ ...sp, text: sp.text.slice(from - at, to - at) });
    at += sp.text.length;
  }
  return out;
}

export function parseAnsi(text: string): Span[][] {
  const lines: Span[][] = [[]];
  let style: Style = {};
  let plain = '';
  const push = () => {
    if (!plain) return;
    const line = lines.at(-1)!;
    const previous = line.at(-1);
    const signature = JSON.stringify(style);
    if (previous) {
      const { text: _, ...previousStyle } = previous;
      if (JSON.stringify(previousStyle) === signature) { previous.text += plain; plain = ''; return; }
    }
    line.push({ text: plain, ...style });
    plain = '';
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === '\r' && text[i + 1] === '\n' || text[i] === '\n') {
      push(); i += text[i] === '\r' ? 2 : 1; lines.push([]); continue;
    }
    if (text[i] !== '\x1b') { plain += text[i++]; continue; }
    push();
    if (text[i + 1] === '[') {
      const match = text.slice(i).match(/^\x1b\[([0-?]*[ -/]*)?([@-~])/);
      if (match) { if (match[2] === 'm') style = sgr(style, match[1] ?? ''); i += match[0].length; continue; }
    } else if (text[i + 1] === ']') {
      const end = text.slice(i + 2).search(/\x07|\x1b\\/);
      if (end >= 0) { i += 2 + end + (text[i + 2 + end] === '\x07' ? 1 : 2); continue; }
    }
    i += Math.min(2, text.length - i);
  }
  push();
  return lines;
}
