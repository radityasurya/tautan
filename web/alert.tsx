import { useEffect, useRef, useState } from 'react';
import type { State, Status } from '../shared/types.ts';
import { haptic, reducedMotion } from './app.tsx';
import { Dot, statusText, unseen } from './home.tsx';

type Need = { key: string; title: string; status: 'blocked' | 'done' };
type Phase = 'entering' | 'shown' | 'leaving';

const NEEDS = (status: Status) => status === 'blocked' || status === 'done';
const DISPLAY_MS = 3600;

export function NeedsCard({
  state,
  openPaneKey,
  onOpen,
}: {
  state: State | null;
  openPaneKey?: string;
  onOpen: (key: string) => void;
}) {
  const previous = useRef<Map<string, Status> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const frame = useRef<number>(undefined);
  const deadline = useRef(0);
  const remaining = useRef(DISPLAY_MS);
  const touch = useRef({ x: 0, y: 0 });
  const [queue, setQueue] = useState<Need[]>([]);
  const [current, setCurrent] = useState<Need | null>(null);
  const [phase, setPhase] = useState<Phase>('entering');
  const reduce = reducedMotion();

  useEffect(() => {
    if (!state) return;
    const next = new Map(state.panes.map((pane) => [pane.key, pane.status]));
    const before = previous.current;
    previous.current = next;
    if (!before || document.visibilityState !== 'visible') return;

    const arrivals: Need[] = [];
    for (const pane of state.panes) {
      const old = before.get(pane.key);
      if (
        old !== undefined &&
        !NEEDS(old) &&
        NEEDS(pane.status) &&
        unseen(pane) &&
        pane.key !== openPaneKey
      ) {
        arrivals.push({ key: pane.key, title: pane.title, status: pane.status });
      }
    }
    if (arrivals.length) setQueue((items) => [...items, ...arrivals]);
  }, [state, openPaneKey]);

  useEffect(() => {
    if (!current && queue.length) {
      setCurrent(queue[0]!);
      setQueue((items) => items.slice(1));
      setPhase('entering');
    } else if (current && queue.length && phase !== 'leaving') {
      setPhase('leaving');
    }
  }, [current, phase, queue]);

  useEffect(() => {
    if (!openPaneKey) return;
    setQueue((items) => items.filter((item) => item.key !== openPaneKey));
    if (current?.key === openPaneKey) setPhase('leaving');
  }, [current, openPaneKey]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!current) return;

    if (phase === 'entering') {
      remaining.current = DISPLAY_MS;
      frame.current = requestAnimationFrame(() => setPhase('shown'));
    } else if (phase === 'shown') {
      deadline.current = performance.now() + remaining.current;
      timer.current = setTimeout(() => setPhase('leaving'), remaining.current);
    } else {
      timer.current = setTimeout(() => setCurrent(null), reduce ? 120 : 200);
    }

    return () => {
      clearTimeout(timer.current);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [current, phase, reduce]);

  if (!current) return null;

  const pause = () => {
    if (phase !== 'shown') return;
    clearTimeout(timer.current);
    remaining.current = Math.max(0, deadline.current - performance.now());
  };
  const resume = () => {
    if (phase !== 'shown') return;
    deadline.current = performance.now() + remaining.current;
    timer.current = setTimeout(() => setPhase('leaving'), remaining.current);
  };
  const open = () => {
    haptic();
    onOpen(current.key);
    setPhase('leaving');
  };
  const label = current.status === 'blocked' ? 'Blocked' : 'Done';
  const hidden = phase !== 'shown';
  const transform = reduce
    ? 'none'
    : phase === 'entering'
      ? 'translateY(-100%)'
      : phase === 'leaving'
        ? 'scaleY(0)'
        : 'none';

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[60] flex justify-start md:justify-center">
      <div
        role="status"
        aria-atomic="true"
        className="pointer-events-auto h-11 w-max origin-top rounded-card bg-elevated text-fg shadow-elevated"
        style={{
          maxWidth: 'min(340px, 100vw)',
          opacity: hidden ? 0 : 1,
          transform,
          transition: reduce
            ? 'opacity 120ms ease-out'
            : 'transform 200ms cubic-bezier(.2,0,0,1), opacity 150ms ease-out',
        }}
      >
        <button
          type="button"
          aria-label={`Open ${current.title}: ${label}`}
          className="flex h-11 min-w-0 max-w-full items-center gap-2 px-3 text-left text-body"
          style={{ touchAction: 'pan-x' }}
          onClick={open}
          onTouchStart={(event) => {
            const point = event.touches[0];
            touch.current = { x: point?.clientX ?? 0, y: point?.clientY ?? 0 };
            pause();
          }}
          onTouchEnd={(event) => {
            const point = event.changedTouches[0];
            const dx = (point?.clientX ?? 0) - touch.current.x;
            const dy = (point?.clientY ?? 0) - touch.current.y;
            event.preventDefault();
            resume();
            if (dy <= -24 && Math.abs(dy) > Math.abs(dx)) setPhase('leaving');
            else open();
          }}
          onTouchCancel={resume}
        >
          <span className="min-w-0 truncate">{current.title}</span>
          <span className={`flex shrink-0 items-center gap-1.5 font-medium ${statusText[current.status]}`}>
            <Dot status={current.status} />
            {label}
          </span>
        </button>
      </div>
    </div>
  );
}
