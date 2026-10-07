// Named palettes. Pure data and no DOM, so test/palettes.test.ts can import it.
// Each one picks the kit's light or dark base (`base`), then overrides tautan's CSS tokens
// and the grid's 16 ANSI colours. Layout never changes.
// Sources, published values:
//   Catppuccin  https://github.com/catppuccin/palette (palette.json), ANSI map from catppuccin/alacritty
//   Gruvbox     https://github.com/morhetz/gruvbox (dark, medium contrast)
//   Nord        https://www.nordtheme.com/docs/colors-and-palettes, ANSI map from nordtheme.com/docs/ports/xterm

export type Palette = {
  label: string;
  /** The Halaska Kit palette this one sits on: `kit` components and color-scheme follow it. */
  base: 'light' | 'dark';
  bg: string;
  fg: string;
  muted: string;
  surface: string;
  elevated: string;
  border: string;
  accent: string;
  ok: string;
  warn: string;
  danger: string;
  /** The grid's `--ansi-0` to `--ansi-15`. */
  ansi: string[];
};

type Cat = Record<
  'base' | 'mantle' | 'surface0' | 'surface1' | 'surface2' | 'text' | 'subtext0' | 'subtext1' | 'red' | 'green'
  | 'yellow' | 'blue' | 'pink' | 'teal' | 'peach',
  string
>;

// ponytail: the 16 slots follow catppuccin/alacritty; the bright half repeats the normal half.
function catppuccin(label: string, base: 'light' | 'dark', c: Cat): Palette {
  const light = base === 'light';
  const hues = [c.red, c.green, c.yellow, c.blue, c.pink, c.teal];
  return {
    label: `Catppuccin ${label}`,
    base,
    bg: c.base,
    fg: c.text,
    muted: c.subtext1,
    surface: c.mantle,
    elevated: light ? c.base : c.surface0,
    border: c.surface1,
    accent: c.blue,
    // Latte's green misses 3:1 on its base too: a darker green (not published).
    ok: light ? '#368a24' : c.green,
    // Latte's peach and yellow miss 3:1 on its base: it uses a darker peach (not published).
    warn: light ? '#e5530a' : c.yellow,
    danger: c.red,
    ansi: [light ? c.subtext1 : c.surface1, ...hues, light ? c.surface2 : c.subtext1, light ? c.subtext0 : c.surface2, ...hues, light ? c.surface1 : c.subtext0],
  };
}

export const PALETTES: Record<string, Palette> = {
  'catppuccin-latte': catppuccin('Latte', 'light', {
    base: '#eff1f5', mantle: '#e6e9ef', surface0: '#ccd0da', surface1: '#bcc0cc', surface2: '#acb0be',
    text: '#4c4f69', subtext0: '#6c6f85', subtext1: '#5c5f77', red: '#d20f39', green: '#40a02b',
    yellow: '#df8e1d', blue: '#1e66f5', pink: '#ea76cb', teal: '#179299', peach: '#fe640b',
  }),
  'catppuccin-frappe': catppuccin('Frappé', 'dark', {
    base: '#303446', mantle: '#292c3c', surface0: '#414559', surface1: '#51576d', surface2: '#626880',
    text: '#c6d0f5', subtext0: '#a5adce', subtext1: '#b5bfe2', red: '#e78284', green: '#a6d189',
    yellow: '#e5c890', blue: '#8caaee', pink: '#f4b8e4', teal: '#81c8be', peach: '#ef9f76',
  }),
  'catppuccin-macchiato': catppuccin('Macchiato', 'dark', {
    base: '#24273a', mantle: '#1e2030', surface0: '#363a4f', surface1: '#494d64', surface2: '#5b6078',
    text: '#cad3f5', subtext0: '#a5adcb', subtext1: '#b8c0e0', red: '#ed8796', green: '#a6da95',
    yellow: '#eed49f', blue: '#8aadf4', pink: '#f5bde6', teal: '#8bd5ca', peach: '#f5a97f',
  }),
  'catppuccin-mocha': catppuccin('Mocha', 'dark', {
    base: '#1e1e2e', mantle: '#181825', surface0: '#313244', surface1: '#45475a', surface2: '#585b70',
    text: '#cdd6f4', subtext0: '#a6adc8', subtext1: '#bac2de', red: '#f38ba8', green: '#a6e3a1',
    yellow: '#f9e2af', blue: '#89b4fa', pink: '#f5c2e7', teal: '#94e2d5', peach: '#fab387',
  }),
  'gruvbox-dark': {
    label: 'Gruvbox Dark',
    base: 'dark',
    bg: '#282828', fg: '#ebdbb2', muted: '#bdae93', surface: '#1d2021', elevated: '#3c3836', border: '#504945',
    accent: '#83a598', ok: '#b8bb26', warn: '#fe8019', danger: '#fb4934',
    ansi: [
      '#504945', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
    ],
  },
  nord: {
    label: 'Nord',
    base: 'dark',
    bg: '#2e3440', fg: '#d8dee9', muted: '#b0b9c9', surface: '#292e39', elevated: '#3b4252', border: '#434c5e',
    accent: '#88c0d0', ok: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a',
    ansi: [
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4',
    ],
  },
};

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hexOf = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** `a` mixed toward `b` by `t` (0 to 1). */
const mix = (a: string, b: string, t: number) => hexOf(rgb(a).map((v, i) => v + (rgb(b)[i]! - v) * t));
const tint = (h: string, a: number) => `rgba(${rgb(h).join(',')},${a})`;

