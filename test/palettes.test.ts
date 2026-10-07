import { expect, test } from 'bun:test';
import { contrast, kitTokens, PALETTES } from '../web/palettes.ts';

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

  test(`${id}: kit tokens meet WCAG AA`, () => {
    const t = kitTokens(p);
    const grounds = [t.bg, t.bgElevated, t.bgSubtle, t.bgInput];
    for (const g of grounds) {
      for (const k of ['text', 'textSecondary', 'textTertiary', 'accentText']) expect(contrast(t[k]!, g)).toBeGreaterThanOrEqual(4.5);
      
    }
    for (const k of ['success', 'warning', 'danger', 'borderFocus']) expect(contrast(t[k]!, t.bg!)).toBeGreaterThanOrEqual(3);
    // Code and disabled controls draw text on bgMuted and bgHover.
    for (const g of [t.bgMuted, t.bgHover]) for (const k of ['text', 'textSecondary']) expect(contrast(t[k]!, g)).toBeGreaterThanOrEqual(4.5);
    // The primary button is text on inverse text; the border is the only cue of a card edge.
    expect(contrast(t.textInverse!, t.text!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.accent!, t.bg!)).toBeGreaterThanOrEqual(3);
    // The *Bg tints are rgba: composite them over bg first.
    const over = (rgba: string) => {
      const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
      const [br, bg, bb] = [1, 3, 5].map((i) => parseInt(t.bg!.slice(i, i + 2), 16)) as [number, number, number];
      return `#${[r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    };
    expect(contrast(t.accentText!, over(t.accentBg!))).toBeGreaterThanOrEqual(4.5);
    for (const k of ['text', 'textSecondary']) expect(contrast(t[k]!, over(t.sheetBg!))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.onAccent!, t.accentHover!)).toBeGreaterThanOrEqual(4.5);
    // Text and marks drawn on accent, danger and success fills.
    for (const [on, fill] of [['onAccent', 'accent'], ['onDanger', 'danger'], ['onSuccess', 'success']] as const)
      expect(contrast(t[on]!, t[fill]!)).toBeGreaterThanOrEqual(4.5);
  });
}
