import { parseAnsi } from './ansi.ts';
import type { Span } from './types.ts';

/**
 * Claude Code's input box, read from the visible screen: `empty`, `draft`, or `bash`.
 * `null` means no box was found — the caller keeps today's behaviour.
 */
export type InputBox = 'empty' | 'draft' | 'bash';

// ponytail: a rule is "full-width" but the screen text carries no terminal width, so any run of
// eight or more `─` counts. A transcript rule can false-positive only when it sits directly
// above a `❯ `/`! ` line that another rule closes; compare the two rules' lengths if one ever does.
const RULE = /^─{8,}$/;
const MARKER = /^[❯!][  ]/;

const plain = (spans: Span[]) => spans.map(span => span.text).join('');
const isRule = (line: Span[]) => RULE.test(plain(line).trim());
// Box body lines between the marker and the bottom rule: blank, or indented two spaces.
const isContinuation = (line: Span[]) => { const t = plain(line); return t.trim() === '' || t.startsWith('  '); };

/**
 * Read the last input box on the screen. The box is anchored on its two `─` rules and the
 * `❯ `/`! ` marker line directly below the top rule — hint lines above and below change with
 * state and are ignored, and so are transcript `❯ ` echoes, which never sit inside the rules.
 * With `ansi`, dim text (the placeholder and the predicted prompt) counts as empty.
 */
export function inputBox(screen: string, ansi: boolean): InputBox | null {
  const lines = parseAnsi(screen);
  for (let top = lines.length - 2; top >= 0; top--) {
    if (!isRule(lines[top]!) || !MARKER.test(plain(lines[top + 1]!))) continue;
    let bottom = top + 2;
    while (bottom < lines.length && !isRule(lines[bottom]!) && isContinuation(lines[bottom]!)) bottom++;
    if (bottom >= lines.length || !isRule(lines[bottom]!)) continue;
    return classify(lines.slice(top + 1, bottom), ansi);
  }
  return null;
}

/**
 * A `!` marker is bash mode whatever it holds. Otherwise any text that is not dim is a draft;
 * with plain text the dim placeholder cannot be told from a draft, so any text reads as one.
 */
function classify(box: Span[][], ansi: boolean): InputBox {
  if (plain(box[0]!)[0] === '!') return 'bash';
  let marker = 2; // the `❯ ` prefix to drop before judging the text
  for (const line of box) for (const span of line) for (const ch of span.text) {
    if (marker > 0 && (ch === '❯' || ch === ' ' || ch === ' ')) { marker--; continue; }
    marker = 0;
    if (ch === ' ' || ch === '\t' || ch === ' ') continue;
    if (!ansi || !span.dim) return 'draft';
  }
  return 'empty';
}

const INVISIBLE = /[​‌⁠﻿]/g;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Remove the invisible characters Claude Code holds a message for: U+200B, U+200C, U+2060 and
 * U+FEFF everywhere, and U+200D outside an emoji ZWJ sequence, so emoji stay whole.
 */
export function stripInvisible(text: string): string {
  let out = '';
  for (const { segment } of segmenter.segment(text)) {
    if (!segment.includes('‍')) { out += segment.replace(INVISIBLE, ''); continue; }
    // A ZWJ stays only inside an emoji sequence: every part around each ZWJ starts with an
    // emoji. A grapheme the segmenter kept whole fails this only when it is malformed
    // (`🤖‍x`), and split graphemes (`a‍b`) fail on their empty parts.
    const parts = segment.split('‍');
    out += parts.length > 1 && parts.every(part => part !== '' && PICTOGRAPHIC.test(part))
      ? segment
      : segment.replace(INVISIBLE, '').replaceAll('‍', '');
  }
  return out;
}
