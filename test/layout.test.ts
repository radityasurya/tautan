import { describe, expect, test } from 'bun:test';
import { parseAnsi } from '../shared/ansi.ts';
import { boxInner, classify, continues, fillOf, hangOf, splitAt, tuiScreen } from '../shared/layout.ts';

const kinds = (text: string) => classify(text, 120).join(',');

describe('classify', () => {
  test('a Claude permission box: edges and rows are box chrome, the hint is prose', () => {
    const box = [
      '┌──────────────────────────────────────────┐',
      '│ Do you want to proceed?                  │',
      '│ ❯ 1. Yes                                 │',
      '│ 2. No, and tell Claude what to do        │',
      '└──────────────────────────────────────────┘',
      '',
      'esc to cancel · enter to confirm',
    ].join('\n');
    expect(kinds(box)).toBe('box-top,box-row,box-row,box-row,box-bottom,prose,prose');
  });

  test('the contract-test prompt shape: only the rule is chrome', () => {
    const prompt = [
      'Bash command',
      'echo tautan-blocked',
      'Do you want to proceed?',
      '❯ 1. Yes',
      "2. Yes, and don't ask again…",
      '3. No, and tell Claude what to do differently (esc)',
      '────────────────────────────────',
      'esc to cancel · enter to confirm',
    ].join('\n');
    expect(kinds(prompt)).toBe('prose,prose,prose,prose,prose,prose,rule,prose');
  });

  test('column alignment is structure, two columns are not', () => {
    expect(kinds('name    status    time    note')).toBe('structure');
    expect(kinds('Mem:  8G   Swap:  2G')).toBe('structure'); // three gaps: aligned output
    expect(kinds('Mem:  8G')).toBe('prose');
    expect(kinds('a  b')).toBe('prose');
  });

  test('ls -l rows stay together even where a size pads with one gap fewer', () => {
    const ls = [
      'total 80',
      'drwxrwxr-x  2 tama tama  4096 Oct  6 22:07 .',
      '-rw-rw-r--  1 tama tama  4184 Sep 12 13:35 affordances.ts',
      '-rw-rw-r--  1 tama tama 13792 Oct  6 22:07 chat.ts',
      '-rw-rw-r--  1 tama tama   497 Sep 12 11:44 seen.ts',
    ].join('\n');
    expect(kinds(ls)).toBe('prose,structure,structure,structure,structure');
    expect(kinds('Done.  Next step.  Then the tests.')).toBe('prose'); // alone, two gaps stay prose
  });

  test('a long markdown table row is structure', () => {
    expect(classify('| tautan | the wide grid | phone-first | two panes | wrap |', 80)[0]).toBe('structure');
    // A short row still keeps its columns, so a header lines up with the long body rows.
    expect(classify('| a | b |', 80)[0]).toBe('structure');
  });

  test('prose with long words and single spaces stays prose', () => {
    expect(kinds('The prompt changed. Read it again before you answer.')).toBe('prose');
    expect(kinds('superlongidentifier_with_underscores and-dashes-here')).toBe('prose');
  });

  test('a git diff is prose: nothing to pin, lines reflow acceptably', () => {
    const diff = ['diff --git a/web/pane.tsx b/web/pane.tsx', '@@ -231,7 +231,7 @@', ' const wrap = wraps[kind];', '-  agent: localStorage.getItem(\'tautan.wrap.agent\') === \'on\','].join('\n');
    expect(kinds(diff)).toBe('prose,prose,prose,prose');
  });

  test('a box with prose inside it: the inside line carries no glyph and stays prose', () => {
    const inside = ['┌────┐', '│    │', 'Do you want to proceed?', '└────┘'].join('\n');
    expect(kinds(inside)).toBe('box-top,box-row,prose,box-bottom');
  });

  test('empty lines are prose and the count always matches the lines', () => {
    const text = 'one\n\nthree';
    const result = classify(text);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe('prose');
  });

  // Claude Code draws its chrome at the desktop's width: 160 columns here.
  const W = 158;
  const row = (t: string) => `│ ${t}${' '.repeat(W - 2 - t.length)} │`;

  test('full-width rules around the input are rules, the prompt is prose', () => {
    const input = ['─'.repeat(159), '> ', '─'.repeat(159), '  ? for shortcuts'].join('\n');
    expect(classify(input, 160).join(',')).toBe('rule,prose,rule,prose');
    expect(kinds('  ━━━━━━━━   ')).toBe('rule');
    expect(kinds('──')).not.toBe('rule'); // two glyphs: a dash or an arrow, not a rule
  });

  test('a rounded box with a title and prose rows, at 160 columns', () => {
    const box = [
      `╭${'─'.repeat(W)}╮`,
      row('Bash command'),
      row(''),
      row('  pnpm exec tsc --noEmit -p . && bun test'),
      row("  2. Yes, and don't ask again for pnpm commands"),
      `╰${'─'.repeat(W)}╯`,
      `┌─ Permission required ${'─'.repeat(40)}┐`,
    ].join('\n');
    expect(classify(box, 160).join(',')).toBe('box-top,box-row,box-row,box-row,box-row,box-bottom,box-top');
  });

  test('a drawn table stays structure: inner separators, ┬ and ┼', () => {
    const grid = ['┌──────┬──────┐', '│ name │ size │', '├──────┼──────┤', '│ a.ts │ 2 kB │', '└──────┴──────┘'].join('\n');
    expect(kinds(grid)).toBe('structure,structure,structure,structure,structure');
  });

  test('a box around aligned columns keeps them', () => {
    expect(kinds('│ NAME    STATUS    AGE    NODE │')).toBe('structure');
  });

  test('a short markdown table: header, separator and rows all keep their columns', () => {
    const md = ['| File | Change |', '|------|--------|', '| a.ts | new |'].join('\n');
    expect(kinds(md)).toBe('structure,structure,structure');
  });

  test('boxInner drops borders and pads, keeps the indent and the title', () => {
    const r = row('  pnpm exec tsc');
    const [s, e] = boxInner(r, 'box-row');
    expect(r.slice(s, e)).toBe('  pnpm exec tsc');
    const empty = row('');
    const [s2, e2] = boxInner(empty, 'box-row');
    expect(e2 - s2).toBe(0);
    const top = `┌─ Permission required ${'─'.repeat(40)}┐`;
    const [s3, e3] = boxInner(top, 'box-top');
    expect(top.slice(s3, e3)).toBe('Permission required');
    const plain = `╰${'─'.repeat(W)}╯`;
    const [s4, e4] = boxInner(plain, 'box-bottom');
    expect(e4 - s4).toBe(0);
  });
});

