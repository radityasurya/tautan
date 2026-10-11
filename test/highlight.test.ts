import { describe, expect, test } from 'bun:test';
import { codeLang } from '../web/markdown.tsx';
import { highlight, load, type Lang } from '../web/highlight.ts';

/** The coloured runs only, as `text:class`, with the shared `text-code-` prefix dropped. */
const coloured = (lang: Lang, src: string) =>
  highlight(lang, src)!.filter(([, cls]) => cls).map(([s, cls]) => `${s.trim()}:${cls.replace(/^text-(code-)?/, '')}`);

describe('fence labels', () => {
  test('the ten languages and their usual aliases, in any case', () => {
    const cases: [string, Lang][] = [
      ['js', 'js'], ['javascript', 'js'], ['mjs', 'js'], ['jsx', 'jsx'], ['ts', 'ts'], ['TypeScript', 'ts'],
      ['tsx', 'tsx'], ['json', 'json'], ['css', 'css'], ['html', 'html'], ['md', 'md'], ['markdown', 'md'],
      ['py', 'py'], ['Python', 'py'], ['yaml', 'yaml'], ['yml', 'yaml'],
    ];
    for (const [label, lang] of cases) expect([label, codeLang(label, 'x')]).toEqual([label, lang]);
  });

  test('no label, another label or a prototype key stays plain', () => {
    for (const label of ['', 'rust', 'sh', 'scss', 'constructor', '__proto__', 'toString']) expect(codeLang(label, 'x')).toBeUndefined();
  });

  test('a block over 100,000 characters stays plain', () => {
    expect(codeLang('ts', 'x'.repeat(100_000))).toBe('ts');
    expect(codeLang('ts', 'x'.repeat(100_001))).toBeUndefined();
  });
});

describe('highlight', () => {
  test('nothing until the language is loaded', () => {
    expect(highlight('yaml', 'a: 1')).toBeUndefined();
  });

  test('each language reaches its own parser', async () => {
    const expected: [Lang, string, string[]][] = [
      ['ts', 'const n: number = 1; // c', ['const:keyword', 'number:type', '1:number', '// c:muted']],
      ['js', 'let s = "a"; f(null)', ['let:keyword', '"a":string', 'f:function', 'null:number']],
      ['jsx', '<div className="x" />', ['div:type', 'className:function', '"x":string']],
      ['tsx', 'let a: T = <b />', ['let:keyword', 'T:type', 'b:type']],
      ['json', '{"a": 1, "b": "s"}', ['"a":function', '1:number', '"b":function', '"s":string']],
      ['css', '.a { color: #fff }', ['a:type', 'color:function', '#fff:number']],
      ['html', '<a href="x">t</a><!-- c -->', ['a:type', 'href:function', '"x":string', 'a:type', '<!-- c -->:muted']],
      ['md', '# Title', ['#:muted', 'Title:keyword']],
      ['py', 'def f():\n    return "s"  # c', ['def:keyword', 'f:function', 'return:keyword', '"s":string', '# c:muted']],
      ['yaml', 'key: "s"\n# c', ['key:function', '"s":string', '# c:muted']],
    ];
    for (const [lang, src, tokens] of expected) {
      await load(lang);
      expect([lang, coloured(lang, src)]).toEqual([lang, tokens]);
    }
  });

  test('the runs join back to the source exactly', async () => {
    const sources: [Lang, string][] = [
      ['ts', '\nconst a = `x ${b} \\n`;\n\n/* two\n   lines */\nexport default a;\n'],
      ['py', 'def f(x):\n\treturn "ü — 🙂"\n'],
      ['md', '# T\n\n- [x] done\n\n```ts\nlet a\n```'],
      ['json', '{"broken": [1, 2,'], // half a block still streams in
      ['html', ''],
    ];
    for (const [lang, src] of sources) {
      await load(lang);
      const runs = highlight(lang, src)!;
      expect(runs.map(([s]) => s).join('')).toBe(src);
      expect(runs.every(([s]) => s.length > 0)).toBe(true);
    }
  });
});
