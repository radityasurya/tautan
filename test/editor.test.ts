import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { lineBreakOf, splitBom } from '../web/folders-logic.ts';

/** What the viewer and the editor do with a file: set the BOM aside, split on the file's own
 *  line break, and join back with it on save (web/file.tsx, web/editor.tsx). */
function open(bytes: string) {
  const { bom, text } = splitBom(bytes);
  const state = EditorState.create({ doc: text, extensions: EditorState.lineSeparator.of(lineBreakOf(text)) });
  return { bom, state, save: (s = state) => (bom ? '﻿' : '') + s.sliceDoc() };
}

describe('editor line endings and BOM', () => {
  const cases: [string, string, number][] = [
    ['LF', 'one\ntwo\n\nfour\n', 5],
    ['CRLF', 'one\r\ntwo\r\n\r\nfour\r\n', 5],
    ['lone CR', 'one\rtwo\r\rfour\r', 5],
    ['BOM and CRLF', '﻿# Title\r\nbody\r\n', 3],
    ['BOM only', '﻿', 1],
  ];

  for (const [label, bytes, lines] of cases) {
    test(`${label} round-trips byte for byte`, () => {
      const { state, save } = open(bytes);
      expect(state.doc.lines).toBe(lines); // split on the file's own break, not left as one line
      expect(save()).toBe(bytes);
    });
  }

  test('a new line takes the file’s line break', () => {
    for (const bytes of ['a\r\nb', 'a\nb', 'a\rb']) {
      const { state, save } = open(bytes);
      const next = state.update({ changes: { from: state.doc.length, insert: state.toText(`${state.lineBreak}c`) } }).state;
      expect(save(next)).toBe(`${bytes}${lineBreakOf(bytes)}c`);
    }
  });

  test('a BOM is kept out of the doc and put back on save', () => {
    const { bom, state, save } = open('﻿x\n');
    expect(bom).toBe(true);
    expect(state.doc.toString().startsWith('﻿')).toBe(false);
    expect(save()).toBe('﻿x\n');
  });

  test('a mixed file keeps its stray breaks as they were', () => {
    const bytes = 'a\r\nb\nc\r\n';
    expect(open(bytes).save()).toBe(bytes);
  });
});
