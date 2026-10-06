/**
 * One spelling per key, for every cap and pill in the dock. Arrows are the small triangles,
 * not the writing arrows: at 11 px a triangle still reads as a direction, and the mono
 * subset ships all four. Anything missing prints its herdr name.
 */
export const GLYPH: Record<string, string> = {
  up: '▲', down: '▼', left: '◀', right: '▶',
  enter: '↵', esc: 'esc', tab: '⇥', 'shift+tab': '⇧⇥', space: '␣', backspace: '⌫',
};

/**
 * The glyph for a herdr key name. `ctrl+d` is `^d`, the way a footer prints it, and a
 * function key is upper case, the way its own cap prints it.
 */
export const keyGlyph = (name: string): string =>
  GLYPH[name] ??
  (name.startsWith('ctrl+') ? `^${name.slice(5)}` : /^f\d{1,2}$/.test(name) ? name.toUpperCase() : name);

/** Herdr key names, with the label shown on the cap. Ordered by real use. Labels stay short:
 *  the open preset is a six-column grid, so a cap is about 55 px on a phone. */
export const AGENT_KEYS: [name: string, label: string][] = [
  ['esc', 'esc'], ['up', GLYPH.up!], ['down', GLYPH.down!], ['tab', 'tab'],
  ['shift+tab', '⇧tab'], ['enter', GLYPH.enter!], ['ctrl+c', '^C'],
];

export const SHELL_KEYS: [name: string, label: string][] = [
  ['ctrl', 'ctrl'], ['esc', 'esc'], ['tab', 'tab'], ['up', GLYPH.up!], ['down', GLYPH.down!],
  ['left', GLYPH.left!], ['right', GLYPH.right!], ['enter', GLYPH.enter!],
  ['c', 'c'], ['d', 'd'], ['l', 'l'], ['r', 'r'],
  // Keep the direct interrupt: a missed ctrl+c is worse than the extra cap.
  ['ctrl+c', '^C'],
];

/**
 * The keys the dock shows without expanding, next to the keys toggle. An agent gets the two
 * that stop it; a shell gets the ones a prompt line needs. Names only — the cap's label
 * still comes from the preset above.
 */
export const INLINE_KEYS: Record<'agent' | 'shell', string[]> = {
  agent: ['esc', 'ctrl+c'],
  shell: ['esc', 'tab', 'up', 'ctrl+c'],
};

// ---- the Keys tray ----

/**
 * One cap in the Keys tray. `keys` are herdr key names (the tmux adapter maps them). A cap
 * without `keys` goes out as raw bytes, because herdr 0.9 refuses `home`, `end`, `pageup`,
 * `pagedown` and `delete` by name (probed on a throwaway server, 2026-10-06), and both Muxes
 * pass `raw` through unchanged. `csi` is the xterm sequence's tail (`A`, `5~`), so an armed
 * modifier can be folded in; `byte` is what an armed alt prefixes with ESC.
 */
export interface Cap {
  label: string;
  /** What a screen reader says. */
  name: string;
  keys?: string[];
  csi?: string;
  byte?: string;
  danger?: boolean;
}

export type Modifier = 'ctrl' | 'alt';
export interface CapGroup { label: string; caps: Cap[] }

const ctrl = (letter: string, name: string): Cap => ({ label: `^${letter.toUpperCase()}`, name, keys: [`ctrl+${letter}`] });

