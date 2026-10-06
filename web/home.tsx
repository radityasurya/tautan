import { TopBar } from './header.tsx';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  NewTabBody, NewTabResult, NewWorkspaceBody, NewWorkspaceResult, RenameBody, State, StatePane, StateWorkspace, Status,
} from '../shared/types.ts';
import { api, haptic, Link, navigate, opensWith, reducedMotion } from './app.tsx';
import { ChevronDown, ChevronRight, CollapseAll, ExpandAll, More, Plus } from './icons.tsx';
import { Chip, EmptyState, IconButton, SearchInput, SegmentedControl, Skeleton, usePal } from './halaska-kit';
import { ConfirmCloseSheet, MenuSheet, NewTabSheet, NewWorkspaceSheet, RenameSheet } from './sheets.tsx';
import { isUnseen } from '../shared/seen.ts';
import { yesNoKeys } from '../shared/blocked.ts';
import { fetchExplain, ON_WARN, promptLine, sendBlocked, type ExplainResponse } from './blocked.tsx';

// ---- status ----

/** Status → the kit palette. `idle` and `unknown` carry no urgency. */
const COLOR = (pal: ReturnType<typeof usePal>): Record<Status, string> => ({
  blocked: pal.warning,
  working: pal.accent,
  done: pal.success,
  idle: pal.textTertiary,
  unknown: pal.textTertiary,
});

export const statusText: Record<Status, string> = {
  blocked: 'text-warn',
  working: 'text-accent',
  done: 'text-ok',
  idle: 'text-muted',
  unknown: 'text-muted',
};

/** 8 px by default. Filled means unseen; a 1.5 px ring means seen. Decoration only: the
 *  row's `aria-label` and the printed status word carry the fact. */
export function Dot({ status, seen, size = 8 }: { status: Status; seen?: boolean; size?: number }) {
  const c = COLOR(usePal())[status];
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-full"
      style={{ width: size, height: size, boxSizing: 'border-box', ...(seen ? { border: `1.5px solid ${c}` } : { background: c }) }}
    />
  );
}

// ---- seen ----
// tautan's own flag, never written back to the Mux. One revision map, read through a module cache.

let seenAt: Record<string, number> | null = null;
const seen = () => (seenAt ??= JSON.parse(localStorage.getItem('tautan.seen') ?? '{}') as Record<string, number>);

export function markSeen(key: string, revision: number) {
  seen()[key] = revision;
  localStorage.setItem('tautan.seen', JSON.stringify(seen()));
}

/** Seed a new device from its first snapshot. Blocked remains actionable regardless. */
export function seedSeen(panes: StatePane[]) {
  const current = seen();
  if (Object.keys(current).length) return;
  for (const pane of panes) current[pane.key] = pane.revision;
  localStorage.setItem('tautan.seen', JSON.stringify(current));
}

/**
 * `idle` means the user already looked (CONTEXT.md) and `unknown` is all tmux can report,
 * so neither can be unseen. Legacy timestamp entries remain readable while each Pane
 * migrates to a revision the next time it is opened.
 */
export const unseen = (p: StatePane) => isUnseen(p, seen());

