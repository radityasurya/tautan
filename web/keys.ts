/**
 * One spelling per key, for every cap and pill in the dock. Arrows are the small triangles,
 * not the writing arrows: at 11 px a triangle still reads as a direction, and the mono
 * subset ships all four. Anything missing prints its herdr name.
 */
export const GLYPH: Record<string, string> = {
  up: '▲', down: '▼', left: '◀', right: '▶',
  enter: '↵', esc: 'esc', tab: '⇥', 'shift+tab': '⇧⇥', space: '␣',
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
