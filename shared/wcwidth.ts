/**
 * Terminal display width: how many columns a glyph covers on the grid. Wide CJK and emoji
 * count 2, combining marks and other zero-width glyphs 0, everything else 1.
 */
// ponytail: block ranges cover the common wide and zero-width blocks, not the full Unicode
// EastAsianWidth list; add a range when an exotic glyph misplaces a tap.
const ZERO: [number, number][] = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x200b, 0x200f], // zero-width space/joiner and direction marks
  [0x20d0, 0x20ff], // combining diacritical marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
];
const WIDE: [number, number][] = [
  [0x1100, 0x115f], // Hangul jamo
  [0x2e80, 0x303e], // CJK radicals and symbols
  [0x3041, 0x33ff], // kana and CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji: pictographs and emoticons
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x20000, 0x2fffd], // CJK extension B and beyond
  [0x30000, 0x3fffd],
];

const inRanges = (cp: number, ranges: [number, number][]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

export function wcwidth(cp: number): number {
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/** The columns a string covers; iterates code points, so a surrogate pair counts once. */
export function strWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += wcwidth(ch.codePointAt(0)!);
  return width;
}
