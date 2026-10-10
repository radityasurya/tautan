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
  /** One or two words under the cap: what the key does here, not what it is. */
  hint?: string;
  keys?: string[];
  csi?: string;
  byte?: string;
  /** Bytes sent as they are, for an Agent's alt chord (`ESC p`); no modifier folds in. */
  raw?: string;
  danger?: boolean;
}

export type Modifier = 'ctrl' | 'alt';
export interface CapGroup { label: string; caps: Cap[] }

const ctrl = (letter: string, name: string, hint?: string): Cap => ({ label: `^${letter.toUpperCase()}`, name, hint, keys: [`ctrl+${letter}`] });
const alt = (letter: string, name: string, hint: string): Cap => ({ label: `⌥${letter.toUpperCase()}`, name, hint, raw: `\x1b${letter}` });

const CONTROL: Cap[] = [
  // ^C first: the interrupt is the one key that must never be a hunt.
  { ...ctrl('c', 'Interrupt, control C', 'stop'), danger: true },
  { label: 'esc', name: 'Escape', hint: 'back', keys: ['esc'] },
  ctrl('d', 'End of input, control D', 'end input'),
  ctrl('z', 'Suspend, control Z', 'suspend'),
  ctrl('l', 'Clear screen, control L', 'clear'),
  ctrl('r', 'Search history, control R', 'search'),
];
/** An Agent's control keys. ^D quits the Agent, so it reads as danger; ^Z would suspend it
 *  to the shell, so it is left out. */
const AGENT_CONTROL: Cap[] = [
  { ...ctrl('c', 'Interrupt, control C', 'stop'), danger: true },
  { label: 'esc', name: 'Escape', hint: 'back', keys: ['esc'] },
  { ...ctrl('d', 'Exit, control D', 'exit'), danger: true },
  ctrl('l', 'Clear input, control L', 'clear input'),
  ctrl('r', 'Search history, control R', 'history'),
];
/** pi aborts a run on esc; its ^C only clears the editor (pi's docs/keybindings.md). */
const PI_CONTROL: Cap[] = [
  { label: 'esc', name: 'Abort, escape', hint: 'abort', keys: ['esc'], danger: true },
  ctrl('c', 'Clear editor, control C', 'clear'),
  { ...ctrl('d', 'Exit, control D', 'exit'), danger: true },
];
/** Line editing for a shell prompt; an Agent's input box does not read these. */
const LINE: Cap[] = [
  ctrl('a', 'Start of line, control A', 'line start'),
  ctrl('e', 'End of line, control E', 'line end'),
  ctrl('u', 'Delete to start of line, control U', 'cut line'),
  ctrl('w', 'Delete word, control W', 'cut word'),
];
/** An Agent's numbered menu (a model picker, a question) takes the digit itself. */
const MENU: Cap[] = ['1', '2', '3', '4', '5'].map((n) => ({ label: n, name: `Option ${n}`, raw: n }));
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
  { label: '⇧tab', name: 'Shift tab', hint: 'back tab', keys: ['shift+tab'] },
  { label: GLYPH.enter!, name: 'Enter', hint: 'enter', keys: ['enter'], byte: '\r' },
  { label: GLYPH.space!, name: 'Space', hint: 'space', keys: ['space'], byte: ' ' },
  { label: GLYPH.backspace!, name: 'Backspace', hint: 'delete', keys: ['backspace'], byte: '\x7f' },
  { label: 'del', name: 'Delete', hint: 'forward', csi: '3~' },
];
export const MODIFIERS: Modifier[] = ['ctrl', 'alt'];

/** Claude Code's own keys, from the default keybinding table of Claude Code 2.1.296. */
const CLAUDE: Cap[] = [
  { label: '⇧⇥', name: 'Cycle mode, shift tab', hint: 'mode', keys: ['shift+tab'] },
  { label: 'esc esc', name: 'Rewind, escape twice', hint: 'rewind', keys: ['esc', 'esc'] },
  ctrl('o', 'Transcript, control O', 'transcript'),
  ctrl('t', 'Task list, control T', 'tasks'),
  ctrl('b', 'Run in background, control B', 'background'),
  alt('p', 'Model picker, alt P', 'model'),
  alt('t', 'Thinking on or off, alt T', 'thinking'),
];
/** pi's own keys, from its docs/keybindings.md defaults. */
const PI: Cap[] = [
  { label: '⇧⇥', name: 'Cycle thinking level, shift tab', hint: 'thinking', keys: ['shift+tab'] },
  ctrl('l', 'Model selector, control L', 'model'),
  ctrl('p', 'Next model, control P', 'next model'),
  ctrl('o', 'Tool output, control O', 'tool output'),
  ctrl('t', 'Thinking blocks, control T', 'show thinking'),
  { label: '⌥↵', name: 'Queue a follow-up, alt enter', hint: 'follow-up', raw: '\x1b\r' },
  { label: `⌥${GLYPH.up}`, name: 'Restore queued messages, alt up', hint: 'dequeue', raw: '\x1b[1;3A' },
];

/**
 * The tray's groups, App first when the App profile has keys of its own: Claude's extras, or
 * the function keys a profile lists (htop, less). Modifiers are drawn by the Composer, which
 * owns the armed state.
 */