export function timeAgo(at?: number): string {
  if (!at) return '';
  const s = Math.max(0, Date.now() - at) / 1000;
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const RANK: Record<Status, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const comparePanes = (a: StatePane, b: StatePane) =>
  RANK[a.status] - RANK[b.status] || (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0);
const basename = (cwd?: string) => cwd?.replace(/\/+$/, '').split('/').pop();
/** `~/projects/tautan` → `~/projects`: where a sibling Workspace would go. */
export const parentDir = (cwd?: string) => cwd?.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || undefined;

/** The Agent most of these Panes run, `''` when none does: the New Tab chip to preselect. */
export function commonAgent(panes: StatePane[]): string {
  const tally = new Map<string, number>();
  for (const p of panes) if (p.agent) tally.set(p.agent, (tally.get(p.agent) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** Blocked reason, else the last non-empty screen line, else the directory. */
const preview = (p: StatePane) => p.lastLine ?? basename(p.cwd) ?? '';

/** Does a row's own text — agent, title, Workspace label — carry the needle? Shared with
 *  the Switch drawer, so one search means one match everywhere. */
export function matchPane(pane: StatePane, needle: string, state?: State | null): boolean {
  if (!needle) return true;
  const workspace = state?.workspaces.find((w) => w.muxKey === pane.muxKey && w.id === pane.workspaceId);
  return `${pane.agent ?? 'shell'} ${pane.title} ${workspace?.label ?? ''}`.toLowerCase().includes(needle);
}

/** A group's Status counts, most urgent first, as `[Status, n]`. `limit` keeps the top ones. */
function tally(panes: StatePane[], limit: number): [Status, number][] {
  return (Object.keys(RANK) as Status[])
    .map((s): [Status, number] => [s, panes.filter((p) => p.status === s).length])
    .filter(([, n]) => n > 0)
    .slice(0, limit);
}

/** The pill's tint per Status: the Status colour at 12 %, and none for the quiet two. */
const PILL: Record<Status, string> = {
  blocked: 'bg-warn/12 text-warn',
  working: 'bg-accent/12 text-accent',
  done: 'bg-ok/12 text-ok',
  idle: 'text-muted',
  unknown: 'text-muted',
};

/** `● 1 blocked`: a Status count as a compact pill. Filled dot for the loud three, ring for the quiet. */
function StatusPill({ status, n }: { status: Status; n: number }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium tabular-nums ${PILL[status]}`}>
      <Dot status={status} seen={status === 'idle' || status === 'unknown'} size={6} />
      {n} {status}
    </span>
  );
}

/** Focus ring for the list's own buttons: inside the edge, so a full-width row never clips it. */
const RING = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

// ---- rows ----

/** The two revealed actions, in px: Rename and Close, 72 each. */
const REVEAL = 144;

/** What a row can do when its Mux writes. Passed in by Home, which owns the sheets. */
export interface RowActions {
  onMenu: (pane: StatePane) => void;
  onRename: (pane: StatePane) => void;
  onClose: (pane: StatePane) => void;
}

/**
 * Apple-style swipe on a Pane row: drag left to reveal Rename and Close. Touch, not
 * pointer — a horizontal drag makes Chromium fire `pointercancel`, so `pointerup` never
 * arrives (the same lesson as the Tab strip). `touch-action: pan-y` keeps vertical
 * scrolls the page's. A tap on an open row closes it instead of navigating. Long-press
 * opens the same actions as a menu, which is also the desktop path.
 */
function Row({ pane, first, actions, context, compact }: {
  pane: StatePane;
  first?: boolean;
  actions?: RowActions;
  context?: string;
  /** The desktop sidebar: one 36 px line, no preview. */
  compact?: boolean;
}) {
  const fresh = unseen(pane);
  const word = pane.status[0]!.toUpperCase() + pane.status.slice(1); // UX §7: the dot never carries Status alone
  const when = timeAgo(pane.statusChangedAt);
  const press = useLongPress(() => actions?.onMenu(pane));
  const [x, setX] = useState(0);
  const [live, setLive] = useState(false);
  const drag = useRef({ x: 0, y: 0, from: 0, at: 0, axis: '' });

  const body = (
    <Link
      to={`#/pane/${encodeURIComponent(pane.key)}`}
      aria-label={[pane.agent ?? 'shell', pane.title, pane.status, fresh ? 'unseen' : 'seen', when]
        .filter(Boolean)
        .join(', ')}
      onClick={(e) => {
        if (x !== 0) {
          e.preventDefault();
          setLive(false);
          setX(0);
        }
      }}
      className={`press flex items-center [-webkit-touch-callout:none] ${RING} ${compact ? 'min-h-9 gap-2.5 px-4 py-1 hover:bg-bg active:bg-bg' : 'min-h-14 gap-3 px-4 py-2.5 hover:bg-surface active:bg-surface'}`}
      {...(actions ? press : {})}
    >
      <Dot status={pane.status} seen={!fresh} />
      {compact ? (
        <span aria-hidden className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={`truncate text-[13px] ${fresh ? 'font-medium text-fg' : 'text-muted'}`}>{pane.title}</span>
          <span className="shrink-0 text-caption text-muted">{pane.agent ?? 'shell'}</span>
        </span>
      ) : (
        <span aria-hidden className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-body text-muted">{pane.agent ?? 'shell'}</span>
            <span className={`truncate text-body ${fresh ? 'font-medium text-fg' : 'text-muted'}`}>{pane.title}</span>
          </span>
          <span className={`truncate text-caption text-muted ${pane.lastLine ? '' : 'font-mono'}`}>
            {word && <span className={statusText[pane.status]}>{word} · </span>}
            {preview(pane)}
            {context && <span className="text-muted/70"> · {context}</span>}
          </span>
        </span>
      )}
      <span aria-hidden className="shrink-0 font-mono text-caption tabular-nums text-muted">
        {when}
      </span>
    </Link>
  );

  if (!actions) return <li className={first ? '' : 'border-t border-border/60'}>{body}</li>;
  return (
    <li className={`relative overflow-hidden ${first ? '' : 'border-t border-border/60'}`}>
      <div className="absolute inset-y-0 right-0 flex" inert={x === 0 ? true : undefined}>
        <button
          type="button"
          aria-label="Rename pane"
          onClick={() => actions.onRename(pane)}
          className="flex w-18 items-center justify-center bg-surface text-[13px] font-medium text-fg active:bg-bg"
        >
          Rename
        </button>
        <button
          type="button"
          aria-label="Close pane"
          onClick={() => actions.onClose(pane)}
          className="flex w-18 items-center justify-center bg-danger text-[13px] font-medium text-bg active:opacity-90"
        >
          Close
        </button>
      </div>
      <div
        className={`relative ${compact ? 'bg-surface' : 'bg-bg'} ${live ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none'}`}
        style={{ transform: `translateX(${x}px)`, touchAction: 'pan-y' }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          drag.current = { x: t?.clientX ?? 0, y: t?.clientY ?? 0, from: x, at: x, axis: '' };
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          const d = drag.current;
          const dx = (t?.clientX ?? 0) - d.x;
          const dy = (t?.clientY ?? 0) - d.y;
          if (!d.axis) {
            if (Math.hypot(dx, dy) < 8) return;
            d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
          }
          if (d.axis !== 'x') return;
          setLive(true);
          d.at = Math.min(0, Math.max(-REVEAL, d.from + dx));
          setX(d.at);
        }}
        onTouchEnd={() => {
          // `at`, not the rendered `x`: a fast flick can end before the last move re-renders.
          if (drag.current.axis === 'x') {
            const open = drag.current.at < -REVEAL / 2;
            if (open && drag.current.at !== -REVEAL) haptic();
            setX(open ? -REVEAL : 0);
          }
          drag.current.axis = '';
          setLive(false);
        }}
      >
        {body}
      </div>
    </li>
  );
}

/**
 * A blocked Pane in Needs you: the Agent, its Workspace and Tab, the command from Explain,
 * and the plain Yes / No of the Pane's own blocked card — the same keys through the same
 * stale-prompt guard. A 409 never re-sends: the answers give way to Re-read. Explain loads
 * only here, so only blocked Panes cost a fetch. `compact` is the desktop sidebar: one
 * 36 px row with Yes only; No stays in the Pane, and the row itself opens it.
 */
function NeedsYouCard({ pane, where, compact }: { pane: StatePane; where?: string; compact?: boolean }) {
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [changed, setChanged] = useState(false);
  /** The send went through: hold the answers until the prompt on screen is a new one. */
  const [sent, setSent] = useState(false);
  const shown = useRef<ExplainResponse | null>(null);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);

  /** One request in flight per card. A load asked for meanwhile runs when it lands, and the
   *  older answer is dropped by the sequence check. A background load never touches
   *  `changed`: only Re-read clears it. */
  const load = () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    const id = ++seq.current;
    fetchExplain(pane.key)
      .then((next) => {
        if (id !== seq.current || queued.current) return;
        if ((next?.promptId ?? null) !== (shown.current?.promptId ?? null)) setSent(false);
        shown.current = next;
        setExplain(next);
      }, () => {}) // offline: keep the Explain already shown
      .finally(() => {
        inFlight.current = false;
        if (queued.current) {
          queued.current = false;
          load();
        } else setLoaded(true);
      });
  };
  /** The user asked to look again: hold the answers until the fresh Explain lands, so a
   *  tap can never carry the prompt id that was just refused. */
  const reread = () => {
    setChanged(false);
    setSent(false);
    setLoaded(false);
    seq.current++; // whatever is in flight was asked before the user looked again
    load();
  };
  // The card exists only while the Pane is blocked, so mounting is the change into blocked.
  useEffect(load, [pane.key]);
  // A printing Pane moves its revision every second; re-read Explain once it settles for 2 s.
  const revised = useRef(pane.revision);
  useEffect(() => {
    if (revised.current === pane.revision) return;
    revised.current = pane.revision;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [pane.revision]);

  const yesNo = explain ? yesNoKeys(explain) : null;
  const offer = !loaded || !!yesNo; // on the first load and a Re-read, the answers hold their place, disabled
  const busy = !loaded || sending || sent;
  const answer = async (key: string) => {
    setSending(true);
    try {
      const outcome = await sendBlocked(pane.key, [key], explain?.promptId);
      if (outcome === 'changed') setChanged(true);
      else setSent(true);
    } finally {
      setSending(false);
    }
  };

  const to = `#/pane/${encodeURIComponent(pane.key)}`;
  const agent = pane.agent ?? 'shell';
  const command = explain ? promptLine(explain) : pane.lastLine;
  const when = timeAgo(pane.statusChangedAt);
  const label = [agent, pane.title, 'needs you', where, command, when].filter(Boolean).join(', ');
  const frame = 'rounded-card border border-warn/35 bg-warn/8';

  if (compact) {
    return (
      <li className="px-2 py-0.5">
        <div className={`flex min-h-9 items-center gap-2 pr-1 ${frame}`}>
          <Link to={to} aria-label={label} title={command} className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch pl-2">
            <Dot status="blocked" />
            <span aria-hidden className="truncate text-[13px] font-medium text-fg">{pane.title}</span>
            <span aria-hidden className="shrink-0 text-caption text-warn">{changed ? 'prompt changed' : agent}</span>
          </Link>
          {changed ? (
            <button type="button" onClick={reread} className="press h-7 shrink-0 rounded-chip px-2.5 text-[12px] font-medium text-accent">
              Re-read
            </button>
          ) : (
            offer && (
              <button
                type="button"
                aria-label={`Yes to ${pane.title}`}
                disabled={busy}
                onClick={() => yesNo && void answer(yesNo.yes.key)}
                className="press h-7 shrink-0 rounded-chip bg-warn px-2.5 text-[12px] font-semibold disabled:opacity-50"
                style={{ color: ON_WARN }}
              >
                Yes
              </button>
            )
          )}
        </div>
      </li>
    );
  }

  const open = (
    <Link to={to} className="press flex h-11 shrink-0 items-center px-3 text-[13px] font-medium text-accent">
      Open
    </Link>
  );
  return (
    <li className="px-4 py-1.5">
      <div role="group" aria-label={`${pane.title} needs you`} className={`flex flex-col gap-2.5 px-3.5 pt-3 pb-2.5 ${frame}`}>
        <Link to={to} aria-label={label} className="flex min-w-0 flex-col gap-1">
          <span aria-hidden className="flex min-w-0 items-center gap-2 text-[12px] font-semibold text-warn">
            <Dot status="blocked" />
            <span className="truncate">Needs you · {agent}{where && <span className="font-normal text-muted"> · {where}</span>}</span>
            <span className="ml-auto shrink-0 font-mono font-normal tabular-nums text-muted">{when}</span>
          </span>
          <span aria-hidden className="truncate text-[15px] font-medium text-fg">{pane.title}</span>
          {command && (
            <code aria-hidden className="truncate font-mono text-caption text-muted">
              {command}
            </code>
          )}
        </Link>
        {changed ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-caption text-warn">The prompt changed. Read it again before you answer.</p>
            <button type="button" onClick={reread} className="press h-11 shrink-0 rounded-chip border border-border bg-bg px-3 text-caption font-medium text-accent">
              Re-read
            </button>
            {open}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {offer && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => yesNo && void answer(yesNo.yes.key)}
                  className="press h-11 min-w-16 shrink-0 rounded-composer bg-warn px-4 text-[14px] font-semibold disabled:opacity-50"
                  style={{ color: ON_WARN }}
                >
                  Yes
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => yesNo && void answer(yesNo.no.key)}
                  className="press h-11 min-w-16 shrink-0 rounded-composer border border-border bg-surface px-4 text-[14px] text-fg disabled:opacity-50"
                >
                  No
                </button>
              </>
            )}
            <span className="ml-auto" />
            {open}
          </div>
        )}
      </div>
    </li>
  );
}