// Pi pads every line to the Pane's width, draws tool blocks as rows of one background, and
// ends with a two-half footer. Lines below are from a real 128-column Pi Pane (126 drawn).
const PI = 128;
const pad = (t: string) => t + ' '.repeat(Math.max(0, PI - 2 - t.length));

describe('Pi', () => {
  test('padding does not make prose a table, and the input rules are rules', () => {
    const screen = [
      pad(' Run `ls | wc -l` to count them.'),
      '',
      '─'.repeat(PI - 2),
      pad(''),
      '─'.repeat(PI - 2),
    ].join('\n');
    expect(classify(screen, PI).join(',')).toBe('prose,prose,rule,prose,rule');
  });

  test('the footer is a split line: left and right halves', () => {
    const line = `~/projects/strategist.sh${' '.repeat(58)}zai/glm-5.3 · high`;
    expect(classify(line, PI)[0]).toBe('split');
    const at = splitAt(line)!;
    expect(line.slice(0, at[0])).toBe('~/projects/strategist.sh');
    expect(line.slice(at[1])).toBe('zai/glm-5.3 · high');
    expect(classify(`41%/1.0m · $0.00 · 31 tok/s${' '.repeat(51)}main · 2 files changed`, PI)[0]).toBe('split');
    // Aligned columns with one wide gap stay structure; a short gap stays prose.
    expect(kinds(`NAME   STATUS${' '.repeat(20)}AGE   NODE`)).toBe('structure');
    expect(kinds('const a = 1;        // note')).toBe('prose');
    expect(classify(pad(' ● ADHD ON'), PI)[0]).toBe('prose');
  });

  test('a tool block is filled edge to edge; ordinary prose and the cursor row are not', () => {
    const [block, blank, prose, cursor] = parseAnsi([
      `\x1b[48;2;54;58;79m \x1b[0m\x1b[38;2;165;173;203m\x1b[48;2;54;58;79mTook 0.0s\x1b[0m\x1b[48;2;54;58;79m${' '.repeat(116)}\x1b[0m`,
      `\x1b[48;2;54;58;79m${' '.repeat(126)}\x1b[0m`,
      pad(' Correct — and it is now stated explicitly.'),
      `\x1b[7m \x1b[0m${' '.repeat(125)}`,
    ].join('\n'));
    expect(fillOf(block!, PI)).toBe('rgb(54,58,79)');
    expect(fillOf(blank!, PI)).toBe('rgb(54,58,79)');
    expect(fillOf(prose!, PI)).toBeUndefined();
    expect(fillOf(cursor!, PI)).toBeUndefined();
    // A highlighted word mid-line is not a fill.
    expect(fillOf(parseAnsi('\x1b[48;5;4mword\x1b[0m')[0]!, PI)).toBeUndefined();
  });

  test('hard-wrapped paragraphs rejoin; list items and short lines do not', () => {
    const text = [
      pad(" Correct — and it's now stated explicitly. The glm-run/codex-watch dispatch layer was a Claude Code workaround: CC couldn't"),
      pad(' natively spawn glm processes, so it shelled out to dispatch commands and watched them through herdr panes. Pi has no such'),
      pad(' gap — spawning IS the Agent tool.'),
      pad(''),
      pad(' - The pi orchestrator persona now says it outright: "Spawn directly with the Agent tool — no dispatch commands (no'),
      pad('   glm-run/codex runs), no watch panes; live runs show in the agents toolbar below the editor."'),
      pad(' - Specialists run as in-process subagents: live toolbar rows, steerable (steer_subagent), collectable (get_subagent_result)'),
      pad('   — the dispatch/watch machinery is replaced by what you already have on screen'),
      pad(' - Chezmoi updated (2460264)'),
    ].join('\n');
    expect(continues(text, PI).map(Number).join('')).toBe('011001010');
  });
});

