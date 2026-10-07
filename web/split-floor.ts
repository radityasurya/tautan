/** The smallest scale a split cell's grid takes. Legibility follows device pixels (CSS px ×
 *  DPR), so a denser screen can scale further: 0.75 at 1x is today's floor, and the floor
 *  falls with the square root of DPR (0.53 at 2x) — not linearly, which would
 *  keep the device-pixel size but ignore that a finer pixel is also a harder glyph to read.
 *  Clamped at 0.45 (from about 2.78x up, so 3x and 4x both get 0.45) so no screen shrinks a grid past use. */
export function splitFloor(dpr: number): number {
  const d = Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
  return Math.max(0.45, 0.75 / Math.sqrt(d));
}
