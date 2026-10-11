import { afterEach, describe, expect, test } from 'bun:test';
import { copyText } from '../web/markdown.tsx';

// copyText (21.4.5): the Clipboard API first; a hidden textarea and execCommand('copy') when
// the API is missing (plain http) or refuses; false only when both fail. The textarea goes in
// an open modal dialog when there is one, because the page around it is inert.
const g = globalThis as { document?: unknown };
const nav = navigator as { clipboard?: unknown };

/** The DOM copyText touches, and a log of what it did. `inert`: the textarea cannot take focus. */
function fakeDocument(exec: () => boolean, { dialog = false, inert = false } = {}) {
  const log: string[] = [];
  const doc: Record<string, unknown> = {};
  const box = {
    value: '',
    style: { cssText: '' },
    setAttribute: () => {},
    focus: () => {
      if (!inert) doc.activeElement = box;
    },
    select: () => {},
    setSelectionRange: () => {},
    remove: () => log.push('removed'),
  };
  Object.assign(doc, {
    activeElement: { focus: () => log.push('focus back') },
    createElement: () => box,
    body: { append: () => log.push('appended') },
    querySelectorAll: () => (dialog ? [{ append: () => log.push('appended to the dialog') }] : []),
    execCommand: (cmd: string) => {
      log.push(`${cmd} ${box.value}`);
      return exec();
    },
  });
  g.document = doc;
  return log;
}

afterEach(() => {
  delete g.document;
  delete nav.clipboard;
});

describe('copyText', () => {
  test('the Clipboard API copies, and execCommand is never asked', async () => {
    const wrote: string[] = [];
    nav.clipboard = { writeText: async (t: string) => void wrote.push(t) };
    const log = fakeDocument(() => true);
    expect(await copyText('hi')).toBe(true);
    expect(wrote).toEqual(['hi']);
    expect(log).toEqual([]);
  });

  test('no Clipboard API (plain http): execCommand copies from a textarea that is removed after', async () => {
    const log = fakeDocument(() => true);
    expect(await copyText('ls -la')).toBe(true);
    expect(log).toEqual(['appended', 'copy ls -la', 'removed', 'focus back']);
  });

  test('the Clipboard API refuses: execCommand still copies', async () => {
    nav.clipboard = { writeText: () => Promise.reject(new Error('NotAllowedError')) };
    const log = fakeDocument(() => true);
    expect(await copyText('x')).toBe(true);
    expect(log).toContain('copy x');
  });

  test('both fail: false, and the textarea is still removed', async () => {
    const log = fakeDocument(() => false);
    expect(await copyText('x')).toBe(false);
    expect(log).toContain('removed');
  });

  test('an open modal dialog holds the textarea, not the inert page behind it', async () => {
    const log = fakeDocument(() => true, { dialog: true });
    expect(await copyText('p')).toBe(true);
    expect(log).toEqual(['appended to the dialog', 'copy p', 'removed', 'focus back']);
  });

  test('a textarea that cannot take focus: false, and execCommand is never asked', async () => {
    const log = fakeDocument(() => true, { inert: true });
    expect(await copyText('x')).toBe(false);
    expect(log).toEqual(['appended', 'removed', 'focus back']);
  });

  test('execCommand throws: false, not an error', async () => {
    const log = fakeDocument(() => {
      throw new Error('gone');
    });
    expect(await copyText('x')).toBe(false);
    expect(log).toContain('removed');
  });
});
