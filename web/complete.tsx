import { useEffect, useRef, useState } from 'react';

/** One row the Hub offers. `value` is the exact text to insert. */
export interface Item { value: string; label: string; detail?: string; dir?: boolean }
export type Kind = 'slash' | 'file' | 'model';

/** The span of the text a picker would replace: `[start, end)`, and what was typed in it. */
export interface Token { kind: Kind; q: string; start: number; end: number }

/**
 * What the caret is completing, or null. `/model ` followed by a word is the model card;
 * `/word` at the very start is a command (a `/` with a second slash is a path, not a
 * command); `@word` after a space or the start is a file. Pure, so it is tested alone.
 */
export function tokenAt(text: string, caret: number): Token | null {
  const at = Math.min(Math.max(caret, 0), text.length);
  const model = /^\/model[ \t]+(\S*)$/.exec(text);
  if (model && at >= text.length - model[1]!.length) {
    return { kind: 'model', q: model[1]!, start: text.length - model[1]!.length, end: text.length };
  }
  const before = text.slice(0, at);
  const tail = /^\S*/.exec(text.slice(at))![0]; // the rest of the word under the caret
  const slash = /^\/([\w:.-]*)$/.exec(before);
  if (slash && /^[\w:.-]*$/.test(tail)) {
    return { kind: 'slash', q: slash[1]! + tail, start: 0, end: at + tail.length };
  }
  const file = /(?:^|\s)@(\S*)$/.exec(before);
  if (file) {
    const start = at - file[1]!.length - 1;
    return { kind: 'file', q: file[1]! + tail, start, end: at + tail.length };
  }
  return null;
}

/**
 * The text after a pick. A command or a file gets a trailing space unless one follows; a
 * folder keeps the picker open to drill in. A file keeps its `@`. A model is not inserted:
 * the Composer sends it.
 */
export function applyPick(text: string, token: Token, item: Item): { text: string; caret: number } {
  const lead = token.kind === 'file' ? '@' : '';
  const value = item.dir && !item.value.endsWith('/') ? `${item.value}/` : item.value;
  const gap = item.dir || /^\s/.test(text.slice(token.end)) ? '' : ' ';
  const insert = `${lead}${value}${gap}`;
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { text: next, caret: token.start + insert.length };
}

const DEBOUNCE = 120;

/**
 * The Hub's list for a token, or []. Waits 120 ms after the last keystroke, aborts the
 * request a newer one replaces, and treats any failure as an empty list: the picker closes
 * and plain typing carries on.
 */
export function useComplete(paneKey: string, token: Token | null): Item[] {
  const [items, setItems] = useState<Item[]>([]);
  const kind = token?.kind;
  const q = token?.q;
  useEffect(() => {
    if (!kind) {
      setItems([]);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      const url = `/api/panes/${encodeURIComponent(paneKey)}/complete?kind=${kind}&q=${encodeURIComponent(q ?? '')}&limit=50`;
      fetch(url, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((body: { items?: unknown }) => {
          if (ctl.signal.aborted) return;
          setItems(Array.isArray(body.items) ? (body.items as Item[]).filter((i) => typeof i?.value === 'string') : []);
        })
        .catch(() => {
          if (!ctl.signal.aborted) setItems([]);
        });
    }, DEBOUNCE);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [paneKey, kind, q]);
  // A list for another kind is stale the moment the kind changes.
  return kind ? items : [];
}

const TITLE: Record<Kind, string> = { slash: 'Commands', file: 'Files', model: 'Models' };

/**
 * The list under the field. Phone: a docked sheet in the flow, above the field and the
 * keyboard. Desktop: a popover above the field. A press keeps focus in the textarea.
 */
export function Picker({
  id,
  kind,
  items,
  active,
  desktop,
  onActive,
  onPick,
}: {
  id: string;
  kind: Kind;
  items: Item[];
  active: number;
  desktop: boolean;
  onActive: (i: number) => void;
  onPick: (item: Item) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    row.current?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);
  return (
    <div
      className={`rise overflow-hidden rounded-card border border-border bg-bg shadow-[0_-8px_24px_rgb(0_0_0/0.18)] ${
        desktop ? 'absolute inset-x-0 bottom-full z-20 mb-1.5' : 'mx-4'
      }`}
    >
      <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">
        {TITLE[kind]}
      </p>
      <ul id={id} role="listbox" aria-label={TITLE[kind]} className={`overflow-y-auto overscroll-contain pb-1 ${desktop ? 'max-h-60' : 'max-h-[34vh]'}`}>
        {items.map((item, i) => (
          <li
            key={item.value}
            id={`${id}-${i}`}
            ref={i === active ? row : undefined}
            role="option"
            aria-selected={i === active}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onPick(item)}
            onPointerMove={(e) => e.pointerType !== 'touch' && i !== active && onActive(i)}
            className={`flex min-h-10 cursor-pointer items-baseline gap-2 px-3 py-2 ${i === active ? 'bg-accent/12' : ''}`}
          >
            <span className={`shrink-0 font-mono text-[13px] ${i === active ? 'text-accent' : 'text-fg'}`}>{item.label}</span>
            {item.detail && <span className="min-w-0 flex-1 truncate text-caption text-muted">{item.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
