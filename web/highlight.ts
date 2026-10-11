// Syntax colours for fenced code in the Chat view, on the editor's own parsers (Phase 31).
// markdown.tsx loads this module on the first fenced block with a known label, so it is a
// `lazy-*` chunk (vite.config.ts) and stays out of the service worker's precache; each
// language is its own chunk, shared with the editor. The result is data, not markup:
// markdown.tsx renders the runs as spans, never through innerHTML.
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight';
import type { Language } from '@codemirror/language';

export type Lang = 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css' | 'html' | 'md' | 'py' | 'yaml';

const LANGUAGES: Record<Lang, () => Promise<Language>> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascriptLanguage),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.jsxLanguage),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.typescriptLanguage),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.tsxLanguage),
  json: () => import('@codemirror/lang-json').then((m) => m.jsonLanguage),
  css: () => import('@codemirror/lang-css').then((m) => m.cssLanguage),
  html: () => import('@codemirror/lang-html').then((m) => m.htmlLanguage),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdownLanguage),
  py: () => import('@codemirror/lang-python').then((m) => m.pythonLanguage),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yamlLanguage),
};

/** Six colours and no weight or slant, so a block that turns coloured keeps its layout.
 *  A tag also matches its children: keyword holds control and module keywords, typeName holds
 *  HTML tag names, propertyName holds attribute names, string holds attribute values. The
 *  `code-*` colours are in theme.css. Operators, punctuation and plain names stay `fg`. */
const HIGHLIGHTER = tagHighlighter([
  { tag: [t.keyword, t.heading], class: 'text-code-keyword' },
  { tag: [t.string, t.regexp, t.escape, t.monospace], class: 'text-code-string' },
  { tag: [t.number, t.bool, t.null, t.atom, t.color, t.unit], class: 'text-code-number' },
  { tag: [t.comment, t.processingInstruction], class: 'text-muted' },
  { tag: [t.typeName, t.className, t.namespace], class: 'text-code-type' },
  { tag: [t.function(t.variableName), t.propertyName, t.link, t.url], class: 'text-code-function' },
]);

const loaded = new Map<Lang, Language>();

/** Fetches a language's parser. Rejects when its chunk cannot load, offline for one. */
export async function load(lang: Lang): Promise<void> {
  if (!loaded.has(lang)) loaded.set(lang, await LANGUAGES[lang]());
}

/** Source text and the class that colours it, '' for plain. */
export type Run = [text: string, cls: string];

/** The runs for `text`, or undefined until `load(lang)` has finished. Joined, the runs are
 *  `text` exactly. Neighbours with one class merge, and a line break joins the run before it.
 *  Where styles nest (a Markdown link holds its brackets) the innermost class, the last, wins. */
export function highlight(lang: Lang, text: string): Run[] | undefined {
  const language = loaded.get(lang);
  if (!language) return undefined;
  const runs: Run[] = [];
  const put = (s: string, classes: string) => {
    const cls = classes.slice(classes.lastIndexOf(' ') + 1);
    const last = runs.at(-1);
    if (last && (last[1] === cls || s === '\n')) last[0] += s;
    else runs.push([s, cls]);
  };
  highlightCode(text, language.parser.parse(text), HIGHLIGHTER, put, () => put('\n', ''));
  return runs;
}
