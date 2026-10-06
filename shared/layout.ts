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
 * next line's first word would not have fit on this one. Claude Code wraps two columns
 * short of `cols` and Pi one or two, so four columns of slack catch both.
 */
// ponytail: a fixed slack; a program wrapping narrower than cols - 4 is not rejoined.
export function continues(text: string, cols = 80): boolean[] {
  const lines = text.split(/\r?\n/);
  const kinds = classify(text, cols);
  return lines.map((line, i) => {
    const prev = lines[i - 1];
    if (prev === undefined || kinds[i] !== 'prose' || kinds[i - 1] !== 'prose') return false;
    const end = prev.trimEnd().length;
    const indent = line.search(/\S/);
    if (!end || indent < 0 || MARKER.test(line) || indent < prev.search(/\S/)) return false;
    const word = line.slice(indent).split(/\s/)[0]!.length;
    return end + 1 + word > cols - 4;
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
 */
// ponytail: a share of lines, not alt-screen detection — the Mux does not report that.
export function tuiScreen(text: string, cols = 80): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return false;
  const drawn = lines.filter((line) => kindOf(line, cols) === 'structure' || /\S\s*[│┃║]\s*\S/.test(line)).length;
  return drawn / lines.length >= 0.4;
}
