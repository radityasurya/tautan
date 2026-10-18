import { expect, test } from 'bun:test';
import { paneKind, running, statusWord } from '../web/pane-label.ts';

test('a shell Pane says what it runs instead of unknown · shell', () => {
  expect(paneKind({ command: 'make' })).toBe('make');
  expect(statusWord({ command: 'make', status: 'unknown' })).toBe('running');
  // At the prompt: just shell, and no Status word.
  expect(paneKind({ command: 'zsh' })).toBe('shell');
  expect(paneKind({ command: '-bash' })).toBe('shell');
  expect(statusWord({ command: 'zsh', status: 'unknown' })).toBeUndefined();
  expect(paneKind({})).toBe('shell');
  // An Agent Pane keeps its Agent and its herdr Status.
  expect(paneKind({ agent: 'claude', command: 'claude' })).toBe('claude');
  expect(running({ agent: 'claude', command: 'node' })).toBeUndefined();
  expect(statusWord({ agent: 'claude', status: 'blocked' })).toBe('needs you');
  expect(statusWord({ agent: 'claude', status: 'idle' })).toBe('idle');
});
