/**
 * What a line of a Screen is when the grid is reflowed for a phone (docs/WAVES.md wave 7):
 * prose reflows, structure keeps its columns (in its own sideways scroller), and the
 * full-width chrome an agent draws — rules and boxes around prose — is redrawn by CSS at
 * the column's width. A heuristic, deliberately cheap — a wrong `prose` mangles a box; a
 * wrong `structure` only costs a scroller.
 */

/** Box-drawing and block glyphs. One definition for the classifier and the blocked card. */
export const BOX = /[─-╿▀-▟]/;

/** Three or more runs of two-plus spaces with content between them: column alignment. */
const aligned = (line: string): boolean => {
  const parts = line.trim().split(/ {2,}/);
  return parts.length >= 4 && parts.every((part) => part.length > 0);
};

/** A `|`-table row longer than half the grid. Without `cols`, 40 columns is the guess.
 *  Trailing pad does not count: Pi pads every line to the full width. */
const table = (line: string, cols: number): boolean =>
  line.trimEnd().length > cols / 2 && /\S\s*\|\s*\S/.test(line);

/** A markdown table row at any length, so a short header keeps its columns with the body. */
const pipeRow = (line: string): boolean => /^\s*\|.*\|.*\|\s*$/.test(line);

/** Only horizontal rule glyphs: Claude Code's full-width separators. */
const RULE = /^\s*[─━═]{3,}[─━═\s]*$/;
/** A box edge: corners, rule glyphs, and at most one title run (`┌─ Permission ──┐`). No `┬`. */
const TOP = /^\s*[╭┌╔┏][─━═]+(?:[^─-╿]+[─━═]+)?[╮┐╗┓]\s*$/;
const BOTTOM = /^\s*[╰└╚┗][─━═]+(?:[^─-╿]+[─━═]+)?[╯┘╝┛]\s*$/;
/** `│ … │` with no glyph inside: a box around prose, not a drawn table. */
const ROW = /^\s*[│┃║](.*)[│┃║]\s*$/;

/**
 * A status line in two halves, the right one pushed to the edge: Pi's footer
 * (`~/projects/x      zai/glm-5.3 · high`), Claude Code's hint row. `[leftEnd, rightStart]`,
 * or null. A 16-space gap is the tell; code alignment rarely needs that much.
 */
export function splitAt(line: string): [number, number] | null {
  const m = /^(\s*\S.*?\S|\s*\S) {16,}(\S.*?)\s*$/.exec(line);
  // Either half with its own column gaps is aligned output, not a two-part status line.
  if (!m || / {2,}/.test(m[1]!.trim()) || / {2,}/.test(m[2]!)) return null;
  return [m[1]!.length, m[1]!.length + line.slice(m[1]!.length).search(/\S/)];
}

export type LineKind = 'structure' | 'prose' | 'rule' | 'box-top' | 'box-row' | 'box-bottom' | 'split';

const kindOf = (line: string, cols: number): LineKind => {
  if (RULE.test(line)) return 'rule';
  if (TOP.test(line)) return 'box-top';
  if (BOTTOM.test(line)) return 'box-bottom';
  const row = ROW.exec(line);
  if (row && !BOX.test(row[1]!) && !aligned(row[1]!)) return 'box-row';
  if (!BOX.test(line) && !/\|/.test(line) && splitAt(line)) return 'split';
  return BOX.test(line) || aligned(line) || pipeRow(line) || table(line, cols) ? 'structure' : 'prose';
};

/** Two column gaps: too weak alone, but enough to join a neighbouring run of columns. */
const gapped = (line: string): boolean => line.trim().split(/ {2,}/).length >= 3;

/**
 * One kind per line of `text`. Plain text only — strip ANSI first if the caller has it.
 * A weakly aligned line next to structure joins it, so `ls -l` rows whose sizes happen to
 * pad differently stay in one scroller instead of alternating with reflowed rows.
 */
export function classify(text: string, cols = 80): LineKind[] {
  const lines = text.split(/\r?\n/);
  const kinds = lines.map((line) => kindOf(line, cols));
  const spread = (i: number, j: number) => {
    if (kinds[i] === 'prose' && kinds[j] === 'structure' && gapped(lines[i]!)) kinds[i] = 'structure';
  };
  for (let i = 1; i < lines.length; i++) spread(i, i - 1);
  for (let i = lines.length - 2; i >= 0; i--) spread(i, i + 1);
  return kinds;
}

/**
 * The text inside a box line, as `[start, end)` offsets: borders, the one-space pad and the
 * trailing pad dropped. A row keeps its leading indent; an edge yields its title (or nothing).
 */
export function boxInner(line: string, kind: LineKind): [number, number] {
  const open = line.search(/\S/);
  const close = line.trimEnd().length - 1;
  let start = open + 1;
  let end = close;
  if (kind !== 'box-row') {
    while (start < end && /[─━═]/.test(line[start]!)) start++;
    while (end > start && /[─━═]/.test(line[end - 1]!)) end--;
  }
  if (line[start] === ' ') start++;
  while (end > start && line[end - 1] === ' ') end--;
  return [start, Math.max(start, end)];
}

/** A new item, not a continuation: a list marker or an agent's bullet glyph. */
const MARKER = /^\s*(?:[-*+•●○⏺✻❯>$]|\d+[.)])\s/;

