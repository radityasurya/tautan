import { expect, test } from 'bun:test';
import { toolLabel } from '../shared/tool-label.ts';

test('Codex tool names read as plain words; other agents keep theirs', () => {
  expect(toolLabel('exec', 'codex')).toBe('shell');
  expect(toolLabel('tool_search_call', 'codex')).toBe('tool search');
  expect(toolLabel('foo_bar', 'codex')).toBe('foo bar');
  expect(toolLabel('Bash', 'claude')).toBe('Bash');
  expect(toolLabel('exec')).toBe('exec');
});
