import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { timeAgo } from './home.tsx';
import { SegmentedControl, Skeleton } from './halaska-kit';
import { CopyButton, Markdown } from './markdown.tsx';
import { ChevronRight } from './icons.tsx';
import { Gallery, Picture, Thumb, chatImage, fileImage, fileView, safeImage } from './image.tsx';
import type { ChatResponse, Subagent, Tool, Turn } from '../shared/chat.ts';
import type { Span, Status } from '../shared/types.ts';
import { deliver, dropPending, pendingSnapshot, settled, subscribePending, type Pending } from './pending.ts';
import { Preview, linkLabel, previewSrc, safeLink } from './preview.tsx';
import { toolbarFromScreen, type Profile } from './profiles.ts';
import { readSubagent, setShowing, subagentChips, subagentName, writeSubagent } from './subagents.ts';

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
const SUMMARY = 'cursor-pointer list-none rounded-chip [&::-webkit-details-marker]:hidden';

/** The open part of a tool row: the image, the page preview, the input, and the output. */
function ToolBody({ tool, image, preview }: { tool: Tool; image?: ReturnType<typeof toolImage>; preview?: { src: string; title: string } }) {
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
 * started a subagent offers its conversation; HTML the Agent wrote previews when opened.
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

  return (
    <li className={ROW}>
      <details className="group">
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
            {at ? <Stamp at={at} /> : <span />}
            <ChevronRight className="text-muted transition-transform group-open:rotate-90" />
          </summary>
        )}
        <ToolBody tool={tool} image={image} preview={preview} />
      </details>
      {tool.subagentId && (
        <button
          type="button"
          onClick={() => onOpenSubagent(tool.subagentId!)}
          className="press flex min-h-11 w-full items-center justify-between gap-2 rounded-b-chip border-t border-border px-3 text-left text-caption font-semibold text-accent lg:min-h-9"
        >
          Open conversation
          <ChevronRight size={16} />
        </button>
      )}
    </li>
  );
}

const capital = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`;

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

/** "Main", then one chip per subagent, newest last; one row that scrolls sideways. */
function Switcher({ subagents, selected, onPick }: { subagents: Subagent[]; selected?: string; onPick: (id?: string) => void }) {
  const chips = useMemo(() => [{ id: '', label: 'Main' }, ...subagentChips(subagents)], [subagents]);
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), [selected]);
  return (
    <div className="shrink-0 px-4 pt-1 pb-2">
      <div
        role="group"
        aria-label="Conversations"
        // `hscroll` is not defined in theme.css, so the strip says what it needs.
        className="flex gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] lg:mx-auto lg:max-w-5xl"
        style={{ maskImage: FADE_END, WebkitMaskImage: FADE_END }}
      >
        {chips.map((chip) => {
          const on = (selected ?? '') === chip.id;
          return (
            <button
              key={chip.id}
              ref={on ? current : undefined}
              type="button"
              aria-pressed={on}
              title={chip.label}
              onClick={() => onPick(chip.id || undefined)}
              className={`press flex h-8 max-w-[15rem] shrink-0 items-center rounded-chip border px-2.5 text-[12px] whitespace-nowrap ${
                on ? 'border-transparent bg-surface font-medium text-fg' : 'border-border text-muted'
              }`}
            >
              <span className="truncate">{chip.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The strip's fade, on the right edge only; the last chip stays readable once scrolled to.
const FADE_END = 'linear-gradient(to right,#000 calc(100% - 16px),transparent)';

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
}) {
  const [selected, setSelected] = useState<string | undefined>(() => readSubagent(paneKey));
  const [data, setData] = useState<{ agent?: string; chat: ChatResponse } | null>(null);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  // The response on screen: the selected conversation's, or nothing while it loads.
  const view = data && data.agent === selected ? data.chat : null;
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Each conversation's scroll, kept across switches; null means "at the bottom". */
  const scrolls = useRef(new Map<string, number | null>());
  const restore = useRef<number | null>(null);
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
    setSelected(id);
  };

  // The Composer says where a reply goes while a subagent is on screen.
  useEffect(() => {
    setShowing(paneKey, selected);
    return () => setShowing(paneKey, undefined);
  }, [paneKey, selected]);

  useEffect(() => {
    const controller = new AbortController();
    const query = selected ? `?agent=${encodeURIComponent(selected)}` : '';
    fetch(`/api/panes/${encodeURIComponent(paneKey)}/chat${query}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<ChatResponse>;
      })
      .then((result) => {
        if (!Array.isArray(result.turns)) throw new Error('invalid chat');
        setData({ agent: selected, chat: result });
        if (result.subagents) setSubagents(result.subagents);
      })
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        // A subagent's transcript that went away falls back to Main; Main's falls back to Screen.
        if (selected) pick(undefined);
        else onUnavailable();
      });
    return () => controller.abort();
  }, [paneKey, selected, revision, nudge, onUnavailable]);

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
    if (!el || !view) return;
    if (restore.current !== null) {
      el.scrollTop = restore.current;
      restore.current = null;
    } else if (pinned.current) el.scrollTop = el.scrollHeight;
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
  const pendingShown = selected ? [] : waiting;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selected && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5">
          <p className="min-w-0 flex-1 truncate text-caption">
            <span className="font-semibold text-fg">Subagent</span>
            {open && (open.type || open.description) && (
              <span className="text-muted"> · {[open.type, open.description].filter(Boolean).join(' — ')}</span>
            )}
          </p>
          <button type="button" onClick={() => pick(undefined)} className="press -my-1 inline-flex min-h-9 shrink-0 items-center text-caption font-semibold text-accent">
            Back to Main
          </button>
        </div>
      )}
      <div
        ref={box}
        aria-busy={!view}
        aria-label={open ? `Subagent transcript, ${subagentName(open)}` : 'Chat transcript'}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 ${subagents.length ? 'pb-4' : 'pb-10'}`}
      >
        <div>
          {!view ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-14 w-4/5 rounded-card" />
              <Skeleton className="ml-auto h-11 w-2/3 rounded-card" />
              <Skeleton className="h-20 w-5/6 rounded-card" />
            </div>
          ) : view.turns.length === 0 && !pendingShown.length ? (
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
                                src: image.src && safeImage(image.src),
                                alt: all.length > 1 ? `Image you pasted, ${n + 1} of ${all.length}` : 'Image you pasted',
                              }))}
                            />
                          </span>
                        ) : null}
                      </div>
                    )}
                    {tools.length > 0 && (
                      <ul className="mt-1.5 flex w-[min(92%,42rem)] flex-col gap-1">
                        {tools.map((tool, toolIndex) => (
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
            </ol>
          )}
          {view && busy && <Working agent={agent} status={status === 'blocked' ? 'blocked' : 'working'} spinner={spinner} onReview={onReview} />}
        </div>
      </div>
      {subagents.length > 0 && <Switcher subagents={subagents} selected={selected} onPick={pick} />}
    </div>
  );
}
