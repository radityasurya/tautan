// Markdown for Chat turns, rendered as React elements: the transcript is untrusted Agent
// output, so nothing here builds HTML from a string and raw HTML stays text.
// ponytail: a line-based subset of CommonMark + GFM — ATX headings, paragraphs, lists nested
// by indent, blockquotes, fences, rules, pipe tables, task lists; inline code, bold, italic,
// strike, links (inline, bare URL, reference-style), images (https only; anything else stays
// literal text, see web/image.tsx). Reference definitions are message-global and the first one wins; an
// unresolved reference renders its span literally, markup inside included; a shortcut
// reference only matches a label without emphasis characters. No setext headings, footnotes,
// HTML, linked images, or image references. Add a real parser (micromark) when a transcript
// needs one of those.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Picture, safeImage } from './image.tsx';
import type { Lang } from './highlight.ts';

type Align = 'left' | 'center' | 'right' | undefined;
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; align: Align[]; head: string[]; rows: string[][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// A rule is three or more of one marker, spaced or not. The run is matched flat and
// validated in a loop: the old single regex, (^ {0,3}([-*_])(?:\s*\1){2,}\s*$), backtracked
// through the nested \s* on long marker runs, and 1 MB of '_' cost half a second.
const RULE_RUN = /^ {0,3}([-*_\s]+)$/;
const isRule = (line: string) => {
  const run = line.match(RULE_RUN)?.[1];
  if (run === undefined) return false;
  let n = 0;
  for (let i = 0; i < run.length; i++) {
    const ch = run[i]!;
    if (ch === ' ' || ch === '\t') continue;
    if (ch !== run[0]) return false;
    n++;
  }
  return n >= 3;
};

const indent = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, '    ').length;
const isTable = (lines: string[], i: number) => lines[i]!.includes('|') && DELIM.test(lines[i + 1] ?? '') && lines[i + 1]!.includes('-');
const starts = (lines: string[], i: number) =>
  FENCE.test(lines[i]!) || HEADING.test(lines[i]!) || isRule(lines[i]!) || QUOTE.test(lines[i]!) || ITEM.test(lines[i]!) || isTable(lines, i);

// The regex that closes a fence opened by an opening-line match.
const closer = (open: RegExpMatchArray) => new RegExp(`^ {0,3}${open[1]![0]}{${open[1]!.length},}\\s*$`);

const DEF = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(\S+)(?:[ \t]+"[^"]*")?[ \t]*$/;

/** Pull link reference definitions out of parsed paragraphs: the line leaves the paragraph
 *  and splits it, as a blank line would, and a definition anywhere is visible everywhere in
 *  the message. Walking the parsed tree leaves fenced code intact by construction, so a
 *  fence behind a list marker or indented keeps its content. Labels fold to trimmed
 *  lowercase; the first definition of a label wins, and the map has no prototype, so
 *  `constructor` and `__proto__` stay ordinary labels. */
function extractDefs(blocks: Block[], refs: Record<string, string>): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.kind === 'para') {
      let text: string[] = [];
      for (const line of block.text.split('\n')) {
        const d = line.match(DEF);
        if (!d) text.push(line);
        else {
          const label = d[1]!.trim().toLowerCase();
          if (!Object.hasOwn(refs, label)) refs[label] = d[2]!.replace(/^<|>$/g, '');
          if (text.length) out.push({ kind: 'para', text: text.join('\n') });
          text = [];
        }
      }
      if (text.length) out.push({ kind: 'para', text: text.join('\n') });
    } else if (block.kind === 'quote') out.push({ ...block, blocks: extractDefs(block.blocks, refs) });
    else if (block.kind === 'list') out.push({ ...block, items: block.items.map((item) => extractDefs(item, refs)) });
    else out.push(block);
  }
  return out;
}

