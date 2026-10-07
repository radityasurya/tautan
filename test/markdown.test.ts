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
    expect(out).toContain('<span>ts</span>');
    expect(out).toContain('<pre><code>const a = **b**;\n&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
    expect(out).not.toContain('<strong>');
    expect(out).not.toContain('<script>');
  });

  test('a line of spaces is a blank line', () => {
    expect(md('one\n      \ntwo')).toBe('<p>one</p><p>two</p>');
    expect(md('- a\n   \n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(md('| a |\n|---|\n| 1 |\n    \nafter')).toContain('</table></div><p>after</p>');
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

  test('an https image renders as an <img> inside a button, title dropped', () => {
    const out = md('Before ![the chart](https://example.com/c.png "Chart") after');
    expect(out).toContain('<img referrerPolicy="no-referrer" loading="lazy" decoding="async" src="https://example.com/c.png" alt="the chart"/>');
    expect(out).toContain('<button type="button" aria-label="Open the chart" aria-haspopup="dialog">');
    expect(out.startsWith('<p>Before <button')).toBe(true);
  });

  test('an image with an unsafe or non-https URL stays text', () => {
    for (const src of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/api/panes/x/file?path=a.png', 'file:///etc/passwd']) {
      const out = md(`![x](${src})`);
      expect(out).not.toContain('<img');
      expect(out).toContain('![x](');
    }
  });

  test('an image with empty alt text is labelled Image', () => {
    expect(md('![](https://example.com/a.png)')).toContain('alt="Image"');
  });
});

describe('reference links', () => {
  test('full, collapsed and shortcut references link; definitions do not render', () => {
    const out = md('Read [the docs][a], [site][] and [b].\n\n[a]: https://example.com/one\n[b]: mailto:x@y.z "Mail"\n[site]: https://example.com');
    expect(out).toBe(
      '<p>Read <a href="https://example.com/one" target="_blank" rel="noopener noreferrer">the docs</a>, '
      + '<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a> and '
      + '<a href="mailto:x@y.z" target="_blank" rel="noopener noreferrer">b</a>.</p>',
    );
  });

  test('labels ignore case; a definition inside a fence is text, not a definition', () => {
    const out = md('[link][A]\n\n```\n[c]: https://nope\n```\n\n[A]: https://example.com/x');
    expect(out).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">link</a>');
    expect(out).toContain('<code>[c]: https://nope</code>');
  });

  test('an unresolved or unsafe reference stays text', () => {
    expect(md('[nope][x] [q][] [r]\n\n[r]: javascript:alert(1)')).toBe('<p>[nope][x] [q][] [r]</p>');
    // A bracketed span with no definition keeps rendering as before references existed.
    expect(md('a [b *c*] d')).toBe('<p>a [b <em>c</em>] d</p>');
  });

  test('a fence opened behind a list marker keeps its content', () => {
    expect(md('- ```\n  [a]: https://x\n  ```')).toContain('<code>[a]: https://x</code>');
  });

  test('prototype labels define and resolve like any other', () => {
    const out = md('See [a][constructor] and [b][__proto__].\n\n[constructor]: https://example.com/c\n[__proto__]: https://example.com/p');
    expect(out).toContain('<a href="https://example.com/c"');
    expect(out).toContain('<a href="https://example.com/p"');
  });

  test('an image reference stays literal, not ! plus a link', () => {
    const out = md('![alt][id]\n\n[id]: https://example.com/i.png');
    expect(out).toBe('<p>![alt][id]</p>');
  });
});

describe('task lists', () => {
  test('a marker renders a disabled checkbox, checked for x or X', () => {
    const out = md('- [ ] plain\n- [x] done\n- [X] upper\n- normal');
    expect(out).toBe(
      '<ul>'
      + '<li><input type="checkbox" disabled=""/>plain</li>'
      + '<li><input type="checkbox" disabled="" checked=""/>done</li>'
      + '<li><input type="checkbox" disabled="" checked=""/>upper</li>'
      + '<li>normal</li>'
      + '</ul>',
    );
  });

  test('ordered task items render the same checkbox', () => {
    expect(md('1. [x] tracked\n2. [ ] later')).toBe(
      '<ol><li><input type="checkbox" disabled="" checked=""/>tracked</li>'
      + '<li><input type="checkbox" disabled=""/>later</li></ol>',
    );
  });

  test('a marker without the trailing space stays text', () => {
    expect(md('- [x]tight')).toBe('<ul><li>[x]tight</li></ul>');
  });

  test('a bare marker with no content still renders the box', () => {
    expect(md('- [x]')).toBe('<ul><li><input type="checkbox" disabled="" checked=""/></li></ul>');
    expect(md('- [ ]')).toBe('<ul><li><input type="checkbox" disabled=""/></li></ul>');
  });

  test('only unordered task items drop their bullet', () => {
    expect(renderToStaticMarkup(createElement(Markdown, { text: '1. [x] a' }))).not.toContain('list-none');
    expect(renderToStaticMarkup(createElement(Markdown, { text: '- [x] a' }))).toContain('list-none');
  });
});

describe('images in table cells', () => {
  test('a cell image renders through the same safe path as prose', () => {
    const out = md('| Shot |\n|---|\n| ![the chart](https://example.com/c.png) |');
    expect(out).toContain('<td><button type="button" aria-label="Open the chart" aria-haspopup="dialog">');
    expect(out).toContain('src="https://example.com/c.png"');
  });

  test('an unsafe image URL in a cell stays text', () => {
    for (const src of ['http://example.com/a.png', 'javascript:alert(1)']) {
      const out = md(`| a |\n|---|\n| ![x](${src}) |`);
      expect(out).not.toContain('<img');
      expect(out).toContain('![x](');
    }
  });
});
