// Quick replies for the Pane dock: which pills to offer, in which order.
// Pure — no React, no fetch. `web/composer.tsx` renders them and decides what a tap does.
import { offeredKeys } from '../shared/blocked.ts';
import type { Explain } from '../shared/types.ts';
import { keyGlyph } from './keys.ts';
import { profileFor } from './profiles.ts';

export interface Pill {
  /** `key` sends its keys at once; `text` is a reply: a preset sends, a draft fills the composer. */
  kind: 'key' | 'text';
  /** What the pill prints. */
  label: string;
  /** The accessible name, because a glyph alone does not read. */
  aria: string;
  /** Key pills: the herdr key names to send. */
  keys?: string[];
  /** Key pills: the key glyph printed after the label. */
  glyph?: string;
  /** Text pills the Hub drafted, marked with ✦: they fill the composer for review. Any other
   *  text pill is a preset and sends in one tap. */
  generated?: boolean;
}

/**
 * A pill is a label plus a key, on one line of a scrolling row, so the label is the verb
 * and nothing else: the parenthesised hint the footer repeats is dropped, so is the `on`
 * or `off` of a mode, and a long one is cut. The full text stays in the accessible name.
 */
export function pillLabel(text: string): string {
  const short = text
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ (on|off)$/i, '');
  return short.length > 14 ? `${short.slice(0, 13).replace(/[\s,.;:'’-]+$/, '')}…` : short;
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').replace(/[│┃|]/g, ' ');

/**
 * Does the prompt show a numbered list? `shared/blocked.ts` only asks whether the first
 * option means yes, so the count lives here: two or more `1.`-style options is a list you
 * move through with the arrows, whatever the agent calls them.
 */
export const isNumberedList = (detection: string): boolean =>
  plain(detection).split(/\r?\n/).filter((l) => /^\s*[❯>»*]?\s*[1-9][.)]\s+\S/.test(l)).length >= 2;

/**
 * The dock's pill row: key pills first, then the Hub's drafts, then the static set.
 * Smart replies are the client's choice, so `suggestions` are dropped when `smart` is off.
 * A blocked Pane drops the static set: the prompt's own choices answer it, and "Commit and
 * push" is no answer to a permission box.
 */
export function quickReplies(o: {
  agent?: string;
  explain?: Explain | null;
  suggestions?: string[];
  smart: boolean;
  blocked?: boolean;
}): Pill[] {
  const pills: Pill[] = [];

  if (o.explain) {
    for (const k of offeredKeys(o.explain)) {
      pills.push({ kind: 'key', label: pillLabel(k.label), aria: `${k.label}, ${k.key}`, keys: [k.key], glyph: keyGlyph(k.key) });
    }
    // ↑ ↓ live in the dock's inline keys now, so a numbered list adds no arrow pills.
  }

  const texts = [
    ...(o.smart ? (o.suggestions ?? []).slice(0, 3).map((t) => [t, true] as const) : []),
    ...(o.blocked ? [] : profileFor({ agent: o.agent }).replies.map((t) => [t, false] as const)),
  ];
  const seen = new Set<string>();
  for (const [label, generated] of texts) {
    const text = label.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    pills.push({ kind: 'text', label: text, aria: generated ? `${text}, fills the reply box` : `${text}, sends`, generated });
  }

  return pills;
}