function cells(line: string): string[] {
  const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// ponytail: block nesting caps at 50 levels. A bare list marker's content is the rest of
// its line, so a line of N '+' nests N deep and overflows the stack at some length. Raise
// the cap, or make the block walk iterative, if real transcripts ever nest deeper.
const MAX_DEPTH = 50;

export function parseBlocks(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      const close = closer(m);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++; // an unclosed fence runs to the end, as in CommonMark
      blocks.push({ kind: 'code', lang: m[2] ?? '', text: body.join('\n') });
    } else if ((m = line.match(HEADING))) {
      blocks.push({ kind: 'heading', level: m[1]!.length, text: m[2] ?? '' });
      i++;
    } else if (isRule(line)) {
      blocks.push({ kind: 'rule' });
      i++;
    } else if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(lines[i]!.replace(QUOTE, ''));
      blocks.push({ kind: 'quote', blocks: parseBlocks(body.join('\n'), depth + 1) });
    } else if ((m = line.match(ITEM)) && depth < MAX_DEPTH) {
      const base = indent(m[1]!);
      const ordered = /\d/.test(m[2]!);
      const items: string[][] = [];
      let col = 0; // the current item's content column
      while (i < lines.length) {
        const l = lines[i]!;
        const item = l.match(ITEM);
        if (item && indent(item[1]!) <= base) {
          if (/\d/.test(item[2]!) !== ordered) break;
          items.push([l.slice(item[0].length)]);
          col = indent(item[1]!) + item[2]!.length + Math.max(1, item[3]!.length);
          i++;
        } else if (l.trim() && indent(l) > base) {
          items.at(-1)!.push(l.slice(Math.min(indent(l), col)));
          i++;
        } else if (!l.trim() && i + 1 < lines.length && (indent(lines[i + 1]!) > base || lines[i + 1]!.match(ITEM)) && lines[i + 1]!.trim()) {
          items.at(-1)!.push('');
          i++;
        } else break;
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? parseInt(m[2]!, 10) : 1, items: items.map((item) => parseBlocks(item.join('\n'), depth + 1)) });
    } else if (isTable(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((d): Align => d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : undefined);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      blocks.push({ kind: 'table', align, head, rows });
    } else {
      const body = [line.trim()];
      for (i++; i < lines.length && lines[i]!.trim() && !starts(lines, i); i++) body.push(lines[i]!.trim());
      blocks.push({ kind: 'para', text: body.join('\n') });
    }
  }
  return blocks;
}

// One pass, leftmost match wins; at the same spot the earlier alternative wins. It is
// sticky (y) and only ever applied at a TRIGGER position found by the scan in inline().
const INLINE = new RegExp([
  /\\([\\`*_{}[\]()#+\-.!~|<>])/.source, // 1 escape
  /(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)/.source, // 2,3 code
  /\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.source, // 4,5 link
  /(https?:\/\/[^\s<>]*[^\s<>.,:;"'!?)\]])/.source, // 6 bare URL
  /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/.source, // 7 bold italic
  /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/.source, // 8 bold
  /(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/.source, // 9 bold
  /~~(?=\S)([\s\S]*?\S)~~/.source, // 10 strike
  /\*(?=[^\s*])([^*]*?[^\s*])\*/.source, // 11 italic
  /(?<!\w)_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/.source, // 12 italic
  /!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.source, // 13,14 image; it starts left of its link, so it wins
  /\[([^\]\n]+)\]\[([^\]\n]*)\]/.source, // 15,16 reference link [text][id]; an empty id reuses the text
  // 17 shortcut [id]; emphasis characters stay out so a plain bracketed span without a
  // definition keeps rendering exactly as it did before references existed
  /\[([^\]\n*_~`\\[\]]+)\]/.source,
  // 18 an image reference stays literal; it swallows the whole span so the reference inside
  // never half-parses into ! plus a link
  /(!\[[^\]\n]*\]\[[^\]\n]*\])/.source,
].join('|'), 'y');

// Every INLINE alternative starts with one of these, so inline() only tries a match where
// one can begin. A plain matchAll instead retries the whole alternation at every index,
// and from every '[' the bracket alternatives rescan to end of line hunting a ']' —
// 1 MB of '[' or '(' turned that into minutes.
const TRIGGER = /[\\`[!*~_]|https?:\/\//g;
// The trigger set minus brackets, for once no ']' remains ahead: brackets can never close
// again, so the scan can skip their positions wholesale.
const TRIGGER_LIVE = /[\\`*_~]|https?:\/\//g;

// ponytail: one inline() call renders at most 1,000 spans; the rest of its text stays
// plain. Element creation is O(spans), so unbounded spans are an unbounded parse — 1 MB
// of '_*[' holds 200,000 legitimate emphases and rendered for seconds, and even a plain
// paragraph never comes near a thousand. Raise the cap when a real transcript needs more.
const MAX_SPANS = 1_000;

