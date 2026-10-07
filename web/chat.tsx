import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { Blocked, ON_WARN, type ExplainResponse } from './blocked.tsx';
import { Dot, timeAgo } from './home.tsx';
import { SegmentedControl, Skeleton } from './halaska-kit';
import { CopyButton, Markdown } from './markdown.tsx';
import { Check, ChevronRight, Down } from './icons.tsx';
import { Gallery, Picture, Thumb, chatImage, fileImage, fileView, safeImage } from './image.tsx';
import { pendingTool, type ChatDelta, type ChatEvent, type ChatResponse, type Subagent, type Tool, type Turn } from '../shared/chat.ts';
import { CHAT_EVENT, mergeTurns } from '../shared/chat-merge.ts';
import type { Span, Status } from '../shared/types.ts';
import { deliver, dropPending, pendingSnapshot, settled, subscribePending, type Pending } from './pending.ts';
import { Preview, linkLabel, previewSrc, safeLink } from './preview.tsx';
import { toolbarFromScreen, type Profile } from './profiles.ts';
import { finishedIn, readSubagent, setShowing, subagentChips, subagentName, subagentRows, subagentRunning, writeSubagent } from './subagents.ts';

export type LensMode = 'chat' | 'screen';



const OPTIONS = ['Chat', 'Screen'];
const storageKey = (paneKey: string) => `tautan.lens.${paneKey}`;

export const readLens = (paneKey: string): LensMode =>
  sessionStorage.getItem(storageKey(paneKey)) === 'chat' ? 'chat' : 'screen';

export function writeLens(paneKey: string, mode: LensMode) {
  sessionStorage.setItem(storageKey(paneKey), mode);
}

export function LensSwitch({ value, onChange }: { value: LensMode; onChange: (mode: LensMode) => void }) {
  return (
    <div
      role="group"
      aria-label={`Pane view, ${value} selected`}
      // One header height with the Status chip and More: 36 px, radius 10 like the chip.
      // The kit sets its box inline, so the overrides need `!`.
      className="w-[112px] shrink-0 [&>div]:h-9! [&>div]:rounded-composer! [&_button]:min-h-[30px] [&_button]:py-0! [&>div>div]:rounded-[7px]!"
    >
      <SegmentedControl
        options={OPTIONS}
        value={value === 'chat' ? 'Chat' : 'Screen'}
        onChange={(next: string) => onChange(next === 'Chat' ? 'chat' : 'screen')}
      />
    </div>
  );
}

/** Where a tool's image loads from, its label, and the full-size view; undefined when it is unsafe. */
function toolImage(paneKey: string, tool: Tool, agent?: string): { src: string; alt: string; href?: string } | undefined {
  // The Hub's copy from the transcript loads for any path; the file route refuses one outside the cwd.
  // No viewer route serves it, so it opens in the Lightbox.
  if (tool.imageId !== undefined) {
    const name = (tool.image ?? tool.brief).split('/').filter(Boolean).at(-1) ?? 'image';
    return { src: chatImage(paneKey, tool.imageId, agent), alt: `Image read by Claude: ${name}` };
  }
  if (!tool.image) return undefined;
  if (tool.via) {
    const src = /^https:/i.test(tool.image) ? safeImage(tool.image) : undefined;
    return src ? { src, alt: `Image sent to ${tool.name}` } : undefined;
  }
  const name = tool.image.split('/').filter(Boolean).at(-1) ?? tool.image;
  return { src: fileImage(paneKey, tool.image), alt: `Image read by Claude: ${name}`, href: fileView(paneKey, tool.image) };
}

const CAPTION: Record<Pending['state'], string> = {
  held: 'Held until the Agent is idle',
  sending: 'Sending…',
  sent: 'Sent',
  late: 'Not in the transcript yet',
  failed: 'Not sent',
};

/** A reply the transcript has not caught up with: dimmed, with what happened to it underneath. */
function PendingTurn({ entry }: { entry: Pending }) {
  const failed = entry.state === 'failed';
  return (
    <li className="flex flex-col items-end">
      <div className={`min-w-0 max-w-[88%] whitespace-pre-wrap break-words rounded-card bg-accent/10 px-3 py-2.5 text-body text-fg ${failed ? '' : 'opacity-60'}`}>
        {entry.text}
      </div>
      <span aria-live="polite" className={`mt-1 px-1 text-right text-[11px] ${failed ? 'text-danger' : 'text-muted'}`}>
        {CAPTION[entry.state]}
        {failed && (
          <>
            {' · '}
            <button type="button" onClick={() => void deliver(entry.id)} className="press -my-2 inline-flex min-h-8 items-center font-semibold text-accent">
              Retry
            </button>
          </>
        )}
      </span>
    </li>
  );
}

function Stamp({ at }: { at?: number }) {
  if (!at) return null;
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
      {timeAgo(at)}
    </time>
  );
}


const ROW = 'min-w-0 rounded-chip bg-surface';
const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
// A shell's last lines are what matter, so its open output starts scrolled to the end.
const SHELL = /^bash$/i;

