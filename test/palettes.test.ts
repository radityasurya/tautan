import { expect, test } from 'bun:test';
import { contrast, PALETTES } from '../web/palettes.ts';

const hex = /^#[0-9a-f]{6}$/;

for (const [id, p] of Object.entries(PALETTES)) {
  test(`${id}: text is readable on its surfaces`, () => {
    for (const surface of [p.bg, p.surface, p.elevated]) {
      expect(contrast(p.fg, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.muted, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`${id}: Status colours read on the background and differ from each other`, () => {
    const status = [p.ok, p.warn, p.danger];
    for (const c of status) expect(contrast(c, p.bg)).toBeGreaterThanOrEqual(3);
    const dist = (a: string, b: string) =>
      [1, 3, 5].reduce((s, i) => s + (parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) ** 2, 0) ** 0.5;
    for (const [i, a] of status.entries()) for (const b of status.slice(i + 1)) expect(dist(a, b)).toBeGreaterThan(60);
  });

  test(`${id}: 16 ANSI colours, all hex`, () => {
    expect(p.ansi).toHaveLength(16);
    for (const c of [...p.ansi, p.bg, p.fg, p.muted, p.surface, p.elevated, p.border, p.accent]) expect(c).toMatch(hex);
  });
}