const SAFE_URL = /^(https?:|mailto:)/i;
const LINK = 'text-accent underline decoration-accent/40 underline-offset-2 [overflow-wrap:anywhere]';

function link(href: string, children: ReactNode, key: number) {
  return <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={LINK}>{children}</a>;
}

export function inline(text: string, refs?: Record<string, string>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const push = (s: string) => {
    // Single newlines inside a paragraph are line breaks.
    s.split('\n').forEach((part, n) => { if (n) out.push(<br key={`br${out.length}`} />); if (part) out.push(part); });
  };
  const ref = (label: string) => refs?.[label.trim().toLowerCase()];
  // Forward-lookahead caches: the scan only moves forward, so a hit holds until the index
  // passes it, and a miss (-1) holds for the rest of the string.
  let close = -2, eol = -2;
  const nextClose = (p: number) => (close === -1 || close < p ? (close = text.indexOf(']', p)) : close);
  const nextEol = (p: number) => (eol === -1 || eol < p ? (eol = text.indexOf('\n', p)) : eol);
  let spans = 0;
  TRIGGER.lastIndex = 0;
  const SPACE = /\s/, WORD = /\w/;
  for (let t: RegExpExecArray | null; (t = TRIGGER.exec(text)); ) {
    const p = t.index;
    // Certain-fail fast path for the emphasis openers: '_' cannot open when a word char
    // precedes it or a space (or nothing) follows; '*' and '~' cannot open before a space.
    // Checking the edges in JS skips the interpreted regex — a formula with 10,000
    // subscripts paid ~1 µs per '_'.
    const ch = text[p]!, nx = text[p + 1];
    if (ch === '_' && nx !== '_' && ((nx === undefined || SPACE.test(nx)) || (p > 0 && WORD.test(text[p - 1]!)))) continue;
    if ((ch === '*' || ch === '~') && (nx === undefined || SPACE.test(nx))) continue;
    if (text[p] === '[' || (text[p] === '!' && text[p + 1] === '[')) {
      // Every bracket alternative needs a ']' on this line, so without one ahead nothing
      // starting at this '[' can match — do not let the regex rescan the line for it.
      const c = nextClose(p);
      if (c === -1) {
        TRIGGER_LIVE.lastIndex = p;
        const live = TRIGGER_LIVE.exec(text);
        TRIGGER.lastIndex = live ? live.index : text.length;
        continue;
      }
      const nl = nextEol(p);
      if (nl !== -1 && c > nl) continue;
    }
    INLINE.lastIndex = p;
    const m = INLINE.exec(text);
    if (!m) continue;
    push(text.slice(last, p));
    last = p + m[0].length;
    const k = out.length;
    if (m[1] !== undefined) push(m[1]);
    else if (m[3] !== undefined) out.push(<code key={k} className="rounded-chip bg-bg px-1 py-px font-mono text-[0.86em] [overflow-wrap:anywhere]">{m[3].replace(/\n/g, ' ')}</code>);
    else if (m[4] !== undefined) out.push(SAFE_URL.test(m[5]!) ? link(m[5]!, inline(m[4], refs), k) : m[0]);
    else if (m[6] !== undefined) out.push(link(m[6], m[6], k));
    else if (m[7] !== undefined) out.push(<strong key={k} className="font-semibold"><em>{inline(m[7], refs)}</em></strong>);
    else if (m[8] !== undefined || m[9] !== undefined) out.push(<strong key={k} className="font-semibold">{inline((m[8] ?? m[9])!, refs)}</strong>);
    else if (m[10] !== undefined) out.push(<s key={k}>{inline(m[10], refs)}</s>);
    else if (m[14] !== undefined) {
      const src = /^https:/i.test(m[14]) ? safeImage(m[14]) : undefined;
      out.push(src ? <Picture key={k} src={src} alt={m[13]!.trim() || 'Image'} /> : m[0]);
    }
    else if (m[15] !== undefined) {
      const href = ref(m[16]! || m[15]!);
      out.push(href && SAFE_URL.test(href) ? link(href, inline(m[15]!, refs), k) : m[0]);
    }
    else if (m[17] !== undefined) {
      const href = ref(m[17]!);
      out.push(href && SAFE_URL.test(href) ? link(href, inline(m[17]!, refs), k) : m[0]);
    }
    else if (m[18] !== undefined) push(m[18]!);
    else out.push(<em key={k}>{inline((m[11] ?? m[12])!, refs)}</em>);
    TRIGGER.lastIndex = last; // the dispatch recursed into inline() and moved it
    if (++spans >= MAX_SPANS) break; // the ceiling above: the tail stays plain text
  }
  push(text.slice(last));
  return out;
}