/** Where a reflowed line's later rows start: under its text, past a list marker if any. */
export function hangOf(line: string): number {
  const marker = /^\s*(?:[-*+•●○⏺]|\d+[.)])\s+/.exec(line);
  return marker ? marker[0].length : Math.max(0, line.search(/\S/));
}

/**
 * Which lines continue the line above: the agent hard-wrapped them at its own width, so
 * Wrap should rejoin them into one paragraph. The test is the word-wrapper's own: the
 * next line's first word would not have fit on this one. The wrapper's width comes from
 * the text itself: the widest prose line, when it sits within eight columns of `cols` —
 * lines only pile up that high if a wrapper filled them (Claude Code wraps two columns
 * short of `cols`, Pi one or two, an inset list a few more). A far narrower widest says
 * nothing wrapped there, and `cols` with four columns of slack stands.
 */
export function continues(text: string, cols = 80): boolean[] {
  const lines = text.split(/\r?\n/);
  const kinds = classify(text, cols);
  const widest = Math.max(0, ...lines.map((line, i) => (kinds[i] === 'prose' ? line.trimEnd().length : 0)));
  const at = widest >= cols - 8 ? Math.min(widest, cols - 4) : cols - 4;
  return lines.map((line, i) => {
    const prev = lines[i - 1];
    if (prev === undefined || kinds[i] !== 'prose' || kinds[i - 1] !== 'prose') return false;
    const end = prev.trimEnd().length;
    const indent = line.search(/\S/);
    if (!end || indent < 0 || MARKER.test(line) || indent < prev.search(/\S/)) return false;
    const word = line.slice(indent).split(/\s/)[0]!.length;
    return end + 1 + word > at;
  });
}

/**
 * The background a line is painted with edge to edge, or undefined: Pi's tool blocks and
 * Claude Code's echoed prompt fill whole rows with one colour. Wrap draws a run of them as
 * one panel instead of a ragged highlight behind each line's words.
 */
export function fillOf(spans: { text: string; bg?: number | string }[], cols = 80): number | string | undefined {
  const last = spans.at(-1);
  const width = spans.reduce((n, sp) => n + sp.text.length, 0);
  return last?.bg !== undefined && width >= cols - 4 ? last.bg : undefined;
}

/**
 * A full-screen program's Screen (htop, k9s, a dashboard): most of its lines are columns
 * or drawn boxes. A shell's output is mostly lines of text, so Wrap can reflow it.
 * `was` is the last answer for the same Pane: the share must pass 0.5 to turn full-screen
 * and fall under 0.3 to turn back, so a table scrolling through the Screen does not flip the
 * view on every update. With no last answer the line is 0.4.
 */
// ponytail: a share of lines, not alt-screen detection — herdr reports no alternate-screen
// signal (neither its pane records nor pane.read carry one, 0.9.3), so this heuristic stays
// its fallback; tmux's real flag rides Screen.alt and replaces it where the Mux reports one.
export function tuiScreen(text: string, cols = 80, was?: boolean): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return false;
  const drawn = lines.filter((line) => kindOf(line, cols) === 'structure' || /\S\s*[│┃║]\s*\S/.test(line)).length;
  return drawn / lines.length >= (was === undefined ? 0.4 : was ? 0.3 : 0.5);
}

/**
 * Whether a Screen must keep its grid instead of reflowing — Wrap's auto rule in one place:
 * the App profile's mouse flag first (a program tautan forwards the mouse to is full-screen),
 * then the Mux's own alternate-screen flag (Screen.alt, tmux), then tuiScreen's read of the
 * text — herdr reports no flag, so an unknown TUI there keeps its grid by its drawn share.
 * An Agent's own screen is never inferred full-screen: its prose carries a Markdown table
 * now and then, and the drawn share of that table is not a TUI.
 */
export function fullScreen(mouse: boolean, alt: boolean | undefined, text: string, cols = 80, o: { agent?: boolean; was?: boolean } = {}): boolean {
  if (mouse) return true;
  if (alt !== undefined) return alt;
  return !o.agent && tuiScreen(text, cols, o.was);
}

/**
 * Where a Pane's input most likely sits, for the caret the Screen draws while the Composer
 * types straight into it: herdr reports no cursor (probed on 0.9.0, neither `pane.read` nor
 * `pane.get` carries one). Claude's prompt row (`❯`), else the row inside pi's editor (between
 * its last two rules), else the last row with text; the column is just past that row's text.
 * ponytail: a heuristic, and a JS-string column (a wide glyph counts as one); read the real
 * cursor when herdr reports it (tmux has `cursor_x`/`cursor_y`).
 */
export function caretAt(rows: string[]): { row: number; col: number } | null {
  const end = (row: string) => row.replace(/[\s\u00a0]+$/, '').length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const at = rows[i]!.search(/\S/);
    if (rows[i]![at] === '❯') return { row: i, col: Math.max(end(rows[i]!), at + 2) };
  }
  const rules = rows.flatMap((row, i) => (/^\s*─{20,}\s*$/.test(row) ? [i] : []));
  const [top, bottom] = rules.slice(-2);
  if (top !== undefined && bottom !== undefined && bottom - top >= 2) {
    let row = bottom - 1;
    while (row > top + 1 && !rows[row]!.trim()) row--;
    return { row, col: end(rows[row]!) };
  }
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.trim()) return { row: i, col: end(rows[i]!) };
  return null;
}
