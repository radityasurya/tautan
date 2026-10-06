import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { timeAgo } from './home.tsx';
import { SegmentedControl, Skeleton } from './halaska-kit';
import { CopyButton, Markdown } from './markdown.tsx';
import { ChevronRight } from './icons.tsx';
import { Picture, Thumb, Unavailable, fileImage, fileView, safeImage } from './image.tsx';
import type { Tool, Turn } from '../shared/chat.ts';

export type LensMode = 'chat' | 'screen';


interface ChatResponse {
  sessionId: string;
  turns: Turn[];
  at: number;
}

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
      className="w-[104px] shrink-0 [&_button]:min-h-[38px]"
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
function toolImage(paneKey: string, tool: Tool): { src: string; alt: string; href?: string } | undefined {
  if (!tool.image) return undefined;
  if (tool.via) {
    const src = /^https:/i.test(tool.image) ? safeImage(tool.image) : undefined;
    return src ? { src, alt: `Image sent to ${tool.name}` } : undefined;
  }
  const name = tool.image.split('/').filter(Boolean).at(-1) ?? tool.image;
  return { src: fileImage(paneKey, tool.image), alt: `Image read by Claude: ${name}`, href: fileView(paneKey, tool.image) };
}

function Stamp({ at }: { at?: number }) {
  if (!at) return null;
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
      {timeAgo(at)}
    </time>
  );
}

export function Chat({
  paneKey,
  revision,
  onUnavailable,
}: {
  paneKey: string;
  revision: number;
  onUnavailable: () => void;
}) {
  const [data, setData] = useState<ChatResponse | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/panes/${encodeURIComponent(paneKey)}/chat`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<ChatResponse>;
      })
      .then((result) => {
        if (!Array.isArray(result.turns)) throw new Error('invalid chat');
        setData(result);
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') onUnavailable();
      });
    return () => controller.abort();
  }, [paneKey, revision, onUnavailable]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  // Images load after the turns render and grow the list; a pinned view follows them down.
  useEffect(() => {
    const el = box.current;
    const list = el?.firstElementChild;
    if (!el || !list) return;
    const observer = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    observer.observe(list);
    return () => observer.disconnect();
  }, [data !== null]);

  return (
    <div
      ref={box}
      aria-busy={!data}
      aria-label="Chat transcript"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-10"
    >
      {!data ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-14 w-4/5 rounded-card" />
          <Skeleton className="ml-auto h-11 w-2/3 rounded-card" />
          <Skeleton className="h-20 w-5/6 rounded-card" />
        </div>
      ) : data.turns.length === 0 ? (
        <p className="text-caption text-muted">No turns yet</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {data.turns.map((turn, turnIndex) => {
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
                      <span className={`flex flex-wrap gap-2 ${turn.text ? 'mt-2' : ''}`}>
                        {turn.images.map((image, n) => {
                          const src = image.src && safeImage(image.src);
                          return src
                            ? <Picture key={n} src={src} alt={`Image you pasted, ${n + 1} of ${turn.images!.length}`} />
                            : <Unavailable key={n} why="Image too large to show here" />;
                        })}
                      </span>
                    ) : null}
                  </div>
                )}
                {tools.length > 0 && (
                  <ul className="mt-1.5 flex w-[min(92%,42rem)] flex-col gap-1">
                    {tools.map((tool, toolIndex) => {
                      const image = toolImage(paneKey, tool);
                      return (
                        <li key={`${tool.name}-${toolIndex}`} className="min-w-0 rounded-chip bg-surface">
                          <details className="group">
                            <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-chip px-2 py-1 font-mono text-caption lg:min-h-8 [&::-webkit-details-marker]:hidden">
                              <span
                                title={tool.via ? `${tool.name}, run by ${tool.via}` : tool.name}
                                className={`${tool.via ? 'max-w-44' : 'max-w-32'} truncate rounded-chip border border-border bg-bg px-1.5 py-0.5 text-[10px] leading-none text-fg`}
                              >
                                {tool.via && <span className="text-muted">{tool.via} · </span>}
                                {tool.name}
                              </span>
                              <span className="flex min-w-0 items-center gap-2">
                                {image && <Thumb src={image.src} />}
                                <span title={tool.brief} className="truncate text-muted">{tool.brief}</span>
                              </span>
                              {toolIndex === tools.length - 1 ? <Stamp at={turn.at} /> : <span />}
                              <ChevronRight className="text-muted transition-transform group-open:rotate-90" />
                            </summary>
                            {image && (
                              <div className="border-t border-border p-2">
                                <Picture {...image} />
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
                          </details>
                        </li>
                      );
                    })}
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
        </ol>
      )}
    </div>
  );
}
