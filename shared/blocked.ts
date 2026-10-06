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