const CONTROL: Cap[] = [
  // ^C first: the interrupt is the one key that must never be a hunt.
  { ...ctrl('c', 'Interrupt, control C'), danger: true },
  { label: 'esc', name: 'Escape', keys: ['esc'] },
  ctrl('d', 'End of input, control D'),
  ctrl('z', 'Suspend, control Z'),
  ctrl('l', 'Clear screen, control L'),
  ctrl('r', 'Search history, control R'),
];
/** Line editing for a shell prompt; an Agent's input box does not read these. */
const LINE: Cap[] = [
  ctrl('a', 'Start of line, control A'),
  ctrl('e', 'End of line, control E'),
  ctrl('u', 'Delete to start of line, control U'),
  ctrl('w', 'Delete word, control W'),
];
const NAVIGATE: Cap[] = [
  { label: GLYPH.up!, name: 'Up', keys: ['up'], csi: 'A' },
  { label: GLYPH.down!, name: 'Down', keys: ['down'], csi: 'B' },
  { label: GLYPH.left!, name: 'Left', keys: ['left'], csi: 'D' },
  { label: GLYPH.right!, name: 'Right', keys: ['right'], csi: 'C' },
  { label: 'home', name: 'Home', csi: 'H' },
  { label: 'end', name: 'End', csi: 'F' },
  { label: 'pgup', name: 'Page up', csi: '5~' },
  { label: 'pgdn', name: 'Page down', csi: '6~' },
];
const EDIT: Cap[] = [
  { label: 'tab', name: 'Tab', keys: ['tab'], byte: '\t' },
  { label: '⇧tab', name: 'Shift tab', keys: ['shift+tab'] },
  { label: GLYPH.enter!, name: 'Enter', keys: ['enter'], byte: '\r' },
  { label: GLYPH.space!, name: 'Space', keys: ['space'], byte: ' ' },
  { label: GLYPH.backspace!, name: 'Backspace', keys: ['backspace'], byte: '\x7f' },
  { label: 'del', name: 'Delete', csi: '3~' },
];
export const MODIFIERS: Modifier[] = ['ctrl', 'alt'];

/** Claude Code's own keys: shift+tab cycles its mode, esc twice opens the rewind list. */
const CLAUDE: Cap[] = [
  { label: '⇧⇥ mode', name: 'Cycle mode, shift tab', keys: ['shift+tab'] },
  { label: 'esc esc', name: 'Rewind, escape twice', keys: ['esc', 'esc'] },
];

/**
 * The tray's groups, App first when the App profile has keys of its own: Claude's extras, or
 * the function keys a profile lists (htop, less). Modifiers are drawn by the Composer, which
 * owns the armed state.
 */
export function trayGroups(o: { shell: boolean; claude: boolean; profileKeys: string[] }): CapGroup[] {
  const fn = o.profileKeys.filter((name) => /^f\d{1,2}$/.test(name))
    .map((name): Cap => ({ label: name.toUpperCase(), name: name.toUpperCase(), keys: [name] }));
  const app = [...(o.claude ? CLAUDE : []), ...fn];
  const edit = o.claude ? EDIT.filter((cap) => cap.keys?.join() !== 'shift+tab') : EDIT; // the App group says it better
  return [
    { label: 'Control', caps: o.shell ? [...CONTROL, ...LINE] : CONTROL },
    ...(app.length ? [{ label: o.claude ? 'Claude' : 'App', caps: app }] : []),
    { label: 'Navigate', caps: NAVIGATE },
    { label: 'Edit', caps: edit },
  ];
}

/**
 * What a cap sends, with an armed modifier folded in. A modified arrow, Home, End, PgUp, PgDn
 * or Delete is the xterm form (`CSI 1;5C` is ctrl+right); alt before tab, enter, space or
 * backspace is ESC and the byte, as a terminal sends it. A modifier means nothing to esc, the
 * ^ caps or shift+tab, so those go out as they are.
 */
export function capInput(cap: Cap, mod: Modifier | null): { keys?: string[]; raw?: string } {
  const m = mod === 'ctrl' ? 5 : mod === 'alt' ? 3 : 0;
  if (cap.csi) {
    const tilde = cap.csi.endsWith('~');
    if (m) return { raw: tilde ? `\x1b[${cap.csi.slice(0, -1)};${m}~` : `\x1b[1;${m}${cap.csi}` };
    return cap.keys ? { keys: cap.keys } : { raw: `\x1b[${cap.csi}` };
  }
  if (mod === 'alt' && cap.byte) return { raw: `\x1b${cap.byte}` };
  return { keys: cap.keys };
}

/** A typed letter or symbol while a modifier is armed: `ctrl+r`, `alt+.`. */
export const modified = (mod: Modifier, ch: string): string => `${mod}+${ch.toLowerCase()}`;
