import { describe, expect, test } from 'bun:test';
import { CYCLE_MODE_KEYS, PROFILES, profileFor, toolbarFromScreen } from '../web/profiles.ts';

// Footers below were recorded 2026-10-06 from the live herdr (pane.read, visible, strip_ansi);
// rule lines trimmed to width. The model prints only on the mode line, so banner art, prose
// and tool results that name a model state nothing.

const rule = '─'.repeat(60);

// A finished Claude Code Screen whose footer prints no ⏵⏵ line: default mode.
const defaultMode = [
  "  install it with `/plugin marketplace add radityasurya/uxui` and then `/plugin install uxui@uxui`.",
  '',
  '✻ Sautéed for 7m 8s · done 10:12 AM',
  '',
  '                                                                                new task? /clear to save 193.6k tokens',
  rule,
  '❯',
  rule,
  '  [PONYTAIL]',
  '  ✻ /help for help',
];

// Plan-mode Screen with model and context on the mode line; plan prints as `⏸`, not `⏵⏵`.
const withModelContext = [
  '✻ Brewed for 48s · done 8:01 PM',
  rule,
  '❯',
  rule,
  '  ⏸ plan mode on (shift+tab to cycle) · Opus 4.6 · Context left until auto-compact: 37%',
];

// The agent-tree footer variant: mode without the "(shift+tab to cycle)" suffix (w8:p28).
const autoNoHint = [
  rule,
  '❯ Message @frontend…',
  rule,
  '  [PONYTAIL]',
  '  ⏵⏵ auto mode on · 1 shell · ⧉ 4 · ← 2 agents · 1 feedback draft',
  '',
  '  ◯ main',
  '❯ └ ◯ frontend    Adding describeSchedule test to scheduled-tasks.test.ts',
];

// Transcript lines that name a model above a footer whose mode line names none (wV:p1).
const modelInProse = [
  '  Get to finished work sooner with Opus 5.5. Switch anytime with /model.',
  '❯ /model',
  '  ⎿  Set model to Opus 5.5 (1M context) and saved as your default for new sessions',
  rule,
  '❯',
  rule,
  '  [PONYTAIL]',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents',
];

// A ⏵⏵ line quoted in the transcript, far above a footer that prints none.
const transcriptEcho = [
  '  user said: what does "⏵⏵ accept edits on (shift+tab to cycle)" mean?',
  ...Array.from({ length: 16 }, (_, i) => `  transcript line ${i} of the answer`),
  rule,
  '❯',
  rule,
  '  [PONYTAIL]',
];

const claude = (lines: string[]) => toolbarFromScreen(PROFILES.claude!, lines);

describe('toolbar from Screen', () => {
  test('default mode: no ⏵⏵ line in the footer hides mode, model and context', () => {
    const read = claude(defaultMode);
    expect(read.mode).toBeUndefined();
    expect(read.model).toBeUndefined();
    expect(read.context).toBeUndefined();
  });

  test('reads short labels from the mode line, both glyphs (⏵⏵ and ⏸)', () => {
    for (const [footer, label] of [
      ['  ⏵⏵ accept edits on (shift+tab to cycle) · ← 2 agents', 'accept edits'],
      ['  ⏸ plan mode on (shift+tab to cycle)', 'plan'],
      ['  ⏵⏵ bypass permissions on (shift+tab to cycle)', 'bypass permissions'],
      ['  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents', 'auto'],
    ] as const) expect(claude([footer]).mode).toBe(label);
  });

  test('matches the mode line with or without the cycle hint', () => {
    expect(claude(autoNoHint).mode).toBe('auto');
  });

  test('model and context only from anchored footer lines, context as percent left', () => {
    expect(claude(withModelContext)).toEqual({ mode: 'plan', model: 'Opus 4.6', context: 37 });
    expect(claude(['  ↓ 85.8k tokens · 42% context left']).context).toBe(42);
    expect(claude(['  ↓ 85.8k tokens · 42% context used']).context).toBeUndefined();
    expect(claude(['  ⏵⏵ accept edits on (shift+tab to cycle) · Sonnet 4.6 · Context left until auto-compact: 42%']).model).toBe('Sonnet 4.6');
  });

  test('model never from transcript prose, banners or tool results above the footer', () => {
    const read = claude(modelInProse);
    expect(read.mode).toBe('auto');
    expect(read.model).toBeUndefined();
  });

  test('ignores a ⏵⏵ line in the transcript above the footer window', () => {
    expect(claude(transcriptEcho).mode).toBeUndefined();
  });

  test('a shell Pane profile states nothing', () => {
    expect(toolbarFromScreen(profileFor({ command: 'zsh' }), withModelContext)).toEqual({});
  });

  test('cycling uses the existing herdr key vocabulary', () => {
    expect(CYCLE_MODE_KEYS).toEqual(['shift+tab']);
  });
});