/**
 * Copies `text`; false when nothing was copied. The Clipboard API needs a secure context, so
 * over plain http on a LAN address it is missing, and a hidden textarea with
 * `execCommand('copy')` (deprecated, still in every browser) does it instead. With no
 * Clipboard API the fallback runs in the same task as the tap, which it needs. An open modal
 * <dialog> (Find in terminal) makes the rest of the page inert, so the textarea goes inside
 * it; a textarea that cannot take focus copies nothing, and says so.
 * Every copy in web/ goes through here.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', ''); // no keyboard on a phone
    // 16 px so iOS does not zoom; fixed and off to the left so nothing scrolls.
    box.style.cssText = 'position:fixed;top:0;left:-9999px;font-size:16px';
    const was = document.activeElement as HTMLElement | null;
    ([...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body).append(box);
    box.focus({ preventScroll: true });
    box.select();
    box.setSelectionRange(0, text.length); // iOS ignores select() alone
    let ok = false;
    try {
      // Unfocused, execCommand would copy whatever else is selected and still answer true.
      ok = document.activeElement === box && document.execCommand('copy');
    } catch {
      // a browser that dropped execCommand throws: nothing was copied
    }
    box.remove();
    was?.focus?.({ preventScroll: true });
    return ok;
  }
}

/** Over plain http with no Clipboard API, execCommand still copies; only both missing leaves Copy out. */
const canCopy = () =>
  typeof document !== 'undefined' && (Boolean(navigator.clipboard?.writeText) || document.queryCommandSupported?.('copy') === true);

export function CopyButton({ text, className, label }: { text: string; className: string; /** names what it copies, where several sit together */ label?: string }) {
  const [done, setDone] = useState<'Copied' | 'Not copied' | null>(null);
  if (!canCopy()) return null;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void copyText(text).then((ok) => {
          setDone(ok ? 'Copied' : 'Not copied');
          setTimeout(() => setDone(null), 1500);
        });
      }}
      className={className}
    >
      <span aria-live="polite" className={done === 'Not copied' ? 'text-danger' : undefined}>
        {done ?? 'Copy'}
      </span>
    </button>
  );
}

// ---- fenced code colours ----
// The highlighter is a `lazy-*` chunk (web/highlight.ts), fetched on the first fenced block
// with a known label. It runs per rendered block, after the parse, never inside it.

const LANGS: Record<string, Lang> = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  ts: 'ts', typescript: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  json: 'json', jsonc: 'json', css: 'css', html: 'html', htm: 'html',
  md: 'md', markdown: 'md', py: 'py', python: 'py', yaml: 'yaml', yml: 'yaml',
};

// ponytail: 100,000 characters, about 100 KB of code. Parsing and spans grow with it; a
// bigger block stays plain. Raise it if long blocks come back plain on a phone that copes.
const MAX_HIGHLIGHT = 100_000;

/** The highlighter's language for a fence label. Unknown labels and blocks over the cap get
 *  undefined, and render plain. */
export function codeLang(label: string, text: string): Lang | undefined {
  const key = label.toLowerCase();
  return text.length <= MAX_HIGHLIGHT && Object.hasOwn(LANGS, key) ? LANGS[key] : undefined;
}

let highlighter: typeof import('./highlight.ts') | undefined;

/** A block's text: plain until the highlighter and its language are in, then the same text
 *  in coloured spans. Colour only, so nothing moves. Offline the lazy chunk is not cached
 *  and the block stays plain. */
function CodeText({ lang, text }: { lang: string; text: string }) {
  const known = codeLang(lang, text);
  const [loads, setLoads] = useState(0);
  // `loads` re-runs this once the chunk arrives: the highlighter is module state, not React's.
  const runs = useMemo(() => (known ? highlighter?.highlight(known, text) : undefined), [known, text, loads]);
  const waiting = runs ? undefined : known;
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    import('./highlight.ts')
      .then((m) => {
        highlighter = m;
        return m.load(waiting);
      })
      .then(() => live && setLoads((n) => n + 1), () => {});
    return () => { live = false; };
  }, [waiting]);
  return <code>{runs ? runs.map(([s, cls], n) => (cls ? <span key={n} className={cls}>{s}</span> : s)) : text}</code>;
}