/** 500 ms, cancelled by 10 px of movement, so a scroll never opens the menu. */
function useLongPress(fn: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const stop = () => clearTimeout(timer.current);
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      from.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(fn, 500);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > 10) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
  };
}

/**
 * A list group header, one row: chevron, the label (the first thing to truncate), the Host as
 * a muted chip, the Status counts as pills on the right, then ⋯. Workspace groups also open
 * their menu on long-press. With a pointer, the row lights up on hover and ⋯ brightens; it
 * is always there, so nothing moves.
 */
function GroupHeader({
  label,
  secondary,
  host,
  panes,
  open,
  compact,
  onToggle,
  onMenu,
}: {
  label: string;
  secondary?: string;
  host?: string;
  panes: StatePane[];
  open: boolean;
  /** The 300 px sidebar: one pill, the most urgent, so the label keeps its room. */
  compact?: boolean;
  onToggle: () => void;
  onMenu?: () => void;
}) {
  const press = useLongPress(() => onMenu?.());
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <h2
      className={`group/header flex items-center ${compact ? 'mt-2 hover:bg-bg' : 'mt-4 hover:bg-surface'} ${onMenu ? (compact ? 'pr-1.5' : 'pr-2') : 'pr-4'}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        {...(onMenu ? press : {})}
        className={`flex min-w-0 flex-1 items-center gap-2 self-stretch pl-4 text-left [-webkit-touch-callout:none] ${RING} ${
          compact ? 'min-h-9 py-1.5' : 'min-h-11 py-2'
        }`}
      >
        <Chevron className={`shrink-0 text-muted ${secondary ? 'self-start mt-1.5' : ''}`} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate font-semibold tracking-tight text-fg ${compact ? 'text-[13px]' : 'text-[15px]'}`}>{label}</span>
            {host && (
              <span className="max-w-[45%] shrink-0 truncate rounded-[5px] bg-fg/6 px-1.5 py-px text-[11px] font-medium text-muted">
                {host}
              </span>
            )}
          </span>
          {secondary && (
            <span title={secondary} className="mt-0.5 block truncate font-mono text-caption text-muted">
              {secondary}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {tally(panes, compact ? 1 : 2).map(([s, n]) => (
            <StatusPill key={s} status={s} n={n} />
          ))}
        </span>
      </button>
      {onMenu && (
        <button
          type="button"
          aria-label={`${label} actions`}
          onClick={onMenu}
          className={`press ml-0.5 flex shrink-0 items-center justify-center rounded-chip text-muted transition-opacity hover:bg-fg/6 hover:text-fg [@media(hover:hover)]:opacity-60 group-hover/header:opacity-100 focus-visible:opacity-100 ${RING} ${
            compact ? 'size-8' : 'size-10'
          }`}
        >
          <More size={18} />
        </button>
      )}
    </h2>
  );
}

/** A pinned section header — Needs you, Running — collapsible like a Workspace group, and
 *  drawn the same way: chevron, label, and the count where a group has its pills. */
function PinnedHeader({ label, count, open, compact, onToggle }: { label: string; count: number; open: boolean; compact?: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <h2 className={`flex ${compact ? 'mt-2 hover:bg-bg' : 'mt-3 hover:bg-surface'}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex w-full items-center gap-2 px-4 text-left ${RING} ${compact ? 'min-h-9 py-1.5' : 'min-h-11 py-2'}`}
      >
        <Chevron className="shrink-0 text-muted" />
        <span className={`font-semibold tracking-tight text-fg ${compact ? 'text-[13px]' : 'text-[15px]'}`}>{label}</span>
        <span className="ml-auto shrink-0 text-[12px] font-medium tabular-nums text-muted">{count}</span>
      </button>
    </h2>
  );
}

// ---- screen ----

const COLLAPSED = 'tautan.collapsed';
const GROUPING = 'tautan.grouping';
type Grouping = 'workspace' | 'folder';
const readCollapsed = (): string[] => JSON.parse(localStorage.getItem(COLLAPSED) ?? '[]') as string[];
const readGrouping = (): Grouping => (localStorage.getItem(GROUPING) === 'folder' ? 'folder' : 'workspace');
const folderFoldKey = (host: string, path: string) => `@folder/${encodeURIComponent(host)}/${encodeURIComponent(path)}`;
/** Fold keys for the two pinned sections. */
const NEEDS = '@needs';
const RUNNING = '@running';

/** `compact` is the desktop sidebar: the same list, without the phone column or the tab bar's room. */
// ponytail: module-level so the Host filter survives the sidebar toggle and a resize across
// `lg`; it resets on reload. Move it to the URL or localStorage if that ever matters.
let hostFilter: string | null = null;

export function Home({ state, compact }: { state: State | null; compact?: boolean }) {
  const [host, setHostState] = useState<string | null>(hostFilter);
  const setHost = (h: string | null) => { hostFilter = h; setHostState(h); };
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [grouping, setGrouping] = useState(readGrouping);
  const [newWorkspace, setNewWorkspace] = useState(() => opensWith('newworkspace'));
  const [newTab, setNewTab] = useState<StateWorkspace | null>(null);
  const [menu, setMenu] = useState<StateWorkspace | null>(null);
  const [rename, setRename] = useState<StateWorkspace | null>(null);
  const [close, setClose] = useState<StateWorkspace | null>(null);
  const [paneMenu, setPaneMenu] = useState<StatePane | null>(null);
  const [paneRename, setPaneRename] = useState<StatePane | null>(null);
  const [paneClose, setPaneClose] = useState<StatePane | null>(null);
  const [q, setQ] = useState('');
  // The Workspace this screen just created: it stays listed until State fills it with a
  // Pane, and scrolls itself into view the first time State carries it.
  const [created, setCreated] = useState<string | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const scrolled = useRef(false);
  const pal = usePal();

  const write = (next: string[]) => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSED, JSON.stringify(next));
  };
  const toggle = (key: string) =>
    write(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
  const groupBy = (next: Grouping) => {
    setGrouping(next);
    localStorage.setItem(GROUPING, next);
  };

  useEffect(() => {
    const el = created && sections.current.get(created);
    if (!el || scrolled.current) return;
    scrolled.current = true;
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [state, created]);

  const hostOf = (muxKey: string) => state?.muxes.find((m) => m.key === muxKey)?.hostId;
  const hostLabel = (muxKey: string) => state?.hosts.find((h) => h.id === hostOf(muxKey))?.label;
  const panesOf = (w: StateWorkspace) =>
    (state?.panes ?? []).filter((p) => p.muxKey === w.muxKey && p.workspaceId === w.id).sort(comparePanes);

  const visible = (muxKey: string) => !host || hostOf(muxKey) === host;
  /** Only herdr writes. tmux answers 501, so tautan never offers the action. */
  const writable = (muxKey?: string) => state?.muxes.find((m) => m.key === muxKey)?.kind === 'herdr';
  const needle = q.trim().toLowerCase();
  const hit = (p: StatePane) => matchPane(p, needle, state);
  const wsLabel = (p: StatePane) => state?.workspaces.find((w) => w.muxKey === p.muxKey && w.id === p.workspaceId)?.label;
  const needsYou = (state?.panes ?? [])
    .filter((p) => visible(p.muxKey) && unseen(p) && (p.status === 'blocked' || p.status === 'done') && hit(p))
    .sort(comparePanes); // blocked cards first, then the done rows
  /** `Workspace › Tab`, for a Needs you card. */
  const whereOf = (p: StatePane) => {
    const tab = state?.tabs.find((t) => t.muxKey === p.muxKey && t.workspaceId === p.workspaceId && t.id === p.tabId)?.label;
    return [wsLabel(p), tab].filter(Boolean).join(' › ') || undefined;
  };
  /** Working Panes pinned beside Needs you, most recently changed first. */
  const running = (state?.panes ?? [])
    .filter((p) => visible(p.muxKey) && p.status === 'working' && hit(p))
    .sort((a, b) => (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0));
  const pinned = new Set([...needsYou, ...running].map((p) => p.key));
  const groups = (state?.workspaces ?? [])
    .filter((w) => visible(w.muxKey))
    .map((w) => {
      const hostId = hostOf(w.muxKey);
      return {
        w,
        host: state?.hosts.find((h) => h.id === hostId),
        all: panesOf(w),
        panes: panesOf(w).filter((p) => !pinned.has(p.key) && hit(p)),
      };
    })
    // A Workspace whose Panes all sit in a pinned section keeps its header — its summary
    // still says what it holds, and the group menu stays reachable. While searching, an
    // empty section is noise instead, so it goes.
    .filter((g) => g.panes.length > 0 || (!needle && g.all.length > 0) || g.host?.online === false || g.w.key === created);
  const folderGroups = (() => {
    const byFolder = new Map<
      string,
      { key: string; path: string; host?: State['hosts'][number]; all: StatePane[]; panes: StatePane[] }
    >();
    for (const pane of state?.panes ?? []) {
      if (!visible(pane.muxKey)) continue;
      const hostId = hostOf(pane.muxKey) ?? '';
      const path = pane.cwd ?? '';
      const key = folderFoldKey(hostId, path);
      const group = byFolder.get(key) ?? {
        key,
        path,
        host: state?.hosts.find((h) => h.id === hostId),
        all: [],
        panes: [],
      };
      group.all.push(pane);
      if (!pinned.has(pane.key) && hit(pane)) group.panes.push(pane);
      byFolder.set(key, group);
    }
    return [...byFolder.values()]
      .map((group) => ({ ...group, all: group.all.sort(comparePanes), panes: group.panes.sort(comparePanes) }))
      .filter((group) => group.panes.length > 0 || (!needle && group.all.length > 0));
  })();
  /** A search must show what it found, so a folded section opens while the needle is set. */
  const openSection = (key: string) => !!needle || !collapsed.includes(key);

  const tabIn = newTab ?? (opensWith('newtab') ? (groups[0]?.w ?? null) : null);
  // A new Workspace lands on the Mux the list already shows, next to the Workspace it was
  // started from: one herdr Mux is the common case, and nothing here asks which.
  const beside = groups.find((g) => writable(g.w.muxKey))?.w ?? state?.workspaces.find((w) => writable(w.muxKey));

  const createTab = async (w: StateWorkspace, o: { label?: string; cwd?: string; agent?: string }) => {
    const { paneKey } = await api<NewTabResult>(`/api/muxes/${encodeURIComponent(w.muxKey)}/tabs`, {
      workspaceId: w.id,
      ...o,
    } satisfies NewTabBody);
    navigate(`#/pane/${encodeURIComponent(paneKey)}`);
  };

  const createWorkspace = async (o: { cwd: string; label?: string; branch?: string }) => {
    const { workspaceKey } = await api<NewWorkspaceResult>(
      `/api/muxes/${encodeURIComponent(beside!.muxKey)}/workspaces`,
      o satisfies NewWorkspaceBody,
    );
    write(collapsed.filter((k) => k !== workspaceKey));
    scrolled.current = false;
    setCreated(workspaceKey);
  };
  const counts = state && `${state.hosts.length} host${state.hosts.length === 1 ? '' : 's'} · ${state.panes.length} panes`;
  // Collapse all folds the pinned sections with the active grouping; the two only exist
  // when they hold rows, which is exactly when folding them means something.
  const groupKeys = grouping === 'workspace' ? groups.map((g) => g.w.key) : folderGroups.map((g) => g.key);
  const keys = [...groupKeys, ...(needsYou.length ? [NEEDS] : []), ...(running.length ? [RUNNING] : [])];
  const allShut = keys.length > 0 && keys.every((k) => collapsed.includes(k));
  const rowActions = (p: StatePane): RowActions | undefined =>
    writable(p.muxKey) ? { onMenu: setPaneMenu, onRename: setPaneRename, onClose: setPaneClose } : undefined;

  const listed = state && (needsYou.length > 0 || running.length > 0 || groups.length > 0);
  const groupToggle = (
    <div role="group" aria-label="Group panes by" className={`flex justify-end px-4 ${compact ? 'pt-1.5 pb-2.5' : 'pt-3'}`}>
      <div className="w-52">
        <SegmentedControl
          options={['Workspace', 'Folder']}
          value={grouping === 'workspace' ? 'Workspace' : 'Folder'}
          onChange={(value: string) => groupBy(value === 'Folder' ? 'folder' : 'workspace')}
        />
      </div>
    </div>
  );

  // The top: title, search, Host chips. In the sidebar it holds the grouping too, and stays
  // put while only the list under it scrolls; on the phone the window scrolls and the
  // TopBar is sticky, so neither part may be wrapped there.
  const top = (
    <>
      <TopBar
        title="tautan"
        right={
          <>
            {!compact && <span className="mr-1.5 text-caption tabular-nums text-muted">{counts}</span>}
            {state && keys.length > 0 && (
              <IconButton
                size={40}
                label={allShut ? 'Expand all' : 'Collapse all'}
                onClick={() => write(allShut ? collapsed.filter((k) => !keys.includes(k)) : [...new Set([...collapsed, ...keys])])}
                icon={allShut ? <ExpandAll size={18} /> : <CollapseAll size={18} />}
              />
            )}
            {beside && (
              <IconButton
                size={40}
                label="New Workspace"
                onClick={() => setNewWorkspace(true)}
                icon={<Plus size={20} />}
                style={{ color: pal.accent }}
              />
            )}
          </>
        }
        below={
          state ? (
            <div className="px-4 pb-2">
              <SearchInput
                value={q}
                onChange={setQ}
                placeholder="Search panes"
                shortcut={null}
                style={{ width: '100%', height: 40 }}
              />
            </div>
          ) : undefined
        }
      />

      {state && state.hosts.length > 1 && (
        <div role="group" aria-label="Filter by Host" className="hscroll flex gap-2 px-4 pt-1.5 pb-0.5">
          {[{ id: null, label: 'All', online: true }, ...state.hosts].map((h) => (
            <Chip key={h.id ?? 'all'} selected={host === h.id} onToggle={() => setHost(h.id)}>
              {h.label}
            </Chip>
          ))}
        </div>
      )}
      {compact && listed && groupToggle}
    </>
  );

  const list = (
    <>
      {!state ? (
        <ul aria-busy className="pt-6">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
              <Skeleton width={8} height={8} rounded />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton width="50%" height={14} />
                <Skeleton width="75%" height={12} />
              </div>
            </li>
          ))}
        </ul>
      ) : !listed ? (
        <div className="pt-6">
          {needle ? (
            <EmptyState title={`Nothing matches “${q.trim()}”`} description="Try an agent, a title or a Workspace label." />
          ) : (
            <EmptyState
              title="No panes yet"
              description="Add a Host and its Muxes appear here."
              action={
                <Link to="#/hosts" className="text-body font-medium text-accent">
                  Add a Host
                </Link>
              }
            />
          )}
        </div>
      ) : (
        <>
          {needsYou.length > 0 && (
            <section>
              <PinnedHeader label="Needs you" count={needsYou.length} compact={compact} open={openSection(NEEDS)} onToggle={() => toggle(NEEDS)} />
              {openSection(NEEDS) && (
                <ul>
                  {needsYou.map((p, i) =>
                    p.status === 'blocked' ? (
                      <NeedsYouCard key={p.key} pane={p} where={whereOf(p)} compact={compact} />
                    ) : (
                      <Row
                        key={p.key}
                        pane={p}
                        first={i === 0 || needsYou[i - 1]!.status === 'blocked'}
                        actions={rowActions(p)}
                        context={wsLabel(p)}
                        compact={compact}
                      />
                    ),
                  )}
                </ul>
              )}
            </section>
          )}

          {running.length > 0 && (
            <section>
              <PinnedHeader label="Running" count={running.length} compact={compact} open={openSection(RUNNING)} onToggle={() => toggle(RUNNING)} />
              {openSection(RUNNING) && (
                <ul>
                  {running.map((p, i) => (
                    <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} context={wsLabel(p)} compact={compact} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {!compact && groupToggle}

          {grouping === 'workspace'
            ? groups.map(({ w, host: h, panes, all }) => {
                const shut = collapsed.includes(w.key);
                return (
                  <section
                    key={w.key}
                    ref={(el) => {
                      if (el) sections.current.set(w.key, el);
                      else sections.current.delete(w.key);
                    }}
                  >
                    <GroupHeader
                      label={w.label}
                      host={h?.label}
                      panes={all}
                      compact={compact}
                      open={!shut}
                      onToggle={() => toggle(w.key)}
                      onMenu={() => setMenu(w)}
                    />
                    {!shut && (
                      <ul>
                        {panes.map((p, i) => (
                          <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} compact={compact} />
                        ))}
                        {h?.online === false && (
                          <li>
                            <Link
                              to="#/hosts"
                              className="flex min-h-11 items-center gap-3 px-4 py-2.5 active:bg-surface"
                              aria-label={`${h.label} unreachable, ${h.error ?? 'offline'}. Open Hosts`}
                            >
                              <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
                              <span aria-hidden className="min-w-0 flex-1 truncate text-[13px] text-muted">
                                <span className="text-danger">{h.label} unreachable</span> · {h.error}
                              </span>
                              <span aria-hidden className="shrink-0 text-caption text-accent">
                                Hosts ›
                              </span>
                            </Link>
                          </li>
                        )}
                      </ul>
                    )}
                  </section>
                );
              })
            : folderGroups.map(({ key, path, host: h, panes, all }) => {
                const shut = collapsed.includes(key);
                return (
                  <section key={key}>
                    <GroupHeader
                      label={basename(path) || path || 'Unknown folder'}
                      secondary={path || 'No directory reported'}
                      host={h?.label}
                      panes={all}
                      compact={compact}
                      open={!shut}
                      onToggle={() => toggle(key)}
                    />
                    {!shut && (
                      <ul>
                        {panes.map((p, i) => (
                          <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} context={wsLabel(p)} compact={compact} />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
        </>
      )}
    </>
  );

  return (
    <div className={compact ? 'flex h-full min-h-0 flex-col' : 'mx-auto max-w-2xl pb-28'}>
      {compact ? <div className="shrink-0 border-b border-border">{top}</div> : top}
      {compact ? (
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-4">{list}</div>
      ) : (
        list
      )}

      <NewWorkspaceSheet
        open={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        cwd={parentDir(beside?.cwd)}
        onSubmit={createWorkspace}
      />
      <NewTabSheet
        open={tabIn !== null}
        onClose={() => setNewTab(null)}
        cwd={tabIn?.cwd}
        agent={commonAgent(tabIn ? panesOf(tabIn) : [])}
        where={
          <>
            in <span className="text-fg">{tabIn?.label}</span> · {hostLabel(tabIn?.muxKey ?? '')}
          </>
        }
        onSubmit={(o) => createTab(tabIn!, o)}
      />
      <MenuSheet
        open={menu !== null}
        title={menu?.label ?? ''}
        meta={menu && [hostLabel(menu.muxKey), `${panesOf(menu).length} Pane${panesOf(menu).length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
        onClose={() => setMenu(null)}
        items={[
          ...(writable(menu?.muxKey)
            ? [
                { label: 'New Tab', onClick: () => setNewTab(menu) },
                { label: 'Rename', onClick: () => setRename(menu) },
              ]
            : []),
          { label: 'Diff', onClick: () => menu && navigate(`#/diff/${encodeURIComponent(menu.key)}`) },
          { label: collapsed.includes(menu?.key ?? '') ? 'Expand' : 'Collapse', onClick: () => menu && toggle(menu.key) },
          ...(writable(menu?.muxKey) ? [{ label: 'Close Workspace', danger: true, onClick: () => menu && setClose(menu) }] : []),
        ]}
      />
      <RenameSheet
        open={rename !== null}
        kind="Workspace"
        current={rename?.label ?? ''}
        onClose={() => setRename(null)}
        onSubmit={(label) =>
          api<void>('/api/rename', { muxKey: rename!.muxKey, workspaceId: rename!.id, label } satisfies RenameBody)
        }
      />
      <ConfirmCloseSheet
        open={close !== null}
        kind="Workspace"
        title={close?.label ?? ''}
        onClose={() => setClose(null)}
        onConfirm={() => api<void>(`/api/workspaces/${encodeURIComponent(close!.key)}/close`)}
      />
      <MenuSheet
        open={paneMenu !== null}
        title={paneMenu?.title ?? ''}
        meta={paneMenu && [paneMenu.agent ?? 'shell', paneMenu.status, wsLabel(paneMenu)].filter(Boolean).join(' · ')}
        onClose={() => setPaneMenu(null)}
        items={[
          { label: 'Rename', onClick: () => paneMenu && setPaneRename(paneMenu) },
          { label: 'Close Pane', danger: true, onClick: () => paneMenu && setPaneClose(paneMenu) },
        ]}
      />
      <RenameSheet
        open={paneRename !== null}
        kind="Pane"
        current={paneRename?.title ?? ''}
        onClose={() => setPaneRename(null)}
        onSubmit={(label) =>
          api<void>('/api/rename', { muxKey: paneRename!.muxKey, paneId: paneRename!.id, label } satisfies RenameBody)
        }
      />
      <ConfirmCloseSheet
        open={paneClose !== null}
        title={paneClose?.title ?? ''}
        onClose={() => setPaneClose(null)}
        onConfirm={() => api<void>(`/api/panes/${encodeURIComponent(paneClose!.key)}/close`)}
      />
    </div>
  );
}