describe('Claude Code wrapping', () => {
  test('a bullet continuation rejoins, the next bullet does not', () => {
    const text = [
      '  - New section 2a, pacing through Calendar: every outgoing link waits in one queue per site, and the Calendar shows',
      '    That covers directory submissions, outreach pitches, guest-post drafts, and the backlinks that come with link',
      '    exchange placements.',
      '  - New decision D4: no bursts, and the Calendar queue is the only way to submit.',
      '  - New open question Q6, budget defaults: start at 3 a week, add 2 each week, stop at 10 a week, Monday to Friday.',
    ].join('\n');
    expect(continues(text, 122).map(Number).join('')).toBe('01100');
  });
});

test('hangOf: under the text, past a list marker', () => {
  expect(hangOf('  - New decision D4: no bursts')).toBe(4);
  expect(hangOf('● Everything is already committed')).toBe(2);
  expect(hangOf(' 12. Twelfth')).toBe(5);
  expect(hangOf('  What I changed')).toBe(2);
  expect(hangOf('')).toBe(0);
});

describe('tuiScreen', () => {
  test('htop is a full-screen program', () => {
    const htop = [
      '    0[||||||||||||       39.9%]  3[|||||||||||||      47.1%]   6[||||||||||         39.4%]   9[||||||||||         36.2%]',
      '    1[||||||||||         40.2%]  4[|||||||||||||||||||84.5%]   7[||||||||||||       42.3%]  10[|||||||||          30.9%]',
      '  Mem[|||||||||||||||||||||||||||||||||||||||||||||||          12.3G/31.1G] Tasks: 412, 1873 thr; 3 running',
      '  Swp[|                                                         0K/2.00G] Load average: 3.12 2.80 2.41',
      '',
      '    PID USER       PRI  NI  VIRT   RES   SHR S  CPU% MEM%   TIME+  Command',
      ' 812345 tama        20   0 11.2G  812M  120M S  12.3  2.6  1:02.11 /usr/bin/node server.js',
      ' 812346 tama        20   0  2.1G  210M   40M S   3.1  0.7  0:12.40 bun server/main.ts',
      'F1Help  F2Setup F3SearchF4FilterF5Tree  F6SortByF7Nice -F8Nice +F9Kill  F10Quit',
    ].join('\n');
    expect(tuiScreen(htop, 122)).toBe(true);
  });

  test('a shell with command output is line-oriented', () => {
    const shell = [
      '~/projects/taut main* ❯ git --no-pager log --oneline -4',
      '5dcb79a (HEAD -> main, origin/main) Chat view: images inline on the phone and desktop',
      '1911e56 Desktop sidebar, composer and Switch drawer: fixed tops, one scroller',
      '728f90f Chat view: z.ai tool blocks as rows, and a code block header',
      '121cf0f Chat view: Markdown, and tool rows that open',
      '~/projects/taut main* ❯ echo done',
      'done',
      '~/projects/taut main* ❯',
    ].join('\n');
    expect(tuiScreen(shell, 122)).toBe(false);
    expect(tuiScreen('', 80)).toBe(false);
  });

  test('side-by-side panels are a full-screen program', () => {
    const panels = Array.from({ length: 6 }, (_, i) => `│ item ${i} │ detail ${i} │`).join('\n');
    expect(tuiScreen(panels, 80)).toBe(true);
  });
});