const HEADING_CLASS = ['', 'text-title', 'text-title', 'text-body font-semibold', 'text-body font-semibold', 'text-body font-semibold text-muted', 'text-body font-semibold text-muted'];
const CELL = 'border-border px-2 py-1.5 align-top [&+*]:border-l';

function Blocks({ blocks, tight = false, refs }: { blocks: Block[]; tight?: boolean; refs?: Record<string, string> }) {
  // A list item holding one paragraph renders it bare, so the marker sits on its text.
  if (tight && blocks.length === 1 && blocks[0]!.kind === 'para') return <>{inline(blocks[0]!.text, refs)}</>;
  return <>{blocks.map((block, n) => <BlockView key={n} block={block} refs={refs} />)}</>;
}

function BlockView({ block, refs }: { block: Block; refs?: Record<string, string> }) {
  switch (block.kind) {
    case 'heading': {
      const H = `h${block.level}` as 'h1';
      return <H className={`${HEADING_CLASS[block.level]} font-semibold [&:not(:first-child)]:mt-1`}>{inline(block.text, refs)}</H>;
    }
    case 'para': return <p>{inline(block.text, refs)}</p>;
    case 'rule': return <hr className="my-1 border-0 border-t border-border" />;
    case 'quote': return <blockquote className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted"><Blocks blocks={block.blocks} refs={refs} /></blockquote>;
    case 'code': return (
      <div className="min-w-0 overflow-hidden rounded-card border border-border bg-bg">
        {(block.lang || canCopy()) && (
          <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border pl-3 pr-1 lg:min-h-7">
            <span className="truncate font-mono text-[10px] leading-none text-muted">{block.lang}</span>
            <CopyButton text={block.text} className="min-h-8 rounded-chip px-2 text-caption text-muted hover:text-fg active:text-fg lg:min-h-6" />
          </div>
        )}
        <pre className="max-h-96 overflow-auto overscroll-contain px-3 py-2 font-mono text-caption"><CodeText lang={block.lang} text={block.text} /></pre>
      </div>
    );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      // A bare marker with nothing after it is still a task item.
      const TASK = /^\[( |x|X)\](?:\s|$)/;
      return (
        <List start={block.ordered && block.start !== 1 ? block.start : undefined} className={`space-y-1 pl-5 marker:text-muted ${block.ordered ? 'list-decimal' : 'list-disc [&_ul]:list-[circle]'}`}>
          {block.items.map((item, n) => {
            const first = item[0];
            const task = first?.kind === 'para' ? first.text.match(TASK) : null;
            return (
              <li key={n} className={`pl-0.5 [&>*+*]:mt-1${task && !block.ordered ? ' list-none' : ''}`}>
                {task && <input type="checkbox" checked={task[1] !== ' '} disabled className="mr-1 align-[-2px] accent-accent" />}
                <Blocks blocks={task && first?.kind === 'para' ? [{ ...first, text: first.text.slice(task[0].length) }, ...item.slice(1)] : item} tight refs={refs} />
              </li>
            );
          })}
        </List>
      );
    }
    case 'table': return (
      <div className="min-w-0 overflow-x-auto overscroll-x-contain rounded-chip border border-border">
        <table className="min-w-full border-collapse text-caption">
          <thead className="bg-bg">
            <tr>{block.head.map((cell, n) => <th key={n} style={{ textAlign: block.align[n] ?? 'left' }} className={`${CELL} border-b font-semibold`}>{inline(cell, refs)}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r} className="[&+tr]:border-t [&+tr]:border-border">
                {block.head.map((_, n) => <td key={n} style={{ textAlign: block.align[n] }} className={CELL}>{inline(row[n] ?? '', refs)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
}

export function Markdown({ text }: { text: string }) {
  const refs: Record<string, string> = Object.create(null);
  return <div className="flex min-w-0 flex-col gap-2"><Blocks blocks={extractDefs(parseBlocks(text), refs)} refs={refs} /></div>;
}
