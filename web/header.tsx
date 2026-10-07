import { useEffect, useState, type ReactNode } from 'react';
import type { Status } from '../shared/types.ts';
import { Link } from './app.tsx';
import { LensSwitch, type LensMode } from './chat.tsx';
import { Dot, statusText } from './home.tsx';
import { Back, ChatLens, ChevronDown, More, ScreenLens } from './icons.tsx';

/**
 * Sticky top bar, shared by the root screens and the Pane. One 56 px row + safe area, 16 px
 * sides, 44 px icon targets. `large` is the root screens' title: 26 px at rest, and once the
 * document scrolls past a few pixels it shrinks to the 44 px bar and gains a hairline.
 * `compact` is the Pane's: the 17 px title from the start and no scroll listener, because
 * the Pane's grid scrolls in its own box. `leading` sits before the title (the back chevron).
 * `tall` is the desktop sidebar's: 64 px, the Pane header's height, so the two line up.
 */
export function TopBar({
  title,
  leading,
  right,
  below,
  size = 'large',
  tall,
}: {
  title: string;
  leading?: ReactNode;
  right?: ReactNode;
  below?: ReactNode;
  size?: 'large' | 'compact';
  tall?: boolean;
}) {
  const shrinks = size === 'large';
  const [scrolled, setScrolled] = useState(() => shrinks && scrollY > 24);
  useEffect(() => {
    if (!shrinks) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrolled(scrollY > 24));
    };
    addEventListener('scroll', onScroll, { passive: true });
    return () => { removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [shrinks]);
  return (
    <header
      className={`sticky top-0 z-30 shrink-0 bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur-md transition-[box-shadow] duration-200 ${
        scrolled ? 'shadow-[0_1px_0_0_var(--border)]' : ''
      }`}
    >
      {/* `@container`, so a caller can cap an item at a share of the row (`45cqw`). */}
      <div
        className={`@container flex items-center justify-between px-4 transition-[height] duration-200 motion-reduce:transition-none ${
          tall ? 'h-16' : scrolled ? 'h-11' : 'h-14'
        }`}
      >
        {leading}
        <h1
          className={`min-w-0 flex-1 origin-left truncate font-semibold tracking-tight transition-[font-size] duration-200 motion-reduce:transition-none ${
            shrinks && !scrolled ? 'text-[26px]' : 'text-[17px]'
          }`}
        >
          {title}
        </h1>
        {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
      </div>
      {below}
    </header>
  );
}

/** The header's word for a Status. Blocked is said as what it asks of you. */
const word = (s: Status) => (s === 'blocked' ? 'needs you' : s);

/** The desktop Status chip, tinted with its own colour at 12 %. */
const TINT: Record<Status, string> = {
  blocked: 'bg-warn/12',
  working: 'bg-accent/12',
  done: 'bg-ok/12',
  idle: 'bg-surface',
  unknown: 'bg-surface',
};

/**
 * The Pane's header, one component at both widths (docs/WAVES.md 10.2, variants A and C).
 * Phone: back · title over `● status · agent · host / workspace / tab ⌄` (one Switch trigger;
 * the path gives way first) · lens icons · ⋯. At `lg`: the title over the small muted path,
 * the Status chip, the labelled lens, then ⋯. Read aloud lives in ⋯ at both widths. Blocked
 * draws a 2 px warn line under the bar and says "needs you"; the answer lives in the
 * blocked card (the dock, or the Chat view's approval row), never in the header.
 */
export function PaneHeader({
  desktop,
  title,
  path,
  status,
  agent,
  lens,
  onLens,
  onSwitch,
  onMore,
}: {
  desktop: boolean;
  title: string;
  path: (string | undefined)[];
  status: Status;
  agent?: string;
  lens: LensMode;
  /** Absent for a shell Pane: there is no Chat to switch to. */
  onLens?: (mode: LensMode) => void;
  onSwitch: () => void;
  onMore: () => void;
}) {
  const blocked = status === 'blocked';
  const back = (
    <Link
      to="#/"
      aria-label="All panes"
      className={`flex shrink-0 items-center justify-center text-accent ${desktop ? 'size-9' : 'size-11'}`}
    >
      <Back />
    </Link>
  );
  const more = (
    <button
      type="button"
      aria-label="More"
      onClick={onMore}
      className={`press flex shrink-0 items-center justify-center text-muted ${desktop ? 'size-9' : 'h-10 w-11'}`}
    >
      <More size={desktop ? 18 : 20} />
    </button>
  );
  const parts = path.filter(Boolean);
  const statusWord = (
    <span aria-live="polite" className={`shrink-0 font-medium ${statusText[status]}`}>
      {word(status)}
    </span>
  );

  return (
    <header
      className={`sticky top-0 z-30 shrink-0 bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur-md ${
        blocked ? 'shadow-[inset_0_-2px_0_0_var(--warn)]' : ''
      }`}
    >
      {desktop ? (
        <div className="flex h-16 items-center gap-3 pr-4 pl-2">
          {back}
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-[17px] leading-[22px] font-semibold tracking-tight">{title}</h1>
            <p className="truncate text-[11px] leading-4 text-muted">
              {parts.map((part, i) => (
                <span key={i}>
                  {i > 0 && <span aria-hidden className="opacity-50"> / </span>}
                  {part}
                </span>
              ))}
            </p>
          </div>
          <button
            type="button"
            aria-label={`Switch Pane, ${word(status)}`}
            onClick={onSwitch}
            className={`press flex h-9 shrink-0 items-center gap-1.5 rounded-composer px-3 text-[12px] ${TINT[status]}`}
          >
            <Dot status={status} size={7} />
            {statusWord}
            <span className="text-muted">· {agent ?? 'shell'}</span>
            <span aria-hidden className="flex text-muted">
              <ChevronDown />
            </span>
          </button>
          {onLens && <LensSwitch value={lens} onChange={onLens} />}
          {more}
        </div>
      ) : (
        <div className="flex h-14 items-center gap-1 pr-2 pl-1">
          {back}
          {/* One trigger: the title and its Status line open Switch. The Status word and the
              agent never truncate; the path gives way first. */}
          <h1 className="min-w-0 flex-1">
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={onSwitch}
              className="press flex w-full min-w-0 flex-col items-start gap-px text-left"
            >
              <span className="w-full truncate text-[16px] font-semibold tracking-tight">{title}</span>
              <span className="flex w-full min-w-0 items-center gap-1.5 text-[12px] font-normal text-muted">
                <Dot status={status} size={7} />
                {statusWord}
                <span className="shrink-0">· {agent ?? 'shell'}</span>
                {parts.length > 0 && <span className="min-w-0 truncate">· {parts.join(' / ')}</span>}
                <span aria-hidden className="flex shrink-0">
                  <ChevronDown />
                </span>
              </span>
            </button>
          </h1>
          {onLens && (
            <div role="group" aria-label="Pane view" className="flex shrink-0 rounded-composer bg-surface p-0.5">
              {(
                [
                  ['chat', 'Chat', <ChatLens key="c" />],
                  ['screen', 'Screen', <ScreenLens key="s" />],
                ] as const
              ).map(([mode, label, icon]) => (
                <button
                  key={mode}
                  type="button"
                  aria-label={label}
                  aria-pressed={lens === mode}
                  onClick={() => onLens(mode)}
                  className={`press flex h-9 w-10 items-center justify-center rounded-chip ${
                    lens === mode ? 'bg-elevated text-fg shadow-sm' : 'text-muted'
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
          )}
          {more}
        </div>
      )}
    </header>
  );
}
