import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { timeAgo } from './home.tsx';
import { SegmentedControl, Skeleton } from './halaska-kit';

export type LensMode = 'chat' | 'screen';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  tools: { name: string; brief: string }[];
  at?: number;
}

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

  return (
    <div
      ref={box}
      aria-busy={!data}
      aria-label="Chat transcript"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
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
                {turn.text && (
                  <div
                    className={`max-w-[88%] whitespace-pre-wrap break-words rounded-card px-3 py-2.5 text-body ${
                      assistant ? 'bg-surface text-fg' : 'bg-accent/10 text-fg'
                    }`}
                  >
                    {turn.text}
                  </div>
                )}
                {tools.length > 0 && (
                  <ul className="mt-1.5 flex w-[min(92%,42rem)] flex-col gap-1">
                    {tools.map((tool, toolIndex) => (
                      <li
                        key={`${tool.name}-${toolIndex}`}
                        className="grid min-h-7 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-chip bg-surface px-2 py-1 font-mono text-caption"
                      >
                        <span
                          title={tool.name}
                          className="max-w-32 truncate rounded-chip border border-border bg-bg px-1.5 py-0.5 text-[10px] leading-none text-fg"
                        >
                          {tool.name}
                        </span>
                        <span title={tool.brief} className="truncate text-muted">{tool.brief}</span>
                        {toolIndex === tools.length - 1 && <Stamp at={turn.at} />}
                      </li>
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
        </ol>
      )}
    </div>
  );
}
