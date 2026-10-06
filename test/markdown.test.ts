import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../web/markdown.tsx';

/** Rendered HTML with class and style attributes dropped, so tests read the structure. */
const md = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text }))
    .replace(/ (class|style)="[^"]*"/g, '')
    .replace(/^<div>|<\/div>$/g, '');

describe('blocks', () => {
  test('headings', () => {
    expect(md('# One\n## Two\n### Three\n#### Four')).toBe('<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4>');
    expect(md('#hashtag')).toBe('<p>#hashtag</p>');
  });

  test('paragraphs split on blank lines; single newlines are breaks', () => {
    expect(md('one\ntwo\n\nthree')).toBe('<p>one<br/>two</p><p>three</p>');
  });

  test('unordered and ordered lists, nested by indent', () => {
    expect(md('- a\n- b\n  - b1\n  - b2\n- c')).toBe('<ul><li>a</li><li><p>b</p><ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>');
    expect(md('* x\n* y')).toBe('<ul><li>x</li><li>y</li></ul>');
    expect(md('1. one\n2. two\n   - sub')).toBe('<ol><li>one</li><li><p>two</p><ul><li>sub</li></ul></li></ol>');
    expect(md('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  test('a list ends a paragraph and a paragraph after a blank line ends the list', () => {
    expect(md('Steps:\n- a\n- b\n\nDone.')).toBe('<p>Steps:</p><ul><li>a</li><li>b</li></ul><p>Done.</p>');
  });

  test('blockquote', () => {
    expect(md('> quoted **bold**\n> more')).toBe('<blockquote><p>quoted <strong>bold</strong><br/>more</p></blockquote>');
  });

  test('fenced code keeps its text literal, with a language label', () => {
    const out = md('```ts\nconst a = **b**;\n<script>alert(1)</script>\n```');
    expect(out).toContain('<div>ts</div>');
    expect(out).toContain('<pre><code>const a = **b**;\n&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
    expect(out).not.toContain('<strong>');
    expect(out).not.toContain('<script>');
  });

  test('an unclosed fence runs to the end', () => {
    expect(md('```\nopen')).toContain('<code>open</code>');
  });

  test('horizontal rule', () => {
    expect(md('a\n\n---\n\nb')).toBe('<p>a</p><hr/><p>b</p>');
  });

  test('GFM pipe table with alignment and inline content', () => {
    const out = md('| Name | Size |\n|:-----|-----:|\n| `a.ts` | 12 |\n| b | 3 |');
    expect(out).toBe(
      '<div><table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody>'
      + '<tr><td><code>a.ts</code></td><td>12</td></tr><tr><td>b</td><td>3</td></tr></tbody></table></div>',
    );
    expect(renderToStaticMarkup(createElement(Markdown, { text: '| a | b |\n|---|--:|\n| 1 | 2 |' }))).toContain('text-align:right');
  });
});

describe('inline', () => {
  test('bold, italic, strike, code', () => {
    expect(md('**b** *i* _i2_ ~~s~~ `c`')).toBe('<p><strong>b</strong> <em>i</em> <em>i2</em> <s>s</s> <code>c</code></p>');
    expect(md('***both***')).toBe('<p><strong><em>both</em></strong></p>');
  });

  test('nested emphasis and code inside bold', () => {
    expect(md('**run `pnpm test` *now***')).toBe('<p><strong>run <code>pnpm test</code> <em>now</em></strong></p>');
  });

  test('snake_case and arithmetic stay text', () => {
    expect(md('a snake_case_name and 2 * 3 * 4')).toBe('<p>a snake_case_name and 2 * 3 * 4</p>');
  });

  test('code span keeps markdown and HTML literal', () => {
    expect(md('`**x** <b>`')).toBe('<p><code>**x** &lt;b&gt;</code></p>');
  });

  test('safe links open in a new tab', () => {
    expect(md('[docs](https://example.com/a?b=1) and [mail](mailto:a@b.c)')).toBe(
      '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">docs</a> and '
      + '<a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">mail</a></p>',
    );
  });

  test('a javascript: link stays text', () => {
    const out = md('[click](javascript:alert(1)) [x](data:text/html,hi)');
    expect(out).not.toContain('<a');
    expect(out).toContain('[click](javascript:alert(1))');
  });

  test('bare URLs link, trailing punctuation stays outside', () => {
    expect(md('See https://example.com/x.')).toBe(
      '<p>See <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.</p>',
    );
  });

  test('raw HTML renders as text', () => {
    expect(md('<img src=x onerror=alert(1)> <b>hi</b>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &lt;b&gt;hi&lt;/b&gt;</p>');
  });

  test('backslash escapes', () => {
    expect(md('\\*not italic\\*')).toBe('<p>*not italic*</p>');
  });
});
