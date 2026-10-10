import { BOX } from './layout.ts';
import type { Explain, Screen } from './types.ts';

/** A yes/no prompt always answers to enter/esc, even when the Mux names no hint keys. */
const PRESET = [
  { key: 'enter', label: 'Yes' },
  { key: 'esc', label: 'No' },
];

/** `❯ 1. Yes`, `1. Allow`, `Accept` — the first option of an approval box, whatever the agent. */
const AFFIRMATIVE = /^[^\S\n]*[❯>»]?[^\S\n]*(?:[1-9][.)][^\S\n]*)?(?:yes|allow|accept|approve)\b/im;

/**
 * Does this prompt take enter as "yes" and esc as "no"?
 *
 * The rule id alone is not enough: a real Claude Code permission box matches
 * `live_blocked_form` (priority 980) long before `bash_permission_prompt` (850), because its
 * "esc to cancel · enter to confirm" footer sits after a horizontal rule. So read the box as
 * well as the id — an options list that offers Yes/Allow/Accept first is a yes/no prompt.
 */
export const asksYesNo = (explain: Explain): boolean =>
  /permission|approval|approve/i.test(explain.ruleId) || AFFIRMATIVE.test(explain.detection);

/**
 * The keys to offer for a blocked Pane: the Yes/No preset first when the prompt takes one,
 * then whatever hint keys the Mux found, minus the duplicates (the footer's own
 * `esc to cancel` and `enter to confirm` are the preset under another name).
 *
 * Idempotent, so the Hub can apply it on the way out and the card again on the way in.
 */
export function offeredKeys(explain: Explain): Explain['hintKeys'] {
  const keys = asksYesNo(explain) ? [...PRESET, ...explain.hintKeys] : explain.hintKeys;
  return keys.filter((key, i) => keys.findIndex(other => other.key === key.key) === i);
}

/**
 * The plain Yes and No of a yes/no prompt, for a one-tap surface (the desktop header), or
 * null when the prompt is not one. Never an option from the hint keys: a label such as
 * "Yes, and don't ask again" is an Always key and stays in the card.
 */
export function yesNoKeys(explain: Explain): { yes: { key: string; label: string }; no: { key: string; label: string } } | null {
  return asksYesNo(explain) ? { yes: PRESET[0]!, no: PRESET[1]! } : null;
}

// ---- prompt id ----

/** Random per Hub process, so an id cannot survive a restart. Tests rotate it. */
let salt: Uint8Array | null = null;
export function rotatePromptSalt(): void { salt = null; }

/**
 * Claude Code's working line ticks while it runs — `✢ Tempering… (1m 55s · ↓ 10.0k tokens ·
 * esc to interrupt)` — so the time and token count must not count toward the id. The whole
 * line is replaced by `* <doing> (<time> · <tokens>)` with literal placeholders; the digits
 * do not survive. Matched whole — spinner, arrow and token count included — and only when
 * no other line of the Screen has the same shape: a second match is not certainly the
 * spinner, so then neither line is normalised.
 */
const WORKING = /^[^\S\n]*[✢✳✶✻✽]\s+(.+?)\s+\(\d+[smh](?: \d+[smh])*\s+·\s+[↓↑→]\s+[\d.]+[km]?\s+tokens\s+·\s+esc to interrupt\)[^\S\n]*$/;

/** The id of the prompt on screen: 12 hex chars of salted SHA-256 over the detection and
 *  the whole visible Screen, the working line normalised. Same box, same id; anything the
 *  Screen prints moves it. */
export async function promptId(explain: Explain, screen: Screen): Promise<string> {
  const lines = screen.text.split(/\r?\n/);
  const hits = lines.map((line) => WORKING.exec(line));
  const text = hits.filter(Boolean).length === 1
    ? lines.map((line, i) => (hits[i] ? `* ${hits[i]![1]!} (<time> · <tokens>)` : line)).join('\n')
    : screen.text;
  const payload = new TextEncoder().encode(`${explain.ruleId}\0${explain.detection}\0${text}`);
  const s = (salt ??= crypto.getRandomValues(new Uint8Array(16)));
  const bytes = new Uint8Array(s.length + payload.length);
  bytes.set(s, 0); bytes.set(payload, s.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- the box, read for the card ----

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
const RULE = /^\s*─{20,}\s*$/;
/** A numbered menu row: `❯ 1. Yes` on the cursor, `  2. No` off it. */
const OPTION = /^(\s*)(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
/** The question tabs over a form of several questions: `←  ☐ One  ☐ Two  ✔ Submit  →`. */
const TABS = /^←.*→$/;

/** One row of an Agent's numbered menu, and the keys that pick it: arrows from the cursor
 *  row, then enter. Arrows rather than the digit, because every menu reads them alike. */
export interface MenuOption { number: string; label: string; detail?: string; keys: string[] }

/**
 * The blocked box as the card shows it: the question, the lines around it (ANSI kept), and the
 * numbered menu when there is one (two rows or more). Some rules (herdr's
 * `bash_permission_prompt`, `live_blocked_form` on a question) hand over much of the Screen,
 * so the box starts after the last full-width rule — except a rule a numbered row follows,
 * which divides the menu itself (Claude's `Type something.` from `Chat about this`).
 */
export function readBox(detection: string): { head: string; rest: string[]; menu: MenuOption[] } {
  const frame = new RegExp(BOX.source, 'g');
  const raw = detection.split(/\r?\n/);
  const firstText = (from: number) => raw.slice(from).find((line) => plain(line).trim());
  let start = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (!RULE.test(plain(raw[i]!))) continue;
    const next = firstText(i + 1);
    if (next !== undefined && OPTION.test(plain(next))) continue;
    if (raw.slice(i + 1).filter((line) => plain(line).trim()).length >= 2) start = i + 1;
    break;
  }
  const lines = raw.slice(start).filter((line) => !RULE.test(plain(line)));
  // The menu: each numbered row, and the deeper-indented lines under it as its description.
  const menu: (MenuOption & { at: number })[] = [];
  const used = new Set<number>();
  let cursor = 0;
  let column = -1;
  lines.forEach((line, i) => {
    const text = plain(line).replace(frame, '');
    const row = text.match(OPTION);
    if (row) {
      if (row[2]) cursor = menu.length;
      column = row[1]!.length + (row[2]?.length ?? 0);
      menu.push({ number: row[3]!, label: row[4]!, keys: [], at: i });
      used.add(i);
    } else if (menu.length && text.trim() && text.length - text.trimStart().length > column) {
      const last = menu.at(-1)!;
      last.detail = last.detail ? `${last.detail} ${text.trim()}` : text.trim();
      used.add(i);
    } else if (text.trim()) column = Infinity; // a shallower line ends the last row's description
  });
  const options = menu.length >= 2 ? menu.map(({ at: _at, ...option }, i) => ({
    ...option,
    keys: [...Array<string>(Math.abs(i - cursor)).fill(i > cursor ? 'down' : 'up'), 'enter'],
  })) : [];
  const shown = lines
    .filter((_, i) => !options.length || !used.has(i))
    .map((line) => line.replace(frame, '').trim())
    .filter((line) => plain(line).trim() && !/^Tip:/.test(plain(line)));
  // The question heads the card; the tabs over a form of several questions follow it.
  if (shown.length > 1 && TABS.test(plain(shown[0]!).trim())) shown.splice(1, 0, shown.shift()!);
  const [head = 'Blocked', ...rest] = shown;
  return { head, rest, menu: options };
}
