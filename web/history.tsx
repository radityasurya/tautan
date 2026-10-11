// Find in terminal (Wave 22): search what a Pane printed, past the Screen, and read each match
// in its context. The Hub reads the Pane's kept history and searches it (ADR 0010); this view
// draws what it sends, oldest at the top and newest at the bottom like the terminal, and steps
// through the matches newest first. It is read-only: a link opens and a path copies or opens,
// as they do on the Screen, and nothing here types into the Pane.
import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { parseAnsi } from '../shared/ansi.ts';
import type { HistoryResult } from '../shared/types.ts';
import { useHold } from './affordances.tsx';
import { api, haptic, navigate, useDesktop } from './app.tsx';
import { filesHash } from './folders-logic.ts';
import { blocksOf, hitsIn, pathsIn, step } from './history-logic.ts';
import { ChevronDown, Plus, Search } from './icons.tsx';
import { sliceSpans, spanNode, spanStyle, withLinks } from './pane.tsx';
import { why } from './sheets.tsx';

/** The last search per Pane, for this page's life: reopening Find offers it again, selected. */
const lastQuery = new Map<string, string>();

/** One query's answer, with every page loaded so far (newest first). */
type Found = HistoryResult & { q: string };

/** An answer faster than this never shows "Searching…", so a quick search does not flash. */
const SLOW_MS = 300;
const COARSE = matchMedia('(pointer: coarse)').matches;
/** The grid's own stack: box drawing and Braille from the subset, the rest from Geist Mono. */
const GRID_FONT = '"tautan-box", "Geist Mono", ui-monospace, monospace';

const HIT = 'rounded-[2px] bg-accent/20 text-inherit';
const HIT_CURRENT = 'rounded-[2px] bg-accent/45 text-inherit ring-1 ring-accent';
const STEP =
  'press flex size-11 shrink-0 items-center justify-center rounded-chip text-fg outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent data-[end]:text-muted/50 data-[end]:hover:bg-transparent';