/** What the tool returned: a header with its size, Copy, and the text in its own scroll box. */
function ToolResult({ tool, full }: { tool: Tool; full?: string }) {
  const result = full ?? tool.result!;
  const total = tool.resultLines ?? result.split('\n').length;
  const capped = full === undefined && (tool.resultTruncated || result.startsWith('…\n'));
  const size = capped ? `last ${result.split('\n').length - (result.startsWith('…\n') ? 1 : 0)} of ${count(total, 'line')}` : count(total, 'line');
  return (
    <section aria-label={`${tool.name} ${tool.isError ? 'error' : 'output'}`} className="border-t border-border p-2">
      <div className="mb-1.5 flex min-h-8 items-center gap-2 pl-1">
        <span className={`min-w-0 flex-1 truncate text-[11px] ${tool.isError ? 'font-semibold text-danger' : 'text-muted'}`}>
          {tool.isError ? 'Error' : 'Output'} · {size}
        </span>
        <CopyButton text={result} className="min-h-8 shrink-0 rounded-chip border border-border bg-bg px-2 text-caption text-muted active:text-fg" />
      </div>
      <pre
        data-tail={SHELL.test(tool.name) || undefined}
        tabIndex={0}
        className={`max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-[6px] border bg-bg px-2 py-1.5 font-mono text-caption text-fg ${
          tool.isError ? 'border-danger/40' : 'border-border'
        }`}
      >
        {result}
      </pre>
    </section>
  );
}

/** The closed row's hint: a red dot for a failure, else how long the output is. */
function ResultHint({ tool }: { tool: Tool }) {
  if (tool.isError) {
    return (
      <span title="The tool reported an error" className="flex items-center">
        <span aria-hidden className="size-2 rounded-full bg-danger" />
        <span className="sr-only">, failed</span>
      </span>
    );
  }
  if (tool.result === undefined) return null;
  return <span className="shrink-0 text-[10px] tabular-nums text-muted">{count(tool.resultLines ?? 1, 'line')}</span>;
}
/** Whole outputs fetched so far, by Pane, subagent and tool id: a row that closes and opens again asks once. */
const outputs = new Map<string, string>();

/** The whole output of a sliced tool result, fetched the first time its row opens; the slice stands in until then. */
function useFullOutput(paneKey: string, agent: string | undefined, tool: Tool, opened: boolean): string | undefined {
  const key = tool.resultTruncated && tool.id ? `${paneKey}\u0000${agent ?? ''}\u0000${tool.id}` : undefined;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!opened || !key || outputs.has(key)) return;
    let alive = true;
    const url = `/api/panes/${encodeURIComponent(paneKey)}/chat/output/${encodeURIComponent(tool.id!)}${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`;
    fetch(url)
      .then((r) => (r.ok ? r.text() : undefined))
      .then((text) => { if (text !== undefined) { outputs.set(key, text); if (alive) redraw((n) => n + 1); } })
      .catch(() => {}); // the slice stays; the next open asks again
    return () => { alive = false; };
  }, [opened, key]);
  return key ? outputs.get(key) : undefined;
}
const SUMMARY = 'cursor-pointer list-none rounded-chip [&::-webkit-details-marker]:hidden';

/** The open part of a tool row: the image, the page preview, the input, and the output. */
function ToolBody({ tool, image, preview, full }: { tool: Tool; image?: ReturnType<typeof toolImage>; preview?: { src: string; title: string }; full?: string }) {
  return (
    <>
      {image && (
        <div className="border-t border-border p-2">
          <Picture {...image} />
        </div>
      )}
      {preview && (
        <div className="border-t border-border p-2">
          <Preview {...preview} />
        </div>
      )}
      <div className="relative border-t border-border">
        {(tool.detail || tool.brief) && (
          <pre className="max-h-72 overflow-auto overscroll-contain whitespace-pre-wrap break-words px-2 py-2 pr-16 font-mono text-caption text-fg">
            {tool.detail || tool.brief}
          </pre>
        )}
        <CopyButton
          text={[tool.detail || tool.brief, tool.output].filter(Boolean).join('\n\n')}
          className="absolute right-1.5 top-1.5 min-h-8 rounded-chip border border-border bg-bg px-2 text-caption text-muted active:text-fg"
        />
      </div>
      {tool.result !== undefined && <ToolResult tool={tool} full={full} />}
      {tool.result === undefined && tool.isError && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] font-semibold text-danger">Error, no output</p>
      )}
      {tool.output !== undefined && (
        <section aria-label={`${tool.name} output`} className="border-t border-border">
          <div className="max-h-96 overflow-auto overscroll-contain px-3 py-2.5 text-caption [&_h1]:text-body [&_h2]:text-body">
            <Markdown text={tool.output} />
          </div>
          {tool.truncated && (
            <p className="border-t border-border px-3 py-1.5 text-[10px] text-muted">Output cut short by {tool.via ?? 'the tool'}</p>
          )}
        </section>
      )}
    </>
  );
}

/**
 * One tool call. A published page (the Artifact tool) is a card with Open; a Task that
 * started a subagent opens that Agent; HTML the Agent wrote previews when opened.
 */
