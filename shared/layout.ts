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

/** A `|`-table row longer than half the grid. Without `cols`, 40 columns is the guess. */
const table = (line: string, cols: number): boolean =>
  line.length > cols / 2 && /\S\s*\|\s*\S/.test(line);

/** A markdown table row at any length, so a short header keeps its columns with the body. */
const pipeRow = (line: string): boolean => /^\s*\|.*\|.*\|\s*$/.test(line);

/** Only horizontal rule glyphs: Claude Code's full-width separators. */
const RULE = /^\s*[─━═]{3,}[─━═\s]*$/;
/** A box edge: corners, rule glyphs, and at most one title run (`┌─ Permission ──┐`). No `┬`. */
const TOP = /^\s*[╭┌╔┏][─━═]+(?:[^─-╿]+[─━═]+)?[╮┐╗┓]\s*$/;
const BOTTOM = /^\s*[╰└╚┗][─━═]+(?:[^─-╿]+[─━═]+)?[╯┘╝┛]\s*$/;
/** `│ … │` with no glyph inside: a box around prose, not a drawn table. */
const ROW = /^\s*[│┃║](.*)[│┃║]\s*$/;

export type LineKind = 'structure' | 'prose' | 'rule' | 'box-top' | 'box-row' | 'box-bottom';

const kindOf = (line: string, cols: number): LineKind => {
  if (RULE.test(line)) return 'rule';
  if (TOP.test(line)) return 'box-top';
  if (BOTTOM.test(line)) return 'box-bottom';
  const row = ROW.exec(line);
  if (row && !BOX.test(row[1]!) && !aligned(row[1]!)) return 'box-row';
  return BOX.test(line) || aligned(line) || pipeRow(line) || table(line, cols) ? 'structure' : 'prose';
};

/** One kind per line of `text`. Plain text only — strip ANSI first if the caller has it. */
export function classify(text: string, cols = 80): LineKind[] {
  return text.split(/\r?\n/).map((line) => kindOf(line, cols));
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
