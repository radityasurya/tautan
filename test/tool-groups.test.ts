import { describe, expect, test } from 'bun:test';
import type { Tool } from '../shared/chat.ts';
import { runSummary, toolRuns } from '../web/tool-groups.ts';

const tool = (name: string, brief = name, more: Partial<Tool> = {}): Tool => ({ name, brief, detail: brief, result: 'ok', ...more });

describe('toolRuns', () => {
  test('folds runs of two or more; a lone row and a kept-out row stay rows', () => {
    // 0 1 2 fold, 3 is kept out, 4 is alone, 5 is kept out, 6 7 fold
    const out = new Set([3, 5]);
    expect(toolRuns(8, (n) => out.has(n))).toEqual([{ run: [0, 1, 2] }, { row: 3 }, { row: 4 }, { row: 5 }, { run: [6, 7] }]);
  });

  test('nothing to fold: every row stands alone', () => {
    expect(toolRuns(3, () => true)).toEqual([{ row: 0 }, { row: 1 }, { row: 2 }]);
    expect(toolRuns(1, () => false)).toEqual([{ row: 0 }]);
    expect(toolRuns(0, () => false)).toEqual([]);
  });
});

describe('runSummary', () => {
  test('names each kind in the order it first ran, singular and plural right', () => {
    const tools = [
      tool('Bash', 'git status'), tool('Read', 'a.ts'), tool('Bash', 'bun test'), tool('Edit', 'a.ts'),
      tool('Grep', 'TODO'), tool('Read', 'b.ts'), tool('WebFetch', 'https://x'), tool('Bash', 'ls'), tool('Glob', '*.ts'),
    ];
    expect(runSummary(tools)).toEqual({ text: 'Ran 3 shell commands, read 2 files, edited 1 file, searched 2 patterns, fetched 1 page', failed: 0 });
  });

  test('file kinds count distinct paths; a Write says wrote', () => {
    expect(runSummary([tool('Read', 'a.ts'), tool('Read', 'a.ts'), tool('Write', 'b.ts')]).text).toBe('Read 1 file, wrote 1 file');
  });

  test('unknown tools fall back to "Used N tools", or "used N other tools" after known ones', () => {
    expect(runSummary([tool('TodoWrite'), tool('mcp__plane__list')]).text).toBe('Used 2 tools');
    expect(runSummary([tool('bash', 'ls'), tool('TodoWrite')]).text).toBe('Ran 1 shell command, used 1 other tool');
    expect(runSummary([tool('web_search', 'x', { via: 'z.ai' }), tool('read', 'a.ts')]).text).toBe('Read 1 file, used 1 other tool'); // a z.ai row is never a known kind
  });

  test('counts the failed calls', () => {
    expect(runSummary([tool('Bash', 'a', { isError: true }), tool('Bash', 'b'), tool('Read', 'c', { isError: true })]).failed).toBe(2);
  });

  test("Codex and pi names read as the same kinds", () => {
    expect(runSummary([tool('exec_command', 'ls'), tool('shell', 'pwd'), tool('read', 'x'), tool('edit', 'x'), tool('find', '*.md')]).text)
      .toBe('Ran 2 shell commands, read 1 file, edited 1 file, searched 1 pattern');
  });
});
