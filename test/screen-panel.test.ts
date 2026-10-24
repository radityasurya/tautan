import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAnsi } from '../shared/ansi.ts';
import type { Span } from '../shared/types.ts';
import { panelCommand, screenPanel } from '../web/screen-panel.ts';

const fixture = (name: string) => parseAnsi(readFileSync(join(import.meta.dir, 'fixtures/claude-2.1.310', name), 'utf8'));
const text = (rows: Span[][]) => rows.map((spans) => spans.map((sp) => sp.text).join(''));
const rule = '─'.repeat(40);

describe('screenPanel', () => {
  test('/usage: the rows under the rule, while the input box is gone', () => {
    const panel = screenPanel(fixture('usage-panel.ansi.txt'), '/usage')!;
    expect(panel.live).toBe(true);
    const rows = text(panel.rows);
    // The two-space indent and the blank rows at both ends are cut; the footer stays.
    expect(rows[0]).toBe('Settings  Status   Config   Usage   Stats');
    expect(rows.at(-1)).toBe('Esc to cancel');
    expect(rows).toContain('Current session');
    expect(rows.some((row) => row.startsWith('❯'))).toBe(false); // the echo above the rule
  });

  test('a meter keeps its drawn empty part, and no row keeps plain trailing pad', () => {
    const rows = screenPanel(fixture('usage-panel.ansi.txt'), '/usage')!.rows;
    const meter = rows.find((spans) => spans.some((sp) => sp.text.includes('20% used')))!;
    expect(meter[0]!.bg).toBeDefined();
    expect(meter[0]!.text).toMatch(/^█+ +$/);
    for (const row of text(rows)) expect(row).toBe(row.trimEnd());
  });

  test('/config: the search box inside the panel is not its top rule', () => {
    const rows = text(screenPanel(fixture('config-panel.ansi.txt'), '/config')!.rows);
    expect(rows[0]).toContain('Settings');
    expect(rows.some((row) => row.includes('Search settings'))).toBe(true);
  });

  const screen = (...rows: string[]) => parseAnsi(rows.join('\n'));
  const box = [rule, '❯ ', rule, '  ⏵⏵ auto mode on'];

  test('the input box is back after Esc: what the panel left is not this command\'s', () => {
    const lines = screen('❯ /usage', '  ⎿  Settings dialog dismissed', '', ...box);
    // The dismissal note is printed output, which the card ignores once it saw the panel live.
    expect(screenPanel(lines, '/usage')).toEqual({ live: false, rows: [[{ text: '⎿  Settings dialog dismissed' }]] });
    expect(screenPanel(lines, '/context')).toBeNull();
  });

  test('/context: printed above the box, under its echo', () => {
    const lines = screen('● Earlier reply', '', '❯ /context', '  ⎿  Context Usage', '     ⛁ ⛁ ⛶   Opus 5.5', '', ...box);
    const panel = screenPanel(lines, '/context')!;
    expect(panel.live).toBe(false);
    expect(text(panel.rows)).toEqual(['⎿  Context Usage', '   ⛁ ⛁ ⛶   Opus 5.5']);
  });

  test('/context taller than the Screen: no echo left, every row above the box', () => {
    const lines = screen('     ├ dataviz: ~480 tokens', '     └ init: ~20 tokens', '', ...box);
    expect(text(screenPanel(lines, '/context')!.rows)).toEqual(['├ dataviz: ~480 tokens', '└ init: ~20 tokens']);
  });

  test('a later echo means the conversation moved on', () => {
    const lines = screen('❯ /context', '  ⎿  Context Usage', '', '❯ fix the parser', '', '● On it.', '', ...box);
    expect(screenPanel(lines, '/context')).toBeNull();
  });

  test('a Screen with neither a box nor a rule shows nothing', () => {
    expect(screenPanel(screen('$ ls', 'README.md'), '/usage')).toBeNull();
  });
});

test('panelCommand: Claude\'s Screen commands, less the ones that keep the Screen', () => {
  expect(panelCommand('/usage')).toBe(true);
  expect(panelCommand('/config')).toBe(true);
  expect(panelCommand('/login')).toBe(false);
  expect(panelCommand('/resume')).toBe(false);
  expect(panelCommand('/model opus')).toBe(false); // with an argument it is a plain send
  expect(panelCommand('fix /usage')).toBe(false);
});