/** `c` pulled toward `toward` until it reads at 4.5:1 on every ground. */
function readable(c: string, toward: string, grounds: string[]): string {
  let out = c;
  for (let t = 0; t <= 1 && grounds.some((g) => contrast(out, g) < 4.5); t += 0.05) out = mix(c, toward, t);
  return out;
}

/** The better of `fg` and `bg` for text drawn on `fill`. */
// When neither reaches 4.5:1 (a published pastel), it moves to black or white, whichever reads better.
function on(p: Palette, fill: string): string {
  const pick = contrast(p.bg, fill) >= contrast(p.fg, fill) ? p.bg : p.fg;
  if (contrast(pick, fill) >= 4.5) return pick;
  return contrast('#000000', fill) >= contrast('#ffffff', fill) ? '#000000' : '#ffffff';
}

/**
 * The kit colour tokens (tokens.light / tokens.dark keys) for a palette. Applied over the
 * kit's own base by web/app.tsx, so every kit component follows the palette without a kit edit.
 */
export function kitTokens(p: Palette): Record<string, string> {
  const light = p.base === 'light';
  return {
    bg: p.bg, bgElevated: p.elevated, bgSubtle: p.surface,
    bgMuted: mix(p.surface, p.border, 0.2), bgHover: mix(p.surface, p.border, 0.3), bgInput: p.surface,
    border: p.border, borderSubtle: mix(p.border, p.bg, 0.5),
    borderInput: tint(p.fg, 0.12), borderFocus: p.accent,
    text: p.fg, textSecondary: p.muted,
    // ponytail: tertiary shares muted so every text token stays readable; add a step if the hierarchy is missed.
    textTertiary: p.muted, textMuted: mix(p.muted, p.bg, 0.45), textInverse: p.bg,
    shadow: light ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.2)', shadowMd: light ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.3)', shadowLg: light ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.4)',
    sheetBg: tint(p.elevated, 0.95),
    onAccent: on(p, p.accent), onDanger: on(p, p.danger), onSuccess: on(p, p.ok),
    accent: p.accent, accentHover: mix(p.accent, light ? '#000000' : '#ffffff', 0.15), accentBg: tint(p.accent, 0.12), accentText: readable(p.accent, p.fg, [p.bg, p.surface, p.elevated, mix(p.bg, p.accent, 0.12)]),
    success: p.ok, successHover: mix(p.ok, light ? '#000000' : '#ffffff', 0.15), successBg: tint(p.ok, 0.1),
    warning: p.warn, warningHover: mix(p.warn, light ? '#000000' : '#ffffff', 0.15), warningBg: tint(p.warn, 0.1),
    danger: p.danger, dangerHover: mix(p.danger, light ? '#000000' : '#ffffff', 0.15), dangerBg: tint(p.danger, 0.1),
  };
}

export const PALETTE_IDS = Object.keys(PALETTES);

/** WCAG 2.x contrast ratio between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
