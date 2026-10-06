// Markdown for Chat turns, rendered as React elements: the transcript is untrusted Agent
// output, so nothing here builds HTML from a string and raw HTML stays text.
// ponytail: a line-based subset of CommonMark + GFM — ATX headings, paragraphs, lists nested
// by indent, blockquotes, fences, rules, pipe tables; inline code, bold, italic, strike,
// links and bare URLs. No setext headings, reference links, footnotes, task boxes, HTML,
// images, or emphasis that crosses another span's boundary. Add a real parser (micromark)
// when a transcript needs one of those.
import { useState, type ReactNode } from 'react';

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
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indent = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, '    ').length;
const isTable = (lines: string[], i: number) => lines[i]!.includes('|') && DELIM.test(lines[i + 1] ?? '') && lines[i + 1]!.includes('-');
const starts = (lines: string[], i: number) =>
  FENCE.test(lines[i]!) || HEADING.test(lines[i]!) || RULE.test(lines[i]!) || QUOTE.test(lines[i]!) || ITEM.test(lines[i]!) || isTable(lines, i);

function cells(line: string): string[] {
  const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      const close = new RegExp(`^ {0,3}${m[1]![0]}{${m[1]!.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++; // an unclosed fence runs to the end, as in CommonMark
      blocks.push({ kind: 'code', lang: m[2] ?? '', text: body.join('\n') });
    } else if ((m = line.match(HEADING))) {
      blocks.push({ kind: 'heading', level: m[1]!.length, text: m[2] ?? '' });
      i++;
    } else if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
    } else if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(lines[i]!.replace(QUOTE, ''));
      blocks.push({ kind: 'quote', blocks: parseBlocks(body.join('\n')) });
    } else if ((m = line.match(ITEM))) {
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
      blocks.push({ kind: 'list', ordered, start: ordered ? parseInt(m[2]!, 10) : 1, items: items.map((item) => parseBlocks(item.join('\n'))) });
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

// One pass, leftmost match wins; at the same spot the earlier alternative wins.
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
].join('|'), 'g');

const SAFE_URL = /^(https?:|mailto:)/i;
const LINK = 'text-accent underline decoration-accent/40 underline-offset-2 [overflow-wrap:anywhere]';

function link(href: string, children: ReactNode, key: number) {
  return <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={LINK}>{children}</a>;
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const push = (s: string) => {
    // Single newlines inside a paragraph are line breaks.
    s.split('\n').forEach((part, n) => { if (n) out.push(<br key={`br${out.length}`} />); if (part) out.push(part); });
  };
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const k = out.length;
    if (m[1] !== undefined) push(m[1]);
    else if (m[3] !== undefined) out.push(<code key={k} className="rounded-chip bg-bg px-1 py-px font-mono text-[0.86em] [overflow-wrap:anywhere]">{m[3].replace(/\n/g, ' ')}</code>);
    else if (m[4] !== undefined) out.push(SAFE_URL.test(m[5]!) ? link(m[5]!, inline(m[4]), k) : m[0]);
    else if (m[6] !== undefined) out.push(link(m[6], m[6], k));
    else if (m[7] !== undefined) out.push(<strong key={k} className="font-semibold"><em>{inline(m[7])}</em></strong>);
    else if (m[8] !== undefined || m[9] !== undefined) out.push(<strong key={k} className="font-semibold">{inline((m[8] ?? m[9])!)}</strong>);
    else if (m[10] !== undefined) out.push(<s key={k}>{inline(m[10])}</s>);
    else out.push(<em key={k}>{inline((m[11] ?? m[12])!)}</em>);
  }
  push(text.slice(last));
  return out;
}

// Clipboard needs a secure context; over plain http the button is left out, not broken.
const canCopy = () => typeof navigator !== 'undefined' && Boolean(navigator.clipboard);

export function CopyButton({ text, className }: { text: string; className: string }) {
  const [copied, setCopied] = useState(false);
  if (!canCopy()) return null;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => {});
      }}
      className={className}
    >
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

const HEADING_CLASS = ['', 'text-title', 'text-title', 'text-body font-semibold', 'text-body font-semibold', 'text-body font-semibold text-muted', 'text-body font-semibold text-muted'];
const CELL = 'border-border px-2 py-1.5 align-top [&+*]:border-l';

function Blocks({ blocks, tight = false }: { blocks: Block[]; tight?: boolean }) {
  // A list item holding one paragraph renders it bare, so the marker sits on its text.
  if (tight && blocks.length === 1 && blocks[0]!.kind === 'para') return <>{inline(blocks[0]!.text)}</>;
  return <>{blocks.map((block, n) => <BlockView key={n} block={block} />)}</>;
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const H = `h${block.level}` as 'h1';
      return <H className={`${HEADING_CLASS[block.level]} font-semibold [&:not(:first-child)]:mt-1`}>{inline(block.text)}</H>;
    }
    case 'para': return <p>{inline(block.text)}</p>;
    case 'rule': return <hr className="my-1 border-0 border-t border-border" />;
    case 'quote': return <blockquote className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted"><Blocks blocks={block.blocks} /></blockquote>;
    case 'code': return (
      <div className="min-w-0 overflow-hidden rounded-card border border-border bg-bg">
        {(block.lang || canCopy()) && (
          <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border pl-3 pr-1 lg:min-h-7">
            <span className="truncate font-mono text-[10px] leading-none text-muted">{block.lang}</span>
            <CopyButton text={block.text} className="min-h-8 rounded-chip px-2 text-caption text-muted hover:text-fg active:text-fg lg:min-h-6" />
          </div>
        )}
        <pre className="max-h-96 overflow-auto overscroll-contain px-3 py-2 font-mono text-caption"><code>{block.text}</code></pre>
      </div>
    );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List start={block.ordered && block.start !== 1 ? block.start : undefined} className={`space-y-1 pl-5 marker:text-muted ${block.ordered ? 'list-decimal' : 'list-disc [&_ul]:list-[circle]'}`}>
          {block.items.map((item, n) => <li key={n} className="pl-0.5 [&>*+*]:mt-1"><Blocks blocks={item} tight /></li>)}
        </List>
      );
    }
    case 'table': return (
      <div className="min-w-0 overflow-x-auto overscroll-x-contain rounded-chip border border-border">
        <table className="min-w-full border-collapse text-caption">
          <thead className="bg-bg">
            <tr>{block.head.map((cell, n) => <th key={n} style={{ textAlign: block.align[n] ?? 'left' }} className={`${CELL} border-b font-semibold`}>{inline(cell)}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r} className="[&+tr]:border-t [&+tr]:border-border">
                {block.head.map((_, n) => <td key={n} style={{ textAlign: block.align[n] }} className={CELL}>{inline(row[n] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
}

export function Markdown({ text }: { text: string }) {
  return <div className="flex min-w-0 flex-col gap-2"><Blocks blocks={parseBlocks(text)} /></div>;
}