/** A path, as the Screen treats one: a tap copies it and says so, a hold opens it in Files. */
function PathButton({ path, paneKey, children }: { path: string; paneKey: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const hold = useHold(() => navigate(filesHash(paneKey, { path })));
  return (
    <button
      type="button"
      aria-label={`${path}, copies it, hold to open`}
      {...hold.on}
      onClick={() => {
        if (hold.held.current) return;
        haptic();
        void navigator.clipboard?.writeText(path);
        setCopied(true);
        // ponytail: one timer per tap, as on the Screen; the chip is the whole receipt.
        setTimeout(() => setCopied(false), 1500);
      }}
      className="relative text-left whitespace-pre-wrap underline decoration-accent/60 decoration-[1.5px] underline-offset-[3px] [-webkit-touch-callout:none]"
    >
      {children}
      {copied && (
        <span aria-hidden className="absolute bottom-full left-0 rounded-chip bg-elevated px-1.5 py-0.5 font-sans text-[11px] font-medium text-fg shadow-elevated">
          Copied
        </span>
      )}
    </button>
  );
}

/** One history line: the Screen's spans and links, its paths as buttons, every hit marked. */
const Line = memo(function Line({ text, q, current, paneKey }: { text: string; q: string; current: boolean; paneKey: string }) {
  const spans = withLinks([parseAnsi(text)[0] ?? []], Infinity)[0]!;
  const plain = spans.map((sp) => sp.text).join('');
  const hits = hitsIn(plain, q);
  const paths = pathsIn(plain);
  const cuts = [...new Set([0, plain.length, ...hits.flat(), ...paths.flatMap((p) => [p.start, p.end])])].sort((a, b) => a - b);
  const out: ReactNode[] = [];
  let inPath: ReactNode[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    const nodes = sliceSpans(spans, from, to).map((sp, j) => spanNode(sp, j, spanStyle(sp)));
    const piece = hits.some(([s, e]) => s <= from && to <= e) ? (
      <mark key={from} className={current ? HIT_CURRENT : HIT}>{nodes}</mark>
    ) : (
      <Fragment key={from}>{nodes}</Fragment>
    );
    const path = paths.find((p) => p.start <= from && to <= p.end);
    if (!path) {
      out.push(piece);
      continue;
    }
    inPath.push(piece);
    if (to === path.end) {
      out.push(<PathButton key={`path-${path.start}`} path={path.path} paneKey={paneKey}>{inPath}</PathButton>);
      inPath = [];
    }
  }
  return <>{out}</>;
});

/** The lines between two blocks, or after the newest one, folded into a count. */
function Gap({ lines, end }: { lines: number; end?: boolean }) {
  return (
    <p className="flex items-center gap-3 px-4 py-1.5 text-[11px] text-muted tabular-nums">
      <span aria-hidden className="h-px flex-1 bg-border" />
      {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'}
      {end ? ' to the end' : <span className="sr-only"> skipped</span>}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </p>
  );
}

/**
 * The Find in terminal view: a field, the count and the two steps, then the matches in their
 * context. Full screen on a phone; a panel at the right edge on desktop, wider than a sheet
 * because terminal lines are. A native modal <dialog>: Escape and ✕ close it, and focus goes
 * back to `opener`.
 */
export function HistorySheet({
  paneKey,
  title,
  opener,
  onClose,
}: {
  paneKey: string;
  /** The Pane's title, under the heading. */
  title?: string;
  /** The ⋯ button, or whatever had focus when the shortcut opened Find. */
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const desktop = useDesktop();
  const [q, setQ] = useState(() => lastQuery.get(paneKey) ?? '');
  const [found, setFound] = useState<Found | null>(null);
  /** The current match, as an index into `found.matches`: 0 is the newest. */
  const [at, setAt] = useState(0);
  /** Bumped by a search and by a step: each brings the current match into view. A page loaded
   *  from the button does not, so the reader stays on the older matches they asked for. */
  const [jump, setJump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  /** The Hub's code when the search itself failed. */
  const [failed, setFailed] = useState('');
  const [paging, setPaging] = useState(false);
  const [pageFailed, setPageFailed] = useState('');
  /** Bumped by each search, so an answer to an older one is dropped. */
  const gen = useRef(0);
  const inFlight = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const base = `/api/panes/${encodeURIComponent(paneKey)}/history?q=`;

  const search = async (query: string) => {
    const my = ++gen.current;
    lastQuery.set(paneKey, query);
    setBusy(true);
    setPageFailed('');
    const timer = setTimeout(() => my === gen.current && setSlow(true), SLOW_MS);
    try {
      const r = await api<HistoryResult>(base + encodeURIComponent(query), undefined, 'GET');
      if (my !== gen.current) return;
      setFound({ ...r, q: query });
      setAt(0);
      setJump((n) => n + 1);
      setFailed('');
    } catch (e) {
      if (my !== gen.current) return;
      setFound(null);
      setFailed((e instanceof Error && e.message) || 'network');
    } finally {
      clearTimeout(timer);
      if (my === gen.current) {
        setBusy(false);
        setSlow(false);
      }
    }
  };

  /** The page older than the oldest match loaded. True when it brought any. */
  const more = async (): Promise<boolean> => {
    if (!found?.matches.length || inFlight.current) return false;
    const my = gen.current;
    const oldest = found.matches.at(-1)!.line;
    inFlight.current = true;
    setPaging(true);
    setPageFailed('');
    try {
      const r = await api<HistoryResult>(`${base}${encodeURIComponent(found.q)}&before=${oldest}`, undefined, 'GET');
      if (my !== gen.current) return false;
      // ponytail: `before` counts lines of the first read; if herdr trimmed its ring between the
      // two reads, a page can skip or repeat a few matches. A read id from the Hub would fix it.
      const older = r.matches.filter((m) => m.line < oldest);
      // Nothing older came back, so the count was ahead of the history: it stops here.
      setFound((f) => f && { ...f, matches: [...f.matches, ...older], total: older.length ? f.total : f.matches.length });
      return older.length > 0;
    } catch (e) {
      if (my === gen.current) setPageFailed((e instanceof Error && e.message) || 'network');
      return false;
    } finally {
      inFlight.current = false;
      if (my === gen.current) setPaging(false);
    }
  };

  const go = async (by: 1 | -1) => {
    if (!found) return;
    const next = step(at, found.matches.length, found.total, by);
    if (!next || (next.load && !(await more()))) return;
    setAt(next.at);
    setJump((n) => n + 1);
  };

  // Enter searches, and steps to the next older match once the words have not changed, as a
  // browser's find does; Shift+Enter steps back. An input method's own Enter is its own.
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (e.shiftKey) return void go(-1);
    if (found?.matches.length && found.q === q && !busy) return void go(1);
    if (!q) return;
    void search(q);
    // On a phone the keyboard goes down, so the matches have the screen.
    if (COARSE) field.current?.blur();
  };

  const blocks = useMemo(() => (found ? blocksOf(found.matches) : []), [found]);
  const currentLine = found?.matches[at]?.line;
  useLayoutEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, [jump]);
  // Opened once, on mount. A ref callback runs on every render, and one that lands between
  // Escape and the `close` event (a `state` event will) would open the dialog again and trap
  // focus in it. The field takes focus, its kept query selected so typing replaces it.
  useLayoutEffect(() => {
    dialog.current?.showModal();
    field.current?.focus();
    field.current?.select();
  }, []);

  const total = found ? Math.max(found.total, found.matches.length) : 0;
  const count = slow ? 'Searching…' : !found ? '' : total ? `${(at + 1).toLocaleString()} of ${total.toLocaleString()}` : 'No match';
  const newest = !found || at <= 0;
  const oldest = !found || at + 1 >= total;
  const last = blocks.at(-1);
  const tail = found && last ? found.lines - (last.from + last.lines.length - 1) : 0;
  const unsupported = failed === 'unsupported' || failed === 'http 501';

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="find-title"
      onClose={() => {
        onClose();
        opener.current?.focus();
      }}
      className={`m-0 max-h-none max-w-none overflow-hidden bg-bg p-0 text-fg backdrop:bg-black/40 motion-safe:animate-[tautan-push-in_200ms_cubic-bezier(0.2,0,0,1)] ${
        desktop
          ? 'fixed inset-y-0 right-0 left-auto h-dvh w-[min(640px,100vw)] border-l border-border shadow-elevated'
          : // The visual viewport, like the Pane screen: the field stays above the phone's keyboard.
            'fixed inset-x-0 top-(--vv-top,0px) h-(--vv-h,100dvh) w-full'
      }`}
    >
      <div className="flex h-full flex-col">
        <header className="shrink-0 border-b border-border px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 pt-1.5">
              <h2 id="find-title" className="text-title">
                Find in terminal
              </h2>
              {title && <p className="truncate text-caption text-muted">{title}</p>}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={(e) => e.currentTarget.closest('dialog')?.close()}
              className="press -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Plus className="rotate-45" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-1">
            <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-composer border border-border bg-surface px-3 focus-within:border-accent/60">
              <Search size={16} className="shrink-0 text-muted" />
              <input
                ref={field}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                maxLength={200}
                aria-label="Text to find"
                placeholder="Find in history"
                enterKeyHint="search"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[16px] placeholder:text-muted focus:outline-none lg:text-[13px]"
              />
              <span aria-live="polite" className="shrink-0 text-caption whitespace-nowrap text-muted tabular-nums">
                {count}
              </span>
            </label>
            {/* Older is up, as in the terminal: the matches run oldest at the top. */}
            <button
              type="button"
              aria-label="Older match"
              title={desktop ? 'Older match (Enter)' : undefined}
              aria-disabled={oldest || undefined}
              data-end={oldest || undefined}
              onClick={() => void go(1)}
              className={STEP}
            >
              <ChevronDown className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Newer match"
              title={desktop ? 'Newer match (Shift+Enter)' : undefined}
              aria-disabled={newest || undefined}
              data-end={newest || undefined}
              onClick={() => void go(-1)}
              className={STEP}
            >
              <ChevronDown />
            </button>
          </div>
        </header>

        {/* Relative, so the `sr-only` text inside scrolls with the list, not the dialog. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(env(safe-area-inset-bottom),12px)]">
          {unsupported ? (
            <div role="status" className="px-4 pt-4">
              <p className="text-body">This herdr cannot search its history</p>
              <p className="mt-1 text-caption text-muted">Update herdr and restart its server, then try again.</p>
            </div>
          ) : failed ? (
            <p role="alert" className="px-4 pt-4 text-caption text-danger">
              {why(failed)}
            </p>
          ) : !found ? (
            <p className="px-4 pt-4 text-caption text-muted">Search what this Pane printed, past the Screen.</p>
          ) : !total ? (
            <p className="px-4 pt-4 text-caption text-muted">No match in the last {found.lines.toLocaleString()} lines</p>
          ) : (
            <div aria-busy={busy || undefined} className={`transition-opacity ${slow ? 'opacity-50' : ''}`}>
              {found.matches.length < total && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-1">
                  <button
                    type="button"
                    disabled={paging}
                    onClick={() => void more()}
                    className="press min-h-9 rounded-chip border border-border bg-bg px-3 text-[13px] font-medium text-fg disabled:text-muted"
                  >
                    {paging ? 'Loading…' : `Load ${(total - found.matches.length).toLocaleString()} older ${total - found.matches.length === 1 ? 'match' : 'matches'}`}
                  </button>
                  {pageFailed && (
                    <span role="alert" className="text-caption text-danger">
                      {why(pageFailed)}
                    </span>
                  )}
                </div>
              )}
              {blocks.map((b, i) => {
                const prev = blocks[i - 1];
                return (
                  <Fragment key={b.from}>
                    {prev && <Gap lines={b.from - (prev.from + prev.lines.length)} />}
                    <pre className="py-1 text-caption break-words whitespace-pre-wrap" style={{ fontFamily: GRID_FONT }}>
                      {b.lines.map((text, j) => {
                        const n = b.from + j;
                        const on = n === currentLine;
                        return (
                          <span
                            key={n}
                            ref={on ? currentRef : undefined}
                            aria-current={on || undefined}
                            className={`block min-h-[1lh] px-4 ${on ? 'bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                          >
                            <Line text={text} q={found.q} current={on} paneKey={paneKey} />
                          </span>
                        );
                      })}
                    </pre>
                  </Fragment>
                );
              })}
              {tail > 0 && <Gap lines={tail} end />}
            </div>
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