function ToolRow({
  paneKey,
  agent,
  tool,
  at,
  subagent,
  onOpenSubagent,
}: {
  paneKey: string;
  /** The subagent whose transcript this row is in, for the image and preview routes. */
  agent?: string;
  tool: Tool;
  /** The turn's time, on the last row only. */
  at?: number;
  subagent?: Subagent;
  onOpenSubagent: (id: string) => void;
}) {
  const image = toolImage(paneKey, tool, agent);
  const href = tool.link && safeLink(tool.link.url);
  const card = href ? linkLabel(tool.link!) : undefined;
  const title = card?.title ?? tool.brief.split('/').filter(Boolean).at(-1) ?? tool.name;
  const preview = tool.previewId !== undefined ? { src: previewSrc(paneKey, tool.previewId, agent), title } : undefined;
  const brief = subagent ? subagentName(subagent) : tool.brief;
  const [opened, setOpened] = useState(false);
  const full = useFullOutput(paneKey, agent, tool, opened);

  return (
    <li className={ROW}>
      <details
        className="group"
        onToggle={(event) => {
          if (event.currentTarget.open) setOpened(true);
          const tail = event.currentTarget.open && event.currentTarget.querySelector<HTMLElement>('[data-tail]');
          if (tail) tail.scrollTop = tail.scrollHeight;
        }}
      >
        {card ? (
          <summary className={`${SUMMARY} flex min-h-14 items-center gap-3 py-2 pr-2 pl-3 lg:min-h-12`}>
            <span className="min-w-0 flex-1">
              <span title={card.title} className="block truncate text-body font-medium text-fg">{card.title}</span>
              <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted">
                <span className="truncate">{tool.name} · {card.host}</span>
                <Stamp at={at} />
              </span>
            </span>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${card.title} on ${card.host} in a new tab`}
              className="press inline-flex min-h-9 shrink-0 items-center gap-1 rounded-chip bg-accent px-3 text-caption font-semibold text-bg"
            >
              Open
              <span aria-hidden>↗</span>
            </a>
            <ChevronRight className="shrink-0 text-muted transition-transform group-open:rotate-90" />
          </summary>
        ) : (
          <summary className={`${SUMMARY} grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 px-2 py-1 font-mono text-caption lg:min-h-8`}>
            <span
              title={tool.via ? `${tool.name}, run by ${tool.via}` : tool.name}
              className={`${tool.via ? 'max-w-44' : 'max-w-32'} truncate rounded-chip border border-border bg-bg px-1.5 py-0.5 text-[10px] leading-none text-fg`}
            >
              {tool.via && <span className="text-muted">{tool.via} · </span>}
              {tool.name}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              {image && <Thumb src={image.src} />}
              <span title={brief} className={`truncate ${subagent ? 'font-sans text-fg' : 'text-muted'}`}>{brief}</span>
            </span>
            <span className="flex items-center gap-2">
              <ResultHint tool={tool} />
              <Stamp at={at} />
            </span>
            <ChevronRight className="text-muted transition-transform group-open:rotate-90" />
          </summary>
        )}
        <ToolBody tool={tool} image={image} preview={preview} full={full} />
      </details>
      {tool.subagentId && (
        <button
          type="button"
          onClick={() => onOpenSubagent(tool.subagentId!)}
          className="press flex min-h-11 w-full items-center justify-between gap-2 rounded-b-chip border-t border-border px-3 text-left text-caption font-semibold text-accent lg:min-h-9"
        >
          Open agent
          <ChevronRight size={16} />
        </button>
      )}
    </li>
  );
}

const capital = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`;

/** The blocked prompt, answered where it sits in the conversation. Absent unless blocked. */
export interface Approval {
  explain: ExplainResponse;
  /** The last answer to this prompt came back 409. */
  stale: boolean;
  desktop: boolean;
  /** The Pane's one answer path (`sendBlocked` with the 409 guard). */
  onAnswer: (keys: string[], promptId?: string) => Promise<'sent' | 'changed'>;
  onReread: () => void;
  /** The row on screen, so Review can bring it into view. */
  ref: RefObject<HTMLLIElement | null>;
}

/** An answer went out and the Agent has not moved yet. Choices come back after this, in case it never does. */
const SENT_MS = 10_000;

/**
 * The approval as a transcript item: the tool row it asks about (warn-tinted, its input open)
 * with the choices under it, or the full blocked card when no tool row matches (a question).
 * After an answer it says so until the Status moves on and the row turns back into a tool row.
 */
function ApprovalItem({ approval, agent, tool, at }: { approval: Approval; agent: string; tool?: Tool; at?: number }) {
  const { explain, stale, desktop, onAnswer, onReread, ref } = approval;
  const promptId = explain.promptId ?? '';
  const [sent, setSent] = useState<string | null>(null);
  const waiting = sent === promptId;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setSent(null), SENT_MS);
    return () => clearTimeout(t);
  }, [waiting]);
  const send = async (keys: string[], id?: string) => {
    const outcome = await onAnswer(keys, id);
    if (outcome === 'sent') setSent(id ?? '');
    return outcome;
  };
  const note: ReactNode = (
    <p role="status" className="flex min-h-11 items-center gap-2 px-1 text-caption text-muted lg:min-h-9">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted motion-safe:animate-pulse" />
      Sent · waiting for {capital(agent)}
    </p>
  );
  const card = (bare: boolean) =>
    waiting ? note : (
      <Blocked
        key={promptId || 'mock'}
        explain={explain}
        agent={agent}
        stale={stale}
        layout={desktop ? 'row' : 'rows'}
        bare={bare}
        onSend={send}
        onReread={onReread}
      />
    );

  if (!tool) {
    return (
      <li ref={ref} data-approval className="flex scroll-my-4 flex-col items-start">
        <div className="w-[min(92%,42rem)]">{card(false)}</div>
      </li>
    );
  }
  const input = tool.detail || tool.brief;
  return (
    <li ref={ref} data-approval aria-label={`${tool.name} needs your approval`} className="min-w-0 scroll-my-4 rounded-chip border border-warn/40 bg-warn/8">
      <div className="flex min-h-11 items-center gap-2 px-2 py-1 lg:min-h-8">
        <span className="max-w-32 shrink-0 truncate rounded-chip border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] leading-none text-fg">
          {tool.name}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-semibold text-warn">
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" />
          <span className="truncate">Needs your approval</span>
        </span>
        <Stamp at={at} />
      </div>
      {input && (
        <pre className="mx-2 max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-[6px] border border-border bg-bg px-2 py-1.5 font-mono text-caption text-fg">
          {input}
        </pre>
      )}
      <div className="p-2">{card(true)}</div>
    </li>
  );
}

/**
 * The assistant side's "typing": three dots and what the Agent is doing. Claude's own spinner
 * line, read off the Screen, gives the verb and the time; anything else says "working".
 * A blocked Agent asks for the answer instead, and Review brings the prompt's card up.
 */
function Working({ agent, status, spinner, onReview }: {
  agent: string;
  status: Status;
  spinner?: { verb: string; elapsed?: string };
  onReview?: () => void;
}) {
  const name = capital(agent);
  if (status === 'blocked') {
    return (
      <div role="status" className="mt-4 flex w-fit max-w-[88%] items-center gap-2.5 rounded-card bg-warn/10 py-1.5 pr-1.5 pl-3 text-caption text-fg">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-warn" />
        <span className="min-w-0">Waiting for your answer</span>
        {onReview && (
          <button type="button" onClick={onReview} className="press inline-flex min-h-8 shrink-0 items-center rounded-chip bg-bg px-2.5 font-semibold text-accent">
            Review
          </button>
        )}
      </div>
    );
  }
  return (
    <div role="status" className="mt-4 flex w-fit max-w-[88%] items-center gap-2.5 rounded-card bg-surface px-3 py-2 text-caption">
      <span className="sr-only">{name} is working</span>
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {[0, 160, 320].map((delay) => (
          <span
            key={delay}
            style={{ animationDelay: `${delay}ms` }}
            className="size-1.5 rounded-full bg-muted motion-safe:animate-pulse"
          />
        ))}
      </span>
      <span aria-hidden className="min-w-0 truncate text-muted">
        {spinner ? (
          <>
            <span className="text-fg">{spinner.verb}…</span>
            {spinner.elapsed && <span className="font-mono text-[11px] tabular-nums"> · {spinner.elapsed}</span>}
          </>
        ) : (
          `${name} is working…`
        )}
      </span>
    </div>
  );
}

/**
 * The Agents of this Pane's chat: the main Agent first, with the Pane's Status, then every
 * subagent, running ones first and then newest, each nested one after its parent. One row of
 * chips that scrolls sideways; the list button on its left opens them all as rows above the
 * strip, each with its description, state and start time. Choosing a row switches and closes
 * it; Esc and a click outside close it too.
 */
function Switcher({ agent, status, subagents, running, selected, onPick }: {
  agent: string;
  status: Status;
  subagents: Subagent[];
  running: (agent: Subagent) => boolean;
  selected?: string;
  onPick: (id?: string) => void;
}) {
  const chips = useMemo(() => subagentChips(subagents, running), [subagents, running]);
  const rows = useMemo(() => subagentRows(subagents, running), [subagents, running]);
  const busy = rows.filter((r) => r.running).length;
  const current = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selected]);
  useEffect(() => {
    if (!open) return;
    const chosen = panel.current?.querySelector<HTMLElement>('[aria-current=true]');
    chosen?.scrollIntoView({ block: 'nearest' });
    chosen?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const choose = (id?: string) => {
    setOpen(false);
    onPick(id);
    trigger.current?.focus();
  };
  const mainState = word(status);
  const row = (id: string | undefined, depth: number, name: string, detail: string | undefined, dot: Status, seen: boolean, state: string, live: boolean, at?: number) => {
    const on = selected === id;
    return (
      <li key={id ?? ''}>
        <button
          type="button"
          aria-current={on ? 'true' : undefined}
          onClick={() => choose(id)}
          title={detail ? `${name} · ${detail}` : name}
          className={`press flex min-h-12 w-full items-center gap-2.5 rounded-lg py-1.5 pr-2.5 text-left hover:bg-fg/6 lg:min-h-10 ${on ? 'bg-fg/6' : ''}`}
          style={{ paddingLeft: 10 + depth * 16 }}
        >
          {depth > 0 && <span aria-hidden className="-mr-1 shrink-0 text-[12px] text-muted">↳</span>}
          <Dot status={dot} seen={seen} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={`truncate text-[13px] text-fg ${on ? 'font-semibold' : 'font-medium'}`}>{name}</span>
              <span className={`shrink-0 text-[11px] ${live ? 'font-medium text-accent' : 'text-muted'}`}>{state}</span>
            </span>
            {detail && <span className="block truncate text-[12px] text-muted">{detail}</span>}
          </span>
          <Stamp at={at} />
          <span aria-hidden className={`flex w-4 shrink-0 justify-end text-accent ${on ? '' : 'invisible'}`}>
            <Check size={16} />
          </span>
        </button>
      </li>
    );
  };
  const chip = (id: string, label: string, dot: Status, seen: boolean, state: string) => {
    const on = (selected ?? '') === id;
    return (
      <button
        key={id}
        ref={on ? current : undefined}
        type="button"
        aria-pressed={on}
        aria-label={`${label}, ${state}`}
        title={`${label} · ${state}`}
        onClick={() => onPick(id || undefined)}
        className={`press flex h-8 max-w-[15rem] shrink-0 items-center gap-1.5 rounded-chip border px-2.5 text-[12px] whitespace-nowrap ${
          on ? 'border-transparent bg-surface font-medium text-fg' : 'border-border text-muted'
        }`}
      >
        <Dot status={dot} seen={seen} size={6} />
        <span className="truncate">{label}</span>
      </button>
    );
  };
  return (
    <div className="shrink-0 px-4 pt-1 pb-2">
      <div ref={box} className="relative flex gap-1.5 lg:mx-auto lg:max-w-5xl">
        <button
          ref={trigger}
          type="button"
          aria-label={`All Agents, ${rows.length + 1}${busy ? `, ${busy} running` : ''}`}
          title="All Agents"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`press flex size-8 shrink-0 items-center justify-center rounded-chip border ${
            open ? 'border-transparent bg-surface text-fg' : 'border-border text-muted hover:text-fg'
          }`}
        >
          <ListIcon />
        </button>
        <div
          role="group"
          aria-label="Agents"
          // `hscroll` is not defined in theme.css, so the strip says what it needs.
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
          style={{ maskImage: FADE_END, WebkitMaskImage: FADE_END }}
        >
          {chip('', `${agent} · main`, status, false, mainState)}
          {chips.map((c) => chip(c.id, c.label, c.running ? 'working' : 'done', !c.running, c.running ? 'running' : 'done'))}
        </div>
        {open && (
          <div
            ref={panel}
            role="dialog"
            aria-label="Agents"
            className="absolute right-0 bottom-full left-0 z-40 mb-1.5 flex max-h-[min(26rem,60dvh)] flex-col rounded-xl border border-border bg-elevated shadow-elevated sm:right-auto sm:w-[28rem]"
          >
            <p className="flex shrink-0 items-baseline justify-between px-3.5 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
              Agents
              <span className="font-normal tracking-normal normal-case tabular-nums">
                {busy ? `${busy} running · ` : ''}{rows.length + 1}
              </span>
            </p>
            <ul className="min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
              {row(undefined, 0, agent, 'main', status, false, mainState, status === 'working' || status === 'blocked')}
              {rows.map((r) => row(r.agent.id, r.depth, r.agent.type?.trim() || 'Subagent', r.agent.description?.trim(), r.running ? 'working' : 'done', !r.running, r.running ? 'running' : 'done', r.running, r.agent.at))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** The main Agent's state in the switcher, in the header's words. */
const word = (s: Status) => (s === 'blocked' ? 'needs you' : s);

/** Rows with a bullet each: the list panel's button. */
const ListIcon = () => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth={2.6} />
  </svg>
);

// The strip's fade, on the right edge only; the last chip stays readable once scrolled to.
const FADE_END = 'linear-gradient(to right,#000 calc(100% - 16px),transparent)';

/** What a poll can add to a conversation: a turn, a tool row, or text on the last turn. */
const tail = (chat: ChatResponse) => {
  const last = chat.turns.at(-1);
  return `${chat.turns.length}:${last?.tools.length ?? 0}:${last?.text.length ?? 0}`;
};

/** A reply that waits for its answer longer than this, with the Status never moving, stops showing the dots. */
const AWAIT_MS = 30_000;

export function Chat({
  paneKey,
  revision,
  onUnavailable,
  agent,
  status,
  lines,
  profile,
  onReview,
  approval,
}: {
  paneKey: string;
  revision: number;
  onUnavailable: () => void;
  /** The Pane's Agent, by its Mux name ("claude"). */
  agent: string;
  status: Status;
  /** This Pane's Screen, for Claude's spinner line; null while it has not arrived. */
  lines: Span[][] | null;
  profile: Profile;
  /** Brings the blocked prompt's card into view. */
  onReview?: () => void;
  /** Set while the Pane is blocked: the prompt is answered in the transcript. */
  approval?: Approval | null;
}) {
  const [selected, setSelected] = useState<string | undefined>(() => readSubagent(paneKey));
  const [data, setData] = useState<{ agent?: string; chat: ChatResponse } | null>(null);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  /** Subagents whose Task row has its result in a transcript loaded so far: they have finished. */
  const [finished, setFinished] = useState<ReadonlySet<string>>(() => new Set());
  // The response on screen: the selected conversation's, or nothing while it loads.
  const view = data && data.agent === selected ? data.chat : null;
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Each conversation's scroll, kept across switches; null means "at the bottom". */
  const scrolls = useRef(new Map<string, number | null>());
  const restore = useRef<number | null>(null);
  /** New turns arrived below while the user reads further up. */
  const [fresh, setFresh] = useState(false);
  /** The approval row appeared below while the user reads further up. */
  const [asking, setAsking] = useState(false);
  const shown = useRef<ChatResponse | null>(null);
  const all = useSyncExternalStore(subscribePending, pendingSnapshot);
  const waiting = all.filter((p) => p.paneKey === paneKey);
  // The Hub re-reads the transcript on a revision, which may come late or not at all for a
  // write; a fresh send asks again soon after, when the Agent has usually logged it.
  const [nudge, setNudge] = useState(0);
  const sentIds = waiting.filter((p) => p.state === 'sent').map((p) => p.id).join();
  useEffect(() => {
    if (!sentIds) return;
    const timers = [600, 2000, 5000].map((ms) => setTimeout(() => setNudge((n) => n + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [sentIds]);

  const pick = (id?: string) => {
    if (id === selected) return;
    const el = box.current;
    if (el) scrolls.current.set(selected ?? '', pinned.current ? null : el.scrollTop);
    const saved = scrolls.current.get(id ?? '');
    pinned.current = saved === undefined || saved === null;
    restore.current = saved ?? null;
    writeSubagent(paneKey, id);
    setFresh(false);
    setSelected(id);
  };

  // The Composer says where a reply goes while a subagent is on screen.
  useEffect(() => {
    setShowing(paneKey, selected);
    return () => setShowing(paneKey, undefined);
  }, [paneKey, selected]);

  // The Chat view asks the Hub for what changed since its cursor (ADR 0007): a `chat` event
  // from the Hub wakes it at once, and a slow poll covers a missed event, because herdr moves
  // a Pane's revision on the title, cwd and Status only. The first ask sends an empty cursor,
  // which the Hub answers as a reset. The next ask waits for the previous one; a revision, a
  // send or a Status change asks at once.
  const pace = useRef({ fast: false, blocked: false });
  pace.current = { fast: status === 'working' || waiting.some((p) => p.state !== 'held' && p.state !== 'failed'), blocked: status === 'blocked' };
  const poke = useRef(() => {});
  useEffect(() => {
    const base = `/api/panes/${encodeURIComponent(paneKey)}/chat?since=`;
    const agentQuery = selected ? `&agent=${encodeURIComponent(selected)}` : '';
    const controller = new AbortController();
    let cursor = '';
    let turns: Turn[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false, again = false, loaded = false, quiet = 0;
    const next = () => {
      clearTimeout(timer);
      if (controller.signal.aborted || document.visibilityState === 'hidden') return;
      const { fast, blocked } = pace.current;
      if (fast || blocked) quiet = 0; // the 30 s back-off counts idle 304s only
      timer = setTimeout(run, fast ? 1_500 : blocked ? 5_000 : quiet >= 4 ? 30_000 : 15_000);
    };
    const run = async () => {
      clearTimeout(timer);
      if (busy) { again = true; return; }
      busy = true;
      try {
        const response = await fetch(`${base}${encodeURIComponent(cursor)}${agentQuery}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw Object.assign(new Error(String(response.status)), { gone: response.status === 404 || response.status === 501 });
        const delta = (await response.json()) as ChatDelta;
        if (!Array.isArray(delta.upserts)) throw new Error('invalid chat');
        const merged = mergeTurns(turns, delta);
        cursor = delta.cursor;
        if (merged === turns && loaded && !delta.subagents) quiet++;
        else {
          quiet = 0;
          loaded = true;
          turns = merged;
          setData((prev) => ({
            agent: selected,
            chat: { sessionId: delta.sessionId, turns, at: Date.now(), subagents: delta.subagents ?? (prev && prev.agent === selected ? prev.chat.subagents : undefined), ...(selected ? { agent: selected } : {}) },
          }));
          if (delta.subagents) setSubagents(delta.subagents);
          const done = finishedIn(turns);
          setFinished((prev) => (done.every((id) => prev.has(id)) ? prev : new Set([...prev, ...done])));
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        // A transcript that went away, or one that never loaded: a subagent's falls back to
        // Main, Main's to Screen. A blip on a loaded view only waits for the next poll.
        if (!loaded || (error as { gone?: boolean }).gone) {
          controller.abort();
          if (selected) pick(undefined);
          else onUnavailable();
          return;
        }
      } finally { busy = false; }
      if (again) { again = false; void run(); } else next();
    };
    poke.current = () => void run();
    const onChat = (event: Event) => {
      const wake = (event as CustomEvent<ChatEvent>).detail;
      if (wake.pane === paneKey && wake.agent === selected && wake.cursor !== cursor) void run();
    };
    addEventListener(CHAT_EVENT, onChat);
    const onVisible = () => { if (document.visibilityState === 'visible') void run(); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', onVisible);
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener(CHAT_EVENT, onChat);
      poke.current = () => {};
    };
  }, [paneKey, selected, onUnavailable]);
  // A revision, a send's nudge or a Status change asks now instead of at the next tick.
  const asked = useRef(`${revision} ${nudge} ${status}`);
  useEffect(() => {
    const now = `${revision} ${nudge} ${status}`;
    if (now !== asked.current) poke.current();
    asked.current = now;
  }, [revision, nudge, status]);

  // A remembered subagent the transcript no longer lists: back to Main.
  useEffect(() => {
    if (selected && data && !data.agent && !subagents.some((s) => s.id === selected)) pick(undefined);
  }, [data, subagents, selected]);

  // A pending turn goes the moment its real turn is in Main's transcript.
  useEffect(() => {
    if (data && !data.agent) dropPending(settled(data.chat.turns, waiting));
  }, [data, waiting]);

  // A new send is the user's own action: follow it down even when scrolled up, and it went
  // to the main Agent, so a subagent view gives way to Main where the reply shows.
  const newest = waiting.at(-1)?.id;
  const followed = useRef(newest);
  useEffect(() => {
    if (newest !== undefined && newest !== followed.current && selected) pick(undefined);
  }, [newest]);
  useLayoutEffect(() => {
    const el = box.current;
    if (newest !== undefined && newest !== followed.current) pinned.current = true;
    followed.current = newest;
    const before = shown.current;
    shown.current = view;
    if (!el || !view) return;
    if (restore.current !== null) {
      el.scrollTop = restore.current;
      restore.current = null;
    } else if (pinned.current) el.scrollTop = el.scrollHeight;
    else if (before && before !== view && before.agent === view.agent && tail(before) !== tail(view)) setFresh(true);
  }, [view, newest]);

  // Images load after the turns render and grow the list; a pinned view follows them down.
  useEffect(() => {
    const el = box.current;
    const list = el?.firstElementChild;
    if (!el || !list) return;
    const observer = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // A new prompt comes into view, unless the user reads further up: then the pill says so.
  const prompt = approval && view ? approval.explain.promptId ?? 'mock' : null;
  useLayoutEffect(() => {
    const el = box.current;
    const row = approval?.ref.current;
    if (!prompt || !el || !row) {
      setAsking(false);
      return;
    }
    if (!pinned.current) {
      setAsking(true);
      return;
    }
    // A row taller than the view shows its top (the command); else the bottom stays pinned.
    if (row.offsetHeight > el.clientHeight) row.scrollIntoView({ block: 'start' });
    else el.scrollTop = el.scrollHeight;
  }, [prompt]);

  // A delivered reply shows the dots before the Status catches up: from the send until the
  // Status turns working (it then speaks for itself), an assistant turn arrives, or AWAIT_MS.
  const mainTurns = data && !data.agent ? data.chat.turns : null;
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const counted = useRef(new Set<number>());
  useEffect(() => {
    const fresh = waiting.filter((p) => p.state === 'sent' && !counted.current.has(p.id));
    if (!fresh.length) return;
    fresh.forEach((p) => counted.current.add(p.id));
    setAwaiting(mainTurns?.length ?? 0);
  }, [sentIds]);
  useEffect(() => {
    if (awaiting === null) return;
    if (status === 'working' || mainTurns?.slice(awaiting).some((t) => t.role === 'assistant')) return setAwaiting(null);
    // ponytail: a fixed cap for a Mux that never reports working (tmux); a Status event would be exact.
    const t = setTimeout(() => setAwaiting(null), AWAIT_MS);
    return () => clearTimeout(t);
  }, [awaiting, status, mainTurns]);

  const spinner = useMemo(
    () => (lines && status === 'working' ? toolbarFromScreen(profile, lines.map((spans) => spans.map((s) => s.text).join(''))).spinner : undefined),
    [lines, profile, status],
  );
  const busy = status === 'blocked' || status === 'working' || awaiting !== null;

  const byId = useMemo(() => new Map(subagents.map((s) => [s.id, s])), [subagents]);
  const open = selected ? byId.get(selected) : undefined;
  const live = status === 'working' || status === 'blocked';
  const running = useCallback((item: Subagent) => subagentRunning(item, subagents, finished, live), [subagents, finished, live]);
  const openRunning = open ? running(open) : false;
  const pendingShown = selected ? [] : waiting;
  const target = approval && view ? pendingTool(view.turns) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selected && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-caption">
            <Dot status={openRunning ? 'working' : 'done'} seen={!openRunning} size={7} />
            <span className="min-w-0 truncate">
              <span className="font-semibold text-fg">{open?.type?.trim() || 'Subagent'}</span>
              <span className={openRunning ? 'text-accent' : 'text-muted'}> {openRunning ? 'running' : 'done'}</span>
              {open?.description?.trim() && <span className="text-muted"> · {open.description.trim()}</span>}
            </span>
          </p>
          <button type="button" onClick={() => pick(undefined)} className="press -my-1 inline-flex min-h-9 shrink-0 items-center text-caption font-semibold text-accent">
            Back to {agent}
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={box}
        aria-busy={!view}
        aria-label={open ? `${subagentName(open)}, subagent transcript` : `${agent} transcript`}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (pinned.current) setFresh(false);
          const row = approval?.ref.current;
          if (asking && row && row.getBoundingClientRect().top < el.getBoundingClientRect().bottom - 48) setAsking(false);
        }}
        className={`relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 ${subagents.length ? 'pb-4' : 'pb-10'}`}
      >
        <div>
          {!view ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-14 w-4/5 rounded-card" />
              <Skeleton className="ml-auto h-11 w-2/3 rounded-card" />
              <Skeleton className="h-20 w-5/6 rounded-card" />
            </div>
          ) : view.turns.length === 0 && !pendingShown.length && !approval ? (
            <p className="text-caption text-muted">No turns yet</p>
          ) : (
            <ol className="flex flex-col gap-4">
              {view.turns.map((turn, turnIndex) => {
                const assistant = turn.role === 'assistant';
                const tools = assistant ? turn.tools : [];
                return (
                  <li key={turnIndex} className={`flex flex-col ${assistant ? 'items-start' : 'items-end'}`}>
                    {(turn.text || Boolean(turn.images?.length)) && (
                      <div
                        className={`min-w-0 max-w-[88%] break-words rounded-card px-3 py-2.5 text-body ${
                          assistant ? 'bg-surface text-fg' : 'bg-accent/10 text-fg'
                        }`}
                      >
                        {turn.text && <Markdown text={turn.text} />}
                        {turn.images?.length ? (
                          <span className={`block ${turn.text ? 'mt-2' : ''}`}>
                            <Gallery
                              images={turn.images.map((image, n, all) => ({
                                src: image.imageId !== undefined ? chatImage(paneKey, image.imageId, selected) : image.src && safeImage(image.src),
                                alt: all.length > 1 ? `Image you pasted, ${n + 1} of ${all.length}` : 'Image you pasted',
                              }))}
                            />
                          </span>
                        ) : null}
                      </div>
                    )}
                    {tools.length > 0 && (
                      <ul className="mt-1.5 flex w-[min(92%,42rem)] flex-col gap-1">
                        {tools.map((tool, toolIndex) => approval && target?.turn === turnIndex && target.tool === toolIndex ? (
                          <ApprovalItem
                            key={`${tool.name}-${toolIndex}`}
                            approval={approval}
                            agent={agent}
                            tool={tool}
                            at={toolIndex === tools.length - 1 ? turn.at : undefined}
                          />
                        ) : (
                          <ToolRow
                            key={`${tool.name}-${toolIndex}`}
                            paneKey={paneKey}
                            agent={selected}
                            tool={tool}
                            at={toolIndex === tools.length - 1 ? turn.at : undefined}
                            subagent={tool.subagentId ? byId.get(tool.subagentId) : undefined}
                            onOpenSubagent={pick}
                          />
                        ))}
                      </ul>
                    )}
                    {tools.length === 0 && (
                      <span className={`mt-1 px-1 ${assistant ? '' : 'text-right'}`}>
                        <Stamp at={turn.at} />
                      </span>
                    )}
                  </li>
                );
              })}
              {pendingShown.map((entry) => <PendingTurn key={`pending-${entry.id}`} entry={entry} />)}
              {approval && !target && <ApprovalItem approval={approval} agent={agent} />}
            </ol>
          )}
          {view && busy && !approval && <Working agent={agent} status={status === 'blocked' ? 'blocked' : 'working'} spinner={spinner} onReview={onReview} />}
        </div>
      </div>
      {asking && approval ? (
        <button
          type="button"
          onClick={() => {
            setAsking(false);
            onReview?.();
          }}
          className="absolute inset-x-0 bottom-2 mx-auto flex w-max items-center gap-1.5 rounded-chip bg-warn px-3 py-1.5 text-caption font-semibold shadow-elevated"
          style={{ color: ON_WARN }}
        >
          Needs your approval
          <Down />
        </button>
      ) : fresh && (
        <button
          type="button"
          onClick={() => {
            const el = box.current;
            if (el) el.scrollTop = el.scrollHeight;
            pinned.current = true;
            setFresh(false);
          }}
          className="absolute inset-x-0 bottom-2 mx-auto flex w-max items-center gap-1.5 rounded-chip bg-elevated px-3 py-1.5 text-caption font-medium text-fg shadow-elevated"
        >
          <Down />
          New messages
        </button>
      )}
      </div>
      {subagents.length > 0 && (
        <Switcher agent={agent} status={status} subagents={subagents} running={running} selected={selected} onPick={pick} />
      )}
    </div>
  );
}
