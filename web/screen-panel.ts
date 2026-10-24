// Claude Code draws some slash commands only on its Screen: `/usage` and `/config` as a panel
// in place of its input box, `/context` as text printed above the box. The Chat view shows
// that panel as a card at the end of the conversation (`PanelItem` in chat.tsx), live.
import { sliceSpans } from '../shared/ansi.ts';
import { boxRows, isRule } from '../shared/inputbox.ts';
import type { Span } from '../shared/types.ts';

/** Slash commands that open a menu or a prompt on the Screen and write nothing to the
 *  transcript until they finish, so the Chat view would show nothing while they wait.
 *  ponytail: a fixed list of Claude's and pi's; extend it when another one turns up. */
export const SCREEN_COMMAND = /^\/(login|logout|model|config|settings|permissions|resume|agents|mcp|hooks|status|theme|tree|fork|hotkeys|plugin|help|usage|cost|context|skills|tasks|export|effort|memory|ide|add-dir|rewind|workflows)$/;

/** Claude's Screen commands that still open the Screen: `/login` prints a link the Screen
 *  joins back into one across its rows, `/resume` is a long list to search, and `/memory`
 *  hands the terminal to an editor. */
export const SCREEN_ONLY = /^\/(login|resume|memory)$/;

/** A Claude command whose panel the Chat view shows as a card instead of opening the Screen. */
export const panelCommand = (text: string) => SCREEN_COMMAND.test(text) && !SCREEN_ONLY.test(text);

export interface Panel {
  /** The panel's rows: blank rows at either end, the shared indent and trailing pad cut. */
  rows: Span[][];
  /** Drawn in place of the input box, until Esc closes it. False: text printed above the box. */
  live: boolean;
}

const plain = (spans: Span[]) => spans.map((sp) => sp.text).join('');
/** Claude echoes a sent prompt as `❯ text`, the marker followed by a space or a no-break space. */
const ECHO = /^❯[  ]/;

/** The rows without blank rows at either end, the indent they share, or trailing pad. A
 *  space with a background stays: it is drawn (the empty part of a `/usage` meter). */
function shape(rows: Span[][], live: boolean): Panel | null {
  const text = rows.map(plain);
  const first = text.findIndex((t) => t.trim());
  if (first < 0) return null;
  let last = text.length - 1;
  while (!text[last]!.trim()) last--;
  const kept = rows.slice(first, last + 1);
  const indent = Math.min(...text.slice(first, last + 1).filter((t) => t.trim()).map((t) => t.search(/\S/)));
  return {
    live,
    rows: kept.map((spans) => {
      let end = plain(spans).trimEnd().length;
      let at = 0;
      for (const sp of spans) {
        at += sp.text.length;
        if (sp.bg !== undefined || sp.inverse) end = Math.max(end, at);
      }
      return sliceSpans(spans, indent, end);
    }),
  };
}

/**
 * What `command` drew on Claude Code's Screen, or null. While no input box is drawn, a panel
 * stands in its place: every row under the last full-width rule (`/usage`, `/config`). Once
 * the box is back, the rows between the box and the command's own `❯ /…` echo are what it
 * printed (`/context`); with no echo left on the Screen, the output outgrew it and every row
 * above the box is the command's. Another echo means the conversation moved on.
 * ponytail: a panel that draws a full-width rule of its own loses the rows above it, and
 * printed output with no echo cannot be told from an older reply; compare the rule's length
 * with the Pane's width, and read the Screen's scrollback, if either ever matters.
 */
export function screenPanel(lines: Span[][], command: string): Panel | null {
  const box = boxRows(lines);
  if (!box) {
    for (let i = lines.length - 1; i >= 0; i--) if (isRule(lines[i]!)) return shape(lines.slice(i + 1), true);
    return null;
  }
  for (let i = box.top - 1; i >= 0; i--) {
    const text = plain(lines[i]!);
    if (ECHO.test(text)) return text.slice(2).trim() === command ? shape(lines.slice(i + 1, box.top), false) : null;
  }
  return shape(lines.slice(0, box.top), false);
}
