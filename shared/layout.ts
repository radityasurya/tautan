/**
 * What a line of a Screen is: structure keeps its columns when the grid is reflowed for a
 * phone (docs/WAVES.md wave 7), prose reflows. A heuristic, deliberately cheap — a wrong
 * `prose` mangles a box; a wrong `structure` only costs a wider line.
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

export type LineKind = 'structure' | 'prose';

/** One kind per line of `text`. Plain text only — strip ANSI first if the caller has it. */
export function classify(text: string, cols = 80): LineKind[] {
  return text.split(/\r?\n/).map((line) =>
    BOX.test(line) || aligned(line) || table(line, cols) ? 'structure' : 'prose',
  );
}