export function trayGroups(o: { shell: boolean; claude: boolean; pi?: boolean; profileKeys: string[] }): CapGroup[] {
  const fn = o.profileKeys.filter((name) => /^f\d{1,2}$/.test(name))
    .map((name): Cap => ({ label: name.toUpperCase(), name: name.toUpperCase(), keys: [name] }));
  const own = o.claude ? CLAUDE : o.pi ? PI : [];
  const app = [...own, ...fn];
  const edit = own.length ? EDIT.filter((cap) => cap.keys?.join() !== 'shift+tab') : EDIT; // the App group says it better
  return [
    { label: 'Control', caps: o.shell ? [...CONTROL, ...LINE] : o.pi ? PI_CONTROL : AGENT_CONTROL },
    ...(app.length ? [{ label: o.claude ? 'Claude' : o.pi ? 'pi' : 'App', caps: app }] : []),
    ...(o.shell ? [] : [{ label: 'Menu', caps: MENU }]),
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
  if (cap.raw) return { raw: cap.raw };
  const m = mod === 'ctrl' ? 5 : mod === 'alt' ? 3 : 0;
  if (cap.csi) {
    const tilde = cap.csi.endsWith('~');
    if (m) return { raw: tilde ? `\x1b[${cap.csi.slice(0, -1)};${m}~` : `\x1b[1;${m}${cap.csi}` };
    return cap.keys ? { keys: cap.keys } : { raw: `\x1b[${cap.csi}` };
  }
  if (mod === 'alt' && cap.byte) return { raw: `\x1b${cap.byte}` };
  return { keys: cap.keys };
}

/**
 * A key pressed while typing straight into the Pane: what it sends, or null to leave it to the
 * field. Plain text arrives through `beforeinput` instead, and a Cmd chord stays the
 * browser's (copy, paste).
 */
export function directKey(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }): { keys?: string[]; raw?: string } | null {
  if (e.metaKey) return null;
  if (e.key === 'Tab' && e.shiftKey) return { keys: ['shift+tab'] };
  if (e.key === 'Enter' && e.altKey) return { raw: '\x1b\r' };
  const named = DIRECT_NAMES[e.key];
  if (named) return { keys: [named] };
  const csi = DIRECT_CSI[e.key];
  if (csi) return { raw: `\x1b[${csi}` };
  if (e.key.length === 1 && e.ctrlKey) return { keys: [`ctrl+${e.key.toLowerCase()}`] };
  if (e.key.length === 1 && e.altKey) return { raw: `\x1b${e.key}` };
  return null;
}
const DIRECT_NAMES: Record<string, string> = {
  Enter: 'enter', Backspace: 'backspace', Escape: 'esc', Tab: 'tab',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
const DIRECT_CSI: Record<string, string> = { Home: 'H', End: 'F', PageUp: '5~', PageDown: '6~', Delete: '3~' };

/** A typed letter or symbol while a modifier is armed: `ctrl+r`, `alt+.`. */
export const modified = (mod: Modifier, ch: string): string => `${mod}+${ch.toLowerCase()}`;

// ---- the editable key bar ----

/** The caps the user chose: `order` is every label in the user's order, `hidden` the ones off. */
export interface KeyPrefs { order: string[]; hidden: string[] }

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** A saved choice, or null for the defaults. Anything malformed is the defaults. */
export function parseKeyPrefs(raw: string | null): KeyPrefs | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { order?: unknown; hidden?: unknown } | null;
    return v && typeof v === 'object' ? { order: strings(v.order), hidden: strings(v.hidden) } : null;
  } catch {
    return null;
  }
}

/** Every cap of the tray in the user's order, with a flag for whether it shows. A cap the
 *  choice never saw (a new key, another Pane's profile) goes last, shown. */
export function editableCaps(groups: CapGroup[], prefs: KeyPrefs | null): { cap: Cap; on: boolean }[] {
  const all = groups.flatMap((g) => g.caps);
  const rank = (cap: Cap) => {
    const i = prefs?.order.indexOf(cap.label) ?? -1;
    return i < 0 ? Infinity : i;
  };
  const sorted = prefs ? [...all].sort((a, b) => rank(a) - rank(b)) : all; // stable: unknowns keep default order
  return sorted.map((cap) => ({ cap, on: !prefs?.hidden.includes(cap.label) }));
}

/** The groups the tray draws: the defaults, or one flat group of the chosen caps. */
export function applyKeyPrefs(groups: CapGroup[], prefs: KeyPrefs | null): CapGroup[] {
  if (!prefs) return groups;
  return [{ label: 'Your keys', caps: editableCaps(groups, prefs).filter((r) => r.on).map((r) => r.cap) }];
}

/** The choice after an edit: `rows` is the list as the editor shows it. */
export const toKeyPrefs = (rows: { cap: Cap; on: boolean }[]): KeyPrefs => ({
  order: rows.map((r) => r.cap.label),
  hidden: rows.filter((r) => !r.on).map((r) => r.cap.label),
});

/** Move row `i` by `by` places; a move off either end changes nothing. */
export function moveRow<T>(rows: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= rows.length) return rows;
  const next = [...rows];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
