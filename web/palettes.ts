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
